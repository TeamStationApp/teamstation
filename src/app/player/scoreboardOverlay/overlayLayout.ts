import type { BoardPlacement } from '../../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../../common/scoreboard'
import type { Rect } from '../controlGeometry'
import { BOARD_INSET } from './layouts'

/**
 * The geometry of the scoreboard over a picture: where the picture is inside
 * its view, where the board goes in it, and how big.
 *
 * Pure arithmetic, so the rules are tested on their own and the two views,
 * web and phone, draw from the same numbers. The board itself is drawn at its
 * natural size and scaled by one factor (`ScoreboardOverlay`), so everything
 * here is a rectangle whose width follows from its height and the board's
 * shape.
 *
 * Every size is set for the full board, batter and pitcher rows included
 * (`FULL_BOARD_HEIGHT` tall at its natural size): a board with nobody named
 * is drawn at the same scale and so comes out shorter, not stretched. A
 * board too big for its space is narrowed to fit, keeping its top-left
 * corner. However small that makes it, it is drawn: a board that shows and
 * hides with the size of the window would blink.
 */

export interface Size {
  width: number
  height: number
}

/**
 * Where a picture of `aspect` lands in a box, fitted whole and centred: the
 * box less any black bars above and below it, or either side.
 */
export function pictureRect(
  boxWidth: number,
  boxHeight: number,
  aspect: number
): Rect {
  if (!(aspect > 0) || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, w: Math.max(0, boxWidth), h: Math.max(0, boxHeight) }
  }
  let w = boxWidth
  let h = boxWidth / aspect
  if (h > boxHeight) {
    h = boxHeight
    w = boxHeight * aspect
  }
  return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h }
}

/** Whether two rectangles share any area; touching edges do not count. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

/** The board's width when it is drawn `height` tall. */
export function widthAt(natural: Size, height: number): number {
  return natural.height > 0 ? (height * natural.width) / natural.height : 0
}

/** The full board's natural height, its batter and pitcher rows included. */
export const FULL_BOARD_HEIGHT = SCOREBOARD_BOARD_SIZE.height

/**
 * The board drawn at `scale` from `x`, `y`, narrowed to fit inside `area`
 * from that corner; null where it would not be readable.
 */
function fitted(
  area: Rect,
  x: number,
  y: number,
  scale: number,
  natural: Size
): Rect | null {
  if (natural.width <= 0 || natural.height <= 0 || !(scale > 0)) return null
  let w = natural.width * scale
  let h = natural.height * scale
  const room = Math.min(
    1,
    Math.max(0, area.x + area.w - x) / w,
    Math.max(0, area.y + area.h - y) / h
  )
  w *= room
  h *= room
  if (!(h > 0)) return null
  return { x, y, w, h }
}

/**
 * The board over `area` by a node placement: its top-left corner at the
 * placement's fractions of the area, the full board `height` of the area
 * tall. It sits exactly there, whatever the player draws around it, and is
 * only ever narrowed to stay inside the area.
 */
export function placedBoardRect(
  area: Rect,
  placement: BoardPlacement,
  natural: Size
): Rect | null {
  return fitted(
    area,
    area.x + placement.x * area.w,
    area.y + placement.y * area.h,
    (placement.height * area.h) / FULL_BOARD_HEIGHT,
    natural
  )
}

/** The board over a single camera's picture. */
export function singleBoardRect(options: {
  /** The picture inside the view: the view less any black bars. */
  picture: Rect
  placement: BoardPlacement
  /** The board's own size, as measured. */
  natural: Size
}): Rect | null {
  return placedBoardRect(options.picture, options.placement, options.natural)
}

/**
 * The board over the landscape grid's top-left angle, four angles, in that
 * angle's own coordinates.
 */
export function tileBoardRect(
  tile: Rect,
  placement: BoardPlacement,
  natural: Size
): Rect | null {
  return placedBoardRect(
    { x: 0, y: 0, w: tile.w, h: tile.h },
    placement,
    natural
  )
}

/** Fractions of a point off an edge are arithmetic, not a crossing. */
const EDGE_SLACK = 1e-6

/**
 * Where the top-left angle's name goes in the four-angle landscape grid
 * while the board is over that angle, in the angle's own coordinates: just
 * below the full board, so the board never hides which angle it is. Given
 * the board's `natural` size, the full board is placed and fitted to the
 * angle as it is drawn, and with a `safe` area kept clear of the hardware
 * (`keptClear`), and the name goes under the rect that results.
 */
export function tileNameTop(
  tile: Rect,
  placement: BoardPlacement,
  safe?: Rect,
  natural?: Size
): number {
  const full =
    natural == null
      ? null
      : placedBoardRect(tile, placement, {
          width: natural.width,
          height: FULL_BOARD_HEIGHT
        })
  if (full == null) {
    // Unmeasured: the full board's top, moved down clear as `keptClear`
    // moves it.
    const top = tile.y + placement.y * tile.h
    const kept =
      safe != null && top < safe.y - EDGE_SLACK ? safe.y + BOARD_INSET : top
    return kept - tile.y + placement.height * tile.h + BOARD_INSET / 2
  }
  const kept = safe == null ? full : keptClear(full, safe, tile)
  return kept.y + kept.h - tile.y + BOARD_INSET / 2
}

