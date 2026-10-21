import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultScoreboardSettings } from '../../../common/nodeSettings'
import { dragSlots, gridShape, tileRects } from '../multiCam/layout'
import { BOARD_INSET } from './layouts'
import {
  aboveBoardRect,
  FULL_BOARD_HEIGHT,
  keptClear,
  pictureRect,
  placedBoardRect,
  singleBoardRect,
  tileBoardRect,
  tileNameTop,
  widthAt
} from './overlayLayout'

/** The full board as it measures with short team names, and with long ones. */
const SHORT = { width: 607, height: 247 }
const LONG = { width: 980, height: 247 }
/** The board with nobody named: no batter and pitcher rows. */
const UNNAMED = { width: 607, height: 170 }
const SINGLE = defaultScoreboardSettings.single

const near = (actual: number, expected: number): void => {
  expect(actual).closeTo(expected, 1e-6)
}

describe('the picture inside its box', function () {
  it('fills a box of its own shape', function () {
    expect(pictureRect(1280, 720, 16 / 9)).deep.equals({
      x: 0,
      y: 0,
      w: 1280,
      h: 720
    })
  })

  it('has bars above and below when it is wider than the box', function () {
    const picture = pictureRect(1280, 720, 2.4)
    near(picture.w, 1280)
    near(picture.h, 1280 / 2.4)
    near(picture.y, (720 - 1280 / 2.4) / 2)
    near(picture.x, 0)
  })

  it('has bars either side when it is narrower', function () {
    const picture = pictureRect(1280, 720, 4 / 3)
    near(picture.h, 720)
    near(picture.w, 960)
    near(picture.x, 160)
  })

  it('is the whole box for a shape it cannot use', function () {
    expect(pictureRect(400, 300, 0)).deep.equals({ x: 0, y: 0, w: 400, h: 300 })
    expect(pictureRect(-1, 300, 1)).deep.equals({ x: 0, y: 0, w: 0, h: 300 })
  })
})

describe('the board over a single picture (U31)', function () {
  const picture = { x: 0, y: 0, w: 1280, h: 720 }

  it('sits at the setting’s fractions of the picture, the full board the setting’s height', function () {
    const board = singleBoardRect({
      picture,
      placement: SINGLE,
      natural: SHORT
    })!
    near(board.x, 0.01 * 1280)
    near(board.y, 0.01 * 720)
    near(board.h, 0.15 * 720)
    near(board.w, widthAt(SHORT, 0.15 * 720))
  })

  it('is shorter at the same scale with nobody named, not stretched', function () {
    const named = singleBoardRect({
      picture,
      placement: SINGLE,
      natural: SHORT
    })!
    const unnamed = singleBoardRect({
      picture,
      placement: SINGLE,
      natural: UNNAMED
    })!
    near(unnamed.x, named.x)
    near(unnamed.y, named.y)
    near(unnamed.w, named.w)
    near(unnamed.h, (named.h * UNNAMED.height) / FULL_BOARD_HEIGHT)
  })

  it('counts from the picture, not its bars', function () {
    const letterboxed = { x: 0, y: 100, w: 1280, h: 520 }
    const board = singleBoardRect({
      picture: letterboxed,
      placement: { x: 0.25, y: 0.5, height: 0.2 },
      natural: SHORT
    })!
    near(board.x, 0.25 * 1280)
    near(board.y, 100 + 0.5 * 520)
    near(board.h, 0.2 * 520)
  })

  it('is narrowed to fit the picture, keeping its corner, and never overflows', function () {
    const right = singleBoardRect({
      picture,
      placement: { x: 0.9, y: 0.1, height: 0.3 },
      natural: LONG
    })!
    near(right.x, 0.9 * 1280)
    near(right.y, 0.1 * 720)
    near(right.x + right.w, 1280)
    near(right.w / right.h, LONG.width / LONG.height)
    const bottom = singleBoardRect({
      picture,
      placement: { x: 0, y: 0.95, height: 0.3 },
      natural: SHORT
    })!
    near(bottom.y + bottom.h, 720)
    near(bottom.w / bottom.h, SHORT.width / SHORT.height)
  })

  it('is drawn however small the picture, and not without a size or room', function () {
    const tiny = singleBoardRect({
      picture: { x: 0, y: 0, w: 160, h: 90 },
      placement: SINGLE,
      natural: SHORT
    })!
    near(tiny.h, 0.15 * 90)
    expect(placedBoardRect(picture, SINGLE, { width: 0, height: 0 })).equals(
      null
    )
    expect(
      aboveBoardRect({ width: 1280, height: 720 }, 2 * BOARD_INSET, SHORT)
    ).equals(null)
  })
})

