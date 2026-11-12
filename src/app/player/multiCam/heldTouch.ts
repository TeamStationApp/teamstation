/**
 * Whether the finger a phone's grid is following has lifted without saying so.
 *
 * Every touch event carries the fingers on the glass now (`touches`). One
 * that no longer lists the followed finger means its lift was never
 * delivered: left followed, a crawl ran on and every later touch was refused
 * as a second finger. Unknown when the event does not list the fingers.
 */
export function liftWasLost(
  followed: number | null,
  touches: ReadonlyArray<{ identifier: number | string }> | undefined
): boolean {
  if (followed == null || touches == null) return false
  return !touches.some(touch => Number(touch.identifier) === followed)
}
