import { execFile } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { MaestroDevice } from '../../core/maestro'
import type { E2eContext } from '../../core/spec'
import { boxOf, flatten, type Node } from '../app/keyboardDock'

const exec = promisify(execFile)

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
  return product / Math.sqrt(norm * (squares - (sum * sum) / template.length))
}

export async function measureComposerMotion(
  ctx: E2eContext,
  device: MaestroDevice,
  action: () => Promise<void>,
  name = 'composer-motion'
): Promise<{ up: boolean; down: boolean }> {
  const boxes = flatten((await device.hierarchy()) as Node)
  const plus = boxOf(boxes.find(node => node.id === 'chat-attachment-toggle'))
  const root = boxes
    .map(boxOf)
    .filter(box => box != null)
    .reduce(
      (acc, box) => ({
        width: Math.max(acc.width, box.x + box.width),
        height: Math.max(acc.height, box.y + box.height)
      }),
      { width: 0, height: 0 }
    )
  if (plus == null || root.width <= 0 || root.height <= 0)
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
  const scale = stream.width / root.width
  const cx = Math.round((plus.x + plus.width / 2) * scale)
  const cy = Math.round(
    ((plus.y + plus.height / 2) * stream.height) / root.height
  )
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
  const positions = frames.map((frame, index) => {
    let best = 0.88
    let row: number | null = null
    for (let y = half; y <= Math.min(rest + half, rows - half - 1); y++) {
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
  const raised = Math.min(...present.map(p => p.y))
  const atTop = present.find(p => p.y === raised)!
  const countIntermediate = (
    leg: typeof present,
    direction: -1 | 1
  ): number => {
    let previous = direction === -1 ? rest : raised
    let steps = 0
    for (const { y } of leg) {
      if (y <= raised + 1 || y >= rest - 1 || (y - previous) * direction < 2)
        continue
      previous = y
      steps++
    }
    return steps
  }
  const up = countIntermediate(present.slice(0, present.indexOf(atTop)), -1)
  const down = countIntermediate(present.slice(present.indexOf(atTop) + 1), 1)
  const last = present.at(-1)!
  const returned =
    last.y >= rest - 1 &&
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
      raised,
      up,
      down,
      returned,
      positions
    })
  )
  return { up: up >= 3, down: down >= 3 && returned }
}
