import { spawn as nodeSpawn } from 'node:child_process'

import {
  FPS,
  HEIGHT,
  renderAudio,
  renderFrame,
  SAMPLE_RATE,
  samplesForFrame,
  WIDTH
} from './syntheticFrames'

/**
 * Renders one synthetic camera's fixture: `minutes` of its frames and tone,
 * encoded as HEVC (or, with `--codec h264`, H.264) and AAC in FLV, for a
 * publisher to replay later:
 *
 *   node -r sucrase/register e2e/rigs/streaming/renderFixture.ts \
 *     --label SynthA --minutes 30 --out SynthA.flv --ffmpeg <ffmpeg> [--codec h264]
 *
 * Its clock counts from the fixture's start, 00:00:00.000, so a reading is
 * placed in wall time by when the publisher started it (`ClockBase`).
 */

/** HEVC as a live camera sends it: no B-frames, a keyframe every two seconds. */
export const FIXTURE_VIDEO_ARGS = [
  '-c:v',
  'libx265',
  '-preset',
  'medium',
  '-tune',
  'zerolatency',
  '-pix_fmt',
  'yuv420p',
  '-g',
  String(FPS * 2)
]

/** H.264 as a live camera sends it, the same way. */
export const FIXTURE_H264_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-tune',
  'zerolatency',
  '-pix_fmt',
  'yuv420p',
  '-bf',
  '0',
  '-g',
  String(FPS * 2)
]

/** The codecs a fixture can be encoded in. */
export type FixtureCodec = 'hevc' | 'h264'

/** ffmpeg's arguments: raw frames on stdin, raw audio on fd 3, FLV into `out`. */
export function fixtureArgs(
  out: string,
  fps = FPS,
  codec: FixtureCodec = 'hevc'
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${WIDTH}x${HEIGHT}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    '1',
    '-i',
    'pipe:3',
    ...(codec === 'h264' ? FIXTURE_H264_ARGS : FIXTURE_VIDEO_ARGS),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'flv',
    out
  ]
}

/** A writable pipe, as far as rendering needs one. */
export interface Pipe {
  write: (data: Buffer) => boolean
  once: (event: 'drain', listener: () => void) => unknown
  end: () => unknown
}

export interface Encoder {
  video: Pipe
  audio: Pipe
  /** Settles with ffmpeg's exit code. */
  exited: Promise<number | null>
}

export const spawnEncoder = (ffmpeg: string, args: string[]): Encoder => {
  const child = nodeSpawn(ffmpeg, args, {
    stdio: ['pipe', 'inherit', 'inherit', 'pipe']
  })
  // A pipe to an ffmpeg that has gone answers EPIPE: its exit code says why.
  for (const pipe of [child.stdin, child.stdio[3]]) {
    ;(pipe as NodeJS.WritableStream | null)?.on('error', () => undefined)
  }
  return {
    video: child.stdin as Pipe,
    audio: child.stdio[3] as unknown as Pipe,
    exited: new Promise(resolve => {
      child.on('exit', code => {
        resolve(code)
      })
      child.on('error', () => {
        resolve(null)
      })
    })
  }
}

/** Writes `data`, waiting for room, or for ffmpeg to have gone. */
async function send(
  pipe: Pipe,
  data: Buffer,
  exited: Promise<unknown>
): Promise<boolean> {
  if (pipe.write(data)) return true
  return await Promise.race([
    new Promise<boolean>(resolve => {
      pipe.once('drain', () => {
        resolve(true)
      })
    }),
    exited.then(() => false)
  ])
}

/** Renders the fixture, and answers the number of frames written. */
export async function renderFixture(
  options: {
    label: string
    minutes: number
    out: string
    ffmpeg: string
    codec?: FixtureCodec
  },
  spawn: (ffmpeg: string, args: string[]) => Encoder = spawnEncoder
): Promise<number> {
  const frames = Math.round(options.minutes * 60 * FPS)
  const encoder = spawn(
    options.ffmpeg,
    fixtureArgs(options.out, FPS, options.codec)
  )
  const frame = Buffer.alloc(WIDTH * HEIGHT * 3)
  for (let index = 0; index < frames; index++) {
    renderFrame({ index, startEpochMs: 0, label: options.label }, frame)
    const [from, count] = samplesForFrame(index)
    const room =
      (await send(encoder.video, frame, encoder.exited)) &&
      (await send(encoder.audio, renderAudio(from, count), encoder.exited))
    if (!room) break
  }
  encoder.video.end()
  encoder.audio.end()
  const code = await encoder.exited
  if (code !== 0) throw new Error(`ffmpeg exited with ${String(code)}`)
  return frames
}

/** The command line's options. */
export function parseRenderArgs(argv: string[]): {
  label: string
  minutes: number
  out: string
  ffmpeg: string
  codec?: FixtureCodec
} {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null)
      throw new Error(`unknown or empty option ${argv[i]}`)
    values[argv[i].slice(2)] = argv[i + 1]
  }
  for (const flag of ['label', 'minutes', 'out', 'ffmpeg']) {
    if (values[flag] == null) throw new Error(`--${flag} is needed`)
  }
  const minutes = Number(values.minutes)
  if (!(minutes > 0)) throw new Error('--minutes is a positive number')
  const codec = values.codec
  if (codec != null && codec !== 'hevc' && codec !== 'h264') {
    throw new Error('--codec is hevc or h264')
  }
  return {
    label: values.label,
    minutes,
    out: values.out,
    ffmpeg: values.ffmpeg,
    ...(codec == null ? {} : { codec })
  }
}

/**
 * The command: renders, and answers the exit code. Why it could not goes to
 * stderr, which is what a caller reports when it fails.
 */
export async function main(
  argv: string[],
  log: (line: string) => void = console.log,
  spawn: (ffmpeg: string, args: string[]) => Encoder = spawnEncoder,
  fail: (line: string) => void = console.error
): Promise<number> {
  try {
    const args = parseRenderArgs(argv)
    const frames = await renderFixture(args, spawn)
    log(`${args.out}: ${args.label}, ${frames} frames`)
    return 0
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      process.exitCode = 1
    })
}
