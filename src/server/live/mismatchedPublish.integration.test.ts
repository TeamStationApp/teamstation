import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  configuredInit,
  hevcHeaderBody,
  hevcSegment,
  IDR_SLICE,
  parameterSetNals,
  soundHeaderBody
} from './frameWallFixture'
import { listedSegments, timelineStartSec } from './segmentClock'
import {
  absorbWriterPlaylist,
  CONFIGURATION_WAIT_MS,
  configureIngest,
  forcePublishForTest,
  type LiveEvent,
  promoteWriterInit,
  publishArrivedForTest,
  publishGoneForTest,
  resetForTest,
  setLive,
  SOUND_WAIT_MS,
  type TestSession,
  tickSamplerForTest,
  WRITER_INIT_NAME,
  WRITER_PLAYLIST_NAME,
  writerForTest
} from './splitter'
import { firstPublishOnDisk } from './splitterFixtures'

// This process's own: another test run on the machine has its own.
const LIVE_TMP = mkdtempSync(join(tmpdir(), 'ts-live-test-'))

const KEY = 'ts_mismatchkeymismatchkeymismatch'
const FOURCC_HEVC = 0x68766331
const ROOT = join(LIVE_TMP, 'mismatch')
const DIR = join(ROOT, 'recording')
const FAKE = join(ROOT, 'ffmpeg.sh')
const SPAWNS = join(ROOT, 'spawns.txt')
const START_MS = 1_790_000_000_000
const SOUND = Buffer.from([0x11, 0x90])

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Stands in for FFmpeg by starting and staying. The test writes its files. */
function fakeWriter(): void {
  writeFileSync(
    FAKE,
    ['#!/bin/sh', `echo "$$ $*" >> ${SPAWNS}`, 'exec sleep 30', ''].join('\n')
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

const optionOf = (args: string[], name: string): string =>
  args[args.indexOf(name) + 1]

/**
 * The arguments of a writer continuing the recording with its init segment:
 * that init segment and a playlist of its own, numbered from `next`.
 */
function expectContinuing(args: string[], next?: number): void {
  expect(optionOf(args, '-hls_fmp4_init_filename')).equals(WRITER_INIT_NAME)
  expect(optionOf(args, '-hls_flags')).not.contains('append_list')
  expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
  if (next != null) expect(optionOf(args, '-start_number')).equals(String(next))
}

/** The recording's own files, byte for byte, without a writer's notes. */
function recording(): Record<string, string> {
  const held: Record<string, string> = {}
  for (const name of readdirSync(DIR)) {
    if (name.startsWith('.')) continue
    held[name] = readFileSync(join(DIR, name)).toString('base64')
  }
  return held
}

const master = (): string => readFileSync(join(DIR, 'master.m3u8'), 'utf8')

/** A data message, as a publisher sends it, for the stand-in below to read. */
interface DataMessage {
  flags: number
  dts: number
  /** Absent as a publisher leaves it out. */
  audiocodecid?: number | string
  /** Not metadata: `onFI`, or a name node-media-server does not read. */
  notMetadata?: boolean
}

/** What node-media-server does with metadata: every field, present or not. */
function broadcastFor(
  publisher: () => TestSession,
  metadataCodec = FOURCC_HEVC
): NonNullable<TestSession['broadcast']> {
  return {
    subscribers: new Map(),
    broadcastMessage: (packet: DataMessage) => {
      if (packet.flags !== 5 || packet.notMetadata === true) return
      publisher().videoCodec = metadataCodec
      publisher().audioCodec = packet.audiocodecid
    },
    get publisher() {
      return publisher()
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
    // As node-media-server starts every session.
    audioCodec: 0,
    close: () => undefined,
    socket: { destroy: () => undefined }
  }
  made.broadcast = broadcastFor(() => made)
  return made
}

const metadata = (
  made: TestSession,
  fields: Partial<DataMessage> = {}
): void => {
  made.broadcast?.broadcastMessage?.({ flags: 5, dts: 0, ...fields })
}

/** What FFmpeg leaves on the disk as a writer closes a segment of its own. */
function writerClosed(init: Buffer, initName: string, numbers: number[]): void {
  writeFileSync(join(DIR, initName), init)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-MEDIA-SEQUENCE:${String(numbers[0])}`,
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${initName}"`
  ]
  for (const number of numbers) {
    const name = `seg${String(number).padStart(6, '0')}.m4s`
    if (!existsSync(join(DIR, name))) {
      writeFileSync(join(DIR, name), hevcSegment(0, [IDR_SLICE]))
    }
    lines.push(
      '#EXTINF:4.000000,',
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(START_MS + number * 4000).toISOString()}`,
      name
    )
  }
  writeFileSync(join(DIR, WRITER_PLAYLIST_NAME), `${lines.join('\n')}\n`)
  // A closed segment is listed by the directory watch or by a progress line.
  // The tick lists it when that watch delivers nothing.
  tickSamplerForTest()
}

describe('a publish configured differently from the recording', function () {
  this.timeout(60_000)
  let events: LiveEvent[]
  let logs: string[]

  const live = (): void => {
    setLive(KEY, {
      liveStreamId: 'liv_mismatch',
      hlsDir: DIR,
      destinations: [],
      videoStartMs: START_MS
    })
  }
  // As long as a loaded machine's FFmpeg might need; a pass never waits it.
  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done() && waited < 20_000; waited += 10)
      await sleep(10)
    expect(done(), 'timed out').equals(true)
  }

  /** A publisher's opening: its sequence header, then its first keyframe. */
  const show = (
    made: TestSession,
    camera: number,
    kind: 'classic' | 'enhanced' = 'enhanced'
  ): void => {
    const codec = kind === 'classic' ? 12 : FOURCC_HEVC
    made.broadcast?.broadcastMessage?.({
      // node-media-server reads classic HEVC as any other picture.
      flags: kind === 'classic' ? 4 : 2,
      dts: 0,
      codec_id: codec,
      data: hevcHeaderBody(kind, parameterSetNals(camera))
    })
    made.broadcast?.broadcastMessage?.({ flags: 3, dts: 0, codec_id: codec })
  }

  /** Puts a recording on the disk and a publish of `camera` on the key. */
  const publish = async (
    camera: number,
    kind: 'classic' | 'enhanced' = 'enhanced'
  ): Promise<TestSession> => {
    const made = session(`camera ${String(camera)}`, FOURCC_HEVC)
    const before = spawned().length
    publishArrivedForTest(made)
    show(made, camera, kind)
    await until(() => spawned().length === before + 1)
    await until(() => writerForTest(KEY) != null)
    return made
  }

  /** The publisher leaves and its writer's FFmpeg goes with it. */
  const leave = async (made: TestSession): Promise<void> => {
    const writer = writerForTest(KEY)
    publishGoneForTest(made)
    writer?.kill('SIGKILL')
    await until(() => writerForTest(KEY) == null)
  }

  beforeEach(function () {
    resetForTest()
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    fakeWriter()
    events = []
    logs = []
    configureIngest({
      ffmpegPath: FAKE,
      bindHost: '127.0.0.1',
      port: 19_372,
      app: 'live',
      segmentSeconds: 4,
      log: message => logs.push(message),
      onEvent: event => events.push(event)
    })
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

  for (const kind of ['classic', 'enhanced'] as const) {
    it(`leaves every byte of the recording alone for ${kind} HEVC`, async function () {
      firstPublishOnDisk(DIR, START_MS)
      const before = recording()
      live()
      await publish(2, kind)

      const [, ...args] = spawned()[0]
      expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000003.mp4')
      expect(optionOf(args, '-start_number')).equals('3')
      expect(optionOf(args, '-hls_flags')).not.contains('append_list')
      expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
      expect(recording()).deep.equals(before)
      expect(logs.join('\n')).contains('carries on under init000003.mp4')
    })

    it(`keeps a same-configured ${kind} publish on the recording's own init segment`, async function () {
      firstPublishOnDisk(DIR, START_MS)
      live()
      await publish(1, kind)

      const [, ...args] = spawned()[0]
      expectContinuing(args, 3)
    })
  }

  it("reads a header from the server's chunk buffer, as long as it is and no longer", async function () {
    firstPublishOnDisk(DIR, START_MS)
    writeFileSync(
      join(DIR, 'init.mp4'),
      configuredInit(parameterSetNals(1), SOUND)
    )
    live()
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    // As node-media-server hands them over: the message first, then whatever
    // longer message that buffer held before it.
    const body = hevcHeaderBody('enhanced', parameterSetNals(1))
    const chunk = Buffer.concat([body, Buffer.alloc(900, 0xee)])
    const soundBody = soundHeaderBody(SOUND)
    const soundChunk = Buffer.concat([soundBody, Buffer.alloc(900, 0xee)])
    made.broadcast?.broadcastMessage?.({
      flags: 2,
      dts: 0,
      codec_id: FOURCC_HEVC,
      data: chunk,
      size: body.length
    })
    made.broadcast?.broadcastMessage?.({
      flags: 0,
      dts: 0,
      codec_id: 10,
      data: soundChunk,
      size: soundBody.length
    })
    // The next message is read over both.
    chunk.fill(0xdd)
    soundChunk.fill(0xdd)
    made.broadcast?.broadcastMessage?.({
      flags: 3,
      dts: 0,
      codec_id: FOURCC_HEVC,
      data: chunk,
      size: 40
    })
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      WRITER_INIT_NAME
    )
  })

  it('hears a classic header sent before its key has been looked up', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    let answer: () => void = () => undefined
    const looked = new Promise<void>(resolve => {
      answer = resolve
    })
    configureIngest({
      ffmpegPath: FAKE,
      bindHost: '127.0.0.1',
      port: 19_372,
      app: 'live',
      segmentSeconds: 4,
      log: message => logs.push(message),
      onEvent: event => events.push(event),
      resolve: async () => {
        await looked
        return {
          liveStreamId: 'liv_mismatch',
          hlsDir: DIR,
          destinations: [],
          videoStartMs: START_MS
        }
      }
    })
    const made = session('camera', 12)
    publishArrivedForTest(made)
    show(made, 1, 'classic')
    await sleep(30)
    expect(spawned()).length(0)

    answer()
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      WRITER_INIT_NAME
    )
  })

  it('reads a classic header as a header, for the reader that joins late', function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    const made = session('camera', 12)
    const flags: number[] = []
    const broadcast = made.broadcast!
    const passOn = broadcast.broadcastMessage
    broadcast.broadcastMessage = packet => {
      flags.push(packet.flags)
      passOn?.(packet)
    }
    publishArrivedForTest(made)
    show(made, 1, 'classic')
    expect(flags[0]).equals(2)
  })

  it('goes on under its own name when no header ever comes', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    live()
    publishArrivedForTest(session('camera', FOURCC_HEVC))
    await sleep(100)
    tickSamplerForTest()
    expect(spawned(), 'still waiting').length(0)

    await sleep(CONFIGURATION_WAIT_MS)
    tickSamplerForTest()
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      'init000003.mp4'
    )
    expect(recording()).deep.equals(before)
  })

  it('waits for a codec without limit, and only then for headers', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    live()
    const made = session('quiet camera')
    publishArrivedForTest(made)
    await sleep(CONFIGURATION_WAIT_MS + 100)
    tickSamplerForTest()
    await sleep(50)
    expect(spawned(), 'no codec, no writer').length(0)
    expect(events.map(event => event.type)).not.contains('publishStarted')
    expect(recording()).deep.equals(before)

    // Naming its codec this late, it still gets to show its headers.
    made.videoCodec = FOURCC_HEVC
    tickSamplerForTest()
    await sleep(50)
    expect(spawned(), 'the limit starts now').length(0)
    expect(events.map(event => event.type)).contains('publishStarted')
    show(made, 1)
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      WRITER_INIT_NAME
    )
  })

  for (const [name, camera, init] of [
    ['matching', 1, WRITER_INIT_NAME],
    ['different', 2, 'init000003.mp4']
  ] as const) {
    it(`takes a ${name} publish after a refusal as if the refusal never happened`, async function () {
      firstPublishOnDisk(DIR, START_MS)
      const before = recording()
      live()
      const refused = session('wrong camera', 7)
      publishArrivedForTest(refused)
      tickSamplerForTest()
      expect(events.map(event => event.type)).not.contains('publishStarted')
      expect(spawned()).length(0)
      expect(recording()).deep.equals(before)

      await publish(camera)
      expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(init)
      expect(events.filter(event => event.type === 'publishStarted')).length(1)
    })
  }

  it('takes a different sound configuration for a different configuration', async function () {
    firstPublishOnDisk(DIR, START_MS)
    writeFileSync(
      join(DIR, 'init.mp4'),
      configuredInit(parameterSetNals(1), SOUND)
    )
    live()
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    made.broadcast?.broadcastMessage?.({
      flags: 0,
      dts: 0,
      codec_id: 10,
      data: soundHeaderBody(Buffer.from([0x12, 0x10]))
    })
    show(made, 1)
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      'init000003.mp4'
    )
  })

  it('takes metadata naming no sound as a recording losing its sound', async function () {
    firstPublishOnDisk(DIR, START_MS)
    writeFileSync(
      join(DIR, 'init.mp4'),
      configuredInit(parameterSetNals(1), SOUND)
    )
    live()
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    metadata(made, { audiocodecid: 0 })
    show(made, 1)
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      'init000003.mp4'
    )
  })

  describe('with no sound, on a recording with sound', function () {
    /** Everything between the input and `-tag:v`, which only a writer adds to. */
    const encoding = (args: string[]): string[] =>
      args.slice(args.indexOf('-i') + 2, args.indexOf('-tag:v'))
    const COPY = ['-c', 'copy']
    const PICTURE_ONLY = ['-c', 'copy', '-an']
    const silence = (rate: number, layout: string): string[] => [
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${String(rate)}:cl=${layout}`,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-bsf:a',
      'setts=ts=TS-STARTPTS',
      '-shortest'
    ]

    /** A publish whose metadata names no sound, as its header goes out. */
    const soundless = (
      camera: number,
      kind: 'classic' | 'enhanced' = 'enhanced'
    ): TestSession => {
      const made = session('soundless camera', kind === 'classic' ? 12 : 0)
      // node-media-server's reading of metadata, for a classic publish.
      if (kind === 'classic') made.broadcast = broadcastFor(() => made, 12)
      publishArrivedForTest(made)
      metadata(made, { audiocodecid: 0 })
      show(made, camera, kind)
      return made
    }

    /** A publish that says nothing of itself: no metadata, then its picture. */
    const quiet = (
      camera: number,
      kind: 'classic' | 'enhanced' = 'enhanced'
    ): TestSession => {
      const made = session('quiet camera')
      publishArrivedForTest(made)
      show(made, camera, kind)
      return made
    }

    const soundHeader = (made: TestSession, sound: Buffer): void => {
      made.broadcast?.broadcastMessage?.({
        flags: 0,
        dts: 0,
        codec_id: 10,
        data: soundHeaderBody(sound)
      })
    }

    /** A publish with sound, its sound header ahead of its picture. */
    const soundful = (camera: number): TestSession => {
      const made = session('camera', FOURCC_HEVC)
      publishArrivedForTest(made)
      soundHeader(made, SOUND)
      show(made, camera)
      return made
    }

    const recordingWith = (sound: Buffer | undefined): void => {
      firstPublishOnDisk(DIR, START_MS)
      writeFileSync(
        join(DIR, 'init.mp4'),
        configuredInit(parameterSetNals(1), sound)
      )
    }

    for (const kind of ['classic', 'enhanced'] as const) {
      it(`adds silence to a ${kind} publish, and copies its picture`, async function () {
        recordingWith(SOUND)
        const before = recording()
        live()
        soundless(1, kind)
        await until(() => spawned().length === 1)

        const [, ...args] = spawned()[0]
        expect(encoding(args)).deep.equals(silence(48000, 'stereo'))
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
          'init000003.mp4'
        )
        expect(recording()).deep.equals(before)
        expect(logs.join('\n')).contains('with a silent sound track')
      })
    }

    it("matches the recording's sample rate and channels", async function () {
      recordingWith(Buffer.from([0x12, 0x08]))
      live()
      soundless(2)
      await until(() => spawned().length === 1)
      expect(encoding(spawned()[0].slice(1))).deep.equals(
        silence(44100, 'mono')
      )
    })

    it('reads the last init segment, so silence follows silence', async function () {
      recordingWith(SOUND)
      live()
      const made = soundless(1)
      await until(() => spawned().length === 1)
      await until(() => writerForTest(KEY) != null)
      writerClosed(
        configuredInit(parameterSetNals(1), Buffer.from([0x12, 0x08])),
        'init000003.mp4',
        [3]
      )
      await until(() => master().includes('seg000003.m4s'))
      await leave(made)

      soundless(1)
      await until(() => spawned().length === 2)
      expect(encoding(spawned()[1].slice(1))).deep.equals(
        silence(44100, 'mono')
      )
    })

    it('adds nothing to a publish with sound, on a part of its own or not', async function () {
      recordingWith(SOUND)
      live()
      const made = session('camera', FOURCC_HEVC)
      publishArrivedForTest(made)
      made.broadcast?.broadcastMessage?.({
        flags: 0,
        dts: 0,
        codec_id: 10,
        data: soundHeaderBody(SOUND)
      })
      show(made, 2)
      await until(() => spawned().length === 1)
      expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
      expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
        'init000003.mp4'
      )
    })

    it('adds nothing to a recording that has never had sound', async function () {
      recordingWith(undefined)
      live()
      soundless(2)
      await until(() => spawned().length === 1)
      expect(encoding(spawned()[0].slice(1))).deep.equals(PICTURE_ONLY)
    })

    it('gives a publish with sound on a recording with none a part of its own, as the recording is', async function () {
      recordingWith(undefined)
      const before = recording()
      live()
      soundful(1)
      await until(() => spawned().length === 1)
      const [, ...args] = spawned()[0]
      expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000003.mp4')
      expect(encoding(args)).deep.equals(PICTURE_ONLY)
      expect(optionOf(args, '-hls_flags')).not.contains('append_list')
      const after = recording()
      for (const name of Object.keys(before)) {
        expect(after[name], name).equals(before[name])
      }
    })

    it('leaves out sound that shows late on a recording with none', async function () {
      recordingWith(undefined)
      const before = recording()
      live()
      const made = quiet(1)
      await until(() => spawned().length === 1)
      soundHeader(made, SOUND)
      const [, ...args] = spawned()[0]
      expect(optionOf(args, '-hls_fmp4_init_filename')).equals(WRITER_INIT_NAME)
      expect(encoding(args)).deep.equals(PICTURE_ONLY)
      expect(recording()['master.m3u8']).equals(before['master.m3u8'])
    })

    it('keeps sound out of every part after, whatever the next publish shows', async function () {
      recordingWith(undefined)
      live()
      const first = soundful(1)
      await until(() => spawned().length === 1)
      await until(() => writerForTest(KEY) != null)
      writerClosed(configuredInit(parameterSetNals(1)), 'init000003.mp4', [3])
      await leave(first)
      soundful(1)
      await until(() => spawned().length === 2)
      expect(encoding(spawned()[1].slice(1))).deep.equals(PICTURE_ONLY)
    })

    it('leaves sound on a first publish, and on a recording with sound', async function () {
      live()
      soundful(1)
      await until(() => spawned().length === 1)
      expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
    })

    describe('on a first publish', function () {
      const WITHIN_WAIT = SOUND_WAIT_MS / 2
      const STANDARD = silence(48000, 'stereo')

      /** Reports the wait running out, as the next packet or tick would. */
      const waitOut = async (): Promise<void> => {
        await sleep(SOUND_WAIT_MS + 20)
        tickSamplerForTest()
      }

      for (const kind of ['classic', 'enhanced'] as const) {
        it(`gives ${kind} HEVC with no sound and no metadata silence from the start, after the bound`, async function () {
          live()
          quiet(1, kind)
          await sleep(WITHIN_WAIT)
          tickSamplerForTest()
          expect(spawned(), 'still waiting').length(0)

          await waitOut()
          await until(() => spawned().length === 1)
          const [, ...args] = spawned()[0]
          expect(encoding(args)).deep.equals(STANDARD)
          expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init.mp4')
          expect(args.at(-1)).equals(join(DIR, 'master.m3u8'))
        })

        it(`keeps ${kind} sound that shows inside the bound, and starts on its header`, async function () {
          live()
          const made = quiet(1, kind)
          await sleep(WITHIN_WAIT)
          tickSamplerForTest()
          expect(spawned(), 'still waiting').length(0)

          const asked = Date.now()
          soundHeader(made, SOUND)
          await until(() => spawned().length === 1)
          expect(Date.now() - asked).lessThan(WITHIN_WAIT)
          expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
        })
      }

      it('starts on a sound header that comes ahead of the first picture, with no wait', async function () {
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        expect(spawned(), 'it has not shown sound').length(0)
        const asked = Date.now()
        soundHeader(made, SOUND)
        await until(() => spawned().length === 1)
        expect(Date.now() - asked).lessThan(WITHIN_WAIT)
        expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
        expect(logs.join('\n')).match(/waited \d{1,3} ms/)
      })

      for (const said of [0, ''] as const) {
        it(`takes metadata saying no sound as ${JSON.stringify(said)} at its word, with no wait`, async function () {
          live()
          const made = session('camera')
          publishArrivedForTest(made)
          const asked = Date.now()
          metadata(made, { audiocodecid: said })
          await until(() => spawned().length === 1)
          expect(Date.now() - asked).lessThan(WITHIN_WAIT)
          expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
        })
      }

      it('hears a camera whose metadata leaves sound out, when its sound header follows', async function () {
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made)
        expect(spawned(), 'it has said nothing of sound').length(0)
        show(made, 1)
        await sleep(WITHIN_WAIT)
        tickSamplerForTest()
        expect(spawned(), 'still waiting').length(0)

        soundHeader(made, SOUND)
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
      })

      it('waits out the bound for metadata that leaves sound out and no sound', async function () {
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made)
        show(made, 1)
        await sleep(WITHIN_WAIT)
        tickSamplerForTest()
        expect(spawned(), 'still waiting').length(0)

        await waitOut()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('takes a data message that is not metadata for saying nothing of sound', async function () {
        live()
        const made = quiet(1)
        metadata(made, { notMetadata: true })
        await sleep(WITHIN_WAIT)
        tickSamplerForTest()
        expect(spawned(), 'still waiting').length(0)
        expect(made.audioCodec, 'the session keeps what it had').equals(0)

        soundHeader(made, SOUND)
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
      })

      it('keeps what earlier metadata said when later metadata leaves it out', async function () {
        live()
        const made = session('camera')
        publishArrivedForTest(made)
        metadata(made, { audiocodecid: 0 })
        metadata(made)
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('ends the wait when late metadata says there is no sound', async function () {
        live()
        const made = quiet(1)
        await sleep(50)
        expect(spawned(), 'still waiting').length(0)
        metadata(made, { audiocodecid: 0 })
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('does not believe metadata naming sound that never comes', async function () {
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made, { audiocodecid: 10 })
        show(made, 1)
        await sleep(WITHIN_WAIT)
        tickSamplerForTest()
        expect(spawned(), 'still waiting').length(0)

        await waitOut()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('goes ahead with silence when no first picture and no sound show', async function () {
        live()
        publishArrivedForTest(session('camera', FOURCC_HEVC))
        await sleep(CONFIGURATION_WAIT_MS + 20)
        tickSamplerForTest()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('writes nothing for a publisher that leaves during the wait', async function () {
        live()
        const made = quiet(1)
        publishGoneForTest(made)
        await waitOut()
        expect(spawned()).length(0)
      })

      it('leaves sound arriving after the bound out of the part', async function () {
        live()
        const made = quiet(1)
        await waitOut()
        await until(() => spawned().length === 1)
        await until(() => writerForTest(KEY) != null)
        soundHeader(made, SOUND)
        await sleep(30)
        expect(spawned(), 'no second writer for it').length(1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
      })

      it('lets a later publish with real sound carry on in a part of its own', async function () {
        live()
        const first = soundless(1)
        await until(() => spawned().length === 1)
        await until(() => writerForTest(KEY) != null)
        expect(encoding(spawned()[0].slice(1))).deep.equals(STANDARD)
        // What that writer's FFmpeg left: the silence FFmpeg's encoder spells.
        firstPublishOnDisk(DIR, START_MS)
        writeFileSync(
          join(DIR, 'init.mp4'),
          configuredInit(
            parameterSetNals(1),
            Buffer.from([0x11, 0x90, 0x56, 0xe5, 0x00])
          )
        )
        const before = recording()
        await leave(first)

        soundful(1)
        await until(() => spawned().length === 2)
        const [, ...args] = spawned()[1]
        expect(encoding(args)).deep.equals(COPY)
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
          'init000003.mp4'
        )
        const after = recording()
        for (const name of Object.keys(before)) {
          expect(after[name], name).equals(before[name])
        }
      })

      it('gives silence after segments that lost their playlist', async function () {
        firstPublishOnDisk(DIR, START_MS)
        writeFileSync(join(DIR, 'master.m3u8'), '#EXTM3U\n')
        live()
        soundless(1)
        await until(() => spawned().length === 1)
        const [, ...args] = spawned()[0]
        expect(encoding(args)).deep.equals(STANDARD)
        // Nothing listed to keep whole: FFmpeg appends to the playlist itself.
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init.mp4')
        expect(optionOf(args, '-hls_flags')).contains('append_list')
        expect(args.at(-1)).equals(join(DIR, 'master.m3u8'))
      })

      it('gives silence over an init segment that cannot be read', async function () {
        firstPublishOnDisk(DIR, START_MS)
        writeFileSync(join(DIR, 'init.mp4'), '')
        live()
        soundless(1)
        await until(() => spawned().length === 1)
        const [, ...args] = spawned()[0]
        expect(encoding(args)).deep.equals(STANDARD)
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
          WRITER_INIT_NAME
        )
      })
    })

    it('forgets the silence for the writer after it', async function () {
      recordingWith(SOUND)
      live()
      const made = soundless(1)
      await until(() => spawned().length === 1)
      await until(() => writerForTest(KEY) != null)
      await leave(made)

      soundful(1)
      await until(() => spawned().length === 2)
      expect(encoding(spawned()[1].slice(1))).deep.equals(COPY)
    })

    describe('when the publish has not said', function () {
      const WITHIN_WAIT = SOUND_WAIT_MS / 2

      /** Runs `opening`, and says how long its writer took to start. */
      const timed = async (opening: () => void): Promise<number> => {
        const before = spawned().length
        const started = Date.now()
        opening()
        await until(() => spawned().length === before + 1)
        return Date.now() - started
      }

      /** Reports the wait running out, as the next packet or tick would. */
      const waitOut = async (): Promise<void> => {
        await sleep(SOUND_WAIT_MS + 20)
        tickSamplerForTest()
      }

      for (const kind of ['classic', 'enhanced'] as const) {
        it(`gives a ${kind} publish with no metadata silence, at the same picture`, async function () {
          recordingWith(SOUND)
          const before = recording()
          live()
          quiet(1, kind)
          await sleep(WITHIN_WAIT)
          tickSamplerForTest()
          expect(spawned(), 'still waiting').length(0)

          await waitOut()
          await until(() => spawned().length === 1)
          const [, ...args] = spawned()[0]
          expect(encoding(args)).deep.equals(silence(48000, 'stereo'))
          expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
            'init000003.mp4'
          )
          expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
          expect(recording(), 'nothing replaced').deep.equals(before)
        })
      }

      it('gives a different picture with no metadata silence too', async function () {
        recordingWith(SOUND)
        const before = recording()
        live()
        quiet(2)
        await waitOut()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
        expect(recording()).deep.equals(before)
      })

      it('takes no metadata and no first picture for no sound as well', async function () {
        recordingWith(SOUND)
        live()
        publishArrivedForTest(session('camera', FOURCC_HEVC))
        await sleep(CONFIGURATION_WAIT_MS + 20)
        tickSamplerForTest()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
      })

      it('does not believe metadata naming sound that never comes', async function () {
        recordingWith(SOUND)
        const before = recording()
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made, { audiocodecid: 10 })
        show(made, 1)
        await sleep(WITHIN_WAIT)
        tickSamplerForTest()
        expect(spawned(), 'still waiting').length(0)

        await waitOut()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
        expect(recording()).deep.equals(before)
      })

      it('takes sound it cannot carry for no sound', async function () {
        recordingWith(SOUND)
        const before = recording()
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made, { audiocodecid: 2 })
        show(made, 1)
        // MP3 has no sequence header: node-media-server reads a sound frame.
        made.broadcast?.broadcastMessage?.({
          flags: 1,
          dts: 0,
          codec_id: 2,
          data: Buffer.from([0x2f, 0xff, 0xfb, 0x90])
        })
        await waitOut()
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
        expect(recording()).deep.equals(before)
      })

      for (const kind of ['classic', 'enhanced'] as const) {
        it(`shares the init segment with ${kind} sound a moment late, and starts on its header`, async function () {
          recordingWith(SOUND)
          live()
          const made = quiet(1, kind)
          await sleep(WITHIN_WAIT)
          tickSamplerForTest()
          expect(spawned(), 'still waiting').length(0)

          const started = await timed(() => {
            soundHeader(made, SOUND)
          })
          expect(started).lessThan(WITHIN_WAIT)
          const [, ...args] = spawned()[0]
          expect(encoding(args)).deep.equals(COPY)
          expectContinuing(args)
        })
      }

      it('takes sound configured differently, a moment late, for a difference', async function () {
        recordingWith(SOUND)
        live()
        const made = quiet(1)
        await sleep(WITHIN_WAIT)
        soundHeader(made, Buffer.from([0x12, 0x08]))
        await until(() => spawned().length === 1)
        const [, ...args] = spawned()[0]
        expect(encoding(args)).deep.equals(COPY)
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
          'init000003.mp4'
        )
      })

      it('holds a publish whose metadata names sound until its header arrives', async function () {
        recordingWith(SOUND)
        live()
        const made = session('camera', FOURCC_HEVC)
        publishArrivedForTest(made)
        metadata(made, { audiocodecid: 10 })
        show(made, 1)
        await sleep(50)
        expect(spawned(), 'a phone sends it after its first picture').length(0)
        soundHeader(made, SOUND)
        await until(() => spawned().length === 1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(COPY)
        expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
          WRITER_INIT_NAME
        )
      })

      it('leaves sound arriving after the bound out of the part, and uses it after', async function () {
        recordingWith(SOUND)
        live()
        const made = quiet(1)
        await waitOut()
        await until(() => spawned().length === 1)
        await until(() => writerForTest(KEY) != null)
        soundHeader(made, SOUND)
        await sleep(30)
        expect(spawned(), 'no second writer for it').length(1)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )

        // Its writer falls over: the one after it has heard the sound.
        writerForTest(KEY)?.kill('SIGKILL')
        await until(() => spawned().length === 2)
        expect(encoding(spawned()[1].slice(1))).deep.equals(COPY)
      })

      it('costs a publish that shows its sound header nothing', async function () {
        recordingWith(SOUND)
        live()
        const started = await timed(() => {
          soundful(1)
        })
        expect(started).lessThan(WITHIN_WAIT)
        expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
          WRITER_INIT_NAME
        )
      })

      it('costs a publish whose metadata says it has no sound nothing', async function () {
        recordingWith(SOUND)
        live()
        const started = await timed(() => {
          soundless(1)
        })
        expect(started).lessThan(WITHIN_WAIT)
      })

      it('ends the wait when late metadata says there is no sound', async function () {
        recordingWith(SOUND)
        live()
        const made = quiet(1)
        await sleep(50)
        expect(spawned(), 'still waiting').length(0)
        const started = await timed(() => {
          metadata(made, { audiocodecid: 0 })
        })
        expect(started).lessThan(WITHIN_WAIT)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
      })

      it('costs a recording with no sound nothing', async function () {
        recordingWith(undefined)
        live()
        const started = await timed(() => {
          quiet(1)
        })
        expect(started).lessThan(WITHIN_WAIT)
        const [, ...args] = spawned()[0]
        expect(encoding(args)).deep.equals(PICTURE_ONLY)
        expect(optionOf(args, '-hls_fmp4_init_filename')).equals(
          WRITER_INIT_NAME
        )
      })

      it('counts from the first picture, not from the writer asking', async function () {
        recordingWith(SOUND)
        let answer: () => void = () => undefined
        const looked = new Promise<void>(resolve => {
          answer = resolve
        })
        configureIngest({
          ffmpegPath: FAKE,
          bindHost: '127.0.0.1',
          port: 19_372,
          app: 'live',
          segmentSeconds: 4,
          log: message => logs.push(message),
          onEvent: event => events.push(event),
          resolve: async () => {
            await looked
            return {
              liveStreamId: 'liv_mismatch',
              hlsDir: DIR,
              destinations: [],
              videoStartMs: START_MS
            }
          }
        })
        const made = quiet(1)
        await sleep(SOUND_WAIT_MS + 20)
        const started = Date.now()
        answer()
        await sleep(20)
        // With no metadata the next picture says what the publish is.
        made.broadcast?.broadcastMessage?.({
          flags: 4,
          dts: 40,
          codec_id: FOURCC_HEVC
        })
        await until(() => spawned().length === 1)
        expect(
          Date.now() - started,
          'the wait ran during the look-up'
        ).lessThan(WITHIN_WAIT)
        expect(encoding(spawned()[0].slice(1))).deep.equals(
          silence(48000, 'stereo')
        )
      })

      it('gives silence after a silent part, read from the last init segment', async function () {
        recordingWith(SOUND)
        live()
        const made = soundless(1)
        await until(() => spawned().length === 1)
        await until(() => writerForTest(KEY) != null)
        writerClosed(
          configuredInit(parameterSetNals(1), Buffer.from([0x12, 0x08])),
          'init000003.mp4',
          [3]
        )
        await until(() => master().includes('seg000003.m4s'))
        await leave(made)

        quiet(1)
        await sleep(WITHIN_WAIT)
        expect(spawned(), 'still waiting').length(1)
        await waitOut()
        await until(() => spawned().length === 2)
        expect(encoding(spawned()[1].slice(1))).deep.equals(
          silence(44100, 'mono')
        )
      })

      it('writes nothing for a publisher that leaves during the wait', async function () {
        recordingWith(SOUND)
        const before = recording()
        live()
        const made = quiet(1)
        await sleep(50)
        publishGoneForTest(made)
        await waitOut()
        await sleep(30)
        expect(spawned()).length(0)
        expect(recording()).deep.equals(before)

        soundful(1)
        await until(() => spawned().length === 1)
        expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
          WRITER_INIT_NAME
        )
      })
    })
  })

  it("lets the writer's own init segment mend one that cannot be read", async function () {
    firstPublishOnDisk(DIR, START_MS)
    writeFileSync(join(DIR, 'init.mp4'), '')
    live()
    const made = session('camera', FOURCC_HEVC)
    publishArrivedForTest(made)
    made.broadcast?.broadcastMessage?.({
      flags: 0,
      dts: 0,
      codec_id: 10,
      data: soundHeaderBody(SOUND)
    })
    show(made, 2)
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      WRITER_INIT_NAME
    )
  })

  it("lists a writer's segments behind a discontinuity and its map, on the programme clock", async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = master()
    live()
    await publish(2)
    const init = configuredInit(parameterSetNals(2))

    writerClosed(init, 'init000003.mp4', [3])
    await until(() => master().includes('seg000003.m4s'))

    expect(master().startsWith(before), 'nothing listed changes').equals(true)
    const added = master().slice(before.length).split('\n')
    expect(added.slice(0, 2)).deep.equals([
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-MAP:URI="init000003.mp4"'
    ])
    expect(listedSegments(master()).at(-1)).includes({
      name: 'seg000003.m4s',
      init: 'init000003.mp4'
    })
    const at = timelineStartSec(init, readFileSync(join(DIR, 'seg000003.m4s')))
    expect(at, 'stamped before it was listed').above(11)

    writerClosed(init, 'init000003.mp4', [3, 4])
    await until(() => master().includes('seg000004.m4s'))
    expect(master().match(/EXT-X-MAP/g)).length(2)
    expect(master().match(/seg000003/g), 'listed once').length(1)
  })

  it("lists a writer's segments while live even with program dates ahead of the clock", async function () {
    const ahead = Date.now() + 3_600_000
    firstPublishOnDisk(DIR, ahead)
    setLive(KEY, {
      liveStreamId: 'liv_mismatch',
      hlsDir: DIR,
      destinations: [],
      videoStartMs: ahead
    })
    await publish(2)
    writerClosed(configuredInit(parameterSetNals(2)), 'init000003.mp4', [3])
    await until(() => master().includes('seg000003.m4s'))
    expect(writerForTest(KEY), 'its writer is still running').not.equals(
      undefined
    )
  })

  it('never lets a mismatched writer start on the playlist a player holds', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    await publish(2)
    const held = master()
    writeFileSync(join(DIR, WRITER_PLAYLIST_NAME), '#EXTM3U\n')
    await sleep(100)
    expect(master()).equals(held)
  })

  it('gives every writer after the change its own init segment, the first camera too', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    const second = await publish(2)
    writerClosed(configuredInit(parameterSetNals(2)), 'init000003.mp4', [3, 4])
    await until(() => master().includes('seg000004.m4s'))
    await leave(second)

    const third = await publish(1)
    const [, ...args] = spawned()[1]
    expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000005.mp4')
    expect(optionOf(args, '-start_number')).equals('5')
    expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
    expect(
      existsSync(join(DIR, WRITER_PLAYLIST_NAME)),
      "the last writer's list is gone"
    ).equals(false)

    writerClosed(configuredInit(parameterSetNals(1)), 'init000005.mp4', [5])
    await until(() => master().includes('seg000005.m4s'))
    await leave(third)
    expect(listedSegments(master()).map(segment => segment.init)).deep.equals([
      'init.mp4',
      'init.mp4',
      'init.mp4',
      'init000003.mp4',
      'init000003.mp4',
      'init000005.mp4'
    ])
  })

  it("picks a writer's last segments up after a crash, on the next publish", async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    const init = configuredInit(parameterSetNals(2))
    // What a process that died leaves: a closed segment listed nowhere else.
    writerClosed(init, 'init000003.mp4', [3])
    await publish(2)

    expect(listedSegments(master()).at(-1)).includes({
      name: 'seg000003.m4s',
      init: 'init000003.mp4'
    })
    const [, ...args] = spawned()[0]
    expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000004.mp4')
  })

  it('leaves the recording as it was when a writer dies before closing a segment', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = master()
    live()
    const made = await publish(2)
    await leave(made)
    expect(master()).equals(before)

    await publish(1)
    expect(optionOf(spawned()[1], '-hls_fmp4_init_filename')).equals(
      WRITER_INIT_NAME
    )
  })

  it('keeps init.mp4 as it was while a continuing writer has written none of its own', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = readFileSync(join(DIR, 'init.mp4'))
    const inode = statSync(join(DIR, 'init.mp4')).ino
    const listed = master()
    live()
    await publish(1)
    expectContinuing(spawned()[0].slice(1), 3)
    await sleep(100)
    expect(readFileSync(join(DIR, 'init.mp4'))).deep.equals(before)

    // FFmpeg opens its init file as it starts, and writes it seconds later.
    writeFileSync(join(DIR, WRITER_INIT_NAME), '')
    writeFileSync(join(DIR, 'seg000003.m4s.tmp'), 'part of a segment')
    await sleep(200)
    expect(readFileSync(join(DIR, 'init.mp4'))).deep.equals(before)
    expect(statSync(join(DIR, 'init.mp4')).ino).equals(inode)
    expect(master()).equals(listed)
  })

  it("renames a continuing writer's whole init segment over init.mp4, then lists its segments behind one join", async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = master()
    const inode = statSync(join(DIR, 'init.mp4')).ino
    live()
    await publish(1)
    const init = configuredInit(parameterSetNals(1))

    writerClosed(init, WRITER_INIT_NAME, [3])
    await until(() => master().includes('seg000003.m4s'))
    expect(readFileSync(join(DIR, 'init.mp4'))).deep.equals(init)
    expect(
      statSync(join(DIR, 'init.mp4')).ino,
      'renamed, not rewritten'
    ).not.equals(inode)
    expect(existsSync(join(DIR, WRITER_INIT_NAME))).equals(false)
    expect(master().startsWith(before), 'nothing listed changes').equals(true)
    const added = master().slice(before.length).split('\n')
    expect(added[0]).equals('#EXT-X-DISCONTINUITY')
    expect(master().match(/EXT-X-MAP/g)).length(1)
    expect(listedSegments(master()).at(-1)).includes({
      name: 'seg000003.m4s',
      init: 'init.mp4'
    })
    const at = timelineStartSec(init, readFileSync(join(DIR, 'seg000003.m4s')))
    expect(at, 'stamped before it was listed').above(11)

    writerClosed(init, WRITER_INIT_NAME, [3, 4])
    await until(() => master().includes('seg000004.m4s'))
    writerClosed(init, WRITER_INIT_NAME, [3, 4, 5])
    await until(() => master().includes('seg000005.m4s'))
    expect(master().match(/EXT-X-DISCONTINUITY/g), 'one join').length(1)
    expect(master().match(/seg000003/g), 'listed once').length(1)
    expect(master().match(/EXT-X-MAP/g)).length(1)
  })

  it('never takes an init segment that is not whole, and the next writer clears it away', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    const inode = statSync(join(DIR, 'init.mp4')).ino
    live()
    const made = await publish(1)
    const init = configuredInit(parameterSetNals(1))
    writeFileSync(join(DIR, WRITER_INIT_NAME), init.subarray(0, 40))
    await sleep(200)
    await leave(made)
    expect(recording()).deep.equals(before)
    expect(statSync(join(DIR, 'init.mp4')).ino).equals(inode)

    await publish(1)
    expect(existsSync(join(DIR, WRITER_INIT_NAME))).equals(false)
    expect(recording()).deep.equals(before)
    expectContinuing(spawned()[1].slice(1), 3)
  })

  it("picks a continuing writer's segments up after a crash, its init segment with them", async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = master()
    // What a process that died leaves: a whole init segment of the writer's,
    // and a closed segment listed nowhere else.
    const init = configuredInit(parameterSetNals(1))
    writerClosed(init, WRITER_INIT_NAME, [3])
    live()
    await publish(1)

    expect(master().startsWith(before)).equals(true)
    expect(master().slice(before.length).split('\n')[0]).equals(
      '#EXT-X-DISCONTINUITY'
    )
    expect(listedSegments(master()).at(-1)).includes({
      name: 'seg000003.m4s',
      init: 'init.mp4'
    })
    expect(readFileSync(join(DIR, 'init.mp4'))).deep.equals(init)
    expect(existsSync(join(DIR, WRITER_INIT_NAME))).equals(false)
    expect(existsSync(join(DIR, WRITER_PLAYLIST_NAME))).equals(false)
    expectContinuing(spawned()[0].slice(1), 4)
  })

  it('gives a writer with no publisher to ask its own init segment after a part with one of its own', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    const second = await publish(2)
    writerClosed(configuredInit(parameterSetNals(2)), 'init000003.mp4', [3])
    await until(() => master().includes('seg000003.m4s'))
    await leave(second)

    forcePublishForTest(KEY, true)
    await until(() => spawned().length === 2)
    const [, ...args] = spawned()[1]
    expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000004.mp4')
    expect(args.at(-1)).equals(join(DIR, WRITER_PLAYLIST_NAME))
    forcePublishForTest(KEY, false)
  })

  it('lists nothing of a writer whose init segment is not whole, and says so before clearing it away', async function () {
    firstPublishOnDisk(DIR, START_MS)
    const before = recording()
    const listed = master()
    live()
    const made = await publish(1)
    const init = configuredInit(parameterSetNals(1))
    writerClosed(init.subarray(0, init.length - 1), WRITER_INIT_NAME, [3])
    await sleep(300)
    expect(master(), 'nothing under an init segment that is not there').equals(
      listed
    )
    await leave(made)
    expect(master()).equals(listed)

    await publish(1)
    expect(logs.join('\n')).contains(
      "[live:liv_mismatch] the last writer's init segment never went over init.mp4; seg000003.m4s stay unlisted"
    )
    expect(existsSync(join(DIR, WRITER_INIT_NAME))).equals(false)
    expect(readFileSync(join(DIR, 'init.mp4')).toString('base64')).equals(
      before['init.mp4']
    )
  })

  it('gives a writer after a change its own init segment when the camera before it matched', async function () {
    firstPublishOnDisk(DIR, START_MS)
    live()
    const first = await publish(1)
    writerClosed(configuredInit(parameterSetNals(1)), WRITER_INIT_NAME, [3])
    await until(() => master().includes('seg000003.m4s'))
    await leave(first)

    const second = await publish(2)
    expect(optionOf(spawned()[1].slice(1), '-hls_fmp4_init_filename')).equals(
      'init000004.mp4'
    )
    writerClosed(configuredInit(parameterSetNals(2)), 'init000004.mp4', [4])
    await until(() => master().includes('seg000004.m4s'))
    await leave(second)

    await publish(1)
    const [, ...args] = spawned()[2]
    expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init000005.mp4')
    expect(listedSegments(master()).map(segment => segment.init)).deep.equals([
      'init.mp4',
      'init.mp4',
      'init.mp4',
      'init.mp4',
      'init000004.mp4'
    ])
    expect(master().match(/EXT-X-DISCONTINUITY/g)).length(2)
  })
})

describe("carrying a writer's playlist onto the recording", function () {
  const dir = join(ROOT, 'absorb')

  beforeEach(function () {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    firstPublishOnDisk(dir, START_MS)
  })

  afterEach(function () {
    rmSync(ROOT, { recursive: true, force: true })
  })

  const listing = (): string => readFileSync(join(dir, 'master.m3u8'), 'utf8')
  const writer = (lines: string[]): void => {
    writeFileSync(
      join(dir, WRITER_PLAYLIST_NAME),
      `${['#EXTM3U', '#EXT-X-MAP:URI="init000003.mp4"', ...lines].join('\n')}\n`
    )
  }

  const continuing = (lines: string[]): void => {
    writeFileSync(
      join(dir, WRITER_PLAYLIST_NAME),
      `${['#EXTM3U', `#EXT-X-MAP:URI="${WRITER_INIT_NAME}"`, ...lines].join('\n')}\n`
    )
  }

  it("lists a continuing writer's segments under init.mp4, behind one join", function () {
    const before = listing()
    const init = configuredInit(parameterSetNals(1), SOUND)
    writeFileSync(join(dir, WRITER_INIT_NAME), init)
    continuing(['#EXTINF:4.000000,', 'seg000003.m4s'])
    expect(absorbWriterPlaylist(dir)).equals(true)
    expect(readFileSync(join(dir, 'init.mp4'))).deep.equals(init)
    expect(existsSync(join(dir, WRITER_INIT_NAME))).equals(false)
    expect(listing().slice(before.length)).equals(
      '#EXT-X-DISCONTINUITY\n#EXTINF:4.000000,\nseg000003.m4s\n'
    )

    continuing([
      '#EXTINF:4.000000,',
      'seg000003.m4s',
      '#EXTINF:4.000000,',
      'seg000004.m4s'
    ])
    absorbWriterPlaylist(dir)
    expect(listing().slice(before.length)).equals(
      '#EXT-X-DISCONTINUITY\n#EXTINF:4.000000,\nseg000003.m4s\n#EXTINF:4.000000,\nseg000004.m4s\n'
    )
  })

  it('leaves init.mp4 byte for byte as it was for an init segment that is not whole', function () {
    const held = readFileSync(join(dir, 'init.mp4'))
    const init = configuredInit(parameterSetNals(1))
    const moovless = Buffer.alloc(16)
    moovless.writeUInt32BE(16, 0)
    moovless.write('ftyp', 4, 'latin1')
    const odd = Buffer.concat([init, Buffer.from([0, 0, 0])])
    for (const partial of [
      Buffer.alloc(0),
      init.subarray(0, 6),
      init.subarray(0, init.length - 1),
      odd,
      moovless
    ]) {
      writeFileSync(join(dir, WRITER_INIT_NAME), partial)
      expect(promoteWriterInit(dir)).equals(false)
      expect(readFileSync(join(dir, 'init.mp4'))).deep.equals(held)
    }
    rmSync(join(dir, WRITER_INIT_NAME))
    expect(promoteWriterInit(dir), 'none at all').equals(false)
    writeFileSync(join(dir, WRITER_INIT_NAME), init)
    expect(promoteWriterInit(dir)).equals(true)
    expect(readFileSync(join(dir, 'init.mp4'))).deep.equals(init)
  })

  it('leaves a whole init segment where it is when it cannot be renamed', function () {
    const init = configuredInit(parameterSetNals(1))
    rmSync(join(dir, 'init.mp4'))
    mkdirSync(join(dir, 'init.mp4', 'in the way'), { recursive: true })
    writeFileSync(join(dir, WRITER_INIT_NAME), init)
    expect(promoteWriterInit(dir)).equals(false)
    expect(readFileSync(join(dir, WRITER_INIT_NAME))).deep.equals(init)
  })

  it('lists nothing while the writer init segment cannot be renamed, and keeps it', function () {
    const before = listing()
    const init = configuredInit(parameterSetNals(1))
    rmSync(join(dir, 'init.mp4'))
    mkdirSync(join(dir, 'init.mp4', 'in the way'), { recursive: true })
    writeFileSync(join(dir, WRITER_INIT_NAME), init)
    continuing(['#EXTINF:4.000000,', 'seg000003.m4s'])
    expect(absorbWriterPlaylist(dir), 'held back').equals(false)
    expect(listing()).equals(before)
    expect(readFileSync(join(dir, WRITER_INIT_NAME))).deep.equals(init)
  })

  it('takes the writer init segment into place before an end the controller wrote', function () {
    writeFileSync(join(dir, 'master.m3u8'), `${listing()}#EXT-X-ENDLIST\n`)
    const init = configuredInit(parameterSetNals(1))
    writeFileSync(join(dir, WRITER_INIT_NAME), init)
    continuing(['#EXTINF:4.000000,', 'seg000003.m4s'])
    absorbWriterPlaylist(dir)
    const lines = listing().trimEnd().split('\n')
    expect(lines.slice(-4)).deep.equals([
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.000000,',
      'seg000003.m4s',
      '#EXT-X-ENDLIST'
    ])
    expect(readFileSync(join(dir, 'init.mp4'))).deep.equals(init)
  })

  it('does nothing with no writer playlist, or one with no map', function () {
    const before = listing()
    absorbWriterPlaylist(dir)
    writeFileSync(join(dir, WRITER_PLAYLIST_NAME), '#EXTM3U\n')
    absorbWriterPlaylist(dir)
    expect(listing()).equals(before)
  })

  it('does nothing with no recording playlist', function () {
    writer(['#EXTINF:4.000000,', 'seg000003.m4s'])
    rmSync(join(dir, 'master.m3u8'))
    absorbWriterPlaylist(dir)
    expect(existsSync(join(dir, 'master.m3u8'))).equals(false)
  })

  it('keeps the end of a playlist the controller has closed', function () {
    writeFileSync(join(dir, 'master.m3u8'), `${listing()}#EXT-X-ENDLIST\n`)
    writer(['#EXTINF:4.000000,', 'seg000003.m4s', '#EXT-X-ENDLIST'])
    absorbWriterPlaylist(dir)
    const lines = listing().trimEnd().split('\n')
    expect(lines.at(-1)).equals('#EXT-X-ENDLIST')
    expect(lines.at(-2)).equals('seg000003.m4s')
    expect(listing().match(/ENDLIST/g)).length(1)
  })

  it('raises the target duration for a longer segment, and never lowers it', function () {
    writer([
      '#EXTINF:2.000000,',
      'seg000003.m4s',
      '#EXTINF:6.000000,',
      'seg000004.m4s'
    ])
    absorbWriterPlaylist(dir)
    expect(listing()).contains('#EXT-X-TARGETDURATION:6\n')

    writer(['#EXTINF:1.000000,', 'seg000005.m4s'])
    absorbWriterPlaylist(dir)
    expect(listing()).contains('#EXT-X-TARGETDURATION:6\n')
  })

  it('lists up to the first segment that is not ready, in order', function () {
    writer([
      '#EXTINF:4.000000,',
      'seg000003.m4s',
      '#EXTINF:4.000000,',
      'seg000004.m4s',
      '#EXTINF:4.000000,',
      'seg000005.m4s'
    ])
    absorbWriterPlaylist(dir, name => name !== 'seg000004.m4s')
    expect(listedSegments(listing()).map(item => item.name)).deep.equals([
      'seg000000.m4s',
      'seg000001.m4s',
      'seg000002.m4s',
      'seg000003.m4s'
    ])
  })
})
