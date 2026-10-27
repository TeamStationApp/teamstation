import type { Rect } from './motion'

/**
 * Where the test pattern draws what the suite reads back, as fractions of the
 * picture. `testPatternGame.ts` draws it and `counter.ts` reads it, so both
 * take the boxes from here.
 *
 * The frame counter sits on a solid black box in the lower middle: clear of
 * the tile's name at the top left, the grid's notices at the top, and the
 * scrub bar along the bottom of the screen.
 */
export const LAYOUT = {
  /** The angle's name, large. */
  label: { x: 0.04, y: 0.06, size: 0.1 },
  /** Seven digits of frame number, white on black. */
  counter: { x: 0.3, y: 0.56, w: 0.4, h: 0.15 },
  /** Media time and wall clock, for people and the webcam. */
  clock: { x: 0.04, y: 0.8, size: 0.05 }
} as const

/** The pattern's frame rate, matched to the Distributor's uploads. */
export const PATTERN_FPS = 60

/** The picture's own aspect ratio. */
export const PATTERN_ASPECT = 16 / 9

/**
 * Where a picture of `aspect` lands inside a tile drawn `object-fit:
 * contain`: centred, as large as fits, letterboxed on the other axis.
 */
export function contentRect(tile: Rect, aspect: number = PATTERN_ASPECT): Rect {
  if (tile.w / tile.h > aspect) {
    const w = tile.h * aspect
    return { x: tile.x + (tile.w - w) / 2, y: tile.y, w, h: tile.h }
  }
  const h = tile.w / aspect
  return { x: tile.x, y: tile.y + (tile.h - h) / 2, w: tile.w, h }
}

/**
 * Where the angle's name is drawn inside the picture's on-screen rectangle:
 * a band across the top left just wide enough for "Primary" in large type,
 * and short of the pattern's yellow bar.
 */
export function labelBox(content: Rect): Rect {
  const { x, y, size } = LAYOUT.label
  return {
    x: content.x + content.w * (x - 0.01),
    y: content.y + content.h * (y - 0.01),
    w: content.w * 0.27,
    h: content.h * (size + 0.04)
  }
}

/** The counter's box inside the picture's on-screen rectangle. */
export function counterBox(content: Rect): Rect {
  const box = LAYOUT.counter
  return {
    x: content.x + content.w * box.x,
    y: content.y + content.h * box.y,
    w: content.w * box.w,
    h: content.h * box.h
  }
}
