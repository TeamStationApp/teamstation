import {
  chmodSync,
  existsSync,
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
  type LiveEvent,
  publishArrivedForTest,
  publishGoneForTest,
  resetForTest,
  setLive,
  type TestSession,
  tickSamplerForTest,
  WRITER_PLAYLIST_NAME,
  writerForTest
} from './splitter'
import { firstPublishOnDisk } from './splitterFixtures'

const KEY = 'ts_mismatchkeymismatchkeymismatch'
const FOURCC_HEVC = 0x68766331
const ROOT = join(tmpdir(), 'ts-live-test-mismatch')
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

function broadcastFor(
  publisher: () => TestSession
): NonNullable<TestSession['broadcast']> {
  return {
    subscribers: new Map(),
    broadcastMessage: packet => {
      if (packet.flags === 5) publisher().videoCodec = FOURCC_HEVC
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
    close: () => undefined,
    socket: { destroy: () => undefined }
  }
  made.broadcast = broadcastFor(() => made)
  return made
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
}

describe('a publish configured differently from the recording', function () {
  this.timeout(10_000)
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
  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done() && waited < 5000; waited += 10) await sleep(10)
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
      expect(optionOf(args, '-hls_fmp4_init_filename')).equals('init.mp4')
      expect(optionOf(args, '-hls_flags')).contains('append_list')
      expect(args.at(-1)).equals(join(DIR, 'master.m3u8'))
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
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals('init.mp4')
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
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals('init.mp4')
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
    made.broadcast?.broadcastMessage?.({ flags: 5, dts: 0 })
    show(made, 1)
    await until(() => spawned().length === 1)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals(
      'init000003.mp4'
    )
  })

  it('lets FFmpeg mend an init segment that cannot be read', async function () {
    firstPublishOnDisk(DIR, START_MS)
    writeFileSync(join(DIR, 'init.mp4'), '')
    live()
    await publish(2)
    expect(optionOf(spawned()[0], '-hls_fmp4_init_filename')).equals('init.mp4')
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
    expect(optionOf(spawned()[1], '-hls_fmp4_init_filename')).equals('init.mp4')
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
