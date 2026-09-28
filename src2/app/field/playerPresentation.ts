import { type PerspectiveCamera, Vector3 } from 'three'

import { fonts } from '../theme/fonts'
import type { FieldPlayer } from './fieldModel'
import { TERRAIN } from './terrain'

export const PLAYER_SCALE = 3.2 * 1.15
/** Head sphere radius in the player's local units, before PLAYER_SCALE. */
export const HEAD_RADIUS = 0.35
export const LABEL_GAP = 0.3048 // One real-world foot, in game metres.
/** Body size of a field name, in CSS pixels. The browser rasterizes it at the display's own pixel ratio. */
export const NAMEPLATE_FONT = 12
/** Jersey number under the name. */
export const NAMEPLATE_NUMBER_FONT = 10
/** Same inset on every side, so the plate hugs the type. */
export const NAMEPLATE_PAD = 4
/** Space between the name and the number under it. */
export const NAMEPLATE_LINE_GAP = 2
export function hasPlayerLabel(player: FieldPlayer): boolean {
  // The batter and the pitcher are named on the scoreboard, not on the field.
  return (
    player.batting !== true &&
    player.label !== 'P' &&
    player.label !== 'B' &&
    player.id !== 'P'
  )
}
export interface NameplateLabel {
  name: string
  /** `#` plus the jersey, or empty when the player has no number. */
  number: string
}
export function nameplateLabel(player: FieldPlayer): NameplateLabel {
  const ball = player.hasBall === true ? '⚾ ' : ''
  const jersey = player.jersey.trim()
  return {
    name: `${ball}${player.displayName}`,
    number: jersey === '' ? '' : `#${jersey}`
  }
}
let inkContext: CanvasRenderingContext2D | null = null
function inkWidth(text: string, fontPx: number): number {
  if (text === '') return 0
  if (inkContext == null && typeof document !== 'undefined') {
    inkContext = document.createElement('canvas').getContext('2d')
  }
  if (inkContext != null) {
    inkContext.font = `400 ${fontPx}px ${fonts.spaceGrotesk}`
    return Math.ceil(inkContext.measureText(text).width)
  }
  return Math.ceil(text.length * fontPx * 0.56)
}
export function nameplateSize(label: NameplateLabel): {
  width: number
  height: number
} {
  const lines =
    label.number === ''
      ? NAMEPLATE_FONT
      : NAMEPLATE_FONT + NAMEPLATE_LINE_GAP + NAMEPLATE_NUMBER_FONT
  return {
    width:
      Math.max(
        inkWidth(label.name, NAMEPLATE_FONT),
        inkWidth(label.number, NAMEPLATE_NUMBER_FONT)
      ) +
      NAMEPLATE_PAD * 2,
    height: lines + NAMEPLATE_PAD * 2
  }
}
export interface NameplatePlacement {
  id: string
  name: string
  number: string
  team: FieldPlayer['team']
  uniformSide?: FieldPlayer['uniformSide']
  /** Canvas CSS pixels, origin at the top left. The plate is anchored here. */
  x: number
  y: number
  /** 0 is the left edge of the plate, 1 is the right edge. */
  anchorX: number
  /** 0 is the top edge of the plate, 1 is the bottom edge. */
  anchorY: number
  width: number
  height: number
  visible: boolean
}
/** World-space point the nameplate hangs from, in the same place the old sprite sat. */
export function labelAnchor(
  player: FieldPlayer,
  camera: PerspectiveCamera
): { offset: Vector3; anchorX: number; anchorY: number } {
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  const offset = new Vector3()
  let anchorX = 0.5
  let anchorY = 1
  if (player.team === 'runner' || player.label === 'C') {
    // Runners, and the catcher, wear the name under their feet.
    anchorY = 0
    offset.copy(up).multiplyScalar(-LABEL_GAP)
  } else if (player.label === '3B' || player.label === '1B') {
    // Above the head. First base grows right from the head's left side.
    // Third base grows left from the head's right side.
    const growRight = player.label === '1B'
    anchorX = growRight ? 0 : 1
    anchorY = 1
    offset.copy(up).multiplyScalar(LABEL_GAP)
    offset.y += 2.9 * PLAYER_SCALE + 0.13
    offset.addScaledVector(
      right,
      (growRight ? -1 : 1) * HEAD_RADIUS * PLAYER_SCALE
    )
  } else {
    offset.copy(up).multiplyScalar(LABEL_GAP)
    offset.y += 2.9 * PLAYER_SCALE + 0.13
  }
  return { offset, anchorX, anchorY }
}
/** Project the nameplate after the camera transform, in CSS pixels. */
export function projectPlayerLabel(
  player: FieldPlayer,
  camera: PerspectiveCamera,
  width: number,
  height: number
): NameplatePlacement {
  const { offset, anchorX, anchorY } = labelAnchor(player, camera)
  const world = offset.add(
    new Vector3(player.position.x, TERRAIN.players, player.position.z)
  )
  const viewZ = world.clone().applyMatrix4(camera.matrixWorldInverse).z
  const ndc = world.project(camera)
  const label = nameplateLabel(player)
  const box = nameplateSize(label)
  return {
    id: player.id,
    name: label.name,
    number: label.number,
    team: player.team,
    uniformSide: player.uniformSide,
    x: (ndc.x * 0.5 + 0.5) * width,
    y: (0.5 - ndc.y * 0.5) * height,
    anchorX,
    anchorY,
    width: box.width,
    height: box.height,
    visible: viewZ < -camera.near && ndc.z >= -1 && ndc.z <= 1
  }
}
export function nameplateContains(
  player: FieldPlayer,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  x: number,
  y: number
): boolean {
  if (player.suppressed === true || !hasPlayerLabel(player)) return false
  const plate = projectPlayerLabel(player, camera, width, height)
  if (!plate.visible) return false
  const left = plate.x - plate.anchorX * plate.width
  const top = plate.y - plate.anchorY * plate.height
  return (
    x >= left && x <= left + plate.width && y >= top && y <= top + plate.height
  )
}
