import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  RATE,
  fade,
  finish,
  levelDb,
  parseResponse,
  quietestPoint,
  readWav,
  sliceWords,
  trimSilence,
  wavBytes,
  wordSpans
} from './clipSlicer.mjs'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/ttsResponse.json', import.meta.url), 'utf8'))
const TEXT = 'Fifty-six and fifty-two exit.'

/** Audio for the fixture's timings: a tone while a word sounds, silence between. */
function fixtureAudio() {
  const chars = FIXTURE.audio_timestamps.graph_chars
  const times = FIXTURE.audio_timestamps.graph_times
  const samples = new Int16Array(Math.round(FIXTURE.duration * RATE))
  chars.forEach((char, i) => {
    if (char === ' ') return
    const [start, end] = times[i]
    for (let s = Math.round(start * RATE); s < Math.round(end * RATE) + 240; s++) {
      if (s < samples.length) samples[s] = Math.round(8000 * Math.sin(s / 6))
    }
  })
  return samples
}

function base64(samples) {
  const bytes = Buffer.alloc(samples.length * 2)
  samples.forEach((value, i) => bytes.writeInt16LE(value, i * 2))
  return bytes.toString('base64')
}

const fixtureResponse = () => ({ ...FIXTURE, audio: base64(fixtureAudio()) })

test('parseResponse reads the PCM and pairs each character with its time', () => {
  const parsed = parseResponse(fixtureResponse(), TEXT)
  assert.equal(parsed.samples.length, Math.round(FIXTURE.duration * RATE))
  assert.equal(parsed.chars.join(''), TEXT)
  assert.deepEqual(parsed.times[0], { start: 0.1, end: 0.12 })
})

test('parseResponse accepts {start, end} objects as well as pairs', () => {
  const json = fixtureResponse()
  json.audio_timestamps = {
    graph_chars: ['a'],
    graph_times: [{ start: 0.5, end: 0.75 }]
  }
  assert.deepEqual(parseResponse(json, 'a').times, [{ start: 0.5, end: 0.75 }])
})

test('parseResponse rejects a response without audio or timestamps', () => {
  assert.throws(() => parseResponse(null, TEXT), /no audio/)
  assert.throws(() => parseResponse({ audio: 'AAAA' }, TEXT), /no character timestamps/)
  assert.throws(
    () => parseResponse({ audio: 'AAAA', audio_timestamps: { graph_chars: ['a'], graph_times: [] } }, 'a'),
    /no character timestamps/
  )
})

test('parseResponse rejects timestamps that spell another text', () => {
  assert.throws(() => parseResponse(fixtureResponse(), 'Fifty-six.'), /timestamps spell/)
})

test('wordSpans splits on spaces only and keeps hyphenated numbers whole', () => {
  const { chars, times } = parseResponse(fixtureResponse(), TEXT)
  const spans = wordSpans(chars, times)
  assert.deepEqual(
    spans.map(span => span.word),
    ['Fifty-six', 'and', 'fifty-two', 'exit.']
  )
  assert.deepEqual(spans[0], { word: 'Fifty-six', start: 0.1, end: 0.7 })
  assert.deepEqual(spans[1], { word: 'and', start: 0.86, end: 0.96 })
})

test('quietestPoint finds the silence inside a gap', () => {
  const samples = new Int16Array(RATE).fill(5000)
  samples.fill(0, 12000, 12480)
  const point = quietestPoint(samples, RATE, 0.4, 0.6)
  assert.ok(point >= 12000 && point <= 12480, `cut at ${point}`)
})

test('quietestPoint takes the midpoint of a gap shorter than its window', () => {
  const samples = new Int16Array(RATE).fill(5000)
  assert.equal(quietestPoint(samples, RATE, 0.5, 0.505), 12060)
})

test('sliceWords cuts in the later half of each gap, so a word keeps its tail', () => {
  const samples = new Int16Array(RATE).fill(3000)
  // A quiet stop inside the first word's tail, early in the gap, and a pause late in it.
  samples.fill(0, 4800, 5040)
  samples.fill(0, 7200, 7440)
  const spans = [
    { word: 'six', start: 0, end: 0.19 },
    { word: 'and', start: 0.32, end: 0.5 }
  ]
  const [six, and] = sliceWords(samples, RATE, spans)
  assert.ok(six.samples.length >= 7200 && six.samples.length <= 7440, `six ends at ${six.samples.length}`)
  assert.equal(six.samples.length + and.samples.length, RATE)
  assert.equal(six.word, 'six')
})

test('sliceWords on the fixture yields four words that cover the audio', () => {
  const { samples, chars, times } = parseResponse(fixtureResponse(), TEXT)
  const words = sliceWords(samples, RATE, wordSpans(chars, times))
  assert.equal(words.length, 4)
  assert.equal(
    words.reduce((sum, word) => sum + word.samples.length, 0),
    samples.length
  )
  for (const word of words) assert.ok(levelDb(word.samples) > -40, `${word.word} is not silent`)
})

