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

/**
 * Every video frame's presentation time in a recording, in seconds and in
 * order, as ffprobe lists its packets.
 */
export function frameTimes(file: string, run: RunTool = runTool): number[] {
  const probe = run(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', 'v:0'],
      ...['-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]
    ],
    { maxBuffer: 1 << 28 }
  )
  if (probe.status !== 0) {
    throw new Error(`ffprobe could not read ${file}: ${probe.stderr}`)
  }
  return probe.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(Number)
    .sort((a, b) => a - b)
}

/**
 * Each whole frame of a recording, `width` by `height`, in grayscale, handed
 * to `onFrame` one at a time as FFmpeg decodes it and never kept: a long
 * recording's frames would not fit in memory. A frame's `data` is reused for
 * the next, so `onFrame` reads it before it returns. Answers how many frames
 * there were.
 */
export async function eachGrayFrame(
  file: string,
  size: { width: number; height: number },
  onFrame: (frame: GrayFrame, n: number) => void,
  run: StreamTool = spawn
): Promise<number> {
  const bytes = size.width * size.height
  const buffer = new Uint8Array(bytes)
  const frame: GrayFrame = { ...size, data: buffer }
  let filled = 0
  let n = 0
  const ffmpeg = run(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error', '-i', file],
      ...['-map', '0:v:0', '-fps_mode', 'passthrough'],
      ...['-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  ffmpeg.stdout?.on('data', (chunk: Buffer) => {
    let offset = 0
    while (offset < chunk.length) {
      const take = Math.min(bytes - filled, chunk.length - offset)
      buffer.set(chunk.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled === bytes) {
        onFrame(frame, n++)
        filled = 0
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg could not read ${file}: exit ${code}`))
    })
  })
  return n
}

/**
 * The first frame of a video or picture file, raw: one byte a pixel in
 * `gray`, three in `rgb24`, scaled to `width` by `height` when both are
 * given. Null when FFmpeg decodes no frame from it.
 */
export async function decodeFirstFrame(
  file: string,
  options: { pixFmt: 'gray' | 'rgb24'; width?: number; height?: number },
  run: StreamTool = spawn
): Promise<Uint8Array | null> {
  const scale =
    options.width == null || options.height == null
      ? []
      : ['-vf', `scale=${options.width}:${options.height}`]
  const ffmpeg = run(
    'ffmpeg',
    [
      ...['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file],
      ...scale,
      ...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', options.pixFmt],
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const chunks: Buffer[] = []
  ffmpeg.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  const code = await new Promise<number | null>(resolve => {
    ffmpeg.on('error', () => {
      resolve(null)
    })
    ffmpeg.on('close', resolve)
  })
  const bytes = Buffer.concat(chunks)
  return code === 0 && bytes.length > 0 ? new Uint8Array(bytes) : null
}

/** What `hlsFixture` encodes: a test picture with no sound, as H.264 HLS. */
export interface HlsFixtureOptions {
  seconds: number
  /** `<width>x<height>`. */
  size: string
  fps: number
  /** Frames between keyframes. */
  gop: number
  segmentSeconds: number
}

/**
 * Encodes a test picture into `dir` as an event playlist with no end,
 * `master.m3u8`, and its `.ts` segments, as a live stream still being
 * written looks; answers the files' names, the playlist first.
 */
export function hlsFixture(
  dir: string,
  options: HlsFixtureOptions,
  run: RunTool = runTool
): string[] {
  mkdirSync(dir, { recursive: true })
  const made = run('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...[
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${options.size}:rate=${options.fps}`
    ],
    ...['-t', String(options.seconds), '-an'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(options.gop)],
    ...['-f', 'hls', '-hls_time', String(options.segmentSeconds)],
    ...['-hls_list_size', '0', '-hls_playlist_type', 'event'],
    ...['-hls_flags', 'omit_endlist', join(dir, 'master.m3u8')]
  ])
  if (made.status !== 0) throw new Error(`FFmpeg failed: ${made.stderr}`)
  return [
    'master.m3u8',
    ...readdirSync(dir)
      .filter(name => name.endsWith('.ts'))
      .sort()
  ]
}

/** A rectangle of a picture's own pixels, its corner and its size. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

const evenPixels = (value: number): number =>
  Math.max(2, Math.floor(value / 2) * 2)

/**
 * The mean luma difference between each picture and the one before it,
 * inside `rect`, for a numbered PNG sequence (`%06d.png`) or a video: one
 * FFmpeg pass, crop, `tblend` difference against the previous frame, and
 * `signalstats`' mean of it. Entry `i` compares picture `i + 1` with picture
 * `i`, so the series is one shorter than the pictures.
 */
export function lumaDiffs(
  input: { pattern: string } | { video: string },
  rect: PixelRect,
  run: RunTool = runTool
): number[] {
  const source =
    'pattern' in input
      ? ['-framerate', '1', '-i', input.pattern]
      : ['-i', input.video]
  const filter =
    `crop=${evenPixels(rect.w)}:${evenPixels(rect.h)}:${Math.round(rect.x)}:${Math.round(rect.y)},` +
    'format=gray,tblend=all_mode=difference,signalstats,' +
    'metadata=print:key=lavfi.signalstats.YAVG:file=-'
  const ran = run('ffmpeg', [
    ...['-nostdin', '-loglevel', 'error', ...source],
    ...['-vf', filter, '-f', 'null', '-']
  ])
  if (ran.status !== 0) {
    throw new Error(`ffmpeg could not compare the pictures: ${ran.stderr}`)
  }
  // `tblend` emits from the second picture on: one value a pair.
  return [...ran.stdout.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(
    match => Number(match[1])
  )
}

/**
 * The text inside `box` of a PNG, read with tesseract on one line: `digits`
 * turns the box dark on light and reads only digits (a burned-in counter),
 * `white` keeps only the brightest pixels, black on white (a burned-in
 * name). The box is cut out, scaled up and given a white margin first, as
 * tesseract drops a character that touches the edge; that picture is kept at
 * `scratch`.
 */
export function ocrBox(
  png: string,
  box: PixelRect,
  scratch: string,
  mode: 'digits' | 'white',
  run: RunTool = runTool
): string {
  const crop = `crop=${Math.round(box.w)}:${Math.round(box.h)}:${Math.round(box.x)}:${Math.round(box.y)},scale=-2:160,format=gray,`
  const ink = mode === 'digits' ? 'negate' : "lut=c0='if(gt(val,235),0,255)'"
  const cut = run('ffmpeg', [
    ...['-nostdin', '-loglevel', 'error', '-i', png],
    ...['-vf', `${crop}${ink},pad=iw+120:ih+40:60:20:white`],
    ...['-frames:v', '1', '-y', scratch]
  ])
  if (cut.status !== 0) {
    throw new Error(`ffmpeg could not cut the box: ${cut.stderr}`)
  }
  const read = run('tesseract', [
    scratch,
    'stdout',
    '--psm',
    '7',
    ...(mode === 'digits' ? ['-c', 'tessedit_char_whitelist=0123456789'] : [])
  ])
  if (read.status !== 0) {
    throw new Error(`tesseract could not read the box: ${read.stderr}`)
  }
  return read.stdout.trim()
}

/**
 * A recording's pictures as a numbered PNG sequence in `dir` (`000001.png`
 * …), `fps` a second, each with its time from the recording's start.
 */
export function stillFrames(
  file: string,
  dir: string,
  fps: number,
  run: RunTool = runTool
): Array<{ file: string; atSec: number }> {
  mkdirSync(dir, { recursive: true })
  const cut = run('ffmpeg', [
    ...['-nostdin', '-loglevel', 'error', '-i', file],
    ...['-vf', `fps=${fps}`, '-start_number', '1', join(dir, '%06d.png')]
  ])
  if (cut.status !== 0) {
    throw new Error(`ffmpeg could not cut ${file}: ${cut.stderr}`)
  }
  return readdirSync(dir)
    .filter(name => /^\d{6}\.png$/.test(name))
    .sort()
    .map((name, index) => ({ file: join(dir, name), atSec: index / fps }))
}

/** Whether FFmpeg sees a sound track in a recording. */
export function hasAudio(file: string, run: RunTool = runTool): boolean {
  return /Stream #\S+.*: Audio:/.test(
    run('ffmpeg', ['-hide_banner', '-i', file]).stderr
  )
}

/**
 * A recording's loudness, as FFmpeg's ebur128 filter measures it: each
 * second's first momentary loudness in LUFS (or `-inf`), by whole second,
 * and the filter's closing summary.
 */
export function momentaryLoudness(
  file: string,
  run: RunTool = runTool
): { seconds: Map<number, string>; summary: string } {
  const measured = run('ffmpeg', [
    ...['-nostdin', '-i', file],
    ...['-vn', '-af', 'ebur128', '-f', 'null', '-']
  ])
  if (measured.status !== 0) {
    throw new Error(`ffmpeg measured nothing in ${file}: ${measured.stderr}`)
  }
  const seconds = new Map<number, string>()
  for (const match of measured.stderr.matchAll(
    /t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)/g
  )) {
    const second = Math.floor(Number(match[1]))
    if (!seconds.has(second)) seconds.set(second, match[2])
  }
  const summary = /Summary:[\s\S]*$/.exec(measured.stderr)?.[0] ?? ''
  return { seconds, summary: summary.trim() }
}

