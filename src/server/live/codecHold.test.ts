import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { hevcSegment, IDR_SLICE } from './frameWallFixture'
import {
  configureIngest,
  forcePublishForTest,
  type LiveEvent,
  publishArrivedForTest,
  publishGoneForTest,
  resetForTest,
  setLive,
  statusFor,
  type TestSession,
  tickSamplerForTest,
  writerForTest
} from './splitter'
import { firstPublishOnDisk, placedAt } from './splitterFixtures'

const KEY = 'ts_codecholdkeycodecholdkey'
const FOURCC_HEVC = 0x68766331
const ROOT = join(tmpdir(), 'ts-live-test-codec-hold')
const DIR = join(ROOT, 'recording')
const FAKE = join(ROOT, 'ffmpeg.sh')
const SPAWNS = join(ROOT, 'spawns.txt')
const START_MS = 1_790_000_000_000

interface Packet {
  flags: number
  dts: number
  codec_id?: number
  data?: Buffer
  metadataCodec?: number
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Stands in for FFmpeg, as hard on a recording as FFmpeg is when it starts. */
function fakeWriter(clobbers = true): void {
  writeFileSync(
    FAKE,
    [
      '#!/bin/sh',
      `echo "$$ $*" >> ${SPAWNS}`,
      ...(clobbers
        ? [
            `printf 'a writer was here' > ${join(DIR, 'init.mp4')}`,
            `printf 'a part-made segment' > ${join(DIR, 'seg000003.m4s')}`,
            `printf '#EXTINF:1.000000,\\nseg000003.m4s\\n' >> ${join(DIR, 'master.m3u8')}`
          ]
        : []),
      'exec sleep 30',
      ''
    ].join('\n')
  )
  chmodSync(FAKE, 0o755)
}

function spawned(): string[][] {
  try {
    return readFileSync(SPAWNS, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => line.split(' '))
  } catch {
    return []
  }
}

/** Everything in the recording's folder, byte for byte. */
function recording(): Record<string, string> {
  const held: Record<string, string> = {}
  for (const name of readdirSync(DIR)) {
    held[name] = readFileSync(join(DIR, name)).toString('base64')
  }
  return held
}

/** node-media-server's `BroadcastServer`, down to its metadata. */
function broadcast(
  publisher: () => TestSession
): NonNullable<TestSession['broadcast']> {
  return {
    subscribers: new Map(),
    broadcastMessage: (packet: Packet) => {
      if (packet.flags === 5) publisher().videoCodec = packet.metadataCodec
    }
  }
}

function session(id: string, videoCodec?: number): TestSession {
  const made: TestSession = {
    id,
    streamApp: 'live',
    streamName: KEY,
    streamPath: `/live/${KEY}`,
    videoCodec,
    close: () => undefined,
    socket: { destroy: () => undefined }
  }
  made.broadcast = broadcast(() => made)
  return made
}

function appendEndlist(): void {
  const path = join(DIR, 'master.m3u8')
  writeFileSync(path, `${readFileSync(path, 'utf8')}#EXT-X-ENDLIST\n`)
}

describe('a publish on a key that already holds a recording', function () {
  this.timeout(10_000)
  let events: LiveEvent[]
  let logs: string[]

  const refusals = (): LiveEvent[] =>
    events.filter(
      event => event.type === 'publishEnded' && event.refusedSince != null
    )
  const live = (videoStartMs?: number): void => {
    setLive(KEY, {
      liveStreamId: 'liv_hold',
      hlsDir: DIR,
      destinations: [],
      videoStartMs
    })
  }
  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done() && waited < 5000; waited += 10) await sleep(10)
    expect(done(), 'timed out').equals(true)
  }
  const send = (made: TestSession, packet: Packet): void => {
    made.broadcast?.broadcastMessage?.(packet)
  }

  /** Forgets the key and its writers, and puts the recording back. */
  const anew = (): void => {
    resetForTest()
    rmSync(SPAWNS, { force: true })
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    configureIngest({
      ffmpegPath: FAKE,
      bindHost: '127.0.0.1',
      port: 19_371,
      app: 'live',
      segmentSeconds: 4,
      log: message => logs.push(message),
      onEvent: event => events.push(event)
    })
  }

  beforeEach(function () {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    fakeWriter()
    events = []
    logs = []
    anew()
  })

