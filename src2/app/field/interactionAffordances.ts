import { type Camera, type Ray, type Raycaster, Vector2 } from 'three'

export const TOUCH_TARGET_LIFT = 32
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
/** Offset in screen pixels before intersecting the field or seats, so tilt,
 * zoom, and landing height do not change the amount of finger clearance. */
export function placementRay(
  raw: Ray,
  pointer: { x: number; y: number },
  camera: Camera,
  height: number,
  touch: boolean,
  caster: Raycaster
): Ray {
  if (!touch) return raw
  caster.setFromCamera(
    new Vector2(
      pointer.x,
      pointer.y + (2 * TOUCH_TARGET_LIFT) / Math.max(1, height)
    ),
    camera
  )
  return caster.ray
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
