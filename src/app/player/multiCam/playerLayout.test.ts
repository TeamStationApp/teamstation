import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultScoreboardSettings,
  defaultSponsorSettings
} from '../../../common/nodeSettings'
import { BOARD_INSET } from '../scoreboardOverlay/layouts'
import {
  LINE_BOX_HEIGHT,
  LINE_BOX_WIDTH,
  lineBoxHeight,
  lineColumns
} from '../scoreboardOverlay/lineScoreLayout'
import {
  FULL_BOARD_HEIGHT,
  intersects
} from '../scoreboardOverlay/overlayLayout'
import { type Rect, tileRects } from './layout'
import {
  COMPACT_LINE_SCALE,
  controlBlock,
  GAP,
  playerLayout,
  type PlayerLayoutInput,
  reelHasPlace,
  topOfAngles,
  videoBlock
} from './playerLayout'

const SETTINGS = {
  show: true,
  single: defaultScoreboardSettings.single,
  landscape: defaultScoreboardSettings.landscape,
  portraitHeight: defaultScoreboardSettings.portraitHeight
}
const BOARD = { width: 607, height: 247 }
/**
 * The innings a box drawn at `rect` shows, `current` the latest: as
 * `LineScoreBox` draws it, every inning its width holds when it is shorter
 * than six innings' shape.
 */
const shownOf = (rect: Rect, current: number): number[] =>
  lineColumns(
    rect.w / (rect.h / LINE_BOX_HEIGHT),
    current,
    rect.h < lineBoxHeight(rect.w) - 0.5 ? Infinity : undefined
  )
const near = (actual: number, expected: number, why?: string): void => {
  expect(actual, why).closeTo(expected, 1e-6)
}
const inside = (rect: Rect, area: Rect): void => {
  expect(rect.x).at.least(area.x - 1e-6)
  expect(rect.y).at.least(area.y - 1e-6)
  expect(rect.x + rect.w).at.most(area.x + area.w + 1e-6)
  expect(rect.y + rect.h).at.most(area.y + area.h + 1e-6)
}

/** A phone upright, its island 59 points deep and the home bar 34. */
const PORTRAIT = {
  screen: { width: 402, height: 874 },
  safe: { x: 0, y: 59, w: 402, h: 874 - 59 - 34 }
}
/** The same phone sideways: the island on the left. */
const LANDSCAPE = {
  screen: { width: 874, height: 402 },
  safe: { x: 59, y: 0, w: 874 - 2 * 59, h: 402 - 21 }
}

function layout(
  where: { screen: { width: number; height: number }; safe: Rect },
  options: Partial<PlayerLayoutInput>
): ReturnType<typeof playerLayout> {
  return playerLayout({
    ...where,
    count: 2,
    aspect: 16 / 9,
    landscape: where.screen.width > where.screen.height,
    settings: SETTINGS,
    board: BOARD,
    line: true,
    ...options
  })
}

