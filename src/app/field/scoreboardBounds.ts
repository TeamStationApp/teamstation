import { type Camera, Vector3 } from 'three'

import { SCOREBOARD_SCALE, SCOREBOARD_Y, SCOREBOARD_Z } from './cameraModel'
export function scoreboardBounds(
  camera: Camera,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  const topLeft = new Vector3(
    -33 * SCOREBOARD_SCALE,
    SCOREBOARD_Y + 9 * SCOREBOARD_SCALE,
    SCOREBOARD_Z
  ).project(camera)
  const bottomRight = new Vector3(
    33 * SCOREBOARD_SCALE,
    SCOREBOARD_Y - 9 * SCOREBOARD_SCALE,
    SCOREBOARD_Z
  ).project(camera)
  const left = Math.max(12, ((topLeft.x + 1) * width) / 2)
  return {
    x: Math.min(left, Math.max(12, width - 100)),
    y: Math.max(62, ((1 - topLeft.y) * height) / 2),
    width: Math.max(
      76,
      Math.min(width - left - 12, ((bottomRight.x - topLeft.x) * width) / 2)
    ),
    height: Math.max(60, ((topLeft.y - bottomRight.y) * height) / 2)
  }
}
