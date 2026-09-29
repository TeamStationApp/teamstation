/**
 * A pitch's speed as a scorer gives it, in miles an hour: from 20 to 110.
 * The engine drops any other speed a pitch gives, so a saved play that holds
 * one still replays.
 */
export function isPitchSpeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 20 &&
    value <= 110
  )
}

/**
 * One of MLB's pitch zones, as the catcher sees the plate: 1 to 9 across and
 * down the strike zone, and 11 to 14 the corners outside it. There is no 10.
 * The engine drops any other zone a pitch gives, and the Gumbo validator
 * refuses one on a stored play.
 */
export function isPitchZone(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    ((value >= 1 && value <= 9) || (value >= 11 && value <= 14))
  )
}
