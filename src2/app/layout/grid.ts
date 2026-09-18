/**
 * How many columns of cards fit, and where each card sits.
 *
 * A narrow window gets one column so a phone shows one game at a time; a wide
 * one fills across. Cards are laid out row by row in the order they are given,
 * and the API hands games back newest first, so the newest is top-left and
 * reading order is newest to oldest — which is how somebody looks for last
 * night's game.
 */
/**
 * How many videos fit across, by the width they have to share.
 *
 * Four is the ceiling: a fifth column makes each row narrower than the two
 * lines of team names it has to hold, and the point of a wide window is to see
 * more games at once rather than to see the same ones smaller.
 */
export const GRID_BREAKPOINTS = [
  { minWidth: 0, columns: 1 },
  { minWidth: 640, columns: 2 },
  { minWidth: 1040, columns: 3 },
  { minWidth: 1440, columns: 4 }
]

export function columnsForWidth(width: number): number {
  let columns = 1
  for (const breakpoint of GRID_BREAKPOINTS) {
    if (width >= breakpoint.minWidth) columns = breakpoint.columns
  }
  return columns
}

export interface CardSizeOptions {
  width: number
  /** Space between cards and at the edges, in pixels. */
  gutter: number
  /** Widest a single card should ever be, so one card does not fill a TV. */
  maxCardWidth?: number
}

export interface CardSize {
  columns: number
  cardWidth: number
  gutter: number
}

/**
 * The width of one card, with equal gutters between and either side. Rounded
 * down so rounding never pushes the last card of a row onto the next one.
 */
export function cardSize(options: CardSizeOptions): CardSize {
  const { width, gutter, maxCardWidth } = options
  const columns = columnsForWidth(width)
  const available = Math.max(0, width - gutter * (columns + 1))
  let cardWidth = Math.floor(available / columns)
  if (maxCardWidth != null && cardWidth > maxCardWidth) cardWidth = maxCardWidth
  return { columns, cardWidth: Math.max(0, cardWidth), gutter }
}

/** Where a card sits in the grid, counting from the newest. */
export function cardPosition(
  index: number,
  columns: number
): { row: number; column: number } {
  return {
    row: Math.floor(index / columns),
    column: index % columns
  }
}

/**
 * How many columns a list of highlights gets.
 *
 * Not `columnsFor`: that is the rule for cards, which are far wider than a
 * highlight row, so the two would either cramp the cards or waste the list.
 * Derived from the width available against a sensible minimum rather than from
 * the breakpoint alone, so a narrow window with no rail does not get three
 * squeezed columns.
 */
export function highlightColumnsFor(width: number): number {
  // 380, not 288. A label like `Ground out: Benito W (2B) to Isaac D (1B)`
  // needs about that much even across two lines.
  const MIN = 380
  if (width < 600) return 1
  // Two is the ceiling, which is what YouTube fits under its player, and mostly
  // academic: the widest the stacked layout ever gets is just under a thousand
  // pixels, where two is what fits anyway. Above that the highlights move to a
  // 402px column on the right, which is one row wide and asks this same
  // function for its own count.
  return Math.max(1, Math.min(2, Math.floor(width / MIN)))
}
