/**
 * The space between two cards in the roster, lineup and defense columns:
 * one rem, the app's body text size (`theme.rem(1)`, 16 points), so a card's
 * drop shadow reads against the next card. The lists, the space a drag opens
 * for its card, and the drag geometry all use it, so what the scorer sees and
 * where a drop lands agree.
 */
export const ROSTER_CARD_GAP = 16
/** The space between the Roster and Lineup columns side by side: a rem. */
export const ROSTER_COLUMN_GAP = 16

/**
 * Defense's two roster columns in a grid `width` wide: the left card's left
 * edge `margin` in from one side, the right card's right edge `margin` in
 * from the other, and `gap` between them.
 */
export function rosterGridColumns(
  width: number,
  margin: number,
  gap: number
): [{ left: number; width: number }, { left: number; width: number }] {
  const column = Math.max(0, (width - 2 * margin - gap) / 2)
  return [
    { left: margin, width: column },
    { left: margin + column + gap, width: column }
  ]
}
