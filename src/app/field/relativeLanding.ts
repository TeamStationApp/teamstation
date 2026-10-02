import { type Camera, Vector2, Vector3 } from 'three'

import type { BallArcState } from './ballArcModel'
import { TERRAIN } from './terrain'

/** Move the projected target by the pointer delta; never teleport to the finger. */
export function relativeLandingPointer(
  initial: BallArcState,
  start: { x: number; y: number },
  pointer: { x: number; y: number },
  camera: Camera
): Vector2 {
  const projected = new Vector3(
    initial.target.x,
    initial.landingHeight ?? TERRAIN.players,
    initial.target.z
  ).project(camera)
  return new Vector2(
    projected.x + pointer.x - start.x,
    projected.y + pointer.y - start.y
  )
}
