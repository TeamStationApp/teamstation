import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { loadSettings, type LocalSettings } from '../../core/settings'

/**
 * Whether something on a phone moved through the frames between two places
 * or jumped, read off the bench camera. maestro-d cannot record a real
 * iPhone's screen, and an Android recording stays on the phone where a hub
 * does not fetch it, so the camera is the frame source: its stream is
 * recorded around an action the hub drives, cropped to the phone's screen,
 * and a horizontal edge (the top of Search's field) is followed down the
 * crop's centre column, frame by frame.
 */

/** Where a phone's screen sits in the camera's frame, and its field at rest. */
export interface Crop {
  width: number
  height: number
  x: number
  y: number
  /** The field's top edge at rest, down from the turned crop's top. */
  fieldY: number
  /**
   * A phone held sideways in its cradle shows the app on its side: the
   * crop is turned a quarter, clockwise or not, to stand the app upright.
   */
  turn?: 'cw' | 'ccw'
}

/** `w:h:x:y:fieldY[:cw|:ccw]`, as the local settings hold it. */
export function parseCrop(text: string): Crop {
  const fields = text.split(':')
  const last = fields.at(-1)
  const turn = last === 'cw' || last === 'ccw' ? last : undefined
  const parts = (turn == null ? fields : fields.slice(0, -1)).map(Number)
  if (
    parts.length !== 5 ||
    parts.some(part => !Number.isInteger(part) || part < 0)
  )
    throw new Error(
      `a crop is w:h:x:y:fieldY[:cw|:ccw] in whole pixels, not "${text}"`
    )
  const [width, height, x, y, fieldY] = parts
  return turn == null
    ? { width, height, x, y, fieldY }
    : { width, height, x, y, fieldY, turn }
}

/**
 * The camera and this device's crop, or null when either is not set: the
 * crop is worked out afresh from a camera frame before each run, never kept.
 */
export function webcamFor(
  deviceId: string,
  settings: LocalSettings = loadSettings()
): { url: string; crop: Crop } | null {
  const url = settings.webcam?.url
  const crop = settings.webcam?.crops?.[deviceId]
  return url == null || crop == null ? null : { url, crop: parseCrop(crop) }
}

/** One grayscale frame, row by row. */
export interface Frame {
  width: number
  height: number
  data: Uint8Array
}

type Spawn = typeof spawn

/**
 * Records the camera from before `action` until after it: the stream takes
 * about a second to connect, so recording starts `leadMs` early and runs
 * `tailMs` past the action, which covers a keyboard's whole animation.
 */
export async function record(
  url: string,
  file: string,
  action: () => Promise<void>,
  options: { leadMs?: number; tailMs?: number; run?: Spawn } = {}
): Promise<string> {
  const run = options.run ?? spawn
  const ffmpeg = run(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error'],
      ...['-rtsp_transport', 'tcp', '-tls_verify', '0'],
      ...['-timeout', '15000000', '-i', url, '-c', 'copy', '-y', file]
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const errors: Buffer[] = []
  ffmpeg.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
  let stopping = false
  // Settled the moment ffmpeg fails (no ffmpeg, a camera that will not
  // answer), so the failure is never unhandled while the action runs, and
  // says why.
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', code => {
      if (stopping || code === 0) resolve()
      else
        reject(
          new Error(
            `the camera recording stopped (exit ${code}): ${Buffer.concat(errors).toString().trim()}`
          )
        )
    })
  })
  const failed = done.then(
    () => undefined,
    (error: unknown) => error
  )
  const wait = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  try {
    // A recording that failed to start fails the run before the action.
    const early = await Promise.race([
      failed,
      wait(options.leadMs ?? 1500).then(() => 'waited' as const)
    ])
    if (early !== 'waited' && early !== undefined)
      throw early instanceof Error
        ? early
        : new Error('the camera recording failed to start')
    await action()
    await wait(options.tailMs ?? 1500)
  } finally {
    // ffmpeg finishes the file on an interrupt.
    stopping = true
    ffmpeg.kill('SIGINT')
  }
  await done
  return file
}

