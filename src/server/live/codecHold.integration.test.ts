import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { STREAM_REFUSAL_PREFIXES } from '../../common/api'
import {
  avcHeaderBody,
  hevcHeaderBody,
  hevcSegment,
  IDR_SLICE,
  parameterSetNals,
  soundHeaderBody
} from './frameWallFixture'
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
  WRITER_INIT_NAME,
  WRITER_PLAYLIST_NAME,
  writerForTest
} from './splitter'
import { firstPublishOnDisk, placedAt } from './splitterFixtures'

// This process's own: another test run on the machine has its own.
const LIVE_TMP = mkdtempSync(join(tmpdir(), 'ts-live-test-'))

const KEY = 'ts_codecholdkeycodecholdkey'
const FOURCC_HEVC = 0x68766331
const FOURCC_AVC = 0x61766331
const FOURCC_VP9 = 0x76703039
const ROOT = join(LIVE_TMP, 'codec-hold')
const DIR = join(ROOT, 'recording')
const FAKE = join(ROOT, 'ffmpeg.sh')
const SPAWNS = join(ROOT, 'spawns.txt')
const START_MS = 1_790_000_000_000

/** SPS units libx264 and libx265 wrote, at the size each names. */
const SPS = {
  avc1080: '67640028acd940780227e5c044000003000400000300f03c60c658',
  avc540: '6764001facd940f0117ef0110000030001000003003c0f183196',
  hevc1440:
    '420101016000000300900000030000030096a001402005a16595952930bc05a020000003002000000303c1'
}
const AVC_PPS = Buffer.from('68ebe3cb22c0', 'hex')

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
  this.timeout(60_000)
  let events: LiveEvent[]
  let logs: string[]

  const refusals = (): LiveEvent[] =>
    events.filter(
      event =>
        event.type === 'publishEnded' &&
        STREAM_REFUSAL_PREFIXES.some(prefix => event.reason.startsWith(prefix))
    )
  /** The tag each publish the controller was told of was started with. */
  const heardTags = (): string[] =>
    events.flatMap(event =>
      event.type === 'publishStarted' ? [event.codecTag] : []
    )
  /** The streams the controller was told have started publishing. */
  const heard = (): string[] =>
    events.flatMap(event =>
      event.type === 'publishStarted' ? [event.liveStreamId] : []
    )
  const live = (videoStartMs?: number): void => {
    setLive(KEY, {
      liveStreamId: 'liv_hold',
      hlsDir: DIR,
      destinations: [],
      videoStartMs
    })
  }
  // As long as a loaded machine's FFmpeg might need; a pass never waits it.
  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done() && waited < 20_000; waited += 10)
      await sleep(10)
    expect(done(), 'timed out').equals(true)
  }
  const send = (made: TestSession, packet: Packet): void => {
    made.broadcast?.broadcastMessage?.(packet)
  }

  /**
   * What a publisher sends first: the sequence header of the configuration
   * `firstPublishOnDisk` recorded, and a keyframe.
   */
  const showSound = (made: TestSession): void => {
    send(made, {
      flags: 0,
      dts: 0,
      codec_id: 10,
      data: soundHeaderBody(Buffer.from([0x11, 0x90]))
    })
  }
  const show = (made: TestSession, codec: 12 | typeof FOURCC_HEVC): void => {
    const header = hevcHeaderBody(
      codec === 12 ? 'classic' : 'enhanced',
      parameterSetNals(1)
    )
    send(made, {
      flags: codec === 12 ? 4 : 2,
      dts: 0,
      codec_id: codec,
      data: header
    })
    send(made, { flags: 3, dts: 0, codec_id: codec })
  }
  /** A sequence header alone, Enhanced RTMP, with `sps` or stand-in sets. */
  const showHeader = (
    made: TestSession,
    family: 'hevc' | 'h264',
    sps?: string,
    codecId?: number
  ): void => {
    const data =
      family === 'hevc'
        ? hevcHeaderBody(
            'enhanced',
            sps == null
              ? parameterSetNals(1)
              : [parameterSetNals(1)[0], Buffer.from(sps, 'hex')]
          )
        : avcHeaderBody('enhanced', [
            Buffer.from(sps ?? SPS.avc1080, 'hex'),
            AVC_PPS
          ])
    send(made, {
      flags: 2,
      dts: 0,
      codec_id: codecId ?? (family === 'hevc' ? FOURCC_HEVC : FOURCC_AVC),
      data
    })
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

  it('leaves every byte of an HEVC recording alone when the publish is H.264', async function () {
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

  it('takes an H.264 publish onto a recording that has nothing yet, and says it started', async function () {
    live(START_MS)
    const made = session('camera', FOURCC_AVC)
    publishArrivedForTest(made)
    showHeader(made, 'h264')
    showSound(made)
    await until(() => spawned().length === 1)
    tickSamplerForTest()
    expect(refusals()).length(0)
    expect(heard()).deep.equals(['liv_hold'])
    const args = spawned()[0]
    expect(args[args.indexOf('-tag:v') + 1]).equals('avc1')
    // And the live row is told the same tag, for the players (U8).
    expect(heardTags()).deep.equals(['avc1'])
  })

  it('still refuses VP9, and writes nothing for it', async function () {
    live(START_MS)
    publishArrivedForTest(session('wrong camera', FOURCC_VP9))
    await sleep(100)
    tickSamplerForTest()
    expect(spawned()).length(0)
    expect(heard()).length(0)
    const refused = refusals()
    expect(refused).length(1)
    expect(refused[0].type === 'publishEnded' && refused[0].reason).equals(
      'TeamStation takes H.264 and HEVC. This stream is vp09, which it cannot store.'
    )
    expect(readdirSync(DIR)).deep.equals([])
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
    show(hevc, FOURCC_HEVC)
    await until(() => spawned().length === 1)
    await until(() => writerForTest(KEY) != null)
    const writer = writerForTest(KEY)
    publishGoneForTest(hevc)
    const before = recording()

    // The wrong camera arrives while the writer flushes. It finishes first,
    // and the sampler's refusal lands after: the start that was owed then
    // must not run.
    publishArrivedForTest(session('wrong camera', FOURCC_VP9))
    writer?.kill('SIGKILL')
    await until(() => writerForTest(KEY) == null)
    await sleep(100)
    tickSamplerForTest()
    expect(refusals()).length(1)
    expect(spawned(), 'nothing started on its exit').length(1)
    expect(recording()).deep.equals(before)

    // The camera itself comes back, and the recording goes on.
    const again = session('camera again', FOURCC_HEVC)
    publishArrivedForTest(again)
    show(again, FOURCC_HEVC)
    showSound(again)
    await until(() => spawned().length === 2)
    // A writer continuing the recording: its own playlist and init segment,
    // numbered after the segment the last writer left.
    const next = spawned()[1]
    const flags = next[next.indexOf('-hls_flags') + 1].split('+')
    expect(flags).not.includes('append_list')
    expect(next[next.indexOf('-start_number') + 1]).equals('4')
    expect(next[next.indexOf('-hls_fmp4_init_filename') + 1]).equals(
      WRITER_INIT_NAME
    )
    expect(next.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
  })

  it('refuses a newcomer that replaced a quiet publisher, its writer still finishing', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const stalled = session('stalled camera', FOURCC_HEVC)
    publishArrivedForTest(stalled)
    show(stalled, FOURCC_HEVC)
    await until(() => spawned().length === 1)
    await until(() => writerForTest(KEY) != null)
    const writer = writerForTest(KEY)
    for (let tick = 0; tick < 3; tick += 1) tickSamplerForTest()
    const before = recording()

    publishArrivedForTest(session('wrong camera', FOURCC_VP9))
    expect(logs.join('\n')).contains('replaces it')
    writer?.kill('SIGKILL')
    await until(() => writerForTest(KEY) == null)
    await sleep(100)
    tickSamplerForTest()
    expect(refusals()).length(1)

    expect(spawned()).length(1)
    expect(recording()).deep.equals(before)
  })

  it('holds a writer past metadata until the first picture has shown its headers', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live(START_MS)
    const made = session('camera')
    publishArrivedForTest(made)
    await sleep(50)
    expect(spawned()).length(0)
    send(made, { flags: 5, dts: 0, metadataCodec: FOURCC_HEVC })
    await sleep(50)
    expect(spawned(), 'metadata is not a sequence header').length(0)
    show(made, FOURCC_HEVC)
    await until(() => spawned().length === 1)
    const args = spawned()[0]
    expect(args[args.indexOf('-hls_fmp4_init_filename') + 1]).equals(
      WRITER_INIT_NAME
    )
    expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
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
      show(made, codec)
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
    show(made, 12)
    for (let dts = 0; dts < 20; dts += 1) {
      send(made, { flags: 3, dts, codec_id: 12 })
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
    show(made, FOURCC_HEVC)
    await until(() => spawned().length === 1)
    send(made, { flags: 4, dts: 0, codec_id: 7 })
    expect(made.videoCodec).equals(FOURCC_HEVC)
  })

  it('protects a video that lost its publish before a segment closed', async function () {
    live(START_MS)
    publishArrivedForTest(session('wrong camera', FOURCC_VP9))
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
      show(made, codec === 12 ? 12 : FOURCC_HEVC)
      // No sampler tick: one that has shown itself has nothing to wait for.
      await until(() => spawned().length === 1)
      expect(spawned()[0].slice(1), String(codec)).deep.equals(baseline)
    }
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
    show(made, 12)
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
    show(made, 12)
    await until(() => spawned().length === 1)
    expect(logs.join('\n')).match(/waited \d{1,3} ms/)
  })

  it('starts a first publish the moment it has shown HEVC and its sound', async function () {
    live()
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    expect(heard(), 'its size is not known yet').deep.equals([])
    showHeader(made, 'hevc')
    expect(heard(), 'accepted on its header').deep.equals(['liv_hold'])
    expect(heardTags()).deep.equals(['hvc1'])
    expect(spawned(), 'sound first').length(0)
    showSound(made)
    await until(() => spawned().length === 1)
    expect(logs.join('\n')).match(/waited \d{1,3} ms/)
  })

  it('writes nothing for a first publish until it shows HEVC', async function () {
    live()
    const made = session('camera')
    publishArrivedForTest(made)
    await sleep(100)
    expect(spawned(), 'no writer yet').length(0)
    expect(heard(), 'no word yet').deep.equals([])

    send(made, { flags: 5, dts: 0, metadataCodec: FOURCC_HEVC })
    expect(heard(), 'metadata does not give its size').deep.equals([])
    showHeader(made, 'hevc')
    expect(heard()).deep.equals(['liv_hold'])
    showSound(made)
    await until(() => spawned().length === 1)
  })

  describe('a refused publish never looks published', function () {
    const onTheAir = (): LiveEvent[] =>
      events.filter(
        event => event.type === 'status' && event.status.ingress.publishing
      )

    it('says nothing of a first VP9 publish and leaves its folder empty', async function () {
      live()
      const made = session('wrong camera', FOURCC_VP9)
      publishArrivedForTest(made)
      made.inBytes = 500_000
      await sleep(100)
      expect(statusFor(KEY)?.ingress.publishing, 'it is connected').equals(true)
      expect(heard(), 'but not published').deep.equals([])
      tickSamplerForTest()
      await sleep(100)

      expect(heard()).deep.equals([])
      expect(onTheAir(), 'no status says it is on the air').deep.equals([])
      expect(refusals()).length(1)
      expect(spawned(), 'no writer').length(0)
      expect(readdirSync(DIR), 'nothing written').deep.equals([])
    })

    it('sends no status while bytes arrive and the codec is unknown', async function () {
      live()
      const made = session('camera')
      publishArrivedForTest(made)
      made.inBytes = 500_000
      tickSamplerForTest()

      expect(statusFor(KEY)?.ingress.bytesPerSecond).is.above(0)
      expect(onTheAir(), 'nothing moves the quiet clock').deep.equals([])

      send(made, { flags: 5, dts: 0, metadataCodec: FOURCC_HEVC })
      expect(onTheAir(), 'its size is not known yet').deep.equals([])
      showHeader(made, 'hevc')
      expect(onTheAir(), 'accepted, it is heard of').length.above(0)
    })

    it('says nothing of a VP9 publish that leaves before the sampler looks', async function () {
      live()
      const made = session('wrong camera', FOURCC_VP9)
      publishArrivedForTest(made)
      await sleep(50)
      publishGoneForTest(made)
      await sleep(50)

      expect(heard()).deep.equals([])
      expect(refusals()).length(0)
      expect(spawned()).length(0)
    })

    it('says nothing of VP9 seen only in its packets', async function () {
      live()
      const made = session('wrong camera')
      publishArrivedForTest(made)
      send(made, { flags: 2, dts: 0, codec_id: FOURCC_VP9 })
      send(made, { flags: 3, dts: 0, codec_id: FOURCC_VP9 })
      tickSamplerForTest()

      expect(heard()).deep.equals([])
      expect(refusals()).length(1)
    })

    it('hears of each retry only when one may be recorded, and of that one once', async function () {
      live()
      for (const round of [1, 2, 3]) {
        publishArrivedForTest(session(`retry ${round}`, FOURCC_VP9))
        await sleep(20)
        tickSamplerForTest()
      }
      expect(heard()).deep.equals([])
      expect(refusals()).length(3)

      const good = session('camera')
      publishArrivedForTest(good)
      showHeader(good, 'hevc')
      send(good, { flags: 3, dts: 1, codec_id: FOURCC_HEVC })
      tickSamplerForTest()
      tickSamplerForTest()
      expect(heard()).deep.equals(['liv_hold'])
    })

    it('hears of a real publish once, and not of a refused one after it', async function () {
      live()
      const good = session('camera', FOURCC_HEVC)
      publishArrivedForTest(good)
      showHeader(good, 'hevc')
      showSound(good)
      await until(() => spawned().length === 1)
      await until(() => writerForTest(KEY) != null)
      const writer = writerForTest(KEY)
      publishGoneForTest(good)
      writer?.kill('SIGKILL')
      await until(() => writerForTest(KEY) == null)

      publishArrivedForTest(session('wrong camera', FOURCC_VP9))
      await sleep(50)
      tickSamplerForTest()

      expect(heard()).deep.equals(['liv_hold'])
      expect(refusals()).length(1)
    })

    it('takes a codec the sampler finds with no packet to carry it', async function () {
      live()
      const made = session('camera')
      publishArrivedForTest(made)
      // A header node-media-server could not name the codec of.
      showHeader(made, 'hevc', undefined, 0)
      expect(heard()).deep.equals([])
      made.videoCodec = FOURCC_HEVC
      tickSamplerForTest()
      expect(heard()).deep.equals(['liv_hold'])
    })

    it('waits for the sequence header, however long, before it takes a publish', async function () {
      live()
      const made = session('camera', FOURCC_HEVC)
      publishArrivedForTest(made)
      showSound(made)
      for (let tick = 0; tick < 3; tick += 1) tickSamplerForTest()
      await sleep(100)
      expect(heard()).deep.equals([])
      expect(spawned()).length(0)
      expect(refusals()).length(0)
    })
  })

  describe('a picture outside 720p to 1080p', function () {
    for (const [name, family, codec, sps, size] of [
      ['HEVC', 'hevc', FOURCC_HEVC, SPS.hevc1440, '2560 × 1440'],
      ['H.264', 'h264', 7, SPS.avc540, '960 × 540']
    ] as const) {
      it(`refuses ${size} ${name} on its sequence header, before anything is written`, async function () {
        live()
        const made = session('camera')
        publishArrivedForTest(made)
        // Its metadata names the codec ahead of the header, as FFmpeg's does.
        send(made, { flags: 5, dts: 0, metadataCodec: codec })
        showSound(made)
        expect(refusals(), 'the codec alone is fine').length(0)
        showHeader(made, family, sps, family === 'hevc' ? codec : 0)

        // No sampler tick: the header decides it.
        const refused = refusals()
        expect(refused).length(1)
        expect(refused[0].type === 'publishEnded' && refused[0].reason).equals(
          `TeamStation takes 720p to 1080p. This stream is ${size} — change the resolution and start it again.`
        )
        expect(statusFor(KEY)?.ingress.publishing).equals(false)
        expect(heard(), 'never on the air').deep.equals([])
        await sleep(100)
        tickSamplerForTest()
        expect(refusals(), 'refused once').length(1)
        expect(spawned(), 'no writer').length(0)
        expect(readdirSync(DIR), 'nothing written').deep.equals([])
      })
    }

    it('takes 1080p onto a recording after a refused 540p try', async function () {
      live()
      const small = session('camera', FOURCC_AVC)
      publishArrivedForTest(small)
      showHeader(small, 'h264', SPS.avc540)
      expect(refusals()).length(1)

      const good = session('camera again', FOURCC_AVC)
      publishArrivedForTest(good)
      showHeader(good, 'h264', SPS.avc1080)
      showSound(good)
      await until(() => spawned().length === 1)
      expect(heard()).deep.equals(['liv_hold'])
      expect(refusals()).length(1)
    })
  })
})