describe('the tiles below a band (U33)', function () {
  const screen = { width: 402, height: 874 }

  it('keeps the whole screen’s shape, so a band never makes a column a grid', function () {
    const rects = tileRects({ width: 500, height: 560, count: 2, top: 84 })
    expect(gridShape(500, 560, 2).columns).equals(1)
    expect(rects[0].x).equals(rects[1].x)
    expect(rects[1].y).greaterThan(rects[0].y)
    const zoomed = tileRects({
      width: 500,
      height: 560,
      count: 2,
      top: 84,
      zoomed: 0
    })
    expect(zoomed[1]).deep.equals(rects[1])
  })

  it('measures drags against the tiles where they are, below it', function () {
    // A deep band, as a full-width board makes: the drags still land by
    // where the tiles are.
    const band = 0.15 * screen.height
    const rects = tileRects({ ...screen, count: 4, top: band })
    const offset = { x: 0, y: rects[0].h * 1.5 }
    expect(dragSlots(rects, 1, 0, offset).target).equals(2)
    expect(dragSlots(rects, 1, 2, { x: 0, y: -rects[2].y }).target).equals(0)
  })
})

describe('the board over the landscape grid (U34)', function () {
  const screen = { width: 1280, height: 720 }
  const landscape = defaultScoreboardSettings.landscape

  it('with four angles, sits by the setting over the top-left angle', function () {
    const [corner] = tileRects({ ...screen, count: 4 })
    const board = tileBoardRect(corner, landscape, SHORT)!
    near(board.x, landscape.x * corner.w)
    near(board.y, landscape.y * corner.h)
    near(board.h, landscape.height * corner.h)
    // Its name goes just below the full board.
    near(
      tileNameTop(corner, landscape),
      landscape.y * corner.h + landscape.height * corner.h + BOARD_INSET / 2
    )
  })

  it('with four angles, is narrowed to fit the angle', function () {
    const [corner] = tileRects({ ...screen, count: 4 })
    const board = tileBoardRect(corner, { x: 0.5, y: 0, height: 0.5 }, LONG)!
    near(board.x + board.w, corner.w)
  })

  it('with two angles, is centred in the space above them', function () {
    const rects = tileRects({ ...screen, count: 2 })
    const top = rects[0].y
    expect(top).greaterThan(0)
    const board = aboveBoardRect(screen, top, SHORT)!
    near(board.h, top - 2 * BOARD_INSET)
    near(board.x + board.w / 2, screen.width / 2)
    near(board.y + board.h / 2, top / 2)
    expect(board.y + board.h).at.most(top)
    // A narrow screen narrows it to its width.
    const narrow = aboveBoardRect({ width: 300, height: 720 }, top, SHORT)!
    near(narrow.w, 300 - 2 * BOARD_INSET)
  })
})

