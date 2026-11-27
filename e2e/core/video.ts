import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/**
 * Free measurements of a recording, made before anyone pays to look at it. They answer
 * "is the picture up", never a pacing question: smoothness stays on the bench camera.
 */
export interface VideoInterval {
  start: number
  end: number
}

export interface VideoMeasurement {
  durationSec: number
  hasAudio: boolean
  frozen: VideoInterval[]
  black: VideoInterval[]
  silent: VideoInterval[]
}

function intervals(
  log: string,
  startPattern: RegExp,
  endPattern: RegExp,
  durationSec: number
): VideoInterval[] {
  const starts = [...log.matchAll(startPattern)].map(row => Number(row[1]))
  const ends = [...log.matchAll(endPattern)].map(row => Number(row[1]))
  return starts.map((start, index) => ({
    start,
    end: ends[index] ?? durationSec
  }))
}

export function parseMeasurement(log: string): VideoMeasurement {
  const time = /Duration: (\d+):(\d+):([\d.]+)/.exec(log)
  const durationSec =
    time == null
      ? 0
      : Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
  const black = [
    ...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)
  ].map(row => ({ start: Number(row[1]), end: Number(row[2]) }))
  return {
    durationSec,
    hasAudio: /Stream #\S+.*: Audio:/.test(log),
    frozen: intervals(
      log,
      /freeze_start: ([\d.]+)/g,
      /freeze_end: ([\d.]+)/g,
      durationSec
    ),
    black,
    silent: intervals(
      log,
      /silence_start: ([\d.]+)/g,
      /silence_end: ([\d.]+)/g,
      durationSec
    )
  }
}

export function measureVideo(
  path: string,
  ffmpeg = 'ffmpeg'
): VideoMeasurement {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', path], {
    encoding: 'utf8'
  })
  const hasAudio = /Stream #\S+.*: Audio:/.test(probe.stderr)
  const run = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-i',
      path,
      '-vf',
      'freezedetect=n=0.003:d=1,blackdetect=d=0.5:pix_th=0.1',
      ...(hasAudio ? ['-af', 'silencedetect=n=-50dB:d=1'] : []),
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not read ${path}: ${run.stderr.slice(-300)}`)
  }
  return parseMeasurement(run.stderr)
}

/** What is wrong with the recording, in words a report can carry. */
export function videoProblems(
  measured: VideoMeasurement,
  options: { expectAudio?: boolean } = {}
): string[] {
  const total = (rows: VideoInterval[]): number =>
    rows.reduce((sum, row) => sum + (row.end - row.start), 0)
  const problems: string[] = []
  const add = (name: string, rows: VideoInterval[]): void => {
    if (rows.length > 0) {
      problems.push(`${name} for ${total(rows).toFixed(1)}s`)
    }
  }
  add('frozen', measured.frozen)
  add('black', measured.black)
  add('silent', measured.silent)
  if (options.expectAudio === true && !measured.hasAudio) {
    problems.push('no audio track')
  }
  return problems
}

/** A grid of frames, the only form of video an AI judge is shown. */
export function contactSheet(
  path: string,
  outPath: string,
  ffmpeg = 'ffmpeg'
): void {
  const run = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-i',
      path,
      '-vf',
      'fps=1,scale=480:-2,tile=3x3',
      '-frames:v',
      '1',
      outPath
    ],
    { encoding: 'utf8' }
  )
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not sheet ${path}: ${run.stderr.slice(-300)}`)
  }
}

/**
 * The local work a rig asks of a recording: frames read off it, text read
 * off its frames, and frames put together into one. A recording itself is
 * always maestro-d's (`recordScreen` below); FFmpeg and macOS Vision run
 * here, in the assertion layer, and their scratch is under the run's
 * directory.
 */

/** How the layer runs a tool: `spawnSync` with text output, or a stand-in. */
export type RunTool = (
  file: string,
  args: string[],
  options?: { maxBuffer?: number }
) => { status: number | null; stdout: string; stderr: string }

/** How the layer streams a tool's raw output: `spawn`, or a stand-in. */
export type StreamTool = typeof spawn

