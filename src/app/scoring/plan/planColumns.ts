/**
 * The game plan sheet's inning columns, apart from React Native so a
 * device driver can work them out too. A cell holds at most two characters
 * of a monospace font, whose every glyph is 0.6 em wide: 19.2 points at 16,
 * plus 8 points of padding, rounded up, is an inning column on a phone.
 */
export const PLAN_COLUMN_WIDTH = 28
/**
 * The window the inning columns are two characters wide in: the iPhone 17
 * Pro's 1206 pixels, at three to a point.
 */
export const PLAN_REFERENCE_WIDTH = 402
/**
 * Three times that display, 3618 pixels: the inning columns stop growing at
 * a window this wide, and the Plan tab is never wider.
 */
export const PLAN_MAX_WIDTH = 1206

/**
 * An inning column for a window `windowWidth` points wide: two characters
 * at the reference width and on anything narrower, growing in proportion
 * up to three times that at `PLAN_MAX_WIDTH`.
 */
export function planColumnWidth(windowWidth: number): number {
  const width = Math.min(
    Math.max(windowWidth, PLAN_REFERENCE_WIDTH),
    PLAN_MAX_WIDTH
  )
  return Math.round((PLAN_COLUMN_WIDTH * width) / PLAN_REFERENCE_WIDTH)
}
