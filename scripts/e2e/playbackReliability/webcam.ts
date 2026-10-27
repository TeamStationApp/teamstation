import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Rect } from './motion'

const run = promisify(execFile)

/**
 * The bench camera, which films the phones' glass: the only evidence that is
 * measured rather than reported. Its address is private and comes from
 * `TS_WEBCAM_URL` (an RTSPS URL); nothing about the bench is written here.
 */
export interface Recording {
  file: string
  /** When ffmpeg was started, on this machine's clock. */
  startedAtMs: number
  stop: () => Promise<void>
}

/** Records the camera, stream-copied, until `stop()`; `seconds` caps it. */
export function recordWebcam(
  url: string,
  file: string,
  seconds: number,
  ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg',
  launch: typeof spawn = spawn
): Recording {
  const child: ChildProcess = launch(
    ffmpeg,
    [
      // No -nostdin: `stop()` ends the recording by typing `q` to ffmpeg.
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-tls_verify',
      '0',
      '-timeout',
      '15000000',
      '-i',
      url,
      '-t',
      String(seconds),
      '-c',
      'copy',
      '-y',
      file
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  const done = new Promise<void>(resolve => {
    child.once('exit', () => {
      resolve()
    })
  })
  return {
    file,
    startedAtMs: Date.now(),
    stop: async () => {
      // `q` lets ffmpeg finish the file. A signal is the fallback, so a
      // recorder that does not answer can never hold a run open.
      child.stdin?.end('q')
      const timer = setTimeout(() => {
        child.kill('SIGINT')
      }, 10_000)
      await done
      clearTimeout(timer)
    }
  }
}

/** One frame of a video at `atSec`, as `width × height` bytes of luma. */
export async function grayFrame(
  video: string,
  atSec: number,
  width: number,
  height: number,
  ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'
): Promise<Uint8Array> {
  const { stdout } = await run(
    ffmpeg,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-ss',
      String(atSec),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height},format=gray`,
      '-f',
      'rawvideo',
      '-'
    ],
    { encoding: 'buffer', maxBuffer: 1 << 26 }
  )
  return new Uint8Array(stdout)
}

/**
 * The phones' screens, found by showing a white page and then a black one on
 * every phone and comparing two frames of the camera: the glass is what got
 * much brighter. Returns each screen's box in the camera's source pixels,
 * left to right, from grids of `width × height` luma scaled from a source of
 * `sourceWidth` pixels across.
 */
export function screensFromCalibration(
  white: Uint8Array,
  black: Uint8Array,
  width: number,
  height: number,
  sourceWidth: number,
  options: { threshold?: number; minCells?: number } = {}
): Rect[] {
  const threshold = options.threshold ?? 60
  const minCells = options.minCells ?? Math.round(width * height * 0.004)
  const lit = new Uint8Array(width * height)
  for (let i = 0; i < lit.length; i++)
    lit[i] = white[i] - black[i] > threshold ? 1 : 0
  const seen = new Uint8Array(width * height)
  const boxes: Array<Rect & { cells: number }> = []
  for (let start = 0; start < lit.length; start++) {
    if (lit[start] === 0 || seen[start] === 1) continue
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let cells = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const at = stack.pop()!
      const x = at % width
      const y = (at - x) / width
      cells++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      for (const next of [at - 1, at + 1, at - width, at + width]) {
        if (next < 0 || next >= lit.length) continue
        if (Math.abs((next % width) - x) > 1) continue
        if (lit[next] === 1 && seen[next] === 0) {
          seen[next] = 1
          stack.push(next)
        }
      }
    }
    if (cells >= minCells) {
      boxes.push({
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        cells
      })
    }
  }
  const scale = sourceWidth / width
  return boxes
    .sort((a, b) => a.x - b.x)
    .map(box => ({
      x: box.x * scale,
      y: box.y * scale,
      w: box.w * scale,
      h: box.h * scale
    }))
}

/** Each frame's time in a recording, from ffprobe, for pairing with `diffSeries`. */
export async function frameTimes(
  video: string,
  ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe'
): Promise<number[]> {
  const { stdout } = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      video
    ],
    { maxBuffer: 1 << 26 }
  )
  return stdout
    .split('\n')
    .map(line => line.trim().replace(/,$/, ''))
    .filter(line => line !== '' && line !== 'N/A')
    .map(seconds => Math.round(Number(seconds) * 1000))
}

/** A frame the camera took of the glass, and when the glass showed it. */
export interface CameraShot {
  atMs: number
  file: string
}

export interface StepCapture {
  /** Ends the capture early; the frames so far are kept. */
  stop: () => Promise<void>
  /** Every frame written, timed, once the capture has ended. */
  frames: () => Promise<CameraShot[]>
}

/**
 * Films one phone for one step: the camera's stream cropped to `box` (camera
 * pixels), `fps` frames a second, into `dir` as 000001.png on. The phone does
 * no work for it, where a screenshot makes it stop and copy its own screen.
 *
 * Each frame is timed by its own timestamp in the stream, from where the
 * first one reached this machine, less `latencyMs` — how long the camera
 * takes to deliver what the glass showed, measured once (`cameraLatencyMs`)
 * by this same timing, so its own delays cancel out.
 */
export function captureStep(
  url: string,
  box: Rect,
  dir: string,
  seconds: number,
  latencyMs: number,
  fps = 8,
  ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg',
  launch: typeof spawn = spawn,
  now: () => number = Date.now,
  /** Scales the cropped picture to this many pixels across; left out, kept. */
  width?: number
): StepCapture {
  mkdirSync(dir, { recursive: true })
  const crop =
    `crop=${Math.round(box.w)}:${Math.round(box.h)}:${Math.round(box.x)}:${Math.round(box.y)}` +
    (width == null ? '' : `,scale=${width}:-2`)
  const child: ChildProcess = launch(
    ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'info',
      '-rtsp_transport',
      'tcp',
      '-tls_verify',
      '0',
      '-timeout',
      '15000000',
      '-i',
      url,
      '-t',
      String(seconds),
      '-vf',
      `${crop},fps=${fps},showinfo`,
      '-start_number',
      '1',
      '-y',
      join(dir, '%06d.png')
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  const times: number[] = []
  let anchor: { atMs: number; ptsSec: number } | null = null
  let pending = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const pts = /showinfo.*\bpts_time:\s*(-?[0-9.]+)/.exec(line)
      if (pts == null) continue
      const ptsSec = Number(pts[1])
      anchor ??= { atMs: now(), ptsSec }
      times.push(
        Math.round(anchor.atMs + (ptsSec - anchor.ptsSec) * 1000 - latencyMs)
      )
    }
  })
  const done = new Promise<void>(resolve => {
    child.once('exit', () => {
      resolve()
    })
  })
  const stop = async (): Promise<void> => {
    child.stdin?.end('q')
    const timer = setTimeout(() => {
      child.kill('SIGINT')
    }, 10_000)
    await done
    clearTimeout(timer)
  }
  return {
    stop,
    frames: async () => {
      await done
      // ffmpeg can write a last frame after its last line about one, so the
      // files decide how many there are; one with no line of its own is
      // timed a frame after the one before.
      const written = readdirSync(dir).filter(name =>
        /^\d{6}\.png$/.test(name)
      ).length
      return Array.from({ length: written }, (_, index) => ({
        atMs:
          times[index] ??
          (times.at(-1) ?? now()) + ((index - times.length + 1) * 1000) / fps,
        file: join(dir, `${String(index + 1).padStart(6, '0')}.png`)
      }))
    }
  }
}

/**
 * How long the camera takes to show what the glass did: the first frame of
 * the screen, timed as `captureStep` times them, that is brighter than the
 * middle of its dark and light, less when the screen was turned light.
 * Null when no frame after that turned light.
 */
export function cameraLatencyMs(
  frames: Array<{ atMs: number; luma: number }>,
  lightAtMs: number
): number | null {
  const before = frames.filter(frame => frame.atMs < lightAtMs)
  const dark = Math.min(...before.map(frame => frame.luma))
  const light = Math.max(...frames.map(frame => frame.luma))
  if (!Number.isFinite(dark) || light - dark < 20) return null
  const middle = (dark + light) / 2
  const first = frames.find(
    frame => frame.atMs >= lightAtMs && frame.luma > middle
  )
  return first == null ? null : first.atMs - lightAtMs
}

/** Where a phone's glass is in the camera's picture, and how late the camera is. */
export interface CameraCalibration {
  box: Rect
  latencyMs: number
}

/**
 * Finds one phone's glass in the camera and how late the camera shows it, by
 * turning its screen black and then white (`setScreen`, which the caller does
 * on the phone) while the whole picture is filmed small. The glass is the
 * largest part that turned much brighter; the delay is when that part
 * brightened, less when it was turned white.
 */
export async function calibrateCamera(
  url: string,
  dir: string,
  setScreen: (color: 'black' | 'white' | null) => Promise<void>,
  options: {
    sourceWidth?: number
    sourceHeight?: number
    width?: number
    ffmpeg?: string
    capture?: typeof captureStep
    frame?: typeof grayFrame
    pause?: (ms: number) => Promise<void>
    now?: () => number
  } = {}
): Promise<CameraCalibration> {
  const sourceWidth = options.sourceWidth ?? 2688
  const sourceHeight = options.sourceHeight ?? 1512
  const width = options.width ?? 672
  const height = Math.round((sourceHeight / sourceWidth) * width)
  const pause =
    options.pause ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  const now = options.now ?? Date.now
  const frame = options.frame ?? grayFrame
  const capture = (options.capture ?? captureStep)(
    url,
    { x: 0, y: 0, w: sourceWidth, h: sourceHeight },
    dir,
    8,
    0,
    10,
    options.ffmpeg,
    undefined,
    now,
    width
  )
  await pause(1500)
  await setScreen('black')
  await pause(2000)
  const lightAtMs = now()
  await setScreen('white')
  await pause(2500)
  await setScreen(null)
  await capture.stop()
  const shots = await capture.frames()
  const dark = shots.filter(shot => shot.atMs < lightAtMs - 200).at(-1)
  const light = shots.find(shot => shot.atMs > lightAtMs + 1500)
  if (dark == null || light == null) {
    throw new Error('the camera gave no frames either side of the flash')
  }
  const darkLuma = await frame(dark.file, 0, width, height)
  const lightLuma = await frame(light.file, 0, width, height)
  const boxes = screensFromCalibration(
    lightLuma,
    darkLuma,
    width,
    height,
    sourceWidth
  )
  const box = boxes.sort((a, b) => b.w * b.h - a.w * a.h)[0]
  if (box == null) throw new Error('no screen brightened in the camera')
  // The glass's brightness in every frame, for when it turned.
  const scale = width / sourceWidth
  const lumas = []
  for (const shot of shots) {
    const grid = await frame(shot.file, 0, width, height)
    let sum = 0
    let cells = 0
    for (let y = Math.round(box.y * scale); y < (box.y + box.h) * scale; y++) {
      for (
        let x = Math.round(box.x * scale);
        x < (box.x + box.w) * scale;
        x++
      ) {
        sum += grid[y * width + x]
        cells++
      }
    }
    lumas.push({ atMs: shot.atMs, luma: cells === 0 ? 0 : sum / cells })
  }
  const latencyMs = cameraLatencyMs(lumas, lightAtMs)
  if (latencyMs == null)
    throw new Error('the screen never turned light in the camera')
  return { box, latencyMs }
}