  afterEach(function () {
    resetForTest()
    for (const [pid] of spawned()) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('leaves every byte of it alone when the publish is H.264', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    live(START_MS)
    publishArrivedForTest(session('wrong camera', 7))
    await sleep(100)
    tickSamplerForTest()
    await sleep(100)

    expect(spawned(), 'no writer').length(0)
    expect(recording()).deep.equals(before)
    expect(refusals()).length(1)
    expect(statusFor(KEY)?.ingress.publishing).equals(false)
  })

  it('leaves a closed playlist closed when the publish is refused', async function () {
    firstPublishOnDisk(DIR, START_MS)
    appendEndlist()
    const before = recording()
    live(START_MS)
    publishArrivedForTest(session('wrong camera', 7))
    await sleep(100)
    tickSamplerForTest()

    expect(spawned()).length(0)
    expect(recording()).deep.equals(before)
  })

  it('writes nothing until the codec is known, then refuses H.264', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    live(START_MS)
    const made = session('wrong camera')
    publishArrivedForTest(made)
    await sleep(100)
    tickSamplerForTest()
    expect(spawned(), 'still unknown').length(0)
    expect(refusals(), 'still unknown').length(0)

    made.videoCodec = 7
    tickSamplerForTest()
    expect(refusals()).length(1)
    expect(recording()).deep.equals(before)
  })

