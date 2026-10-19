import { type Camera, Vector3 } from 'three'

import { BASES } from './fieldModel'
import type { BaseProjection } from './fieldTypes'
import { HEAD_RADIUS, PLAYER_SCALE } from './playerPresentation'
import { TERRAIN } from './terrain'

/** The existing decision anchors plus the standing runner's silhouette. */
export function projectBases(
  camera: Camera,
  width: number,
  height: number
): BaseProjection {
  const atHeight = (y: number): Array<{ x: number; y: number }> =>
    BASES.map(point => {
      const v = new Vector3(point.x, y, point.z).project(camera)
      return { x: ((v.x + 1) * width) / 2, y: ((1 - v.y) * height) / 2 }
    })
  return {
    width,
    height,
    bases: atHeight(9),
    feet: atHeight(TERRAIN.players),
    heads: atHeight(TERRAIN.players + (2.9 + HEAD_RADIUS) * PLAYER_SCALE)
  }
}
