// Reads the test-build time strip and the two colored controls from captured
// pixels. The video clocks come from the synthetic broadcaster's actual media.
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'

import type { Image, Rect } from '../../../e2e/rigs/streaming/surfaces/regions'
import { markerGeometry } from '../scoreboardLog/readMarker'

export interface Point {
  x: number
  y: number
}
export interface Edge extends Point {
  up: boolean
  time: number
}
export interface Sample {
  time: number
  pts: number
  sequence: number
  edges: Edge[]
  slow: boolean
  paused: boolean
  cameras: Array<number | null>
}
const WRAP = 2 ** 24
export const elapsed = (a: number, b: number): number =>
  ((a - b + WRAP / 2 + WRAP) % WRAP) - WRAP / 2

/** Samples within <1 display tick of an edge can contain the previous picture. */
export const DISPLAY_MS = 1000 / 30

interface Strip {
  x: number
  y: number
  cell: number
}
function match(
  rgb: Buffer,
  pixel: number,
  r: number,
  g: number,
  b: number,
  tol = 35
): boolean {
  const i = pixel * 3
  return (
    Math.abs(rgb[i] - r) < tol &&
    Math.abs(rgb[i + 1] - g) < tol &&
    Math.abs(rgb[i + 2] - b) < tol
  )
}
function stripAt(rgb: Buffer, w: number, h: number): Strip | undefined {
  for (let y = 0; y < h / 4; y++) {
    for (let x = 0; x < w / 3; x++) {
      if (!match(rgb, y * w + x, 255, 0, 255, 65)) continue
      let bottom = y + 1
      while (bottom < h && match(rgb, bottom * w + x, 255, 0, 255, 65)) bottom++
      const cell = (bottom - y) / 10
      if (cell < 2) continue
      const row = Math.floor(y + cell * 4.5)
      let left = x
      while (left > 0 && match(rgb, row * w + left - 1, 255, 0, 255, 65)) left--
      // Chroma subsampling can remove a pixel from both ends of the first
      // rail. Find the other rail near the prediction, then use the actual
      // separation of their centers for the cell spacing.
      const from = Math.max(left + 1, Math.floor(left + cell * 25.5 - 8))
      const to = Math.min(w, Math.ceil(left + cell * 25.5 + 8))
      for (let cyan = from; cyan < to; cyan++) {
        if (!match(rgb, row * w + cyan, 0, 255, 255, 70)) continue
        let start = cyan
        let end = cyan
        while (start > 0 && match(rgb, row * w + start - 1, 0, 255, 255, 70))
          start--
        while (end < w - 1 && match(rgb, row * w + end + 1, 0, 255, 255, 70))
          end++
        const exact = ((start + end) / 2 - left) / 25.5
        return { x: left, y: (y + bottom) / 2 - 5 * exact, cell: exact }
      }
    }
  }
}

/** The 1280x720 recording is contained, potentially letterboxed, in each tile. */
function fixtureClock(
  rgb: Uint8Array,
  w: number,
  tile: Rect,
  channels = 3
): number | null {
  const scale = Math.min(tile.width / 1280, tile.height / 720)
  const x = tile.x + (tile.width - 1280 * scale) / 2
  const y = tile.y + (tile.height - 720 * scale) / 2
  const at = (sourceX: number, sourceY: number): number => {
    const i =
      channels *
      (Math.floor(y + sourceY * scale) * w + Math.floor(x + sourceX * scale))
    return (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3
  }
  const m = markerGeometry(720)
  const slot = (bit: number): number =>
    at(m.originX + bit * m.stride + m.cell / 2, m.originY + m.cell / 2)
  if (slot(m.sentinelSlot) < 155 || at(m.originX, m.originY + m.cell + 6) > 100)
    return null
  let time = 0
  for (let i = 0; i < m.bits; i++) if (slot(i) > 128) time += 2 ** i
  return time
}

function imageTiles(screen: Rect, tiles: Rect[], w: number, h: number): Rect[] {
  return tiles.map(r => ({
    x: ((r.x - screen.x) * w) / screen.width,
    y: ((r.y - screen.y) * h) / screen.height,
    width: (r.width * w) / screen.width,
    height: (r.height * h) / screen.height
  }))
}

/** The same source clocks in a full-resolution hub screenshot before contact. */
export function screenshotClocks(
  image: Image,
  screen: Rect,
  tiles: Rect[]
): Array<number | null> {
  return imageTiles(screen, tiles, image.width, image.height).map(tile =>
    fixtureClock(image.data, image.width, tile, 4)
  )
}

export async function samples(
  file: string,
  screen: Rect,
  tiles: Rect[]
): Promise<Sample[]> {
  const meta = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:frame=best_effort_timestamp_time',
        '-of',
        'json',
        file
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
  ) as {
    streams: Array<{ width: number; height: number }>
    frames: Array<{ best_effort_timestamp_time: string }>
  }
  const source = meta.streams[0]
  const w = Math.min(640, source.width)
  const h = 2 * Math.round((w * source.height) / source.width / 2)
  const rects = imageTiles(screen, tiles, w, h)
  const child = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      `scale=${w}:${h}`,
      '-fps_mode',
      'passthrough',
      '-enc_time_base',
      'demux',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const completion = once(child, 'close')
  const result: Sample[] = []
  const frame = Buffer.allocUnsafe(3 * w * h)
  let used = 0
  let index = 0
  let strip: Strip | undefined
  for await (const chunk of child.stdout) {
    let offset = 0
    while (offset < chunk.length) {
      const length = Math.min(frame.length - used, chunk.length - offset)
      chunk.copy(frame, used, offset, offset + length)
      used += length
      offset += length
      if (used !== frame.length) continue
      used = 0
      const pts =
        Number(meta.frames[index++]?.best_effort_timestamp_time) * 1000
      strip ??= stripAt(frame, w, h)
      if (strip == null) continue
      const { x, y, cell } = strip
      if (
        !match(
          frame,
          Math.floor(y + cell * 4.5) * w + Math.floor(x + cell * 0.5),
          255,
          0,
          255,
          65
        )
      ) {
        strip = undefined
        continue
      }
      const words = Array.from({ length: 10 }, (_, row) => {
        let value = 0
        for (let bit = 0; bit < 24; bit++) {
          const i =
            3 *
            (Math.floor(y + (row + 0.5) * cell) * w +
              Math.floor(x + (bit + 1.5) * cell))
          if (frame[i] > 128) value += 2 ** bit
        }
        return value
      })
      let badge = 0
      let play = 0
      for (let py = 0; py < h; py += 3)
        for (let px = 0; px < w; px += 3) {
          if (match(frame, py * w + px, 187, 27, 225, 18)) badge++
          if (match(frame, py * w + px, 24, 228, 154, 18)) play++
        }
      const edges = Array.from({ length: 4 }, (_, i) => {
        const loc = words[3 + 2 * i]
        return {
          time: words[2 + 2 * i],
          up: (loc & (1 << 22)) !== 0,
          x: (loc & 2047) / 2047,
          y: ((loc >> 11) & 2047) / 2047
        }
      })
      result.push({
        pts,
        time: words[0],
        sequence: words[1],
        edges,
        slow: badge >= 22,
        paused: play >= 22,
        cameras: rects.map(r => fixtureClock(frame, w, r))
      })
    }
  }
  const [code] = await completion
  if (code !== 0 || used !== 0 || index !== meta.frames.length)
    throw new Error('Incomplete screen recording')
  return result
}