/** How many columns down the middle of a phone's screen a frame keeps. */
export const STRIP = 16

/**
 * Every frame of a recording, cropped to the phone, upright, in grayscale,
 * as the strip down its middle that the field's edge is read from.
 */
export async function frames(
  file: string,
  crop: Crop,
  run: Spawn = spawn
): Promise<Frame[]> {
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
        // Only the strip down the middle that `fieldTopPerFrame` reads: a
        // whole phone's frames for half a minute would be hundreds of MB.
        `crop=${strip}:ih:(iw-${strip})/2:0`,
        'format=gray'
      ].join(','),
      ...['-f', 'rawvideo', 'pipe:1']
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const chunks: Buffer[] = []
  ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  await new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg could not read ${file}: exit ${code}`))
    })
  })
  return splitFrames(Buffer.concat(chunks), strip, height)
}

export function splitFrames(
  raw: Uint8Array,
  width: number,
  height: number
): Frame[] {
  const size = width * height
  const out: Frame[] = []
  for (let at = 0; at + size <= raw.length; at += size)
    out.push({ width, height, data: raw.subarray(at, at + size) })
  return out
}

/** The mean brightness of a row across the few columns at the centre. */
function rowLevel(frame: Frame, y: number, half = 3): number {
  const centre = Math.floor(frame.width / 2)
  let sum = 0
  for (let x = centre - half; x <= centre + half; x++)
    sum += frame.data[y * frame.width + x]
  return sum / (half * 2 + 1)
}

/**
 * The field's top edge in each frame: the strongest change in brightness
 * down the centre column within `reach` rows of where it was in the frame
 * before, starting from its place at rest. A camera frame is 30 a second,
 * and a keyboard's animation a quarter of a second, so an edge that moves
 * moves no more than a few dozen rows from one frame to the next.
 */
export function fieldTopPerFrame(
  all: Frame[],
  start: number,
  reach?: number
): number[] {
  const positions: number[] = []
  let last = start
  for (const frame of all) {
    // A keyboard crosses a third of a phone's height in a quarter second:
    // eight frames at 30 a second, so a frame's step is a twelfth of it.
    const near = reach ?? Math.max(60, Math.round(frame.height / 12))
    let best = last
    let strongest = -1
    const from = Math.max(1, last - near)
    const to = Math.min(frame.height - 1, last + near)
    for (let y = from; y <= to; y++) {
      const step = Math.abs(rowLevel(frame, y) - rowLevel(frame, y - 1))
      if (step > strongest) {
        strongest = step
        best = y
      }
    }
    positions.push(best)
    last = best
  }
  return positions
}

/** What one run of positions did between its two places. */
export interface Motion {
  rest: number
  raised: number
  /** The distinct places strictly between, with `tolerance` either side. */
  between: number[]
  animated: boolean
}

/**
 * Whether an edge moved from where it starts to the farthest place it
 * reaches and back, through at least `minimum` places between each way
 * (rather than one jump). `tolerance` absorbs the camera's own shimmer.
 */
export function motionOf(
  positions: number[],
  minimum = 3,
  tolerance = 2
): { up: Motion; down: Motion } {
  if (positions.length === 0) throw new Error('no frames to read')
  const rest = positions[0]
  const raised = positions.reduce((a, b) => (b < a ? b : a), rest)
  const peak = positions.indexOf(raised)
  const between = (run: number[]): number[] => [
    ...new Set(run.filter(y => y > raised + tolerance && y < rest - tolerance))
  ]
  const leg = (run: number[]): Motion => {
    const places = between(run)
    return { rest, raised, between: places, animated: places.length >= minimum }
  }
  return {
    up: leg(positions.slice(0, peak + 1)),
    down: leg(positions.slice(peak))
  }
}

/** The frames' file beside a run's other evidence. */
export function motionFile(runDir: string, name: string): string {
  return join(runDir, `${name}.mp4`)
}
