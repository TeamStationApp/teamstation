import type { ScoreboardOverlay as OverlaySettings } from '../../../common/nodeSettings'
import { BOARD_INSET } from '../scoreboardOverlay/layouts'
import {
  LINE_BOX_WIDTH,
  lineBoxHeight,
  lineBoxWidth
} from '../scoreboardOverlay/lineScoreLayout'
import {
  aboveBoardRect,
  FULL_BOARD_HEIGHT,
  keptClear,
  singleBoardRect,
  type Size,
  tileBoardRect
} from '../scoreboardOverlay/overlayLayout'
import { type Rect, tileRects } from './layout'

/** The space between the board, the box score and the tiles, in px. */
export const GAP = 5

export interface PlayerLayoutInput {
  /** The whole screen (or window) the grid is drawn in. */
  screen: Size
  /** What the hardware leaves of it: the board and the box keep inside. */
  safe: Rect
  /** How many angles, at most four. */
  count: number
  /** The angles' shared shape. */
  aspect: number
  landscape: boolean
  /** The node's placement settings, once the server has said. */
  settings: OverlaySettings | null
  /** The board's natural size, as measured; null when there is no board. */
  board: Size | null
  /** The game has a line score: there is a box score to place. */
  line: boolean
  /** The angle zoomed to the whole box, by its index, or null. */
  zoomed?: number | null
}

export interface PlayerLayout {
  /** Each angle's rectangle, in reading order. */
  tiles: Rect[]
  /** Where the board is drawn, in the screen's coordinates; null for none. */
  board: Rect | null
  /**
   * What the board is cut off by: the top-left angle of four, sideways,
   * which the board sits over. Null when it is drawn whole.
   */
  boardClip: Rect | null
  /** Where the box score is drawn; null for none. */
  box: Rect | null
  /** Three angles sideways leave the top-left quadrant to the board. */
  boardCell: boolean
}

/**
 * The portrait board's scale: the screen's width less the insets with one to
 * three angles; with four, `portraitHeight` of one angle's height, the
 * angles and the band found together (`count·h + portraitHeight·h + GAP`
 * is the height below the top of the safe area, unless the width stops an
 * angle first). Either way never wider than the screen less the insets.
 */
function portraitScale(
  width: number,
  height: number,
  natural: Size,
  count: number,
  portraitHeight: number,
  aspect: number
): number {
  if (natural.width <= 0) return 0
  const wide = Math.max(0, width - 2 * BOARD_INSET) / natural.width
  if (count < 4) return wide
  const angle = Math.min(
    width / aspect,
    Math.max(0, height - GAP) / (count + portraitHeight)
  )
  return Math.min((portraitHeight * angle) / bandOf(natural), wide)
}

/**
 * The height kept for the board, in its own units: the full board's, so the
 * angles stay put as the batter and pitcher rows come and go — or the board's
 * own where it measures taller, as a phone's text does, which otherwise hung
 * below the room kept for it, onto the box score's line and the angles.
 */
function bandOf(natural: Size): number {
  return Math.max(FULL_BOARD_HEIGHT, natural.height)
}

/**
 * How tall a box score is drawn with one or two angles, against the height
 * six innings make at its width: shorter, so its own units are wider and
 * more innings fit before a team name is cut off.
 */
export const COMPACT_LINE_SCALE = 0.75

/** A box score's height at width `w` for a layout of `count` angles. */
function boxHeightFor(count: number, w: number): number {
  return lineBoxHeight(w) * (count <= 2 ? COMPACT_LINE_SCALE : 1)
}