describe('the player’s layout (U6)', function () {
  describe('upright', function () {
    it('puts the board on the top of the safe area, the box score under it and the angles under that, with one to three angles', function () {
      for (const count of [1, 2, 3]) {
        const placed = layout(PORTRAIT, { count })
        const board = placed.board!
        const box = placed.box!
        near(board.y, 59, 'the board sits on the safe area, no margin above')
        near(board.x, BOARD_INSET)
        near(board.w, 402 - 2 * BOARD_INSET)
        const scale = board.w / BOARD.width
        near(box.y, 59 + FULL_BOARD_HEIGHT * scale + GAP)
        // As wide as the board, and as tall as six innings make it there:
        // three quarters of that with one or two angles, which shows more.
        near(box.w, board.w)
        const full = (board.w * LINE_BOX_HEIGHT) / LINE_BOX_WIDTH
        if (count < 3) {
          near(box.h, full * COMPACT_LINE_SCALE)
          const shown = shownOf(box, 12)
          expect(shown.length, 'more than six innings').greaterThan(6)
          expect(shown.at(-1)).equals(12)
        } else {
          near(box.h, full)
          expect(shownOf(box, 12), 'six innings, the latest').deep.equals([
            7, 8, 9, 10, 11, 12
          ])
        }
        near(placed.tiles[0].y, box.y + box.h + GAP)
        placed.tiles.forEach((tile, index) => {
          // Full width with one or two; three, with the box above them, are
          // as wide as the height left lets them be.
          if (count < 3) near(tile.w, 402)
          else expect(tile.w).within(300, 402)
          if (index > 0)
            near(tile.y, placed.tiles[index - 1].y + placed.tiles[index - 1].h)
        })
        // What is left over is below the angles.
        expect(placed.tiles.at(-1)!.y + placed.tiles.at(-1)!.h).at.most(874)
        expect(placed.boardCell).equals(false)
      }
    })

    it('butts the angles against the board with no box score, and four never have one', function () {
      for (const [count, line] of [
        [2, false],
        [3, false]
      ] as const) {
        const placed = layout(PORTRAIT, { count, line })
        expect(placed.box).equals(null)
        const scale = placed.board!.w / BOARD.width
        near(placed.tiles[0].y, 59 + FULL_BOARD_HEIGHT * scale + GAP)
      }
    })

    it("shrinks the board to the node's portrait height with four angles, the stack filling what is left", function () {
      const placed = layout(PORTRAIT, { count: 4 })
      expect(placed.box).equals(null)
      const [first, , , last] = placed.tiles
      near(
        FULL_BOARD_HEIGHT * (placed.board!.h / BOARD.height),
        SETTINGS.portraitHeight * first.h
      )
      near(placed.board!.y, 59)
      near(first.y, 59 + SETTINGS.portraitHeight * first.h + GAP)
      // The angles run into the bottom inset, to the screen's edge.
      near(last.y + last.h, 874)
    })

    it('puts the box score where the board would be without one, and the angles on the safe area with neither', function () {
      const boxOnly = layout(PORTRAIT, { board: null })
      expect(boxOnly.board).equals(null)
      near(boxOnly.box!.y, 59)
      near(boxOnly.box!.w, 402 - 2 * BOARD_INSET)
      near(boxOnly.tiles[0].y, boxOnly.box!.y + boxOnly.box!.h + GAP)
      const neither = layout(PORTRAIT, { board: null, line: false })
      expect(neither.box).equals(null)
      near(neither.tiles[0].y, 59)
      // Settings not in yet: no board.
      expect(layout(PORTRAIT, { settings: null, line: false }).board).equals(
        null
      )
    })

    it('follows portrait for a window taller than wide, a tablet upright', function () {
      const tablet = {
        screen: { width: 834, height: 1194 },
        safe: { x: 0, y: 24, w: 834, h: 1170 }
      }
      const placed = layout(tablet, { count: 2 })
      near(placed.board!.y, 24)
      expect(placed.box).not.equals(null)
      expect(placed.tiles[0].x).equals(placed.tiles[1].x)
    })
  })

  describe('sideways', function () {
    it('puts the board over a lone angle by the single setting, and no box score', function () {
      const placed = layout(LANDSCAPE, { count: 1 })
      expect(placed.box).equals(null)
      const [picture] = placed.tiles
      inside(placed.board!, picture)
      near(placed.board!.h, SETTINGS.single.height * picture.h)
      // A zoomed angle of two is a single picture too.
      const zoomed = layout(LANDSCAPE, { count: 2, zoomed: 1 })
      expect(zoomed.box).equals(null)
      inside(zoomed.board!, zoomed.tiles[1])
    })

    it('pins two angles to the bottom, the board right of the middle and the box score left of it, resting on them', function () {
      const placed = layout(LANDSCAPE, { count: 2 })
      const [left, right] = placed.tiles
      near(left.y + left.h, 402)
      near(right.y + right.h, 402)
      const board = placed.board!
      const box = placed.box!
      near(board.x, 874 / 2 + GAP)
      near(box.x + box.w, 874 / 2 - GAP)
      const scale = board.h / BOARD.height
      near(board.y + FULL_BOARD_HEIGHT * scale, left.y - BOARD_INSET)
      near(box.y + box.h, left.y - BOARD_INSET)
      // Six innings' shape, the left half wide or the band tall.
      near(
        box.h,
        ((box.w * LINE_BOX_HEIGHT) / LINE_BOX_WIDTH) * COMPACT_LINE_SCALE
      )
      expect(shownOf(box, 9).length).greaterThan(6)
      expect(shownOf(box, 9).at(-1)).equals(9)
      // Drawn at six innings' height, the same width shows six.
      expect(
        lineColumns(box.w / (lineBoxHeight(box.w) / LINE_BOX_HEIGHT), 9)
      ).deep.equals([4, 5, 6, 7, 8, 9])
      expect(box.y).at.least(0)
      for (const tile of placed.tiles) {
        expect(intersects(tile, board)).equals(false)
        expect(intersects(tile, box)).equals(false)
      }
    })

    it('centres the board over two angles with no box score, and the box score with no board', function () {
      const boardOnly = layout(LANDSCAPE, { count: 2, line: false })
      near(boardOnly.board!.x + boardOnly.board!.w / 2, 874 / 2)
      expect(boardOnly.box).equals(null)
      const boxOnly = layout(LANDSCAPE, { count: 2, board: null })
      expect(boxOnly.board).equals(null)
      near(boxOnly.box!.x + boxOnly.box!.w / 2, 874 / 2)
      near(boxOnly.box!.y + boxOnly.box!.h, boxOnly.tiles[0].y - BOARD_INSET)
      const neither = layout(LANDSCAPE, { count: 2, board: null, line: false })
      expect([neither.board, neither.box]).deep.equals([null, null])
    })

    it('stacks the board over the box score at the top of the quadrant three angles leave, against the angle on its right', function () {
      const placed = layout(LANDSCAPE, { count: 3 })
      expect(placed.boardCell).equals(true)
      const [topRight, bottomLeft] = placed.tiles
      const cell = {
        x: bottomLeft.x,
        y: topRight.y,
        w: bottomLeft.w,
        h: topRight.h
      }
      const board = placed.board!
      const box = placed.box!
      near(board.y, cell.y + BOARD_INSET)
      near(board.x + board.w, cell.x + cell.w - GAP)
      near(box.x + box.w, cell.x + cell.w - GAP)
      expect(box.y).greaterThan(board.y)
      inside(board, cell)
      inside(box, cell)
      for (const tile of placed.tiles) {
        expect(intersects(tile, board)).equals(false)
        expect(intersects(tile, box)).equals(false)
      }
      // The box score alone takes the board's place at the top of the cell.
      const boxOnly = layout(LANDSCAPE, { count: 3, board: null })
      near(boxOnly.box!.y, cell.y + BOARD_INSET)
      near(boxOnly.box!.x + boxOnly.box!.w, cell.x + cell.w - GAP)
      // Neither: the three take the first three quadrants, as before.
      const neither = layout(LANDSCAPE, { count: 3, board: null, line: false })
      expect(neither.boardCell).equals(false)
      expect(neither.tiles).deep.equals(
        tileRects({ width: 874, height: 402, count: 3 })
      )
    })

    it("keeps four angles as they were, the board over the top-left one by the node's landscape setting", function () {
      const placed = layout(LANDSCAPE, { count: 4 })
      expect(placed.tiles).deep.equals(
        tileRects({ width: 874, height: 402, count: 4 })
      )
      expect(placed.box).equals(null)
      expect(placed.boardClip).deep.equals(placed.tiles[0])
      const corner = placed.tiles[0]
      near(placed.board!.h, SETTINGS.landscape.height * corner.h)
      expect(layout(LANDSCAPE, { count: 4, board: null }).board).equals(null)
    })

    it('keeps every board and box score inside the safe area', function () {
      for (const count of [1, 2, 3, 4])
        for (const line of [true, false]) {
          const placed = layout(LANDSCAPE, { count, line })
          if (placed.board != null) inside(placed.board, LANDSCAPE.safe)
          if (placed.box != null) inside(placed.box, LANDSCAPE.safe)
        }
    })

    it('follows landscape for a desktop window and an iPad sideways, and has nothing for no angles', function () {
      for (const screen of [
        { width: 1280, height: 720 },
        { width: 1194, height: 834 }
      ]) {
        const placed = layout(
          { screen, safe: { x: 0, y: 0, w: screen.width, h: screen.height } },
          { count: 2 }
        )
        near(placed.tiles[0].y + placed.tiles[0].h, screen.height)
        near(placed.board!.x, screen.width / 2 + GAP)
      }
      expect(layout(LANDSCAPE, { count: 0 }).tiles).deep.equals([])
    })
  })
})

