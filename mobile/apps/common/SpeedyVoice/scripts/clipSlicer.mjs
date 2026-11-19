// Cuts xAI text-to-speech output into word clips.
//
// A timestamped /v1/tts response carries the audio as base64 PCM (16-bit
// little-endian, mono, at the requested rate) and one [start, end] pair per
// character of the text. Words are the runs between spaces, so "fifty-six"
// stays one word. Between two words the cut goes where the audio is quietest
// inside the gap the timestamps leave, so a clip ends on the speaker's own
// pause rather than mid-sound.

export const RATE = 24000
/** Quieter than this, in dBFS, is silence at a clip's edges. */
export const SILENCE_DB = -45
/** Silence kept before and after the sound when an edge is trimmed. */
export const PAD_MS = 8
/** The linear fade applied at both ends of every clip. */
export const FADE_MS = 6
/** The window the quietest-point search measures. */
const WINDOW_MS = 10
const HOP_MS = 2.5

/**
 * The samples and character timings of a timestamped response, checked
 * against the text that was asked for.
 */
export function parseResponse(json, text) {
  if (json == null || typeof json.audio !== 'string') {
    throw new Error('response has no audio')
  }
  const stamps = json.audio_timestamps
  if (
    stamps == null ||
    !Array.isArray(stamps.graph_chars) ||
    !Array.isArray(stamps.graph_times) ||
    stamps.graph_chars.length !== stamps.graph_times.length
  ) {
    throw new Error('response has no character timestamps')
  }
  const spelled = stamps.graph_chars.join('')
  if (spelled !== text) {
    throw new Error(`timestamps spell ${JSON.stringify(spelled)}, not ${JSON.stringify(text)}`)
  }
  const bytes = Buffer.from(json.audio, 'base64')
  const samples = new Int16Array(bytes.length >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  const times = stamps.graph_times.map(pair => {
    const [start, end] = Array.isArray(pair) ? pair : [pair.start, pair.end]
    return { start: Number(start), end: Number(end) }
  })
  return { samples, chars: stamps.graph_chars, times }
}

/** The words of the text, each with the time its first character starts and its last ends. */
export function wordSpans(chars, times) {
  const words = []
  let current = null
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === ' ') {
      current = null
      continue
    }
    if (current == null) {
      current = { word: '', start: times[i].start, end: times[i].end }
      words.push(current)
    }
    current.word += chars[i]
    current.end = times[i].end
  }
  return words
}

function rms(samples, from, to) {
  let sum = 0
  const n = Math.max(1, to - from)
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / n)
}

/** The quietest sample index between two times, or their midpoint when the gap is shorter than one window. */
export function quietestPoint(samples, rate, fromSeconds, toSeconds) {
  const from = Math.max(0, Math.round(fromSeconds * rate))
  const to = Math.min(samples.length, Math.round(toSeconds * rate))
  const window = Math.round((WINDOW_MS / 1000) * rate)
  if (to - from <= window) return Math.round((from + to) / 2)
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * rate))
  let best = from + (window >> 1)
  let bestLevel = Infinity
  for (let start = from; start + window <= to; start += hop) {
    const level = rms(samples, start, start + window)
    if (level < bestLevel) {
      bestLevel = level
      best = start + (window >> 1)
    }
  }
  return best
}

/**
 * The samples of each word, cut at the quietest point of the later half of
 * each gap. A word's last consonant often sounds past its last character's
 * timestamp ("six" before "and"), and a quiet stop closure inside it would
 * otherwise draw the cut; the next word starts on its own timestamp.
 */
export function sliceWords(samples, rate, spans) {
  const cuts = [0]
  for (let i = 1; i < spans.length; i++) {
    const from = spans[i - 1].end
    const to = spans[i].start
    cuts.push(quietestPoint(samples, rate, (from + to) / 2, to))
  }
  cuts.push(samples.length)
  return spans.map((span, i) => ({ word: span.word, samples: samples.slice(cuts[i], cuts[i + 1]) }))
}

/** Drops the silence at both ends, keeping PAD_MS of it. */
export function trimSilence(samples, rate, thresholdDb = SILENCE_DB) {
  const threshold = 32768 * Math.pow(10, thresholdDb / 20)
  let first = 0
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++
  if (first === samples.length) return new Int16Array(0)
  let last = samples.length - 1
  while (last > first && Math.abs(samples[last]) < threshold) last--
  const pad = Math.round((PAD_MS / 1000) * rate)
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + 1 + pad))
}

/** A linear fade in and out over FADE_MS (or half the clip, when it is shorter). */
export function fade(samples, rate, ms = FADE_MS) {
  const out = samples.slice()
  const n = Math.min(Math.round((ms / 1000) * rate), out.length >> 1)
  for (let i = 0; i < n; i++) {
    const gain = i / n
    out[i] = Math.round(out[i] * gain)
    out[out.length - 1 - i] = Math.round(out[out.length - 1 - i] * gain)
  }
  return out
}

/** A finished clip: trimmed, then faded. */
export function finish(samples, rate) {
  return fade(trimSilence(samples, rate), rate)
}

/** A canonical 44-byte-header WAV: PCM, 16-bit, mono. */
export function wavBytes(samples, rate) {
  const data = samples.length * 2
  const out = Buffer.alloc(44 + data)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + data, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(data, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2)
  return out
}

/** The format and samples of a WAV file, walking its chunks. */
export function readWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF WAVE file')
  }
  let format = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > buffer.length) throw new Error(`chunk ${id} runs past the end`)
    if (id === 'fmt ') {
      format = {
        codec: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      if (format == null) throw new Error('data before fmt')
      const samples = new Int16Array(size >> 1)
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(body + i * 2)
      return { ...format, samples }
    }
    offset = body + size + (size & 1)
  }
  throw new Error('no data chunk')
}

/** RMS level in dBFS; -Infinity for silence. */
export function levelDb(samples) {
  if (samples.length === 0) return -Infinity
  const level = rms(samples, 0, samples.length)
  return level === 0 ? -Infinity : 20 * Math.log10(level / 32768)
}