test('trimSilence keeps the sound and a short pad at each end', () => {
  const samples = new Int16Array(RATE)
  samples.fill(4000, 6000, 18000)
  const trimmed = trimSilence(samples, RATE)
  const pad = Math.round(0.008 * RATE)
  assert.equal(trimmed.length, 12000 + 2 * pad)
  assert.equal(trimmed[pad], 4000)
  assert.equal(trimmed[0], 0)
})

test('trimSilence of silence is empty, and of sound at the edges is unchanged', () => {
  assert.equal(trimSilence(new Int16Array(100), RATE).length, 0)
  const loud = new Int16Array(100).fill(9000)
  assert.equal(trimSilence(loud, RATE).length, 100)
})

test('fade ramps both ends over 6 ms and leaves the middle', () => {
  const samples = new Int16Array(RATE).fill(10000)
  const faded = fade(samples, RATE)
  const n = Math.round(0.006 * RATE)
  assert.equal(faded[0], 0)
  assert.equal(faded[faded.length - 1], 0)
  assert.equal(faded[n >> 1], 5000)
  assert.equal(faded[n], 10000)
  assert.equal(faded[RATE >> 1], 10000)
  assert.equal(samples[0], 10000, 'the input is not changed')
})

test('fade of a clip shorter than two fades ramps over half of it', () => {
  const faded = fade(new Int16Array(10).fill(1000), RATE)
  assert.equal(faded[0], 0)
  assert.equal(faded[9], 0)
  assert.equal(faded[4], 800)
})

test('finish trims and then fades', () => {
  const samples = new Int16Array(RATE)
  samples.fill(4000, 6000, 18000)
  const done = finish(samples, RATE)
  assert.equal(done.length, trimSilence(samples, RATE).length)
  assert.equal(done[0], 0)
})

for (const count of [0, 1, 2, 241]) {
  test(`wavBytes writes a canonical header for ${count} samples`, () => {
    const samples = Int16Array.from({ length: count }, (_, i) => (i * 37) - 100)
    const bytes = wavBytes(samples, RATE)
    assert.equal(bytes.length, 44 + count * 2)
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.readUInt32LE(4), 36 + count * 2)
    assert.equal(bytes.toString('ascii', 8, 16), 'WAVEfmt ')
    assert.equal(bytes.readUInt32LE(16), 16)
    assert.equal(bytes.readUInt16LE(20), 1)
    assert.equal(bytes.readUInt16LE(22), 1)
    assert.equal(bytes.readUInt32LE(24), RATE)
    assert.equal(bytes.readUInt32LE(28), RATE * 2)
    assert.equal(bytes.readUInt16LE(32), 2)
    assert.equal(bytes.readUInt16LE(34), 16)
    assert.equal(bytes.toString('ascii', 36, 40), 'data')
    assert.equal(bytes.readUInt32LE(40), count * 2)
    const read = readWav(bytes)
    assert.deepEqual(Array.from(read.samples), Array.from(samples))
    assert.deepEqual({ codec: read.codec, channels: read.channels, rate: read.rate, bits: read.bits }, { codec: 1, channels: 1, rate: RATE, bits: 16 })
  })
}

test('readWav skips unknown chunks, including an odd-sized one', () => {
  const plain = wavBytes(Int16Array.from([1, -2, 3]), RATE)
  const extra = Buffer.alloc(8 + 3 + 1)
  extra.write('LIST', 0, 'ascii')
  extra.writeUInt32LE(3, 4)
  const withChunk = Buffer.concat([plain.subarray(0, 36), extra, plain.subarray(36)])
  assert.deepEqual(Array.from(readWav(withChunk).samples), [1, -2, 3])
})

test('readWav rejects files that are not usable WAVs', () => {
  assert.throws(() => readWav(Buffer.from('nope')), /not a RIFF WAVE/)
  const noData = wavBytes(new Int16Array(0), RATE).subarray(0, 36)
  assert.throws(() => readWav(noData), /no data chunk/)
  const dataFirst = Buffer.concat([wavBytes(new Int16Array(0), RATE).subarray(0, 12), wavBytes(new Int16Array(1), RATE).subarray(36)])
  assert.throws(() => readWav(dataFirst), /data before fmt/)
  const short = wavBytes(new Int16Array(4), RATE).subarray(0, 46)
  assert.throws(() => readWav(short), /runs past the end/)
})

test('levelDb measures RMS against full scale', () => {
  assert.equal(levelDb(new Int16Array(0)), -Infinity)
  assert.equal(levelDb(new Int16Array(10)), -Infinity)
  assert.ok(Math.abs(levelDb(new Int16Array(10).fill(16384)) - -6.02) < 0.01)
})
