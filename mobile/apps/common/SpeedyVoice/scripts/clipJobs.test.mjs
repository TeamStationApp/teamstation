import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  ENDPOINT,
  SAMPLES,
  assemble,
  checkClips,
  clipNames,
  clipsOf,
  generate,
  jobs,
  next,
  numbers,
  requestBody,
  spell,
  synthesize,
  writeSamples
} from './clipJobs.mjs'
import { RATE, readWav, wavBytes } from './clipSlicer.mjs'

const COMMITTED = new URL('../Sources/SpeedyVoice/Clips', import.meta.url).pathname
const temp = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'speedy-voice-'))
  temp.push(dir)
  return dir
}
after(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true })
})

/** A timestamped response for any text: each character 40 ms of tone, each space 60 ms of silence. */
function responseFor(text) {
  const chars = [...text]
  const times = []
  const pcm = []
  let t = 0
  for (const char of chars) {
    const length = char === ' ' ? 0.06 : 0.04
    times.push([t, t + length])
    const count = Math.round(length * RATE)
    for (let i = 0; i < count; i++) pcm.push(char === ' ' ? 0 : Math.round(6000 * Math.sin((pcm.length + i) / 5)))
    t += length
  }
  const bytes = Buffer.alloc(pcm.length * 2)
  pcm.forEach((value, i) => bytes.writeInt16LE(value, i * 2))
  return {
    audio: bytes.toString('base64'),
    content_type: 'audio/pcm',
    duration: t,
    audio_timestamps: { graph_chars: chars, graph_times: times }
  }
}

function fakeFetch(log = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    log.push({ url, init, body })
    return { ok: true, status: 200, json: async () => responseFor(body.text) }
  }
}

const noPause = async () => {}

test('spell writes 20…99 in words', () => {
  assert.equal(spell(20), 'twenty')
  assert.equal(spell(56), 'fifty-six')
  assert.equal(spell(99), 'ninety-nine')
  assert.equal(spell(70), 'seventy')
  assert.throws(() => spell(19), /no words/)
  assert.throws(() => spell(100), /no words/)
  assert.throws(() => spell(5.5), /no words/)
})

test('numbers runs 20 to 99, and next wraps 99 to 20', () => {
  assert.equal(numbers().length, 80)
  assert.equal(numbers()[0], 20)
  assert.equal(next(56), 57)
  assert.equal(next(99), 20)
})

test('jobs ask for every number alone, every pair in rotation, and the words once', () => {
  const all = jobs()
  assert.equal(all.length, 161)
  assert.deepEqual(all[0], { text: 'Twenty.', clips: ['n20-final'] })
  assert.deepEqual(all[80], { text: 'Twenty and twenty-one exit.', clips: ['n20-and', null, 'n21-exit', null] })
  assert.deepEqual(all[159], { text: 'Ninety-nine and twenty exit.', clips: ['n99-and', null, 'n20-exit', null] })
  assert.deepEqual(all[160], { text: 'Fifty-six and fifty-two exit.', clips: [null, 'word-and', null, 'word-exit'] })
  const made = all.flatMap(job => job.clips.filter(Boolean)).sort()
  assert.deepEqual(made, clipNames(), 'every clip is made exactly once')
})

test('clipNames lists 242 clips', () => {
  const names = clipNames()
  assert.equal(names.length, 242)
  assert.ok(names.includes('n56-final') && names.includes('n56-and') && names.includes('n56-exit'))
  assert.ok(names.includes('word-and') && names.includes('word-exit'))
})

test('requestBody asks for timestamped 24 kHz PCM in the replay voice', () => {
  assert.deepEqual(requestBody('Fifty-six.'), {
    text: 'Fifty-six.',
    language: 'en',
    voice_id: 'rex',
    output_format: { codec: 'pcm', sample_rate: 24000 },
    text_normalization: false,
    with_timestamps: true
  })
})