describe('the single picture sideways under an Android top inset', function () {
  /** An Android phone sideways: the hidden status bar still reported on top. */
  const ANDROID_LANDSCAPE = {
    screen: { width: 874, height: 402 },
    safe: { x: 0, y: 24, w: 874, h: 402 - 24 }
  }
  /** The same with a cutout on the left. */
  const ANDROID_CUTOUT = {
    screen: { width: 874, height: 402 },
    safe: { x: 48, y: 24, w: 874 - 48, h: 402 - 24 }
  }
  /** A cutout on the left, the navigation bar on the right, the gesture bar. */
  const ANDROID_INSET_ALL = {
    screen: { width: 874, height: 402 },
    safe: { x: 48, y: 24, w: 874 - 96, h: 402 - 24 - 40 }
  }
  /** The hidden status bar is the whole of the reported top inset. */
  const under = { singleHiddenTopInset: 24 }
  const atSingle = (board: Rect, picture: Rect): void => {
    const { single } = SETTINGS
    expect(board.y).closeTo(picture.y + single.y * picture.h, 0.01)
    expect(board.x).closeTo(picture.x + single.x * picture.w, 0.01)
    expect(board.h).closeTo(single.height * picture.h, 0.01)
  }
  const band = (board: Rect): number =>
    (board.h * Math.max(FULL_BOARD_HEIGHT, BOARD.height)) / BOARD.height

  it('puts the board at the Single camera top of one angle, above the inset (U1)', function () {
    for (const where of [ANDROID_LANDSCAPE, ANDROID_CUTOUT]) {
      const placed = layout(where, { count: 1, ...under })
      atSingle(placed.board!, placed.tiles[0])
      expect(placed.board!.y).below(where.safe.y)
    }
  })

  it('keeps the board under the inset without the field (U2)', function () {
    for (const field of [{}, { singleHiddenTopInset: 0 }]) {
      const placed = layout(ANDROID_LANDSCAPE, { count: 1, ...field })
      near(placed.board!.y, ANDROID_LANDSCAPE.safe.y + BOARD_INSET)
    }
  })

  it('places the board the same over one angle zoomed out of two or four (U3)', function () {
    for (const count of [2, 4]) {
      const placed = layout(ANDROID_LANDSCAPE, { count, zoomed: 1, ...under })
      expect(placed.box).equals(null)
      atSingle(placed.board!, placed.tiles[1])
    }
  })

  it('still keeps the board off the left, right and bottom insets (U4)', function () {
    const wide = { count: 1, aspect: 2.4 }
    const { safe } = ANDROID_INSET_ALL
    const at = (
      single: { x: number; y: number },
      field: object
    ): ReturnType<typeof playerLayout> =>
      layout(ANDROID_INSET_ALL, {
        ...wide,
        ...field,
        settings: { ...SETTINGS, single: { ...SETTINGS.single, ...single } }
      })
    const placed = at({ x: 0.01, y: 0.01 }, under)
    const picture = placed.tiles[0]
    near(picture.w, 874)
    near(placed.board!.x, safe.x + BOARD_INSET)
    expect(placed.board!.y).closeTo(picture.y + 0.01 * picture.h, 0.01)
    expect(placed.board!.y).below(safe.y)
    const without = at({ x: 0.01, y: 0.01 }, {})
    near(without.board!.x, safe.x + BOARD_INSET)
    near(without.board!.y, safe.y + BOARD_INSET)

    const left = at({ x: 0.01, y: 0.5 }, under)
    expect(left).deep.equals(at({ x: 0.01, y: 0.5 }, {}))
    near(left.board!.x, safe.x + BOARD_INSET)
    const right = at({ x: 0.9, y: 0.5 }, under)
    expect(right).deep.equals(at({ x: 0.9, y: 0.5 }, {}))
    near(right.board!.x + right.board!.w, safe.x + safe.w - BOARD_INSET)
    const low = at({ x: 0.3, y: 0.95 }, under)
    expect(low).deep.equals(at({ x: 0.3, y: 0.95 }, {}))
    near(low.board!.y + band(low.board!), safe.y + safe.h - BOARD_INSET)
  })

  it('keeps the board clear of a top inset taller than the hidden status bar (U7)', function () {
    // A cutout on the top edge sideways: Android reports the edge as the
    // larger of the cutout (60) and the bar (24), so all 60 is the cutout.
    const cutout = {
      screen: { width: 874, height: 402 },
      safe: { x: 0, y: 60, w: 874, h: 402 - 60 }
    }
    const kept = layout(cutout, { count: 1, singleHiddenTopInset: 24 })
    near(kept.board!.y, 60 + BOARD_INSET)
    expect(kept).deep.equals(layout(cutout, { count: 1 }))
    // A bar as tall as the inset, or taller, is all of it.
    for (const bar of [60, 80]) {
      const placed = layout(cutout, { count: 1, singleHiddenTopInset: bar })
      atSingle(placed.board!, placed.tiles[0])
    }
  })

  it('leaves portrait and two to four angles sideways as they were (U5)', function () {
    for (const [where, count] of [
      [PORTRAIT, 1],
      [ANDROID_LANDSCAPE, 2],
      [ANDROID_LANDSCAPE, 3],
      [ANDROID_LANDSCAPE, 4]
    ] as const)
      expect(layout(where, { count, ...under })).deep.equals(
        layout(where, { count })
      )
  })
})