  it('refuses H.264 from a publisher that sends no metadata', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    live(START_MS)
    const made = session('wrong camera')
    publishArrivedForTest(made)
    send(made, { flags: 1, dts: 0, codec_id: 10 })
    send(made, { flags: 2, dts: 0, codec_id: 7 })
    await sleep(100)
    tickSamplerForTest()

    expect(spawned()).length(0)
    expect(refusals()).length(1)
    expect(recording()).deep.equals(before)
  })

  it('refuses during a continuation, with the last writer still finishing', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const hevc = session('camera', FOURCC_HEVC)
    publishArrivedForTest(hevc)
    await until(() => spawned().length === 1)
    await until(() => writerForTest(KEY) != null)
    const writer = writerForTest(KEY)
    publishGoneForTest(hevc)
    const before = recording()

    // The wrong camera arrives while the writer flushes. It finishes first,
    // and the sampler's refusal lands after: the start that was owed then
    // must not run.
    publishArrivedForTest(session('wrong camera', 7))
    writer?.kill('SIGKILL')
    await until(() => writerForTest(KEY) == null)
    await sleep(100)
    tickSamplerForTest()
    expect(refusals()).length(1)
    expect(spawned(), 'nothing started on its exit').length(1)
    expect(recording()).deep.equals(before)

    // The camera itself comes back, and the recording goes on.
    publishArrivedForTest(session('camera again', FOURCC_HEVC))
    await until(() => spawned().length === 2)
    const next = spawned()[1]
    const flags = next[next.indexOf('-hls_flags') + 1].split('+')
    expect(flags).includes('append_list')
    expect(next[next.indexOf('-start_number') + 1]).equals('0')
  })

  it('refuses a newcomer that replaced a quiet publisher, its writer still finishing', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    publishArrivedForTest(session('stalled camera', FOURCC_HEVC))
    await until(() => spawned().length === 1)
    await until(() => writerForTest(KEY) != null)
    const writer = writerForTest(KEY)
    for (let tick = 0; tick < 3; tick += 1) tickSamplerForTest()
    const before = recording()

    publishArrivedForTest(session('wrong camera', 7))
    expect(logs.join('\n')).contains('replaces it')
    writer?.kill('SIGKILL')
    await until(() => writerForTest(KEY) == null)
    await sleep(100)
    tickSamplerForTest()
    expect(refusals()).length(1)

    expect(spawned()).length(1)
    expect(recording()).deep.equals(before)
  })

  it('starts the writer as soon as metadata shows HEVC', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera')
    publishArrivedForTest(made)
    await sleep(50)
    expect(spawned()).length(0)
    send(made, { flags: 5, dts: 0, metadataCodec: FOURCC_HEVC })
    await until(() => spawned().length === 1)
    expect(spawned()[0].join(' ')).contains('append_list')
  })

  for (const [name, codec] of [
    ['classic', 12],
    ['enhanced', FOURCC_HEVC]
  ] as const) {
    it(`starts the writer on the first ${name} HEVC packet with no metadata`, async function () {
      firstPublishOnDisk(DIR, START_MS)
      live(START_MS)
      const made = session('camera')
      publishArrivedForTest(made)
      await sleep(50)
      send(made, { flags: 0, dts: 0, codec_id: 10 })
      await sleep(50)
      expect(spawned(), 'audio says nothing about the picture').length(0)
      send(made, { flags: 4, dts: 0, codec_id: codec })
      await until(() => spawned().length === 1)
      tickSamplerForTest()
      expect(refusals()).length(0)
    })
  }

  it('starts one writer however many packets follow the one that showed HEVC', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera')
    publishArrivedForTest(made)
    await sleep(50)
    for (let dts = 0; dts < 20; dts += 1) {
      send(made, { flags: 4, dts, codec_id: 12 })
    }
    await until(() => writerForTest(KEY) != null)
    await sleep(100)
    expect(spawned()).length(1)
  })

  it('starts nothing for a publisher that left before it showed a codec', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera')
    publishArrivedForTest(made)
    await sleep(50)
    publishGoneForTest(made)
    send(made, { flags: 4, dts: 0, codec_id: 12 })
    await sleep(100)
    expect(spawned()).length(0)
  })

  it('never reads a later video packet over what metadata said', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    await until(() => spawned().length === 1)
    send(made, { flags: 4, dts: 0, codec_id: 7 })
    expect(made.videoCodec).equals(FOURCC_HEVC)
  })

  it('protects a video that lost its publish before a segment closed', async function () {
    live(START_MS)
    publishArrivedForTest(session('wrong camera', 7))
    await sleep(100)
    tickSamplerForTest()
    expect(spawned()).length(0)
    expect(readdirSync(DIR)).deep.equals([])
  })

  it('carries a normal HEVC continuation on exactly as one with nothing to wait for', async function () {
    // The arguments of a writer that never met the check, as a baseline.
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    forcePublishForTest(KEY, true)
    await until(() => spawned().length === 1)
    const baseline = spawned()[0].slice(1)

    for (const codec of [12, FOURCC_HEVC, 'hvc1', 'hev1']) {
      anew()
      firstPublishOnDisk(DIR, START_MS)
      live(START_MS)
      const made = session('camera')
      Object.assign(made, { videoCodec: codec })
      publishArrivedForTest(made)
      // No sampler tick: one that has said so has nothing to wait for.
      await until(() => spawned().length === 1)
      expect(spawned()[0].slice(1), String(codec)).deep.equals(baseline)
    }
    expect(logs.join('\n')).not.contains('for the publish')
  })

  it('lets a late reader of classic HEVC have its header and keyframes', function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera', 12)
    const seen: number[] = []
    const passOn = made.broadcast?.broadcastMessage
    made.broadcast!.broadcastMessage = packet => {
      seen.push(packet.flags)
      passOn?.(packet)
    }
    publishArrivedForTest(made)
    const hevc = (first: number, second: number): Packet => ({
      flags: 4,
      dts: 0,
      codec_id: 12,
      data: Buffer.from([first, second, 0, 0, 0])
    })
    // The header, a keyframe and a picture between keyframes.
    send(made, hevc(0x1c, 0))
    send(made, hevc(0x1c, 1))
    send(made, hevc(0x2c, 1))
    expect(seen).deep.equals([2, 3, 4])

    // H.264 and Enhanced RTMP are node-media-server's own to read.
    seen.length = 0
    send(made, { flags: 4, dts: 0, codec_id: 7, data: Buffer.from([0x17, 0]) })
    send(made, {
      flags: 4,
      dts: 0,
      codec_id: FOURCC_HEVC,
      data: Buffer.from([0x9c, 0])
    })
    send(made, { flags: 4, dts: 0, codec_id: 12 })
    expect(seen).deep.equals([4, 4, 4])
  })

  it('places a writer that waited where it would have gone without waiting', async function () {
    fakeWriter(false)
    // Five minutes in, with a publisher that sends no frame wall clocks.
    const videoStartMs = Date.now() - 300_000
    const { init } = firstPublishOnDisk(DIR, videoStartMs)
    live(videoStartMs)
    const made = session('camera')
    const publishedAt = Date.now()
    publishArrivedForTest(made)
    await sleep(1500)
    send(made, { flags: 3, dts: 0, codec_id: 12 })
    await until(() => spawned().length === 1)
    expect(logs.join('\n')).match(/waited 1[4-9]\d\d ms/)

    writeFileSync(join(DIR, 'seg000003.m4s'), hevcSegment(0, [IDR_SLICE]))
    const firstPdtMs = videoStartMs + 1400
    const expected = (publishedAt - firstPdtMs) / 1000
    const at = await placedAt(DIR, init, 'seg000003.m4s', 1, () => {
      tickSamplerForTest()
    })
    expect(at, 'on the clock of the publish').closeTo(expected, 0.5)
  })

  it('counts a wait from the publish waiting, not from an earlier one', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const left = session('camera')
    publishArrivedForTest(left)
    await sleep(1100)
    publishGoneForTest(left)
    await sleep(300)

    const made = session('camera again')
    publishArrivedForTest(made)
    send(made, { flags: 3, dts: 0, codec_id: 12 })
    await until(() => spawned().length === 1)
    expect(logs.join('\n')).match(/waited \d{1,3} ms/)
  })

  it('leaves a first publish to start at once, before its codec is known', async function () {
    live()
    publishArrivedForTest(session('camera'))
    await until(() => spawned().length === 1)
    expect(spawned()[0].join(' ')).not.contains('append_list')
    expect(logs.join('\n')).not.contains('for the publish')
  })
})