/**
 * Where everything in the full-screen player goes: the angles, the game's
 * board and its box score, by how many angles there are and which way up
 * the screen is. One answer for the browser's grid and the phone's.
 *
 * Upright, the board sits on the top of the safe area, the box score just
 * below it (one to three angles), and the angles just below that, the space
 * left over at the bottom. Four angles shrink the board to the node's
 * `portraitHeight`. Sideways:
 *
 * - one angle (or one zoomed) is a single picture, with the board over it by
 *   the node's `single` setting and no box score;
 * - two angles sit on the bottom of the screen, with the board from just
 *   right of the middle and the box score up to just left of it, both
 *   resting on the angles, or the board alone in the middle;
 * - three take three quadrants and leave the top-left one to the board,
 *   with the box score below it, both against the angle to their right;
 * - four keep the board over the top-left angle, by the node's `landscape`
 *   setting.
 *
 * The box score is shaped for six innings (`LINE_BOX_WIDTH`), as tall as
 * that makes it at the width it is given; with one or two angles it is drawn
 * at `COMPACT_LINE_SCALE` of that height. With no board it takes the board's
 * place; with neither, the angles
 * start at the top of the safe area. Every board and box is kept inside the
 * safe area (`keptClear`).
 */
export function playerLayout(input: PlayerLayoutInput): PlayerLayout {
  const { screen, safe, landscape, settings, line } = input
  const count = Math.max(0, Math.min(4, input.count))
  const board = settings == null ? null : input.board
  const clear = (rect: Rect | null, area?: Rect): Rect | null =>
    rect == null ? null : keptClear(rect, safe, area)
  const none: PlayerLayout = {
    tiles: [],
    board: null,
    boardClip: null,
    box: null,
    boardCell: false
  }
  if (count === 0) return none

  if (!landscape) {
    let below = safe.y
    let boardRect: Rect | null = null
    let boxRect: Rect | null = null
    if (board != null && settings != null) {
      const scale = portraitScale(
        screen.width,
        screen.height - safe.y,
        board,
        count,
        settings.portraitHeight,
        input.aspect
      )
      boardRect = clear({
        x: BOARD_INSET,
        y: safe.y,
        w: board.width * scale,
        h: board.height * scale
      })
      // The band is the full board's, so the angles stay put as the batter
      // and pitcher rows come and go.
      below = safe.y + bandOf(board) * scale
      if (line && count <= 3) {
        // As wide as the board, and as tall as six innings make it there
        // (three quarters of that for one or two angles).
        const w = board.width * scale
        boxRect = clear({
          x: boardRect!.x,
          y: below + GAP,
          w,
          h: boxHeightFor(count, w)
        })
        below = boxRect!.y + boxRect!.h
      }
    } else if (line && count <= 3) {
      const w = screen.width - 2 * BOARD_INSET
      boxRect = clear({
        x: BOARD_INSET,
        y: safe.y,
        w,
        h: boxHeightFor(count, w)
      })
      below = boxRect!.y + boxRect!.h
    }
    const top = boardRect != null || boxRect != null ? below + GAP : safe.y
    const tiles = tileRects({
      width: screen.width,
      height: screen.height,
      top,
      count,
      aspect: input.aspect,
      zoomed: input.zoomed,
      align: 'top'
    })
    return {
      tiles,
      board: boardRect,
      boardClip: null,
      box: boxRect,
      boardCell: false
    }
  }

  const zoomed =
    input.zoomed != null && input.zoomed >= 0 && input.zoomed < count
      ? input.zoomed
      : count === 1
        ? 0
        : null
  // Three angles leave the top-left quadrant to whatever goes there.
  const boardCell = count === 3 && zoomed == null && (board != null || line)
  const tiles = tileRects({
    width: screen.width,
    height: screen.height,
    count,
    aspect: input.aspect,
    zoomed: input.zoomed,
    boardCell,
    align: count === 2 && zoomed == null ? 'bottom' : 'centre'
  })

  if (zoomed != null) {
    const picture = tiles[zoomed]
    return {
      tiles,
      board:
        board == null || settings == null
          ? null
          : clear(
              singleBoardRect({
                picture,
                placement: settings.single,
                natural: board
              }),
              picture
            ),
      boardClip: null,
      box: null,
      boardCell: false
    }
  }

  if (count === 2) {
    const top = Math.min(tiles[0].y, tiles[1].y)
    const half = screen.width / 2
    // Either side of the middle, inside the safe area.
    const leftRoom = half - GAP - Math.max(BOARD_INSET, safe.x + BOARD_INSET)
    const rightRoom =
      Math.min(screen.width, safe.x + safe.w) - BOARD_INSET - (half + GAP)
    const scaleFor = (natural: Size): number =>
      Math.max(
        0,
        Math.min(
          (top - Math.max(BOARD_INSET, safe.y + BOARD_INSET) - BOARD_INSET) /
            bandOf(natural),
          Math.min(leftRoom, rightRoom) / natural.width
        )
      )
    // The band's height above the angles, for a box score to stand in.
    const room = Math.max(
      0,
      top - Math.max(BOARD_INSET, safe.y + BOARD_INSET) - BOARD_INSET
    )
    if (board != null && line) {
      const scale = scaleFor(board)
      const bottom = top - BOARD_INSET
      // The left half, as tall as six innings make it there, unless the band
      // is shorter: then that tall, and as wide as that makes it.
      const boxWidth = Math.max(0, Math.min(leftRoom, lineBoxWidth(room)))
      const boxHeight = boxHeightFor(count, boxWidth)
      return {
        tiles,
        board: clear({
          x: half + GAP,
          y: bottom - bandOf(board) * scale,
          w: board.width * scale,
          h: board.height * scale
        }),
        boardClip: null,
        box: clear({
          x: half - GAP - boxWidth,
          y: bottom - boxHeight,
          w: boxWidth,
          h: boxHeight
        }),
        boardCell: false
      }
    }
    if (board != null)
      return {
        tiles,
        board: clear(aboveBoardRect(screen, top, board)),
        boardClip: null,
        box: null,
        boardCell: false
      }
    if (line) {
      const w = Math.max(
        0,
        Math.min(lineBoxWidth(room), leftRoom + rightRoom + 2 * GAP)
      )
      const h = boxHeightFor(count, w)
      return {
        tiles,
        board: null,
        boardClip: null,
        box: clear({
          x: (screen.width - w) / 2,
          y: top - BOARD_INSET - h,
          w,
          h
        }),
        boardCell: false
      }
    }
    return { ...none, tiles }
  }

  if (count === 3) {
    if (!boardCell) return { ...none, tiles }
    // The quadrant the three leave: left of the top-right angle, above the
    // bottom-left one.
    const cell = {
      x: tiles[1].x,
      y: tiles[0].y,
      w: tiles[1].w,
      h: tiles[0].h
    }
    const right = cell.x + cell.w - GAP
    // The box as wide as the board, and as tall as six innings make it.
    const width = board?.width ?? LINE_BOX_WIDTH
    const boxTall = line ? lineBoxHeight(width) : 0
    const tall = (board != null ? bandOf(board) : 0) + boxTall
    const gaps = board != null && line ? GAP : 0
    const scale = Math.max(
      0,
      Math.min(
        (cell.h - 2 * BOARD_INSET - gaps) / tall,
        (cell.w - BOARD_INSET - GAP) / width
      )
    )
    const boardRect =
      board == null
        ? null
        : clear(
            {
              x: right - board.width * scale,
              y: cell.y + BOARD_INSET,
              w: board.width * scale,
              h: board.height * scale
            },
            cell
          )
    const boxTop =
      board == null
        ? cell.y + BOARD_INSET
        : cell.y + BOARD_INSET + bandOf(board) * scale + GAP
    const boxRect = line
      ? clear(
          {
            x: right - width * scale,
            y: boxTop,
            w: width * scale,
            h: boxTall * scale
          },
          cell
        )
      : null
    return {
      tiles,
      board: boardRect,
      boardClip: null,
      box: boxRect,
      boardCell: true
    }
  }

  // Four: the board over the top-left angle, cut off by it.
  const corner = tiles[0]
  if (board == null || settings == null) return { ...none, tiles }
  const placed = tileBoardRect(corner, settings.landscape, board)
  return {
    tiles,
    board:
      placed == null
        ? null
        : clear(
            { ...placed, x: corner.x + placed.x, y: corner.y + placed.y },
            corner
          ),
    boardClip: corner,
    box: null,
    boardCell: false
  }
}

/** The top of the highest angle, where a notice goes; 0 with none. */
export function topOfAngles(layout: PlayerLayout): number {
  return layout.tiles.length === 0
    ? 0
    : Math.min(...layout.tiles.map(tile => tile.y))
}