describe('a board that measures taller than the full board, as a phone’s does', function () {
  const TALL = { width: 607, height: FULL_BOARD_HEIGHT + 30 }

  it('keeps the box score and the angles clear of it upright', function () {
    for (const count of [2, 3]) {
      const placed = layout(PORTRAIT, { count, board: TALL })
      const bottom = placed.board!.y + placed.board!.h
      near(placed.box!.y, bottom + GAP, `${count}: box under the board`)
      near(
        placed.tiles[0].y,
        placed.box!.y + placed.box!.h + GAP,
        `${count}: angles under it`
      )
    }
  })

  it('rests it on the angles beside the box score sideways, with two angles', function () {
    const placed = layout(LANDSCAPE, { count: 2, board: TALL })
    const top = Math.min(placed.tiles[0].y, placed.tiles[1].y)
    near(
      placed.board!.y + placed.board!.h,
      top - BOARD_INSET,
      'board on the angles'
    )
    near(
      placed.box!.y + placed.box!.h,
      top - BOARD_INSET,
      'box on the same line'
    )
  })

  it('stacks it over the box score in the free quadrant, with three', function () {
    const placed = layout(LANDSCAPE, { count: 3, board: TALL })
    near(placed.box!.y, placed.board!.y + placed.board!.h + GAP, 'box under it')
  })
})

