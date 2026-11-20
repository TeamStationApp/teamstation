// What TS Speedy says, and how each clip of it is made.
//
// Every number from 20 to 99 has three takes, so a phrase built from clips
// keeps the intonation it would have had if spoken whole:
//
//   n56-final   "Fifty-six."                    said alone, falling
//   n56-and     "Fifty-six and fifty-seven exit." the number before "and"
//   n56-exit    "Fifty-five and fifty-six exit."  the number before "exit"
//
// The pair phrases rotate: number N is followed by N + 1 (99 by 20), so each
// number is said once before "and" and once before "exit". "and" and "exit"
// themselves come from "Fifty-six and fifty-two exit."
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  RATE,
  finish,
  levelDb,
  parseResponse,
  readWav,
  sliceWords,
  wavBytes,
  wordSpans
} from './clipSlicer.mjs'

export const FIRST = 20
export const LAST = 99
export const VOICE = 'rex'
export const ENDPOINT = 'https://api.x.ai/v1/tts'
const TIMEOUT_MS = 30000
const ATTEMPTS = 3

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

export function numbers() {
  const out = []
  for (let n = FIRST; n <= LAST; n++) out.push(n)
  return out
}

/** 20…99 in words: "fifty-six", "seventy". */
export function spell(n) {
  if (!Number.isInteger(n) || n < FIRST || n > LAST) throw new Error(`no words for ${n}`)
  const tens = TENS[Math.floor(n / 10)]
  const ones = ONES[n % 10]
  return ones === '' ? tens : `${tens}-${ones}`
}

const capital = text => text[0].toUpperCase() + text.slice(1)

/** The number after n, wrapping 99 to 20. */
export function next(n) {
  return n === LAST ? FIRST : n + 1
}

/** Every request, with the clips each one yields. */
export function jobs() {
  const out = []
  for (const n of numbers()) {
    out.push({ text: `${capital(spell(n))}.`, clips: [`n${n}-final`] })
  }
  for (const n of numbers()) {
    const m = next(n)
    out.push({
      text: `${capital(spell(n))} and ${spell(m)} exit.`,
      clips: [`n${n}-and`, null, `n${m}-exit`, null]
    })
  }
  out.push({
    text: 'Fifty-six and fifty-two exit.',
    clips: [null, 'word-and', null, 'word-exit']
  })
  return out
}

/** The names of every clip the apps ship, without the .wav. */
export function clipNames() {
  const names = []
  for (const n of numbers()) names.push(`n${n}-final`, `n${n}-and`, `n${n}-exit`)
  names.push('word-and', 'word-exit')
  return names.sort()
}

/** The request body for one text. */
export function requestBody(text, voice = VOICE) {
  return {
    text,
    language: 'en',
    voice_id: voice,
    output_format: { codec: 'pcm', sample_rate: RATE },
    text_normalization: false,
    with_timestamps: true
  }
}

