// Where a sponsor's logo and reel are drawn over video: pure arithmetic, so
// the admin previews and every player place them from the same numbers.
// Every rect is in the coordinates of whatever holds it.
import type {
  BoardPlacement,
  LogoPlacement,
  ReelPlacement
} from '../../../common/nodeSettings'
import type { Rect } from '../controlGeometry'
import type { Size } from '../scoreboardOverlay/overlayLayout'

/**
 * A logo in `tile`'s upper-right corner: `side` of the tile's width to its
 * right and `top` of its height above it, as large as fits in `maxWidth` ×
 * `maxHeight` of the tile, its own proportions kept. A logo whose size is
 * not known yet is taken as square.
 */
export function logoRect(
  tile: Rect,
  placement: LogoPlacement,
  natural: Size
): Rect {
  const ratio =
    natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 1
  const widest = placement.maxWidth * tile.w
  const tallest = placement.maxHeight * tile.h
  const h = Math.min(tallest, widest / ratio)
  const w = h * ratio
  return {
    x: tile.x + tile.w - placement.side * tile.w - w,
    y: tile.y + placement.top * tile.h,
    w,
    h
  }
}

/**
 * Where a reel sits in `space`: the largest rect of its `aspect` inside
 * both the space and `maxWidth` × `maxHeight` of the screen. In a board's
 * place (`'board'`) it starts at the space's top-left, as the board does;
 * in a free band below the video (`'band'`) it is centred across the top.
 */
export function reelRect(
  space: Rect,
  placement: ReelPlacement,
  screen: Size,
  aspect: number,
  anchor: 'board' | 'band' = 'board'
): Rect {
  const ratio = aspect > 0 ? aspect : 16 / 9
  const widest = Math.max(
    0,
    Math.min(space.w, placement.maxWidth * screen.width)
  )
  const tallest = Math.max(
    0,
    Math.min(space.h, placement.maxHeight * screen.height)
  )
  const h = Math.min(tallest, widest / ratio)
  const w = h * ratio
  return {
    x: anchor === 'band' ? space.x + (space.w - w) / 2 : space.x,
    y: space.y,
    w,
    h
  }
}

/**
 * The part of `picture` a board placed by `placement` starts in: from the
 * board's anchor (as `placedBoardRect` puts its top-left) to the picture's
 * lower-right corner. A reel takes the board's place there.
 */
export function boardPlaceSpace(
  picture: Rect,
  placement: Pick<BoardPlacement, 'x' | 'y'>
): Rect {
  const x = picture.x + placement.x * picture.w
  const y = picture.y + placement.y * picture.h
  return {
    x,
    y,
    w: picture.x + picture.w - x,
    h: picture.y + picture.h - y
  }
}

/** The live pill over a picture: its inset from the corner, and its size. */
export interface PillBox {
  inset: number
  w: number
  h: number
}

/**
 * Where the live pill starts down from the surface's top, when a sponsor's
 * `logo` is drawn over `picture` on a surface `width` wide; `null` keeps
 * the pill at its own inset in the upper-right corner. The pill moves only
 * when the logo covers that spot: then just below the logo if it fits
 * there inside the picture, else just above it, else it stays put. A node
 * admin can place the logo anywhere, so a logo low in the picture or far
 * from the corner leaves the pill where it was.
 */
export function livePillTop(
  width: number,
  picture: Rect,
  logo: Rect | null,
  pill: PillBox,
  gap: number
): number | null {
  if (logo == null) return null
  const own = {
    x: width - pill.inset - pill.w,
    y: pill.inset,
    w: pill.w,
    h: pill.h
  }
  const covers =
    logo.x < own.x + own.w + gap &&
    logo.x + logo.w + gap > own.x &&
    logo.y < own.y + own.h + gap &&
    logo.y + logo.h + gap > own.y
  if (!covers) return null
  const below = logo.y + logo.h + gap
  if (below + pill.h <= picture.y + picture.h) return below
  const above = logo.y - gap - pill.h
  if (above >= picture.y) return above
  return null
}