describe('where a notice goes (topOfAngles)', function () {
  it('is under the band when the board rests on the angles, at the top of the pictures otherwise', function () {
    const two = layout(LANDSCAPE, { count: 2 })
    near(topOfAngles(two), Math.min(two.tiles[0].y, two.tiles[1].y))
    expect(topOfAngles(two)).greaterThan(two.board!.y + two.board!.h)
    expect(topOfAngles(layout(LANDSCAPE, { count: 4 }))).equals(0)
    const upright = layout(PORTRAIT, { count: 2 })
    near(topOfAngles(upright), upright.tiles[0].y)
    expect(topOfAngles({ ...upright, tiles: [] })).equals(0)
  })
})

describe('the block of videos the controls go on (videoBlock)', function () {
  const top = (rects: Rect[]): number => Math.min(...rects.map(r => r.y))
  const bottom = (rects: Rect[]): number =>
    Math.max(...rects.map(r => r.y + r.h))

  it('is the one video, upright and sideways, and a zoomed one alone', function () {
    for (const where of [PORTRAIT, LANDSCAPE]) {
      const { tiles } = layout(where, { count: 1 })
      const block = videoBlock(tiles)!
      for (const key of ['x', 'y', 'w', 'h'] as const)
        near(block[key], tiles[0][key])
    }
    const { tiles } = layout(LANDSCAPE, { count: 4, zoomed: 2 })
    expect(videoBlock(tiles, 2)).deep.equals(tiles[2])
  })

  it('is the pair side by side, from their top to their bottom, and none of the space above', function () {
    const { tiles, board } = layout(LANDSCAPE, { count: 2 })
    const block = videoBlock(tiles)!
    near(block.x, Math.min(tiles[0].x, tiles[1].x))
    near(block.w, tiles[0].w + tiles[1].w)
    near(block.y, top(tiles))
    near(block.y + block.h, bottom(tiles))
    expect(board!.y + board!.h).at.most(block.y + 1e-6)
  })

  it('is as wide as the bottom pair for three sideways with the board in the top-left quadrant', function () {
    const { tiles, boardCell } = layout(LANDSCAPE, { count: 3 })
    expect(boardCell).equals(true)
    const block = videoBlock(tiles)!
    // One video on the top row, beside the board; two on the bottom.
    near(block.y, tiles[0].y)
    near(block.y + block.h, bottom(tiles))
    near(block.x, tiles[1].x)
    near(block.w, tiles[1].w + tiles[2].w)
    expect(block.w).above(tiles[0].w * 1.5)
  })

  it('is as wide as the top pair for three sideways with no board, down to the lower video', function () {
    const { tiles, boardCell } = layout(LANDSCAPE, {
      count: 3,
      settings: null,
      line: false
    })
    expect(boardCell).equals(false)
    const block = videoBlock(tiles)!
    near(block.w, tiles[0].w + tiles[1].w)
    near(block.x, tiles[0].x)
    near(block.y + block.h, tiles[2].y + tiles[2].h)
  })

  it('is the whole grid of four, and the column of an upright stack of any count', function () {
    const four = layout(LANDSCAPE, { count: 4 }).tiles
    const grid = videoBlock(four)!
    near(grid.w, four[0].w + four[1].w)
    near(grid.h, bottom(four) - top(four))
    for (const count of [1, 2, 3, 4]) {
      const { tiles } = layout(PORTRAIT, { count })
      const block = videoBlock(tiles)!
      near(block.w, tiles[0].w)
      near(block.y, tiles[0].y)
      near(block.y + block.h, tiles[count - 1].y + tiles[count - 1].h)
    }
  })

  it('is nothing with no videos', function () {
    expect(videoBlock([])).equals(null)
    expect(videoBlock([{ x: 0, y: 0, w: 0, h: 0 }])).equals(null)
  })

  it('comes inside the safe area only where an edge runs past it', function () {
    const safe = LANDSCAPE.safe
    // Under the island on the left and the home bar below.
    expect(controlBlock({ x: 0, y: 100, w: 600, h: 400 }, safe)).deep.equals({
      x: 59,
      y: 100,
      w: 541,
      h: 281
    })
    // Inside already: unchanged, not moved out to the safe edges.
    const inner = { x: 200, y: 50, w: 300, h: 200 }
    expect(controlBlock(inner, safe)).deep.equals(inner)
    expect(controlBlock({ x: 900, y: 0, w: 10, h: 10 }, safe).w).equals(0)
  })
})

