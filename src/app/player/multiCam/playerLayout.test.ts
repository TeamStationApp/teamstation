import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultScoreboardSettings } from '../../../common/nodeSettings'
import { BOARD_INSET } from '../scoreboardOverlay/layouts'
import {
  LINE_BOX_HEIGHT,
  LINE_BOX_WIDTH,
  lineColumns
} from '../scoreboardOverlay/lineScoreLayout'
import {
  FULL_BOARD_HEIGHT,
  intersects
} from '../scoreboardOverlay/overlayLayout'
import { type Rect, tileRects } from './layout'
import {
  GAP,
  playerLayout,
  type PlayerLayoutInput,
  topOfAngles
} from './playerLayout'

const SETTINGS = {
  show: true,
  single: defaultScoreboardSettings.single,
  landscape: defaultScoreboardSettings.landscape,
  portraitHeight: defaultScoreboardSettings.portraitHeight
}
const BOARD = { width: 607, height: 247 }
/** The innings a box drawn at `rect` shows, `current` the latest. */
const shownOf = (rect: Rect, current: number): number[] =>
  lineColumns(rect.w / (rect.h / LINE_BOX_HEIGHT), current)
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
        // As wide as the board, and as tall as six innings make it there.
        near(box.w, board.w)
        near(box.h, (board.w * LINE_BOX_HEIGHT) / LINE_BOX_WIDTH)
        expect(shownOf(box, 12), 'six innings, the latest').deep.equals([
          7, 8, 9, 10, 11, 12
        ])
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
      near(box.h, (box.w * LINE_BOX_HEIGHT) / LINE_BOX_WIDTH)
      expect(shownOf(box, 9)).deep.equals([4, 5, 6, 7, 8, 9])
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
