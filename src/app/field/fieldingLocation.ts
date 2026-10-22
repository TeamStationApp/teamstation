import type { Depth } from '../../common/scoring/depth'
import { clampToField, type GroundPoint } from './fieldModel'
import { OUTFIELD_RADIUS } from './stadiumBoundary'

/** Depths a ball is played at up against the wall. */
const AT_THE_WALL: ReadonlySet<Depth> = new Set([
  'deep',
  'warning_track',
  'wall'
])

export function isFairLocation(point: GroundPoint): boolean {
  return point.z <= 1e-8 && Math.abs(point.x) <= -point.z + 1e-8
}
/**
 * Where a ball is played for this outcome. A ball said to go deep, to the
 * warning track or off the wall is played out to the wall, on whichever
 * side of the line it was: only its distance is bounded. Every other ball
 * stays where the field lets a fielder stand.
 */
export function fieldingLocation(
  outcome: string,
  point: GroundPoint,
  depth?: Depth
): GroundPoint {
  if (depth != null && AT_THE_WALL.has(depth)) {
    const scale = Math.min(
      1,
      (OUTFIELD_RADIUS - 0.5) / Math.max(1, Math.hypot(point.x, point.z))
    )
    return { x: point.x * scale, z: point.z * scale }
  }
  if (
    !['Single', 'Double', 'Triple', 'Error', "Fielder's Choice"].includes(
      outcome
    )
  )
    return clampToField(point)
  const z = Math.min(0, point.z)
  const x = Math.max(z, Math.min(-z, point.x))
  const scale = Math.min(1, OUTFIELD_RADIUS / Math.max(1, Math.hypot(x, z)))
  return { x: x * scale, z: z * scale }
}
