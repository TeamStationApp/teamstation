import { type Camera, Vector3 } from 'three'

import { arcPoint, type BallArcState } from './ballArcModel'
import { TERRAIN } from './terrain'
import { guideBearing } from './trajectoryGuide'

/** Screen-space guidance stays beside the arc even when the camera extends its viewport. */
export function trajectoryGrip(
  arc: BallArcState,
  camera: Camera,
  size: { width: number; height: number }
): { position: Vector3; scale: number } {
  const home = new Vector3(0, TERRAIN.players, 0).project(camera)
  const target = new Vector3(
    arc.target.x,
    arc.landingHeight ?? TERRAIN.players,
    arc.target.z
  ).project(camera)
  const middleY = (home.y + target.y) / 2
  const side = (arc.guideBearing ?? guideBearing(arc.target)) > 0 ? -1 : 1
  const projected = (t: number): Vector3 => {
    const p = arcPoint(arc, t)
    return new Vector3(p.x, p.y, p.z).project(camera)
  }
  let previous = projected(0)
  let closest = previous
  let crossing: Vector3 | undefined
  for (let i = 1; i <= 96; i++) {
    const next = projected(i / 96)
    if (Math.abs(next.y - middleY) < Math.abs(closest.y - middleY))
      closest = next
    if (
      (previous.y - middleY) * (next.y - middleY) <= 0 &&
      next.y !== previous.y
    ) {
      const point = previous
        .clone()
        .lerp(next, (middleY - previous.y) / (next.y - previous.y))
      if (crossing == null || side * point.x > side * crossing.x)
        crossing = point
    }
    previous = next
  }
  const anchor = (crossing ?? closest).clone()
  anchor.y = middleY
  anchor.x += (side * 15 * 2) / Math.max(1, size.width)
  const position = anchor.clone().unproject(camera)
  const pixel = anchor.clone()
  pixel.y += 2 / Math.max(1, size.height)
  return { position, scale: pixel.unproject(camera).distanceTo(position) }
}