/**
 * The landscape grid of two angles: the board centred in the space the grid
 * leaves above them, as tall as that space allows less the insets.
 */
export function aboveBoardRect(
  screen: Size,
  /** The top of the angles. */
  top: number,
  natural: Size
): Rect | null {
  const scale = Math.max(0, top - 2 * BOARD_INSET) / FULL_BOARD_HEIGHT
  const across = Math.max(0, screen.width - 2 * BOARD_INSET)
  const narrowed = Math.min(
    scale,
    natural.width > 0 ? across / natural.width : 0
  )
  const w = natural.width * narrowed
  const h = natural.height * narrowed
  if (!(h > 0)) return null
  return { x: (screen.width - w) / 2, y: (top - h) / 2, w, h }
}

/**
 * The landscape grid of three angles: the board in the top-left quadrant,
 * which the angles leave to it, a video wide less the insets, or as tall as
 * the quadrant allows.
 */
export function cellBoardRect(cell: Rect, natural: Size): Rect | null {
  if (natural.width <= 0) return null
  const scale = Math.min(
    Math.max(0, cell.w - 2 * BOARD_INSET) / natural.width,
    Math.max(0, cell.h - 2 * BOARD_INSET) / FULL_BOARD_HEIGHT
  )
  return fitted(
    cell,
    cell.x + BOARD_INSET,
    cell.y + BOARD_INSET,
    scale,
    natural
  )
}

/**
 * The portrait grid's board, in the band above the topmost angle: with four
 * angles, the full board is `portraitHeight` of one angle's height; with
 * fewer it is the screen's width less the insets. Either way it is narrowed
 * to the width.
 *
 * The four angles stack in what the band leaves, each as wide as the screen
 * unless that makes the stack too tall, and then as tall as a quarter of what
 * is left (`gridBox`). So the angle's height and the band's are found
 * together: an angle is the screen's width at its `aspect`, or, where that
 * does not fit, `h` with `count·h + portraitHeight·h + 2·inset` the screen's
 * height. A board narrowed to the width is shorter, which only leaves the
 * angles more room.
 */
function portraitScale(
  screen: Size,
  natural: Size,
  count: number,
  portraitHeight: number,
  aspect: number
): number {
  if (natural.width <= 0) return 0
  const across = Math.max(0, screen.width - 2 * BOARD_INSET)
  const wide = across / natural.width
  if (count < 4) return wide
  const angle = Math.min(
    screen.width / aspect,
    Math.max(0, screen.height - 2 * BOARD_INSET) / (count + portraitHeight)
  )
  const tall = (portraitHeight * angle) / FULL_BOARD_HEIGHT
  return Math.min(tall, wide)
}

/**
 * The band the portrait grid keeps above its angles: the full board's height
 * at the portrait scale and the inset above and below, so the angles stay
 * put while the batter and pitcher rows come and go.
 */
export function bandHeight(
  screen: Size,
  natural: Size,
  count: number,
  portraitHeight: number,
  aspect = 16 / 9
): number {
  const scale = portraitScale(screen, natural, count, portraitHeight, aspect)
  return scale > 0 ? FULL_BOARD_HEIGHT * scale + 2 * BOARD_INSET : 0
}

/**
 * The board moved out from under the hardware: the grid's pictures run to the
 * screen's edges, under a notch, the Dynamic Island and the rounded corners,
 * and the board must not. Where it crosses an edge of the `safe` area it goes
 * back inside by the board's inset; where it is clear it stays exactly where
 * it was put. A board the move would take past the far edge of the safe area,
 * or of the `area` it was placed in, is narrowed to fit from its new corner,
 * keeping its shape, as `fitted` narrows one: it never overflows.
 */
export function keptClear(rect: Rect, safe: Rect, area?: Rect): Rect {
  const move = (
    at: number,
    size: number,
    from: number,
    room: number
  ): number =>
    at < from - EDGE_SLACK
      ? from + BOARD_INSET
      : at + size > from + room + EDGE_SLACK
        ? Math.max(from + BOARD_INSET, from + room - BOARD_INSET - size)
        : at
  const x = move(rect.x, rect.w, safe.x, safe.w)
  const y = move(rect.y, rect.h, safe.y, safe.h)
  const right = Math.min(
    safe.x + safe.w,
    area == null ? Number.POSITIVE_INFINITY : area.x + area.w
  )
  const bottom = Math.min(
    safe.y + safe.h,
    area == null ? Number.POSITIVE_INFINITY : area.y + area.h
  )
  const room =
    rect.w > 0 && rect.h > 0
      ? Math.min(
          1,
          Math.max(0, right - x + EDGE_SLACK) / rect.w,
          Math.max(0, bottom - y + EDGE_SLACK) / rect.h
        )
      : 1
  return { x, y, w: rect.w * room, h: rect.h * room }
}

/** The board in the portrait grid's band, at its left inset. */
export function bandBoardRect(
  screen: Size,
  natural: Size,
  count: number,
  portraitHeight: number,
  aspect = 16 / 9
): Rect | null {
  const scale = portraitScale(screen, natural, count, portraitHeight, aspect)
  return fitted(
    { x: 0, y: 0, w: screen.width, h: Number.POSITIVE_INFINITY },
    BOARD_INSET,
    BOARD_INSET,
    scale,
    natural
  )
}
