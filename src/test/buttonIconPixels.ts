import assert from 'node:assert/strict'

import { PNG } from 'pngjs'

/** Measure painted glyphs against their circular targets, in native points. */
export function assertButtonIconCenters(
  buffer: Buffer,
  geometry: Buffer,
  options: {
    targets?: number
    measured?: number
    diameter?: number
    dimensions?: boolean
  } = {}
): number[][] {
  const png = PNG.sync.read(buffer)
  const { width, height, data } = png
  const blank = PNG.sync.read(geometry)
  assert.equal(blank.width, width, 'Geometry capture width must match')
  assert.equal(blank.height, height, 'Geometry capture height must match')
  const seen = new Uint8Array(width * height)
  const discs: number[][] = []
  const isDisc = (i: number): boolean =>
    blank.data[i * 4] === 226 &&
    blank.data[i * 4 + 1] === 232 &&
    blank.data[i * 4 + 2] === 217
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] !== 0 || !isDisc(i)) continue
    const stack = [i]
    seen[i] = 1
    let left = width
    let top = height
    let right = 0
    let bottom = 0
    let count = 0
    while (stack.length > 0) {
      const pixel = stack.pop()!
      const x = pixel % width
      const y = Math.floor(pixel / width)
      count++
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      for (const next of [pixel - 1, pixel + 1, pixel - width, pixel + width]) {
        if (
          next >= 0 &&
          next < seen.length &&
          seen[next] === 0 &&
          isDisc(next)
        ) {
          seen[next] = 1
          stack.push(next)
        }
      }
    }
    if (count > 1000) discs.push([left, top, right, bottom])
  }
  // Counters inside home/pin/vector outlines also have the target color.
  // Keep only outer components; enclosed islands are not separate buttons.
  const targets = discs.filter(
    (box, index) =>
      !discs.some(
        (outer, other) =>
          index !== other &&
          outer[0] <= box[0] &&
          outer[1] <= box[1] &&
          outer[2] >= box[2] &&
          outer[3] >= box[3]
      )
  )
  targets.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]))
  assert.equal(
    targets.length,
    options.targets ?? 13,
    'Every expected enabled target must be visible'
  )
  return targets
    .slice(0, options.measured ?? 12)
    .map(([left, top, right, bottom], index) => {
      const pixelsPerPoint = (right - left + 1) / (options.diameter ?? 48)
      let inkLeft = width
      let inkTop = height
      let inkRight = -1
      let inkBottom = -1
      // Geometry comes from a separate capture with artwork hidden. Scan past
      // its edge, so painted-over borders and outside ink cannot evade the gate.
      const margin = Math.ceil(pixelsPerPoint * 4)
      const cx = (left + right) / 2
      const cy = (top + bottom) / 2
      const radius = (right - left + 1) / 2
      for (
        let y = Math.max(0, top - margin);
        y <= Math.min(height - 1, bottom + margin);
        y++
      )
        for (
          let x = Math.max(0, left - margin);
          x <= Math.min(width - 1, right + margin);
          x++
        ) {
          const pixel = (y * width + x) * 4
          if (
            data[pixel] < 90 &&
            data[pixel + 1] < 105 &&
            data[pixel + 2] < 85
          ) {
            assert(
              (x - cx) ** 2 + (y - cy) ** 2 <= (radius + 1) ** 2,
              `Glyph ${index} overflows its target`
            )
            inkLeft = Math.min(inkLeft, x)
            inkRight = Math.max(inkRight, x)
            inkTop = Math.min(inkTop, y)
            inkBottom = Math.max(inkBottom, y)
          }
        }
      assert(inkRight >= 0, `Glyph ${index} must be painted`)
      const dx = (inkLeft + inkRight - left - right) / 2 / pixelsPerPoint
      const dy = (inkTop + inkBottom - top - bottom) / 2 / pixelsPerPoint
      // One point accommodates rasterization and the check path's half-unit
      // asymmetry, but rejects a missing 0.1em correction at either font size.
      assert(
        Math.abs(dx) <= 1 && Math.abs(dy) <= 1,
        `Glyph ${index} is off center: (${dx.toFixed(2)}, ${dy.toFixed(2)})pt`
      )
      assert(
        inkLeft > left &&
          inkRight < right &&
          inkTop > top &&
          inkBottom < bottom,
        `Glyph ${index} must not overflow its target`
      )
      return options.dimensions === true
        ? [
            dx,
            dy,
            (inkRight - inkLeft + 1) / pixelsPerPoint,
            (inkBottom - inkTop + 1) / pixelsPerPoint
          ]
        : [dx, dy]
    })
}
