import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PNG } from 'pngjs'

import { assertButtonIconCenters } from './buttonIconPixels'

function gallery(offset = 0, blank = false): Buffer {
  const png = new PNG({ width: 750, height: 420 })
  png.data.fill(255)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < (row === 2 ? 1 : 6); col++) {
      const cx = 60 + col * 120
      const cy = 60 + row * 140
      for (let y = cy - 48; y < cy + 48; y++)
        for (let x = cx - 48; x < cx + 48; x++) {
          if ((x - cx + 0.5) ** 2 + (y - cy + 0.5) ** 2 > 48 ** 2) continue
          const ink =
            !blank &&
            Math.abs(x - cx + 0.5) <= 12 &&
            Math.abs(y - cy + 0.5 - offset) <= 12
          png.data.set(
            ink ? [32, 53, 28, 255] : [226, 232, 217, 255],
            (y * png.width + x) * 4
          )
        }
    }
  }
  return PNG.sync.write(png)
}
describe('native button icon pixel centers', function () {
  it('measures every enabled target independently', function () {
    expect(assertButtonIconCenters(gallery())).deep.equals(
      Array.from({ length: 12 }, () => [0, 0])
    )
  })
  it('rejects a two-point baseline regression', function () {
    expect(() => assertButtonIconCenters(gallery(4))).throws('off center')
  })
  it('rejects missing artwork', function () {
    expect(() => assertButtonIconCenters(gallery(0, true))).throws(
      'must be painted'
    )
  })
})