test('synthesize posts the body with the key as a bearer token', async () => {
  const log = []
  const parsed = await synthesize('Fifty-six.', { apiKey: 'test-key', fetchImpl: fakeFetch(log) })
  assert.equal(log.length, 1)
  assert.equal(log[0].url, ENDPOINT)
  assert.equal(log[0].init.method, 'POST')
  assert.equal(log[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(log[0].body.text, 'Fifty-six.')
  assert.equal(parsed.chars.join(''), 'Fifty-six.')
})

test('synthesize retries, then reports the phrase and never the key', async () => {
  let calls = 0
  const failing = async () => {
    calls++
    return { ok: false, status: 429, json: async () => ({}) }
  }
  await assert.rejects(
    synthesize('Fifty-six.', { apiKey: 'secret-key', fetchImpl: failing, pause: noPause }),
    error => {
      assert.match(error.message, /"Fifty-six\.": HTTP 429/)
      assert.doesNotMatch(error.message, /secret-key/)
      return true
    }
  )
  assert.equal(calls, 3)
})

test('synthesize masks the key when an error message carries it', async () => {
  const leaky = async () => {
    throw new Error('bad header Bearer secret-key')
  }
  await assert.rejects(
    synthesize('Fifty-six.', { apiKey: 'secret-key', fetchImpl: leaky, pause: noPause }),
    /bad header Bearer <key>/
  )
})

test('synthesize recovers when a retry succeeds', async () => {
  let calls = 0
  const flaky = async (url, init) => {
    calls++
    if (calls === 1) return { ok: false, status: 500, json: async () => ({}) }
    return fakeFetch()(url, init)
  }
  const parsed = await synthesize('Fifty-six.', { apiKey: 'k', fetchImpl: flaky, pause: noPause })
  assert.equal(calls, 2)
  assert.equal(parsed.chars.length, 10)
})

test('synthesize reports a timeout', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  await assert.rejects(
    synthesize('Fifty-six.', { apiKey: 'k', fetchImpl: hanging, timeoutMs: 5, pause: noPause }),
    /timed out after 5 ms/
  )
})

test('synthesize uses the real pause between attempts by default', async () => {
  let calls = 0
  const failing = async () => {
    calls++
    throw new Error('offline')
  }
  const started = Date.now()
  await assert.rejects(synthesize('Twenty.', { apiKey: 'k', fetchImpl: failing }), /offline/)
  assert.equal(calls, 3)
  assert.ok(Date.now() - started >= 1400, 'waited 500 + 1000 ms')
})

test('clipsOf keeps a single-take job whole and a pair job as its named words', () => {
  const single = jobs()[36]
  const [only] = clipsOf(single, synthesizeLocally(single.text))
  assert.equal(only.name, 'n56-final')
  assert.ok(only.samples.length > 0)
  const pair = jobs().find(job => job.text === 'Fifty-six and fifty-seven exit.')
  const clips = clipsOf(pair, synthesizeLocally(pair.text))
  assert.deepEqual(clips.map(clip => clip.name), ['n56-and', 'n57-exit'])
})

test('clipsOf refuses a response whose words do not match the job', () => {
  const pair = jobs()[80]
  assert.throws(() => clipsOf(pair, synthesizeLocally('Twenty exit.')), /has 2 words, expected 4/)
})

function synthesizeLocally(text) {
  const json = responseFor(text)
  const bytes = Buffer.from(json.audio, 'base64')
  const samples = new Int16Array(bytes.length >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  return {
    samples,
    chars: json.audio_timestamps.graph_chars,
    times: json.audio_timestamps.graph_times.map(([start, end]) => ({ start, end }))
  }
}

test('generate writes every clip from the fake service, and the set checks clean', async () => {
  const dir = tempDir()
  const lines = []
  const written = await generate({ dir, apiKey: 'k', fetchImpl: fakeFetch(), log: line => lines.push(line), pause: noPause })
  assert.equal(written, 242)
  assert.equal(lines.length, 161)
  assert.equal(readdirSync(dir).length, 242)
  assert.deepEqual(checkClips(dir), [])
  const clip = readWav(readFileSync(path.join(dir, 'n56-and.wav')))
  assert.equal(clip.rate, RATE)
})

test('generate fails when the service does', async () => {
  const failing = async () => ({ ok: false, status: 401, json: async () => ({}) })
  await assert.rejects(generate({ dir: tempDir(), apiKey: 'k', fetchImpl: failing, pause: noPause, concurrency: 1 }), /HTTP 401/)
})

test('checkClips passes the committed set', () => {
  assert.deepEqual(checkClips(COMMITTED), [])
})

test('checkClips names every problem', () => {
  const dir = tempDir()
  const tone = Int16Array.from({ length: RATE / 4 }, (_, i) => Math.round(6000 * Math.sin(i / 5)))
  for (const name of clipNames()) writeFileSync(path.join(dir, `${name}.wav`), wavBytes(tone, RATE))
  rmSync(path.join(dir, 'n20-final.wav'))
  writeFileSync(path.join(dir, 'extra.wav'), wavBytes(tone, RATE))
  writeFileSync(path.join(dir, 'n21-final.wav'), wavBytes(tone, 16000))
  const stereo = wavBytes(tone, RATE)
  stereo.writeUInt16LE(2, 22)
  writeFileSync(path.join(dir, 'n22-final.wav'), stereo)
  const eightBit = wavBytes(tone, RATE)
  eightBit.writeUInt16LE(8, 34)
  writeFileSync(path.join(dir, 'n23-final.wav'), eightBit)
  const float = wavBytes(tone, RATE)
  float.writeUInt16LE(3, 20)
  writeFileSync(path.join(dir, 'n24-final.wav'), float)
  writeFileSync(path.join(dir, 'n25-final.wav'), wavBytes(new Int16Array(100), RATE))
  writeFileSync(path.join(dir, 'n26-final.wav'), wavBytes(new Int16Array(RATE / 4), RATE))
  writeFileSync(path.join(dir, 'n27-final.wav'), Buffer.from('garbage'))
  writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
  assert.deepEqual(checkClips(dir), [
    'extra.wav: not a clip the apps use',
    'n20-final.wav: missing',
    'n21-final.wav: 16000 Hz, not 24000',
    'n22-final.wav: 2 channels, not mono',
    'n23-final.wav: 8-bit, not 16',
    'n24-final.wav: codec 3, not PCM',
    'n25-final.wav: shorter than 50 ms',
    'n26-final.wav: silent',
    'n27-final.wav: not a RIFF WAVE file'
  ])
})

test('assemble joins clips end to end, as the apps do', () => {
  const joined = assemble(COMMITTED, ['n56-and', 'word-and', 'n52-exit', 'word-exit'])
  const parts = ['n56-and', 'word-and', 'n52-exit', 'word-exit'].map(
    name => readWav(readFileSync(path.join(COMMITTED, `${name}.wav`))).samples
  )
  assert.equal(joined.length, parts.reduce((sum, part) => sum + part.length, 0))
  assert.deepEqual(Array.from(joined.subarray(0, parts[0].length)), Array.from(parts[0]))
})

test('writeSamples writes the four listening samples', () => {
  const dir = tempDir()
  const files = writeSamples(COMMITTED, dir)
  assert.deepEqual(files.map(file => path.basename(file)), SAMPLES.map(sample => sample.file))
  for (const file of files) assert.ok(readWav(readFileSync(file)).samples.length > RATE / 4)
})
