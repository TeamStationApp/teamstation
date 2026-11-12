import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { connect as netConnect } from 'node:net'

import {
  FlvReader,
  parseRtmpUrl,
  RtmpPublisher,
  type RtmpSocket,
  type RtmpTarget
} from './rtmpPublish'
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
 * Publisher C: a synthetic camera. Node renders the frames and the tone, ffmpeg encodes
 * them as HEVC and AAC in FLV on its stdout, and `rtmpPublish.ts` sends that to the
 * ingest. The URL, key and all, is read from a mode-600 file and lives only in this
 * process: it is never on ffmpeg's command line and never logged.
 *
 * `cut(seconds)` drops the connection and ffmpeg, as a camera that lost its link, and
 * brings them back after `seconds` with timestamps that carry on from where the stream
 * would have been. `{ discontinuity: true }` brings it back with timestamps from zero.
 */

export interface ChildLike {
  stdin: {
    write: (data: Buffer) => boolean
    end: () => unknown
    on?: (event: 'error', listener: (error: Error) => void) => unknown
  } | null
  stdout: {
    on: (event: 'data', listener: (data: Buffer) => void) => unknown
  } | null
  stderr: {
    on: (event: 'data', listener: (data: Buffer) => void) => unknown
  } | null
  stdio: unknown[]
  kill: (signal?: NodeJS.Signals) => unknown
  on: (event: 'exit', listener: (code: number | null) => void) => unknown
}

export interface PublisherDeps {
  spawn: (command: string, args: string[]) => ChildLike
  connect: (host: string, port: number) => RtmpSocket
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  sleep: (ms: number) => Promise<void>
  /** Reads the URL file, refusing one anybody but its owner can read. */
  readSecret: (path: string) => string
  log: (line: string) => void
}

export function readSecretFile(path: string): string {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is mode ${mode.toString(8)}: the RTMP URL file must be mode 600`
    )
  }
  return readFileSync(path, 'utf8').trim()
}

export const nodeDeps: PublisherDeps = {
  spawn: (command, args) =>
    nodeSpawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    }),
  connect: (host, port) => netConnect({ host, port }),
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => {
    clearInterval(handle as NodeJS.Timeout)
  },
  sleep: async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  },
  readSecret: readSecretFile,
  log: line => {
    console.log(line)
  }
}

export interface SyntheticPublisherOptions {
  /** The suite's pinned ffmpeg, from the local settings. */
  ffmpeg: string
  /** A mode-600 file holding the rtmp:// URL with its key. */
  urlFile: string
  label: string
  fps?: number
  /** The bench clock's offset from UTC, so the burned clock reads as local time. */
  offsetMinutes?: number
  /** Encoder arguments, HEVC by default. */
  videoArgs?: string[]
}

export const DEFAULT_VIDEO_ARGS = [
  '-c:v',
  'libx265',
  '-preset',
  'ultrafast',
  '-tune',
  'zerolatency',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '60'
]

/** ffmpeg's arguments: raw frames on stdin, raw audio on fd 3, FLV on stdout. */
export function ffmpegArgs(options: {
  fps: number
  tsOffsetSec: number
  videoArgs: string[]
}): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${WIDTH}x${HEIGHT}`,
    '-r',
    String(options.fps),
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
    ...options.videoArgs,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-output_ts_offset',
    options.tsOffsetSec.toFixed(3),
    '-f',
    'flv',
    'pipe:1'
  ]
}

/** Takes the URL and its parts out of a line before anything logs it. */
export function redact(line: string, secrets: string[]): string {
  let out = line
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('[redacted]')
  }
  return out
}

interface Leg {
  child: ChildLike
  rtmp: RtmpPublisher
  timer: unknown
  exited: Promise<void>
}

export class SyntheticPublisher {
  private leg: Leg | null = null
  private startMs = 0
  private nextIndex = 0
  private target: RtmpTarget | null = null
  private secrets: string[] = []
  private readonly fps: number
  /** Every argument list ffmpeg was started with, for the record (no URL in any). */
  readonly launches: string[][] = []

  constructor(
    private readonly options: SyntheticPublisherOptions,
    private readonly deps: PublisherDeps = nodeDeps
  ) {
    this.fps = options.fps ?? FPS
  }

  get running(): boolean {
    return this.leg != null
  }