const runTool: RunTool = (file, args, options = {}) => {
  const ran = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  })
  if (ran.error != null) throw ran.error
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

/** What the device must answer to be recorded through maestro-d. */
export interface RecordableDevice {
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: (options: { path: string }) => Promise<unknown>
  artifact: (file: string) => Promise<Uint8Array>
}

/** The recording a `stopRecording` step names in its data, or the name asked for. */
function recordingOf(result: unknown, name: string): string {
  const data = (result as { data?: unknown } | null)?.data
  return typeof data === 'string' && data !== ''
    ? data
    : `recordings/${name}.mp4`
}

/**
 * Records the device's screen through maestro-d around `action`, and keeps
 * the recording as `<runDir>/<name>.mp4`, which it answers with the time
 * the recording had started by (ms since 1970), to place moments in it. The
 * recording is stopped whatever the action does; a failed action keeps its
 * recording as evidence and still fails.
 */
export async function recordScreen(
  device: RecordableDevice,
  runDir: string,
  name: string,
  action: () => Promise<void>,
  now: () => number = Date.now
): Promise<{ file: string; startedAtMs: number }> {
  await device.startRecording({ path: name })
  const startedAtMs = now()
  let failure: Error | undefined
  try {
    await action()
  } catch (error) {
    failure = error instanceof Error ? error : new Error(JSON.stringify(error))
  }
  const stopped = await device.stopRecording({ path: name })
  mkdirSync(runDir, { recursive: true })
  const file = join(runDir, `${name}.mp4`)
  writeFileSync(file, await device.artifact(recordingOf(stopped, name)))
  if (failure !== undefined) throw failure
  return { file, startedAtMs }
}

/** A recording's picture size, read from FFmpeg's description of it. */
export function videoSize(
  file: string,
  run: RunTool = runTool
): { width: number; height: number } {
  const probe = run('ffmpeg', ['-hide_banner', '-i', file])
  const found = /Stream #\S+.*: Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(
    probe.stderr
  )
  if (found == null) throw new Error(`ffmpeg sees no picture in ${file}`)
  return { width: Number(found[1]), height: Number(found[2]) }
}

/** A recording's length in seconds. */
export function videoSeconds(file: string, run: RunTool = runTool): number {
  const measured = parseMeasurement(
    run('ffmpeg', ['-hide_banner', '-i', file]).stderr
  )
  if (!(measured.durationSec > 0))
    throw new Error(`ffmpeg reads no duration from ${file}`)
  return measured.durationSec
}

/** Where a phone's screen sits in a recording's picture. */
export interface FrameCrop {
  width: number
  height: number
  x: number
  y: number
  /** A quarter turn, clockwise or not, to stand a sideways app upright. */
  turn?: 'cw' | 'ccw'
}

/** One grayscale frame, row by row. */
export interface GrayFrame {
  width: number
  height: number
  data: Uint8Array
}

/** How many columns down the middle of the crop a frame keeps. */
export const STRIP = 16

/** Raw grayscale bytes as frames of `width` by `height`. */
export function splitFrames(
  raw: Uint8Array,
  width: number,
  height: number
): GrayFrame[] {
  const size = width * height
  const out: GrayFrame[] = []
  for (let at = 0; at + size <= raw.length; at += size)
    out.push({ width, height, data: raw.subarray(at, at + size) })
  return out
}

/**
 * Every frame of a recording, cropped, upright, in grayscale, as the strip
 * down the crop's middle that an edge is followed down.
 */
export async function frames(
  file: string,
  crop: FrameCrop,
  run: StreamTool = spawn
): Promise<GrayFrame[]> {
  const turned = crop.turn != null
  const width = turned ? crop.height : crop.width
  const height = turned ? crop.width : crop.height
  const strip = Math.min(STRIP, width)
  const ffmpeg = run(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error', '-i', file],
      '-vf',
      [
        `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
        ...(crop.turn == null
          ? []
          : [`transpose=${crop.turn === 'cw' ? 1 : 2}`]),
        // Only the strip down the middle: a whole phone's frames for half a
        // minute would be hundreds of MB.
        `crop=${strip}:ih:(iw-${strip})/2:0`,
        'format=gray'
      ].join(','),
      ...['-f', 'rawvideo', 'pipe:1']
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const chunks: Buffer[] = []
  ffmpeg.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  await new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg could not read ${file}: exit ${code}`))
    })
  })
  return splitFrames(Buffer.concat(chunks), strip, height)
}

