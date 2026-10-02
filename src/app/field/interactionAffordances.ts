export const ARC_GRAB_HALF_WIDTH = 96
export const ARC_GRAB_HALF_HEIGHT = 80
export const ARROW_OVERLAY_ORDER = 1000

export function usesTouchPlacement(
  pointerType: string | undefined,
  mobileHint: boolean
): boolean {
  if (pointerType === 'mouse' || pointerType === 'pen') return false
  return pointerType === 'touch' || mobileHint
}
/**
 * Whether a press is the primary one: a mouse's main button, a pen tip or a
 * finger. Fiber's native Canvas sends a phone's touch with no `button` at all.
 */
export function isPrimaryPress(event: {
  button?: number
  pointerType?: string
}): boolean {
  return event.button === undefined
    ? event.pointerType === 'touch'
    : event.button === 0
}
/** World-space finger clearance, measured in metres (10 feet). */
export const TOUCH_TARGET_DISTANCE = 3.048
export function offsetTouchTarget(
  point: { x: number; z: number },
  touch: boolean
): { x: number; z: number } {
  if (!touch) return { ...point }
  const length = Math.hypot(point.x, point.z)
  return length < 0.001
    ? { x: point.x, z: point.z - TOUCH_TARGET_DISTANCE }
    : {
        x: point.x + (point.x / length) * TOUCH_TARGET_DISTANCE,
        z: point.z + (point.z / length) * TOUCH_TARGET_DISTANCE
      }
}
export function inArcGrabArea(dx: number, dy: number): boolean {
  return (
    Math.abs(dx) <= ARC_GRAB_HALF_WIDTH && Math.abs(dy) <= ARC_GRAB_HALF_HEIGHT
  )
}
/** A crest travels outward; brightness depends on distance from that crest,
 * so the oldest (innermost) trail is darkest when the outer arrow lights up. */
export function arrowPulse(stop: number, seconds: number): number {
  const phase = ((seconds % 1.8) / 1.8) * 3
  return 0.04 + 0.96 * Math.exp(-Math.abs(phase - stop) * 1.65)
}