/** U23: where a sponsor reel plays in each layout, and what it hides. */
describe('the sponsor reel in each layout (U23)', function () {
  const REELS = {
    active: true,
    aspect: 16 / 9,
    placements: defaultSponsorSettings.reel,
    any: true
  }
  const idle = { ...REELS, active: false }
  const third = (n: number): number => n / 3
  const aspectOf = (rect: Rect): number => rect.w / rect.h
  const reelOf = (laid: ReturnType<typeof playerLayout>): Rect => {
    expect(laid.reel).not.equals(null)
    near(aspectOf(laid.reel!), 16 / 9)
    return laid.reel!
  }

  it('leaves every layout as it was with no reels, and with reels and none playing but for two and three sideways', function () {
    for (const where of [PORTRAIT, LANDSCAPE])
      for (let count = 1; count <= 4; count++)
        for (const zoomed of [null, 0]) {
          const plain = layout(where, { count, zoomed })
          expect(plain.reel).equals(null)
          expect(layout(where, { count, zoomed, reel: null })).deep.equals(
            plain
          )
          const waiting = layout(where, { count, zoomed, reel: idle })
          expect(waiting.reel).equals(null)
          const moves =
            where === LANDSCAPE &&
            zoomed == null &&
            (count === 2 || count === 3)
          if (!moves) expect(waiting).deep.equals(plain)
        }
    // Reels and nothing else for three sideways still keep the quadrant.
    expect(
      layout(LANDSCAPE, { count: 3, board: null, line: false, reel: idle })
        .boardCell
    ).equals(true)
    expect(
      layout(LANDSCAPE, { count: 3, board: null, line: false }).boardCell
    ).equals(false)
  })

  it('plays below one or two upright angles, centred, the board and box staying', function () {
    for (const count of [1, 2]) {
      const plain = layout(PORTRAIT, { count })
      const laid = layout(PORTRAIT, { count, reel: REELS })
      const reel = reelOf(laid)
      const bottom = Math.max(...laid.tiles.map(tile => tile.y + tile.h))
      near(reel.y, bottom + GAP)
      near(reel.x + reel.w / 2, PORTRAIT.screen.width / 2)
      expect(reel.w).at.most(third(PORTRAIT.screen.width) + 1e-6)
      expect(laid.board).deep.equals(plain.board)
      expect(laid.box).deep.equals(plain.box)
      inside(reel, PORTRAIT.safe)
    }
  })

  it('takes the board’s place upright with three and four angles, the board hidden', function () {
    for (const count of [3, 4]) {
      const plain = layout(PORTRAIT, { count })
      const laid = layout(PORTRAIT, { count, reel: REELS })
      const reel = reelOf(laid)
      expect(laid.board).equals(null)
      near(reel.x, plain.board!.x)
      near(reel.y, plain.board!.y)
      inside(reel, plain.board!)
      expect(laid.tiles).deep.equals(plain.tiles)
    }
    // With no board, the box's place, and with neither, the first angle's.
    const noBoard = layout(PORTRAIT, { count: 3, board: null, reel: REELS })
    inside(reelOf(noBoard), layout(PORTRAIT, { count: 3, board: null }).box!)
    const bare = layout(PORTRAIT, {
      count: 4,
      board: null,
      line: false,
      reel: REELS
    })
    inside(reelOf(bare), bare.tiles[0])
  })

  it('takes the board’s place on one angle sideways and on a zoomed one, the board hidden', function () {
    for (const options of [
      { count: 1 },
      { count: 3, zoomed: 1 },
      { count: 4, zoomed: 2 }
    ]) {
      const laid = layout(LANDSCAPE, { ...options, reel: REELS })
      const reel = reelOf(laid)
      const picture = laid.tiles[options.zoomed ?? 0]
      expect(laid.board).equals(null)
      near(reel.x, picture.x + SETTINGS.single.x * picture.w)
      near(reel.y, picture.y + SETTINGS.single.y * picture.h)
      inside(reel, picture)
      expect(reel.w).at.most(third(LANDSCAPE.screen.width) + 1e-6)
      expect(reel.h).at.most(third(LANDSCAPE.screen.height) + 1e-6)
    }
    // The node's board placement unknown yet: the default one's place.
    const unknown = layout(LANDSCAPE, {
      count: 1,
      settings: null,
      reel: REELS
    })
    near(
      reelOf(unknown).x,
      unknown.tiles[0].x +
        defaultScoreboardSettings.single.x * unknown.tiles[0].w
    )
  })

  it('keeps two angles sideways to the top with reels, the board above the box in the left half of the band and the reel under the right angle', function () {
    const plain = layout(LANDSCAPE, { count: 2 })
    expect(plain.tiles[0].y).greaterThan(0)
    for (const active of [false, true]) {
      const laid = layout(LANDSCAPE, {
        count: 2,
        reel: { ...REELS, active }
      })
      const bottom = Math.max(...laid.tiles.map(tile => tile.y + tile.h))
      expect(laid.tiles[0].y).equals(0)
      const half = LANDSCAPE.screen.width / 2
      expect(laid.board).not.equals(null)
      expect(laid.box).not.equals(null)
      expect(laid.board!.y).greaterThan(bottom)
      expect(laid.box!.y).at.least(laid.board!.y + laid.board!.h)
      expect(laid.board!.x + laid.board!.w).at.most(half)
      expect(laid.box!.x + laid.box!.w).at.most(half)
      inside(laid.board!, LANDSCAPE.safe)
      inside(laid.box!, LANDSCAPE.safe)
      expect(intersects(laid.board!, laid.box!)).equals(false)
      if (!active) {
        expect(laid.reel).equals(null)
        continue
      }
      const reel = reelOf(laid)
      const right = laid.tiles[1]
      near(reel.y, bottom + GAP)
      near(reel.x + reel.w / 2, right.x + right.w / 2)
      expect(reel.x).at.least(right.x)
      expect(intersects(reel, laid.board!)).equals(false)
      expect(intersects(reel, laid.box!)).equals(false)
    }
    // The board alone, and the box alone, in the band's left half.
    const board = layout(LANDSCAPE, { count: 2, line: false, reel: REELS })
    expect(board.box).equals(null)
    expect(board.board).not.equals(null)
    const box = layout(LANDSCAPE, { count: 2, board: null, reel: REELS })
    expect(box.board).equals(null)
    expect(box.box!.x + box.box!.w).at.most(LANDSCAPE.screen.width / 2)
    const neither = layout(LANDSCAPE, {
      count: 2,
      board: null,
      line: false,
      reel: REELS
    })
    expect([neither.board, neither.box]).deep.equals([null, null])
    reelOf(neither)
  })

  it('has no place for a reel where two angles fill the window’s height, or three sideways leave no quadrant, and says so (reelHasPlace)', function () {
    const wide = {
      screen: { width: 3000, height: 400 },
      safe: { x: 0, y: 0, w: 3000, h: 400 }
    }
    const input = (
      where: typeof wide,
      options: Partial<PlayerLayoutInput>
    ): PlayerLayoutInput => ({
      ...where,
      count: 2,
      aspect: 16 / 9,
      landscape: where.screen.width > where.screen.height,
      settings: SETTINGS,
      board: BOARD,
      line: true,
      ...options
    })
    expect(layout(wide, { count: 2, reel: REELS }).reel).equals(null)
    expect(reelHasPlace(input(wide, { count: 2, reel: idle }))).equals(false)
    // Three sideways with no reels in the track keep no quadrant for one.
    expect(
      layout(LANDSCAPE, {
        count: 3,
        board: null,
        line: false,
        reel: { ...REELS, any: false }
      }).reel
    ).equals(null)
    expect(
      reelHasPlace(
        input(LANDSCAPE, {
          count: 3,
          board: null,
          line: false,
          reel: { ...idle, any: false }
        })
      )
    ).equals(false)
    // Where a reel has its place, it is asked while none plays yet.
    for (const count of [1, 2, 3, 4])
      for (const where of [PORTRAIT, LANDSCAPE])
        expect(reelHasPlace(input(where, { count, reel: idle }))).equals(true)
    expect(reelHasPlace(input(LANDSCAPE, { count: 2, reel: null }))).equals(
      false
    )
  })

  it('plays in the top-left quadrant of three sideways, the board hidden and the box hidden only where the reel covers it', function () {
    const laid = layout(LANDSCAPE, { count: 3, reel: REELS })
    const reel = reelOf(laid)
    const cell = {
      x: laid.tiles[1].x,
      y: laid.tiles[0].y,
      w: laid.tiles[1].w,
      h: laid.tiles[0].h
    }
    near(reel.x, cell.x)
    near(reel.y, cell.y)
    inside(reel, cell)
    expect(laid.board).equals(null)
    const plain = layout(LANDSCAPE, { count: 3 })
    expect(intersects(plain.box!, reel)).equals(true)
    expect(laid.box).equals(null)
    // A small reel leaves the box where it was.
    const small = layout(LANDSCAPE, {
      count: 3,
      reel: {
        ...REELS,
        placements: {
          ...REELS.placements,
          landscape3: { maxWidth: 0.05, maxHeight: 0.05 }
        }
      }
    })
    expect(small.box).deep.equals(plain.box)
    // Reels with nothing else still leave the quadrant to the reel.
    reelOf(
      layout(LANDSCAPE, { count: 3, board: null, line: false, reel: REELS })
    )
  })

  it('takes the board’s place over the top-left angle of four sideways, the board hidden', function () {
    const plain = layout(LANDSCAPE, { count: 4 })
    const laid = layout(LANDSCAPE, { count: 4, reel: REELS })
    const reel = reelOf(laid)
    const corner = laid.tiles[0]
    expect([laid.board, laid.boardClip]).deep.equals([null, null])
    near(reel.x, corner.x + SETTINGS.landscape.x * corner.w)
    near(reel.y, corner.y + SETTINGS.landscape.y * corner.h)
    inside(reel, corner)
    expect(laid.tiles).deep.equals(plain.tiles)
  })

  it('places a reel by the node’s box for its layout, and none in a space with no room', function () {
    const laid = layout(LANDSCAPE, {
      count: 1,
      reel: {
        ...REELS,
        placements: {
          ...REELS.placements,
          landscape1: { maxWidth: 0.25, maxHeight: 1 }
        }
      }
    })
    near(reelOf(laid).w, LANDSCAPE.screen.width / 4)
    // Upright and two angles filling the screen leave no room below.
    const full = playerLayout({
      screen: { width: 400, height: 460 },
      safe: { x: 0, y: 0, w: 400, h: 460 },
      count: 2,
      aspect: 16 / 9,
      landscape: false,
      settings: SETTINGS,
      board: BOARD,
      line: true,
      reel: REELS
    })
    expect(full.reel).equals(null)
    expect(full.board).not.equals(null)
    expect(
      playerLayout({
        ...PORTRAIT,
        count: 0,
        aspect: 1,
        landscape: false,
        settings: null,
        board: null,
        line: false,
        reel: REELS
      }).reel
    ).equals(null)
  })
})
