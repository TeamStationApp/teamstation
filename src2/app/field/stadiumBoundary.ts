import { type HomeRunKind, homeRunKind, PARK } from '../../common/scoring/rules'
import type { GroundPoint } from './fieldModel'

/**
 * The wall as the field draws it, from the park profile the scoring library
 * calls home runs by, so the fence a ball clears is the fence on screen.
 */
export const OUTFIELD_RADIUS = PARK.outfieldRadius
export const WARNING_TRACK_INNER = PARK.warningTrackInner
export const OUTFIELD_HALF_ANGLE = PARK.outfieldHalfAngle
export { homeRunKind }
export type { HomeRunKind }
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