/** One timestamped synthesis, retried on failure. The key never appears in an error. */
export async function synthesize(text, { apiKey, fetchImpl = fetch, voice = VOICE, timeoutMs = TIMEOUT_MS, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  let lastError = null
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(text, voice)),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return parseResponse(await response.json(), text)
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : String(error?.message ?? error)
      lastError = new Error(`${JSON.stringify(text)}: ${reason.split(apiKey).join('<key>')}`)
      if (attempt < ATTEMPTS) await pause(500 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/** The clips one job yields, from its response. */
export function clipsOf(job, response) {
  const words = sliceWords(response.samples, RATE, wordSpans(response.chars, response.times))
  if (job.clips.length === 1) {
    return [{ name: job.clips[0], samples: finish(response.samples, RATE) }]
  }
  if (words.length !== job.clips.length) {
    throw new Error(`${JSON.stringify(job.text)} has ${words.length} words, expected ${job.clips.length}`)
  }
  const out = []
  job.clips.forEach((name, i) => {
    if (name != null) out.push({ name, samples: finish(words[i].samples, RATE) })
  })
  return out
}

/**
 * Runs every job, a few at a time, and replaces the clips in dir with the new set. The clips are
 * written beside dir first and moved in only when every job has succeeded, so a failure leaves
 * the committed set as it was rather than a mix of old and new takes. The first failure stops
 * the other workers from starting more jobs.
 */
export async function generate({ dir, apiKey, fetchImpl, concurrency = 4, log = () => {}, pause }) {
  mkdirSync(dir, { recursive: true })
  const staging = mkdtempSync(path.join(path.dirname(dir), '.clips-'))
  const queue = jobs()
  let written = 0
  let failure = null
  async function worker() {
    while (failure == null) {
      const job = queue.shift()
      if (job == null) return
      try {
        const response = await synthesize(job.text, { apiKey, fetchImpl, pause })
        for (const clip of clipsOf(job, response)) {
          writeFileSync(path.join(staging, `${clip.name}.wav`), wavBytes(clip.samples, RATE))
          written++
        }
        log(`${job.text} -> ${job.clips.filter(Boolean).join(', ')}`)
      } catch (error) {
        failure ??= error
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker))
    if (failure != null) throw failure
    for (const file of readdirSync(dir).filter(name => name.endsWith('.wav'))) {
      rmSync(path.join(dir, file))
    }
    for (const file of readdirSync(staging)) renameSync(path.join(staging, file), path.join(dir, file))
    return written
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export const STT_ENDPOINT = 'https://api.x.ai/v1/stt'

const UNITS = new Set(ONES.filter(Boolean))

/**
 * Whether a transcript says n, as digits ("56") or in words ("fifty-six", "fifty six"), as a whole
 * token: "120" is not 20, and "twenty five" is not 20.
 */
export function heard(text, n) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const words = spell(n).split('-')
  return tokens.some((token, i) => {
    if (token === String(n)) return true
    if (!words.every((word, k) => tokens[i + k] === word)) return false
    // A tens word alone must not be the start of another number.
    return words.length > 1 || !UNITS.has(tokens[i + 1])
  })
}

/**
 * Transcribes every number said alone, and every number joined into a phrase it was not cut from
 * ("56 and 25 exit"), with xAI speech to text, as a check that no clip lost a sound at a cut.
 * Answers the phrases whose transcript is missing a number or "exit". "and" is not required:
 * before "ninety…" it runs into the next "n", as it does in natural speech.
 */
export async function transcribe(dir, { apiKey, fetchImpl = fetch, concurrency = 4 }) {
  const checks = []
  for (const n of numbers()) {
    const m = ((n * 7) % 80) + 20
    checks.push({ label: `${n}`, clips: [`n${n}-final`], numbers: [n], exit: false })
    checks.push({ label: `${n} and ${m} exit`, clips: [`n${n}-and`, 'word-and', `n${m}-exit`, 'word-exit'], numbers: [n, m], exit: true })
  }
  const misses = []
  const queue = [...checks]
  async function worker() {
    for (;;) {
      const check = queue.shift()
      if (check == null) return
      const form = new FormData()
      form.append('file', new Blob([wavBytes(assemble(dir, check.clips), RATE)], { type: 'audio/wav' }), 'phrase.wav')
      form.append('language', 'en')
      const response = await fetchImpl(STT_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      })
      if (!response.ok) throw new Error(`${check.label}: HTTP ${response.status}`)
      const text = String((await response.json()).text ?? '')
      const ok = check.numbers.every(n => heard(text, n)) && (!check.exit || /exit/i.test(text))
      if (!ok) misses.push({ label: check.label, text })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { checked: checks.length, misses: misses.sort((a, b) => a.label.localeCompare(b.label)) }
}

/** Every problem with the clip set in dir; empty when it is complete and well formed. */
export function checkClips(dir) {
  const problems = []
  const expected = new Set(clipNames().map(name => `${name}.wav`))
  const present = new Set(readdirSync(dir).filter(file => file.endsWith('.wav')))
  for (const file of expected) {
    if (!present.has(file)) problems.push(`${file}: missing`)
  }
  for (const file of present) {
    if (!expected.has(file)) {
      problems.push(`${file}: not a clip the apps use`)
      continue
    }
    try {
      const wav = readWav(readFileSync(path.join(dir, file)))
      if (wav.codec !== 1) problems.push(`${file}: codec ${wav.codec}, not PCM`)
      if (wav.channels !== 1) problems.push(`${file}: ${wav.channels} channels, not mono`)
      if (wav.rate !== RATE) problems.push(`${file}: ${wav.rate} Hz, not ${RATE}`)
      if (wav.bits !== 16) problems.push(`${file}: ${wav.bits}-bit, not 16`)
      if (wav.samples.length < RATE / 20) problems.push(`${file}: shorter than 50 ms`)
      else if (levelDb(wav.samples) < -40) problems.push(`${file}: silent`)
    } catch (error) {
      problems.push(`${file}: ${error.message}`)
    }
  }
  return problems.sort()
}

/** The phrases written as samples for a listener to judge. */
export const SAMPLES = [
  { file: 'voice-56.wav', clips: ['n56-final'] },
  { file: 'voice-53-exit.wav', clips: ['n53-exit', 'word-exit'] },
  { file: 'voice-56-and-52-exit.wav', clips: ['n56-and', 'word-and', 'n52-exit', 'word-exit'] },
  { file: 'voice-99-and-20-exit.wav', clips: ['n99-and', 'word-and', 'n20-exit', 'word-exit'] }
]

/** Clips joined end to end, as the apps join them. */
export function assemble(dir, names) {
  const parts = names.map(name => readWav(readFileSync(path.join(dir, `${name}.wav`))).samples)
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Writes SAMPLES into samplesDir; answers the files written. */
export function writeSamples(dir, samplesDir) {
  mkdirSync(samplesDir, { recursive: true })
  return SAMPLES.map(sample => {
    const file = path.join(samplesDir, sample.file)
    writeFileSync(file, wavBytes(assemble(dir, sample.clips), RATE))
    return file
  })
}
