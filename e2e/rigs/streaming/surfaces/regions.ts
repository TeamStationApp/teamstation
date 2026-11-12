import { PNG } from 'pngjs'

/**
 * Whether a tile's picture moved between two screenshots taken a moment apart. It is
 * the same question `e2e/core/video.ts` asks of a recording with ffmpeg's freezedetect,
 * at the same noise floor (0.003 of full scale), asked of two stills per tile instead.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const FROZEN_NOISE = 0.003

export interface Image {
  width: number
  height: number
  /** RGBA, row by row. */
  data: Uint8Array
}

export function decodePng(png: Uint8Array): Image {
  const image = PNG.sync.read(Buffer.from(png))
  return { width: image.width, height: image.height, data: image.data }
}

/** Mean absolute difference over the region, 0–1, sampled every `step` pixels. */
export function regionDifference(
  a: Image,
  b: Image,
  region: Rect,
  step = 2
): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  const x0 = Math.max(0, Math.floor(region.x))
  const y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(a.width, Math.ceil(region.x + region.width))
  const y1 = Math.min(a.height, Math.ceil(region.y + region.height))
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const at = (y * a.width + x) * 4
      sum +=
        Math.abs(a.data[at] - b.data[at]) +
        Math.abs(a.data[at + 1] - b.data[at + 1]) +
        Math.abs(a.data[at + 2] - b.data[at + 2])
      count += 3
    }
  }
  return count === 0 ? 0 : sum / count / 255
}

/** A tile's bounds in screenshot pixels, inset so its border and label are left out. */
export function toPixels(bounds: Rect, scale: number, inset = 0.1): Rect {
  const dx = bounds.width * inset
  const dy = bounds.height * inset
  return {
    x: (bounds.x + dx) * scale,
    y: (bounds.y + dy) * scale,
    width: (bounds.width - 2 * dx) * scale,
    height: (bounds.height - 2 * dy) * scale
  }
}

/** True when the region moved more than the noise floor; null when it is off the image. */
export function regionAdvancing(
  a: Image,
  b: Image,
  bounds: Rect,
  scale: number,
  noise = FROZEN_NOISE
): boolean | null {
  const region = toPixels(bounds, scale)
  if (
    region.width <= 0 ||
    region.height <= 0 ||
    region.x >= a.width ||
    region.y >= a.height
  ) {
    return null
  }
  return regionDifference(a, b, region) > noise
}
