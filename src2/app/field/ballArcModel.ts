import { clampToField, type GroundPoint } from './fieldModel'
import { TERRAIN } from './terrain'

export interface BallArcState {
  target: GroundPoint
  angle: number
}
export type ArcMode = 'off' | 'aim' | 'edit'
export function arcTarget(point: GroundPoint): GroundPoint {
  const target = clampToField({ x: point.x, z: Math.min(-3, point.z) })
  return target
}
export function dragLaunchAngle(start: number, pixelsUp: number): number {
  return Math.max(-45, Math.min(65, start + pixelsUp * 0.35))
}
/** Below 5 degrees the display becomes a chopper. Lower angles move the first
 * impact toward the batter. A schematic coaching path, not a ball-flight solver. */
export function firstBounceFraction(angle: number): number {
  return 0.65 - Math.max(0, Math.min(1, (5 - angle) / 50)) * 0.57
}
export function arcPoint(
  arc: BallArcState,
  t: number
): { x: number; y: number; z: number } {
  t = Math.max(0, Math.min(1, t))
  const distance = Math.hypot(arc.target.x, arc.target.z)
  let y: number
  if (arc.angle >= 5) {
    // dy/dx at home = tan(launch angle); same-height ballistic endpoints.
    y = distance * Math.tan((arc.angle * Math.PI) / 180) * t * (1 - t)
  } else {
    const first = firstBounceFraction(arc.angle)
    const impacts = [0, first, first + (1 - first) * 0.6, 1]
    const segment = t <= first ? 0 : t <= impacts[2] ? 1 : 2
    const u = (t - impacts[segment]) / (impacts[segment + 1] - impacts[segment])
    const peak = ((distance * 0.022 * first) / 0.65) * [1, 0.58, 0.27][segment]
    y = 4 * peak * u * (1 - u)
  }
  return {
    x: t === 0 ? 0 : arc.target.x * t,
    y: TERRAIN.players + 0.16 + y,
    z: t === 0 ? 0 : arc.target.z * t
  }
}
export function arcHandle(arc: BallArcState): {
  x: number
  y: number
  z: number
} {
  const point = arcPoint(
    arc,
    arc.angle >= 5 ? 0.5 : firstBounceFraction(arc.angle) / 2
  )
  return point
}
