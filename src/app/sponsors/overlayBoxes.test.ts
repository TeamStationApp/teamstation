import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  LOGO_MARGIN,
  LOGO_MAX,
  logoBox,
  reelBox,
  VIDEO_ASPECT
} from './overlayBoxes'

const close = (actual: number, expected: number): void => {
  expect(actual).closeTo(expected, 1e-9)
}

describe('the sponsor overlay boxes', () => {
  for (const [name, image] of [
    ['a wide 480 × 120 logo', { width: 480, height: 120 }],
    ['a tall 100 × 400 logo', { width: 100, height: 400 }],
    ['a tiny 10 × 10 logo', { width: 10, height: 10 }]
  ] as const)
    it(`puts ${name} in the upper-right with 5% margins, within a quarter each way, its proportions kept`, () => {
      const box = logoBox(image)
      // 5% of the height above it, and 5% of the width to its right.
      close(box.y, LOGO_MARGIN)
      close(box.x + box.width, 1 - LOGO_MARGIN)
      expect(box.width).at.most(LOGO_MAX + 1e-9)
      expect(box.height).at.most(LOGO_MAX + 1e-9)
      // It reaches one side of its quarter.
      expect(
        Math.max(box.width, box.height),
        'it fills its quarter one way'
      ).closeTo(LOGO_MAX, 1e-9)
      // The frame is 16:9, so its proportions in pixels are kept.
      close((box.width * VIDEO_ASPECT) / box.height, image.width / image.height)
    })

  it('treats a logo whose size is not known yet as square', () => {
    const box = logoBox({ width: 0, height: 0 })
    close(box.height, LOGO_MAX)
    close(box.width * VIDEO_ASPECT, LOGO_MAX)
  })

  it('puts a reel in the scoreboard’s single-camera place, a third each way', () => {
    expect(reelBox()).deep.equals({
      x: 0.01,
      y: 0.01,
      width: 1 / 3,
      height: 1 / 3
    })
  })
})
