import type { GroundPoint } from './fieldModel'
import { TERRAIN } from './terrain'
import { guideOffset } from './trajectoryGuide'

export interface BallArcState {
  target: GroundPoint
  angle: number
  landingHeight?: number
  /** Visual guide only; omitted from the actual hit flight. */
  guideBearing?: number
}
export type ArcMode = 'off' | 'aim' | 'edit'
export const BALL_GROUND = TERRAIN.players + 0.16
export const BALL_CONTACT = TERRAIN.players + 7.2
export function arcTarget(point: GroundPoint): GroundPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z))
    return { x: 0, z: -3 }
  const z = Math.min(-3, point.z)
  const radius = Math.hypot(point.x, z)
  const scale = Math.min(1, 160 / radius)
  return { x: point.x * scale, z: z * scale }
}
export function dragLaunchAngle(start: number, pixelsUp: number): number {
  return Math.max(-45, Math.min(70, start + pixelsUp * 0.5))
}
export function firstBounceFraction(angle: number): number {
  return 0.5 - Math.max(0, Math.min(1, -angle / 45)) * 0.44
}
/** Schematic trajectory: flight, or a straight hit to ground followed by a chop. */
export function arcPoint(
  arc: BallArcState,
  t: number
): { x: number; y: number; z: number } {
  t = Math.max(0, Math.min(1, t))
  const distance = Math.hypot(arc.target.x, arc.target.z)
  const landing = arc.landingHeight ?? BALL_GROUND
  let y: number
  if (arc.angle >= 0) {
    const lift = Math.max(
      0,
      distance * Math.tan((arc.angle * Math.PI) / 180) + BALL_CONTACT - landing
    )
    y = BALL_CONTACT * (1 - t) + landing * t + lift * t * (1 - t)
  } else {
    const first = firstBounceFraction(arc.angle)
    if (t <= first)
      y = BALL_CONTACT + ((BALL_GROUND - BALL_CONTACT) * t) / first
    else {
      const u = (t - first) / (1 - first)
      const peak = Math.max(0.5, distance * (1 - first) * 0.1)
      y = BALL_GROUND * (1 - u) + landing * u + 4 * peak * u * (1 - u)
    }
  }
  return {
    x:
      t === 0
        ? 0
        : arc.target.x * t +
          (arc.guideBearing == null
            ? 0
            : guideOffset(arc.target, arc.guideBearing, t)),
    y,
    z: t === 0 ? 0 : arc.target.z * t
  }
}
export function arcHandle(arc: BallArcState): {
  x: number
  y: number
  z: number
} {
  if (arc.angle < 0) return arcPoint(arc, firstBounceFraction(arc.angle))
  const landing = arc.landingHeight ?? BALL_GROUND
  const lift = Math.max(
    0.001,
    Math.hypot(arc.target.x, arc.target.z) *
      Math.tan((arc.angle * Math.PI) / 180) +
      BALL_CONTACT -
      landing
  )
  const t = Math.max(
    0.05,
    Math.min(0.95, 0.5 + (landing - BALL_CONTACT) / (2 * lift))
  )
  return arcPoint(arc, t)
}
