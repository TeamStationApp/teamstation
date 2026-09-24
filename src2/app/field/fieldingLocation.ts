import { clampToField, type GroundPoint } from './fieldModel'
import { OUTFIELD_RADIUS } from './stadiumBoundary'

export function isFairLocation(point: GroundPoint): boolean {
  return point.z <= 1e-8 && Math.abs(point.x) <= -point.z + 1e-8
}
export function fieldingLocation(
  outcome: string,
  point: GroundPoint
): GroundPoint {
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
