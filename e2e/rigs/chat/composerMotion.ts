import { execFile } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { MaestroDevice } from '../../core/maestro'
import type { E2eContext } from '../../core/spec'
import { boxOf, flatten, type Node } from '../app/keyboardDock'

const exec = promisify(execFile)

interface Point {
  x: number
  y: number
}

export type ReverseKeyboardDrag = (options: {
  qualifiedDevice: string
  platform: 'ios' | 'android'
  from: Point
  turn: Point
  to: Point
}) => Promise<void>

/** A local operator may supply a same-contact gesture that the Hub does not expose. */
export function keyboardDragAdapter(): ReverseKeyboardDrag | undefined {
  const path = process.env.TS_CHAT_REVERSE_DRAG_ADAPTER
  if (path == null || path === '') return undefined
  if (!isAbsolute(path))
    throw new Error(
      'TS_CHAT_REVERSE_DRAG_ADAPTER must be an absolute local path'
    )
  const adapter: { reverseKeyboardDrag?: ReverseKeyboardDrag } = require(path)
  if (typeof adapter.reverseKeyboardDrag !== 'function')
    throw new Error('The gesture adapter must export reverseKeyboardDrag')
  return adapter.reverseKeyboardDrag
}

/** The correlation of the plus glyph with this row of the recorded control lane. */
function similarity(
  template: number[],
  norm: number,
  lane: Buffer,
  offset: number
): number {
  let sum = 0
  let squares = 0
  let product = 0
  for (let i = 0; i < template.length; i++) {
    const value = lane[offset + i]
    sum += value
    squares += value * value
    product += template[i] * value
  }
  const variance = squares - (sum * sum) / template.length
  // A flat patch has no glyph to match.
  return variance <= 0 ? 0 : product / Math.sqrt(norm * variance)
}

export async function measureComposerMotion(
  ctx: E2eContext,
  device: MaestroDevice,
  action: () => Promise<void>,
  name: string,
  reverseDistance?: number
): Promise<{ up: boolean; down: boolean }> {
  const hierarchy = (await device.hierarchy()) as Node
  const boxes = flatten(hierarchy)
  const plus = boxOf(boxes.find(node => node.id === 'chat-attachment-toggle'))
  // Off-screen history rows can extend beyond the actual viewport.
  const viewport =
    boxOf(hierarchy) ??
    boxOf(boxes.find(node => node.id === 'chat-message-history'))
  if (plus == null || viewport == null || viewport.width <= 0)
    throw new Error(
      'Cannot locate the resting composer in the device hierarchy'
    )
  const file = ctx.artifact(name + '.mp4')
  const controller = new AbortController()
  const movie = await device.stream({
    fps: 60,
    audio: false,
    signal: controller.signal
  })
  let streamFailure: Error | undefined
  const recording = pipeline(
    Readable.fromWeb(movie.body),
    createWriteStream(file)
  ).catch((error: unknown) => {
    if (!controller.signal.aborted)
      streamFailure = error instanceof Error ? error : new Error(String(error))
  })
  try {
    await wait(900)
    await action()
    await wait(900)
  } finally {
    controller.abort()
    await recording
  }
  if (streamFailure != null) throw streamFailure
  const { stdout: metadata } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,duration:frame=best_effort_timestamp_time',
    '-of',
    'json',
    file
  ])
  const {
    frames,
    streams: [stream]
  } = JSON.parse(metadata) as {
    frames: Array<{ best_effort_timestamp_time: string }>
    streams: Array<{ width: number; height: number; duration: string }>
  }
  const scale = stream.width / viewport.width
  const cx = Math.round((plus.x + plus.width / 2) * scale)
  const cy = Math.round((plus.y + plus.height / 2) * scale)
  const cropWidth = 2 * Math.round(plus.width * scale * 0.21)
  const top = Math.floor((stream.height * 0.35) / 2) * 2
  const columns = 12
  const rows = Math.round(((stream.height - top) * columns) / cropWidth)
  const { stdout: pixels } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `crop=${cropWidth}:ih-${top}:${cx - cropWidth / 2}:${top},scale=${columns}:${rows},format=gray`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }
  )
  if (frames.length === 0 || pixels.length !== frames.length * rows * columns)
    throw new Error('Incomplete frame timestamps or image data')
  const half = 5
  const rest = Math.round(((cy - top) * rows) / (stream.height - top))
  if (rest < half || rest >= rows - half)
    throw new Error('The composer lies outside the measured control lane')
  const raw = Array.from(
    pixels.subarray((rest - half) * columns, (rest + half + 1) * columns)
  )
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length
  const template = raw.map(value => value - mean)
  const norm = template.reduce((total, value) => total + value * value, 0)
  if (norm < 100 * template.length)
    throw new Error('The resting plus has insufficient contrast')
  const lower = reverseDistance == null ? half : Math.max(half, rest - half)
  const upper = Math.min(
    rows - half - 1,
    rest +
      half +
      Math.ceil(((reverseDistance ?? 0) * rows * scale) / (stream.height - top))
  )

  const positions = frames.map((frame, index) => {
    let best = 0.88
    let row: number | null = null
    for (let y = lower; y <= upper; y++) {
      const score = similarity(
        template,
        norm,
        pixels,
        (index * rows + y - half) * columns
      )
      if (score > best) {
        best = score
        row = y
      }
    }
    return { seconds: Number(frame.best_effort_timestamp_time), row }
  })
  const present = positions.flatMap((p, i) =>
    p.row == null ? [] : [{ i, y: p.row }]
  )
  if (present.length === 0)
    throw new Error('The composer was never visible in the recording')
  const firstLegUp = reverseDistance == null
  const positionsY = present.map(p => p.y)
  const extreme = firstLegUp ? Math.min(...positionsY) : Math.max(...positionsY)
  const turn = present.findIndex(p => p.y === extreme)
  const countIntermediate = (
    leg: typeof present,
    from: number,
    to: number
  ): number => {
    const direction = Math.sign(to - from)
    let previous = from
    let steps = 0
    for (const { y } of leg) {
      if (
        (y - from) * direction <= 1 ||
        (to - y) * direction <= 1 ||
        (y - previous) * direction < 1
      )
        continue
      previous = y
      steps++
    }
    return steps
  }
  const outward = countIntermediate(present.slice(0, turn), rest, extreme)
  const inward = countIntermediate(present.slice(turn + 1), extreme, rest)
  const up = firstLegUp ? outward : inward
  const down = firstLegUp ? inward : outward
  const last = present.at(-1)!
  const returned =
    Math.abs(last.y - rest) <= 1 &&
    positions.at(-1)!.seconds - positions[last.i].seconds < 0.25
  writeFileSync(
    ctx.artifact(name + '.json'),
    JSON.stringify({
      duration: Number(stream.duration),
      frames: frames.length,
      averageFps: frames.length / Number(stream.duration),
      scale,
      cropWidth,
      top,
      columns,
      rows,
      rest,
      extreme,
      firstLegUp,
      up,
      down,
      returned,
      positions
    })
  )
  return {
    up: up >= 3 && (firstLegUp || returned),
    down: down >= 3 && (!firstLegUp || returned)
  }
}
