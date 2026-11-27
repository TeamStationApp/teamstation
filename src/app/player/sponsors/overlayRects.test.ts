import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultScoreboardSettings,
  defaultSponsorSettings,
  type LogoPlacement
} from '../../../common/nodeSettings'
import type { Rect } from '../controlGeometry'
import {
  boardPlaceSpace,
  livePillTop,
  logoRect,
  reelRect
} from './overlayRects'

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

describe('U19 the live pill beside a sponsor logo', () => {
  // The pill as the default theme draws it: 8 px in, about 52 × 24.
  const pill = { inset: 8, w: 52.4, h: 24.2 }
  const gap = 8
  const pillRect = (width: number, top: number | null): Rect => ({
    x: width - pill.inset - pill.w,
    y: top ?? pill.inset,
    w: pill.w,
    h: pill.h
  })
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  const inside = (inner: Rect, outer: Rect): boolean =>
    inner.y >= outer.y - 1e-9 && inner.y + inner.h <= outer.y + outer.h + 1e-9

  for (const [name, width, picture] of [
    ['a 1280 × 720 card', 1280, { x: 0, y: 0, w: 1280, h: 720 }],
    ['a 360 × 202 phone card', 360, { x: 0, y: 0, w: 360, h: 202 }]
  ] as const)
    it(`keeps the pill inside ${name}'s picture and off the logo for every top a node admin can set, up to 0.99`, () => {
      for (let step = 0; step <= 99; step++) {
        const top = step / 100
        const logo = logoRect(
          picture,
          { ...placement, top },
          { width: 480, height: 120 }
        )
        const at = livePillTop(width, picture, logo, pill, gap)
        const drawn = pillRect(width, at)
        expect(
          inside(drawn, picture),
          `top ${top}: pill in the picture`
        ).equals(true)
        // Off the logo wherever the picture has room below or above it.
        const room =
          logo.y + logo.h + gap + pill.h <= picture.y + picture.h ||
          logo.y - gap - pill.h >= picture.y
        if (room)
          expect(overlaps(drawn, logo), `top ${top}: pill off the logo`).equals(
            false
          )
      }
    })

  it('puts the pill just below a logo in its corner, as the default places it', () => {
    const picture = { x: 0, y: 0, w: 1280, h: 720 }
    const logo = logoRect(picture, placement, { width: 480, height: 120 })
    close(livePillTop(1280, picture, logo, pill, gap)!, logo.y + logo.h + gap)
  })

  it('leaves the pill at its inset for a logo placed low or far from the corner, and for none', () => {
    const picture = { x: 0, y: 0, w: 1280, h: 720 }
    const natural = { width: 480, height: 120 }
    for (const moved of [
      { ...placement, top: 0.8 },
      { ...placement, side: 0.5 }
    ]) {
      const logo = logoRect(picture, moved, natural)
      expect(livePillTop(1280, picture, logo, pill, gap)).equals(null)
    }
    expect(livePillTop(1280, picture, null, pill, gap)).equals(null)
  })

  it('puts the pill above a tall logo that reaches the corner and leaves no room below', () => {
    const picture = { x: 0, y: 0, w: 640, h: 360 }
    const logo = { x: 560, y: 36, w: 80, h: 310 }
    const at = livePillTop(640, picture, logo, pill, gap)
    close(at!, logo.y - gap - pill.h)
  })

  it('leaves the pill at its inset when the logo fills the corner from top to bottom', () => {
    const picture = { x: 0, y: 0, w: 640, h: 360 }
    const logo = { x: 560, y: 10, w: 80, h: 340 }
    expect(livePillTop(640, picture, logo, pill, gap)).equals(null)
  })
})
