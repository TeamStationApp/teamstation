import type { Point } from './state'

/**
 * The park as data: where the fence is, measured from home plate in the
 * field's own units, with the outfield opening to `outfieldHalfAngle` either
 * side of straight away. The 3D field draws its wall from the same profile.
 */
export interface ParkProfile {
  outfieldRadius: number
  warningTrackInner: number
  outfieldHalfAngle: number
}
export const PARK: ParkProfile = {
  outfieldRadius: 118,
  warningTrackInner: 109,
  outfieldHalfAngle: Math.PI / 3.5
}

export type HomeRunKind = 'out-of-park' | 'in-park'

/** The visible fence is the boundary: a ball on it stayed in play. */
export function homeRunKind(
  point: Point,
  park: ParkProfile = PARK
): HomeRunKind {
  return point.z < 0 &&
    Math.abs(Math.atan2(point.x, -point.z)) <= park.outfieldHalfAngle + 1e-8 &&
    Math.hypot(point.x, point.z) > park.outfieldRadius + 1e-8
    ? 'out-of-park'
    : 'in-park'
}

/** Between the foul lines, which run at 45° either side of straight away. */
export function isFair(point: Point): boolean {
  return point.z <= 1e-8 && Math.abs(point.x) <= -point.z + 1e-8
}
