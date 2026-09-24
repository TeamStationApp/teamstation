import type { GroundPoint } from './fieldModel'

export const OUTFIELD_RADIUS = 118
export const WARNING_TRACK_INNER = 109
export const OUTFIELD_HALF_ANGLE = Math.PI / 3.5
export type HomeRunKind = 'out-of-park' | 'in-park'
/** The visible fence is the classification boundary; a ball on it is in play. */
export function homeRunKind(point: GroundPoint): HomeRunKind {
  return point.z < 0 &&
    Math.abs(Math.atan2(point.x, -point.z)) <= OUTFIELD_HALF_ANGLE + 1e-8 &&
    Math.hypot(point.x, point.z) > OUTFIELD_RADIUS + 1e-8
    ? 'out-of-park'
    : 'in-park'
}
export function homeRunLanding(point: GroundPoint): GroundPoint {
  const distance = Math.hypot(point.x, point.z)
  if (
    point.z <= 0 &&
    Math.abs(point.x) <= -point.z &&
    distance >= 3 &&
    distance <= 160
  )
    return { ...point }
  const angle = Math.max(
    -Math.PI / 4,
    Math.min(Math.PI / 4, Math.atan2(point.x, -point.z))
  )
  const radius = Math.max(3, Math.min(160, Math.hypot(point.x, point.z)))
  return { x: Math.sin(angle) * radius, z: -Math.cos(angle) * radius }
}
export function homeRunLabel(kind: HomeRunKind): string {
  return kind === 'out-of-park' ? 'Home Run' : 'In-the-park Home Run'
}
