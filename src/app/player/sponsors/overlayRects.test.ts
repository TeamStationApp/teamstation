import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultScoreboardSettings,
  defaultSponsorSettings,
  type LogoPlacement
} from '../../../common/nodeSettings'
import type { Rect } from '../controlGeometry'
import { boardPlaceSpace, logoRect, reelRect } from './overlayRects'

const close = (actual: number, expected: number, what = ''): void => {
  expect(actual, what).closeTo(expected, 1e-9)
}

const placement = defaultSponsorSettings.logo.single

describe('U17 the sponsor overlay rects', () => {
  for (const tile of [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 40, y: 12, w: 360, h: 202 }
  ] satisfies Rect[])
    for (const [name, natural] of [
      ['a wide 480 × 120 logo', { width: 480, height: 120 }],
      ['a tall 100 × 400 logo', { width: 100, height: 400 }],
      ['a tiny 10 × 10 logo', { width: 10, height: 10 }]
    ] as const)
      it(`puts ${name} in a ${tile.w} × ${tile.h} tile's upper-right, 5% in, within its quarter, its proportions kept`, () => {
        const rect = logoRect(tile, placement, natural)
        close(rect.y - tile.y, 0.05 * tile.h, 'top margin')
        close(tile.x + tile.w - (rect.x + rect.w), 0.05 * tile.w, 'side margin')
        expect(rect.w).at.most(0.25 * tile.w + 1e-9)
        expect(rect.h).at.most(0.25 * tile.h + 1e-9)
        // It reaches one side of its box.
        expect(
          Math.abs(rect.w - 0.25 * tile.w) < 1e-9 ||
            Math.abs(rect.h - 0.25 * tile.h) < 1e-9,
          'it fills its box one way'
        ).equals(true)
        close(rect.w / rect.h, natural.width / natural.height, 'aspect')
      })

  it('takes a logo whose size is not known yet as square', () => {
    const rect = logoRect({ x: 0, y: 0, w: 1920, h: 1080 }, placement, {
      width: 0,
      height: 0
    })
    close(rect.w, rect.h)
    close(rect.h, 270)
  })

  it('honours a custom placement', () => {
    const custom: LogoPlacement = {
      side: 0.1,
      top: 0.2,
      maxWidth: 0.5,
      maxHeight: 0.1
    }
    const rect = logoRect({ x: 0, y: 0, w: 1000, h: 500 }, custom, {
      width: 200,
      height: 100
    })
    expect(rect).deep.equals({ x: 800, y: 100, w: 100, h: 50 })
  })

  it('puts a reel in the board’s place at its top-left, a third of the screen at most, aspect kept', () => {
    const picture = { x: 0, y: 0, w: 1920, h: 1080 }
    const space = boardPlaceSpace(picture, defaultScoreboardSettings.single)
    close(space.x, 19.2)
    close(space.y, 10.8)
    close(space.w, 1920 - 19.2)
    close(space.h, 1080 - 10.8)
    const rect = reelRect(
      space,
      defaultSponsorSettings.reel.landscape1,
      { width: 1920, height: 1080 },
      16 / 9
    )
    close(rect.x, space.x)
    close(rect.y, space.y)
    close(rect.w, 640)
    close(rect.h, 360)
  })

  it('centres a reel across the top of a free band, inside the band', () => {
    const band = { x: 0, y: 600, w: 390, h: 150 }
    const rect = reelRect(
      band,
      defaultSponsorSettings.reel.portrait12,
      { width: 390, height: 844 },
      16 / 9,
      'band'
    )
    // A third of the screen's width is 130, which fits the band's height.
    close(rect.w, 130)
    close(rect.h, 130 / (16 / 9))
    close(rect.x, (390 - 130) / 2)
    close(rect.y, 600)
  })

  it('shrinks a reel to a space smaller than its third, keeping its aspect', () => {
    const rect = reelRect(
      { x: 10, y: 20, w: 300, h: 90 },
      { maxWidth: 1, maxHeight: 1 },
      { width: 1920, height: 1080 },
      16 / 9
    )
    close(rect.h, 90)
    close(rect.w, 160)
    close(rect.x, 10)
  })

  it('draws nothing for a space with no room, and takes a bad aspect as 16:9', () => {
    const none = reelRect(
      { x: 0, y: 0, w: -5, h: 10 },
      { maxWidth: 1, maxHeight: 1 },
      { width: 100, height: 100 },
      0
    )
    expect(none.w).equals(0)
    expect(none.h).equals(0)
  })
})