/** A recording's text at one moment. */
export interface FrameText {
  /** The frame's time from the recording's start, in seconds. */
  atSec: number
  lines: string[]
}

/** The macOS Vision reader this layer runs on frames. */
export const OCR_SCRIPT = join(__dirname, 'ocrFrames.swift')

/**
 * The text of a recording from `fromSec` to `toSec`, `fps` frames a second,
 * read with macOS Vision (ocrFrames.swift), each line top to bottom. The
 * frames are written under `scratch` and removed after.
 */
export function framesText(
  file: string,
  scratch: string,
  fromSec: number,
  toSec: number,
  fps = 4,
  run: RunTool = runTool
): FrameText[] {
  const from = Math.max(0, fromSec)
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'frames-'))
  try {
    const cut = run('ffmpeg', [
      ...['-v', 'error', '-ss', String(from), '-i', file],
      ...['-t', String(Math.max(0, toSec - from)), '-vf', `fps=${fps}`],
      join(dir, 'f%04d.png')
    ])
    if (cut.status !== 0)
      throw new Error(`ffmpeg could not cut ${file}: ${cut.stderr.slice(-300)}`)
    const names = readdirSync(dir)
      .filter(name => name.endsWith('.png'))
      .sort()
    if (names.length === 0) return []
    const read = run('swift', [
      OCR_SCRIPT,
      ...names.map(name => join(dir, name))
    ])
    if (read.status !== 0)
      throw new Error(`the frames were not read: ${read.stderr.slice(-300)}`)
    return read.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as { file: string; lines: string[] })
      .map(frame => ({
        atSec: from + names.indexOf(frame.file.split('/').at(-1)!) / fps,
        lines: frame.lines
      }))
  } finally {
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name))
    rmdirSync(dir)
  }
}

/** The text of a recording's last `seconds`, as `framesText` reads it. */
export function lastFramesText(
  file: string,
  scratch: string,
  seconds = 8,
  fps = 4,
  run: RunTool = runTool
): FrameText[] {
  const duration = videoSeconds(file, run)
  return framesText(
    file,
    scratch,
    Math.max(0, duration - seconds),
    duration,
    fps,
    run
  )
}

/** One picture of a series to encode, and when it was painted, in seconds. */
export interface PaintedFrame {
  image: Uint8Array
  at: number
}

/**
 * Puts painted frames together into an MP4 at `out`, each shown until the
 * next (the last for half a second), at 30 frames a second. The pictures
 * are written under `scratch` and removed after, whatever FFmpeg does.
 */
export function encode(
  painted: PaintedFrame[],
  out: string,
  scratch: string,
  run: RunTool = runTool
): void {
  if (painted.length === 0) throw new Error('No frames were painted')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'encode-'))
  try {
    const files = painted.map((frame, i) => {
      const file = join(dir, `frame-${String(i).padStart(5, '0')}.jpg`)
      writeFileSync(file, frame.image)
      return file
    })
    const list = painted.flatMap((frame, i) => [
      `file '${files[i]}'`,
      `duration ${Math.max(0.001, (painted[i + 1]?.at ?? frame.at + 0.5) - frame.at).toFixed(3)}`
    ])
    // The last frame again: FFmpeg's concat leaves the last duration out.
    list.push(`file '${files[files.length - 1]}'`)
    writeFileSync(join(dir, 'frames.txt'), `${list.join('\n')}\n`)
    const made = run('ffmpeg', [
      ...['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0'],
      ...['-i', join(dir, 'frames.txt')],
      ...['-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2'],
      ...['-pix_fmt', 'yuv420p', out]
    ])
    if (made.status !== 0) throw new Error(`FFmpeg failed: ${made.stderr}`)
  } finally {
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name))
    rmdirSync(dir)
  }
}
