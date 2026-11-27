import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultScoreboardSettings,
  defaultSponsorSettings
} from '../../common/nodeSettings'
import type { Rect } from '../player/controlGeometry'
import { intersects } from '../player/scoreboardOverlay/overlayLayout'
import { initialPlayback } from './playbackState'
import { tvLayout } from './tvLayout'

const SCREEN = { width: 1920, height: 1080 }
const SETTINGS = { ...defaultScoreboardSettings, show: true }
const REELS = {
  active: true,
  aspect: 16 / 9,
  placements: defaultSponsorSettings.reel,
  any: true
}
const inside = (rect: Rect, area: Rect): void => {
  expect(rect.x).at.least(area.x - 1e-6)
  expect(rect.y).at.least(area.y - 1e-6)
  expect(rect.x + rect.w).at.most(area.x + area.w + 1e-6)
  expect(rect.y + rect.h).at.most(area.y + area.h + 1e-6)
}
const near = (actual: number, expected: number): void => {
  expect(actual).closeTo(expected, 1e-6)
}

/** U24: the TV's sponsor reel in each count of cameras. */
describe('U24 the TV layout with a sponsor reel', function () {
  it('leaves every count as it was with no reel playing', function () {
    for (let count = 1; count <= 4; count++) {
      const state = initialPlayback(count)
      const plain = tvLayout(state, SCREEN, SETTINGS, true, true)
      expect(plain.reel).equals(null)
      expect(
        tvLayout(state, SCREEN, SETTINGS, true, true, undefined, null)
      ).deep.equals(plain)
      const idle = tvLayout(state, SCREEN, SETTINGS, true, true, undefined, {
        ...REELS,
        active: false
      })
      expect(idle.reel).equals(null)
      // Two cameras are centred either way; three keep their quadrant.
      expect(idle.tiles).deep.equals(plain.tiles)
      expect(idle.box).deep.equals(plain.box)
    }
  })

  it('takes the board’s place on one camera, and on a camera made full', function () {
    for (const state of [
      initialPlayback(1),
      { ...initialPlayback(4), full: 2 }
    ]) {
      const laid = tvLayout(
        state,
        SCREEN,
        SETTINGS,
        true,
        true,
        undefined,
        REELS
      )
      const picture = laid.tiles[state.full ?? 0]
      expect(laid.board).equals(null)
      near(laid.reel!.x, picture.x + SETTINGS.single.x * picture.w)
      near(laid.reel!.y, picture.y + SETTINGS.single.y * picture.h)
      inside(laid.reel!, picture)
      expect(laid.reel!.w).at.most(SCREEN.width / 3 + 1e-6)
    }
  })

  it('plays under the right-hand camera of two, centred, the board and box staying above them', function () {
    const plain = tvLayout(initialPlayback(2), SCREEN, SETTINGS, true, true)
    const laid = tvLayout(
      initialPlayback(2),
      SCREEN,
      SETTINGS,
      true,
      true,
      undefined,
      REELS
    )
    expect(laid.tiles).deep.equals(plain.tiles)
    expect(laid.board).deep.equals(plain.board)
    expect(laid.box).deep.equals(plain.box)
    const right = laid.tiles[1]
    const reel = laid.reel!
    near(reel.y, right.y + right.h + 8)
    near(reel.x + reel.w / 2, right.x + right.w / 2)
    expect(reel.y + reel.h).at.most(SCREEN.height - 8 + 1e-6)
    expect(reel.w / reel.h).closeTo(16 / 9, 1e-6)
  })

  it('plays in the top-left quadrant of three, the board hidden and the box below its place unless the reel covers it', function () {
    const plain = tvLayout(initialPlayback(3), SCREEN, SETTINGS, true, true)
    const laid = tvLayout(
      initialPlayback(3),
      SCREEN,
      SETTINGS,
      true,
      true,
      undefined,
      REELS
    )
    const quadrant = { x: 0, y: 0, w: SCREEN.width / 2, h: SCREEN.height / 2 }
    expect(laid.board).equals(null)
    near(laid.reel!.x, 0)
    near(laid.reel!.y, 0)
    inside(laid.reel!, quadrant)
    // The node's default reel is above the box: it stays below the board's place.
    expect(intersects(plain.box!, laid.reel!)).equals(false)
    expect(laid.box).deep.equals(plain.box)
    // A reel as large as the quadrant covers it, and hides it.
    const large = tvLayout(
      initialPlayback(3),
      SCREEN,
      SETTINGS,
      true,
      true,
      undefined,
      {
        ...REELS,
        placements: {
          ...REELS.placements,
          landscape3: { maxWidth: 0.5, maxHeight: 0.5 }
        }
      }
    )
    inside(large.reel!, quadrant)
    expect(large.box).equals(null)
    // With the board off the box starts at the top, where the reel plays.
    const off = { ...SETTINGS, show: false }
    expect(tvLayout(initialPlayback(3), SCREEN, off, true, true).box!.y).equals(
      0
    )
    expect(
      tvLayout(initialPlayback(3), SCREEN, off, true, true, undefined, REELS)
        .box
    ).equals(null)
  })

  it('takes the board’s TV place over the top-left camera of four', function () {
    const tvLandscape = { x: 0.2, y: 0.2, height: 0.3 }
    const laid = tvLayout(
      initialPlayback(4),
      SCREEN,
      { ...SETTINGS, tvLandscape },
      true,
      true,
      undefined,
      REELS
    )
    const corner = laid.tiles[0]
    expect(laid.board).equals(null)
    near(laid.reel!.x, corner.x + tvLandscape.x * corner.w)
    near(laid.reel!.y, corner.y + tvLandscape.y * corner.h)
    inside(laid.reel!, corner)
  })
})