  async start(): Promise<void> {
    if (this.leg != null)
      throw new Error('the synthetic publisher is already running')
    const url = this.deps.readSecret(this.options.urlFile)
    this.target = parseRtmpUrl(url)
    this.secrets = [url, this.target.key, this.target.tcUrl]
    this.startMs = this.deps.now()
    this.nextIndex = 0
    await this.open(0)
  }

  private async open(tsOffsetSec: number): Promise<void> {
    const target = this.target!
    const rtmp = new RtmpPublisher(
      this.deps.connect(target.host, target.port),
      target
    )
    try {
      await rtmp.open()
    } catch (error) {
      rtmp.close()
      throw new Error(redact((error as Error).message, this.secrets))
    }
    const args = ffmpegArgs({
      fps: this.fps,
      tsOffsetSec,
      videoArgs: this.options.videoArgs ?? DEFAULT_VIDEO_ARGS
    })
    this.launches.push(args)
    const child = this.deps.spawn(this.options.ffmpeg, args)
    const flv = new FlvReader()
    child.stdout?.on('data', data => {
      try {
        for (const tag of flv.push(data)) rtmp.sendTag(tag)
      } catch (error) {
        this.deps.log(
          `synthetic publisher: ${redact((error as Error).message, this.secrets)}`
        )
      }
    })
    child.stderr?.on('data', data => {
      for (const line of data.toString('utf8').split('\n')) {
        if (line.trim() !== '')
          this.deps.log(`ffmpeg: ${redact(line, this.secrets)}`)
      }
    })
    // A pipe to an ffmpeg that has gone answers EPIPE: logged, never thrown,
    // since an unheard pipe error ends the whole run.
    for (const [pipe, stream] of [
      ['stdin', child.stdin],
      ['audio', child.stdio[3]]
    ] as const) {
      ;(stream as ChildLike['stdin'])?.on?.('error', error => {
        this.deps.log(`synthetic publisher: ffmpeg ${pipe}: ${error.message}`)
      })
    }
    let gone = false
    const exited = new Promise<void>(resolve => {
      child.on('exit', () => {
        gone = true
        resolve()
      })
    })
    const timer = this.deps.setInterval(
      () => {
        if (!gone) this.pump(child)
      },
      Math.floor(1000 / this.fps)
    )
    this.leg = { child, rtmp, timer, exited }
    // Start where the wall clock is: a restart never replays the frames of a cut.
    this.nextIndex = Math.floor(
      ((this.deps.now() - this.startMs) * this.fps) / 1000
    )
  }

  /** Writes every frame (and its sound) the wall clock has reached. */
  pump(child: ChildLike): void {
    const due = Math.floor(((this.deps.now() - this.startMs) * this.fps) / 1000)
    const audio = child.stdio[3] as
      { write: (data: Buffer) => boolean } | undefined
    while (this.nextIndex <= due) {
      const index = this.nextIndex++
      child.stdin?.write(
        renderFrame({
          index,
          startEpochMs: this.startMs,
          label: this.options.label,
          fps: this.fps,
          offsetMinutes: this.options.offsetMinutes
        })
      )
      const [from, count] = samplesForFrame(index, this.fps)
      audio?.write(renderAudio(from, count))
    }
  }

  /** Abruptly, as a camera that lost its link; or gracefully, letting ffmpeg finish. */
  private async close(graceful: boolean): Promise<void> {
    const leg = this.leg
    if (leg == null) return
    this.leg = null
    this.deps.clearInterval(leg.timer)
    if (graceful) {
      leg.child.stdin?.end()
      ;(leg.child.stdio[3] as { end?: () => unknown } | undefined)?.end?.()
      const timedOut = await Promise.race([
        leg.exited.then(() => false),
        this.deps.sleep(10_000).then(() => true)
      ])
      if (timedOut) leg.child.kill('SIGKILL')
      leg.rtmp.close()
      return
    }
    leg.rtmp.close()
    leg.child.kill('SIGKILL')
    await leg.exited
  }

  /** Drops the source for `seconds`, then brings it back. */
  async cut(
    seconds: number,
    options: { discontinuity?: boolean } = {}
  ): Promise<void> {
    if (this.leg == null)
      throw new Error('the synthetic publisher is not running')
    await this.close(false)
    await this.deps.sleep(seconds * 1000)
    const offset =
      options.discontinuity === true
        ? 0
        : (this.deps.now() - this.startMs) / 1000
    await this.open(offset)
  }

  /** Ends the stream as a camera that stopped: ffmpeg flushes, then the connection closes. */
  async stop(): Promise<void> {
    await this.close(true)
  }
}
