/**
 * A ball's launch angle, in degrees above the horizontal: from -90, straight
 * down, to 90, straight up. The engine drops any other angle a ball in play
 * gives, and the Gumbo validator refuses one on a stored play.
 */
export function isLaunchAngle(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  )
}
