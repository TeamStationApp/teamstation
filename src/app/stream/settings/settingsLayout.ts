/** The narrowest landscape window that takes two columns of cards. */
export const TWO_COLUMN_MIN_WIDTH = 600

/**
 * How many columns of cards the settings sheet lays out: two in landscape
 * when the window is at least 600 wide, as TS Cameraman's sheet does, and one
 * otherwise. A window taller than it is wide is one column.
 */
export function settingsColumns(width: number, height: number): 1 | 2 {
  return width > height && width >= TWO_COLUMN_MIN_WIDTH ? 2 : 1
}

/**
 * The cards split into columns, in order: the first column takes the first
 * half (the larger half when the count is odd), so reading down the left
 * column and then the right one is the cards' own order.
 */
export function cardColumns<T>(cards: T[], columns: 1 | 2): T[][] {
  if (columns === 1) return [cards]
  const left = Math.ceil(cards.length / 2)
  return [cards.slice(0, left), cards.slice(left)]
}
