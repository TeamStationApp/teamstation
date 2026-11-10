/**
 * Whether a team card's name moves below its corner: a place badge beside the
 * gear or the Follow button leaves too little room on a narrow card, and the
 * name would break inside a word.
 */
export function nameGoesBelowControls(
  hasPlace: boolean,
  hasCornerControl: boolean,
  cardWidth: number,
  roomNeeded: number
): boolean {
  return hasPlace && hasCornerControl && cardWidth < roomNeeded
}
