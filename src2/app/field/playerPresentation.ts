import { type PerspectiveCamera, type Sprite, Vector3 } from 'three'

import type { FieldPlayer } from './fieldModel'
import { TERRAIN } from './terrain'

export const PLAYER_SCALE = 3.2 * 1.15
export const LABEL_WIDTH = 56
export const LABEL_HEIGHT = 14
export const LABEL_GAP = 0.3048 // One real-world foot, in game metres.
export function hasPlayerLabel(player: FieldPlayer): boolean {
  return (
    player.playerId != null || (player.team !== 'runner' && player.id !== 'P')
  )
}
/** Screen-relative left/right/below placement remains useful in every camera view.
 * Sprite anchors keep the box outside the player instead of centred on the head. */
export function placePlayerLabel(
  label: Sprite,
  player: FieldPlayer,
  camera: PerspectiveCamera,
  viewportHeight: number
): void {
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  if (player.label === 'C') {
    label.center.set(0.5, 1)
    label.position.copy(up).multiplyScalar(-LABEL_GAP)
  } else if (player.label === '3B' || player.label === '1B') {
    const side = player.label === '3B' ? -1 : 1
    label.center.set(side === -1 ? 1 : 0, 0.5)
    label.position
      .copy(right)
      .multiplyScalar(side * (0.8 * PLAYER_SCALE + LABEL_GAP))
    label.position.y += 1.5 * PLAYER_SCALE
  } else {
    label.center.set(0.5, 0)
    label.position.copy(up).multiplyScalar(LABEL_GAP)
    label.position.y += 2.9 * PLAYER_SCALE + 0.13
  }
  const world = label.position
    .clone()
    .add(new Vector3(player.position.x, TERRAIN.players, player.position.z))
  const depth = Math.max(
    camera.near,
    -world.applyMatrix4(camera.matrixWorldInverse).z
  )
  const pixel =
    (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) /
    Math.max(1, viewportHeight)
  label.scale.set(pixel * LABEL_WIDTH, pixel * LABEL_HEIGHT, 1)
}