describe('the board kept clear of the hardware', function () {
  // An iPhone held upright: the Dynamic Island's 47 points at the top, the
  // home indicator's 34 at the bottom, on a 390 × 844 screen.
  const UPRIGHT = { x: 0, y: 47, w: 390, h: 763 }
  // The same phone sideways: the island's 47 points at either side.
  const SIDEWAYS = { x: 47, y: 0, w: 750, h: 369 }

  it('takes a tile’s name down below the board where it moves the board', function () {
    // Sideways with a 20-point inset at the top, over a tile at the top edge:
    // the board moves to 28, and the name sits just below its full height.
    const safe = { x: 47, y: 20, w: 750, h: 349 }
    const tile = { x: 100, y: 0, w: 320, h: 180 }
    const placement = { x: 0.01, y: 0.01, height: 0.25 }
    const moved = keptClear(
      { x: tile.x + 3.2, y: tile.y + 1.8, w: 100, h: 45 },
      safe
    )
    near(moved.y, 20 + BOARD_INSET)
    near(
      tileNameTop(tile, placement, safe),
      moved.y - tile.y + 0.25 * 180 + BOARD_INSET / 2
    )
    // A tile already clear keeps its name where it was.
    const lower = { ...tile, y: 40 }
    near(tileNameTop(lower, placement, safe), tileNameTop(lower, placement))
  })

  it('narrows a board it moves to stay inside the area it was placed in', function () {
    // A board fitted to its angle's right edge, moved in from a notch at
    // the left: it would end past the angle, so it is narrowed to its edge.
    const area = { x: 0, y: 0, w: 400, h: 225 }
    const safe = { x: 47, y: 0, w: 750, h: 369 }
    const board = { x: 4, y: 2, w: 396, h: 160 }
    const kept = keptClear(board, safe, area)
    near(kept.x, 47 + BOARD_INSET)
    near(kept.x + kept.w, area.x + area.w)
    near(kept.w / kept.h, board.w / board.h)
    // Clear of the hardware already, it is left exactly as it was.
    const clear = { x: 60, y: 2, w: 300, h: 120 }
    expect(keptClear(clear, safe, area)).deep.equals(clear)
  })

  it('puts the name under the full board as it is fitted and kept clear', function () {
    const tile = { x: 0, y: 0, w: 400, h: 225 }
    const safe = { x: 47, y: 0, w: 750, h: 369 }
    // A tall setting: the full board is narrowed to the angle, and moved in.
    const placement = { x: 0.01, y: 0.01, height: 0.72 }
    const full = placedBoardRect(tile, placement, {
      width: SHORT.width,
      height: FULL_BOARD_HEIGHT
    })!
    const kept = keptClear(full, safe, tile)
    const top = tileNameTop(tile, placement, safe, SHORT)
    near(top, kept.y + kept.h + BOARD_INSET / 2)
    expect(top).lessThan(placement.y * tile.h + placement.height * tile.h)
  })

  it('stays exactly where it was put when it is clear', function () {
    const board = { x: 60, y: 100, w: 200, h: 80 }
    expect(keptClear(board, UPRIGHT)).deep.equals(board)
    expect(keptClear(board, SIDEWAYS)).deep.equals(board)
  })

  it('moves below the island, its size kept, inset as it was from the top', function () {
    const band = { x: BOARD_INSET, y: BOARD_INSET, w: 240, h: 98 }
    expect(keptClear(band, UPRIGHT)).deep.equals({
      x: BOARD_INSET,
      y: 47 + BOARD_INSET,
      w: 240,
      h: 98
    })
  })

  it('moves in from a notch at either side, and up from the bottom', function () {
    near(
      keptClear({ x: 10, y: 20, w: 100, h: 40 }, SIDEWAYS).x,
      47 + BOARD_INSET
    )
    near(
      keptClear({ x: 740, y: 20, w: 100, h: 40 }, SIDEWAYS).x,
      797 - BOARD_INSET - 100
    )
    near(
      keptClear({ x: 60, y: 780, w: 100, h: 40 }, UPRIGHT).y,
      810 - BOARD_INSET - 40
    )
  })

  it('keeps to the top-left edge when it is wider than the safe area', function () {
    const wide = keptClear({ x: 0, y: 0, w: 900, h: 400 }, SIDEWAYS)
    near(wide.x, 47 + BOARD_INSET)
    near(wide.y, BOARD_INSET)
  })
})
