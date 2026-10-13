import { type Camera, Vector3 } from 'three'

import type { GroundPoint } from './fieldModel'

/** A crouched catcher's height and width, in field units, as drawn. */
const CATCHER_HEIGHT = 5
const CATCHER_WIDTH = 4

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the catcher is on screen: the rect from the top of the catcher's
 * head to the feet, as wide as the figure is drawn. The replay hangs its
 * play card from the bottom of it.
 */
export function catcherBounds(
  camera: Camera,
  width: number,
  height: number,
  catcher: GroundPoint
): ScreenRect {
  const toScreen = (v: Vector3): { x: number; y: number } => {
    const p = v.project(camera)
    return { x: ((p.x + 1) * width) / 2, y: ((1 - p.y) * height) / 2 }
  }
  const feet = toScreen(new Vector3(catcher.x, 0, catcher.z))
  const head = toScreen(new Vector3(catcher.x, CATCHER_HEIGHT, catcher.z))
  const left = toScreen(
    new Vector3(catcher.x - CATCHER_WIDTH / 2, 0, catcher.z)
  )
  const right = toScreen(
    new Vector3(catcher.x + CATCHER_WIDTH / 2, 0, catcher.z)
  )
  const span = Math.abs(right.x - left.x)
  return {
    x: feet.x - span / 2,
    y: Math.min(head.y, feet.y),
    width: span,
    height: Math.abs(feet.y - head.y)
  }
}

/** Whether two rects differ by more than a point anywhere. */
export function movedRect(a: ScreenRect | null, b: ScreenRect): boolean {
  return (
    a == null ||
    Math.abs(a.x - b.x) > 1 ||
    Math.abs(a.y - b.y) > 1 ||
    Math.abs(a.width - b.width) > 1 ||
    Math.abs(a.height - b.height) > 1
  )
}