/**
 * A sound file's first `seconds` (the whole of it with null), as 64 kb/s
 * mono MP3 at 24 kHz, in `out`.
 */
export function clipAudio(
  input: string,
  out: string,
  seconds: number | null,
  run: RunTool = runTool
): void {
  const made = run('ffmpeg', [
    ...['-nostdin', '-loglevel', 'error', '-i', input],
    ...(seconds == null ? [] : ['-t', seconds.toFixed(2)]),
    ...['-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1'],
    ...['-y', out]
  ])
  if (made.status !== 0) throw new Error(`FFmpeg cut nothing: ${made.stderr}`)
}

/**
 * Sound files one after another in `out`, as they are (FFmpeg's concat,
 * copying). The list is written under `scratch` and removed after.
 */
export function joinAudio(
  files: string[],
  out: string,
  scratch: string,
  run: RunTool = runTool
): void {
  if (files.length === 0) throw new Error('No sound to join')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'join-'))
  const list = join(dir, 'list.txt')
  try {
    writeFileSync(list, files.map(file => `file '${file}'`).join('\n'))
    const joined = run('ffmpeg', [
      ...['-nostdin', '-loglevel', 'error', '-f', 'concat', '-safe', '0'],
      ...['-i', list, '-c', 'copy', '-y', out]
    ])
    if (joined.status !== 0) {
      throw new Error(`FFmpeg joined nothing: ${joined.stderr}`)
    }
  } finally {
    unlinkSync(list)
    rmdirSync(dir)
  }
}
