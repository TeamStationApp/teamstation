import assert from 'node:assert/strict'
import { PNG } from 'pngjs'

/**
 * Safari omits the field's painted nameplates from its accessibility tree.
 * Find the single dashed red empty-position marker on this exercise's field.
 */
export function emptyPitcherTarget(screenshot: Buffer, width: number) {
  const image = PNG.sync.read(screenshot)
  const scale = image.width / width
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = 4 * (y * image.width + x)
      if (
        image.data[index] !== 214 ||
        image.data[index + 1] !== 84 ||
        image.data[index + 2] !== 84
      )
        continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  const w = (right - left + 1) / scale
  const h = (bottom - top + 1) / scale
  assert(
    w >= 30 && w <= 70 && Math.abs(w - h) < 3,
    'One square empty-position marker must be visible'
  )
  return { x: (left + right) / (2 * scale), y: (top + bottom) / (2 * scale) }
}
