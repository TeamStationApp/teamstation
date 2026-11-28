import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../src/app/field/cameraModel'
import { BASES, createPlayers } from '../../../src/app/field/fieldModel'
import { flatten, type Node, type Rect } from '../coach/coachApp'

/**
 * Where the scoring field draws on the native app, which has no page to
 * probe: the field fills the window, and its home view is the camera the
 * screen sets (`applyFieldCamera` with the scoring screen's framing), so a
 * ground point projects to the window's points as the app draws it.
 */
export interface NativeField {
  rect: Rect
  /** Ground point (x, z), `y` feet up, in the window's points. */
  project: (x: number, z: number, y?: number) => { x: number; y: number }
  /** Where base `index` (0 home, 1 first, 2 second, 3 third) draws. */
  base: (index: number, y?: number) => { x: number; y: number }
  /** Where the fielder at `position` stands before a play. */
  fielder: (position: string, y?: number) => { x: number; y: number }
}

/** Measures the window now: call again after the screen's view changes. */
export async function nativeField(m: any): Promise<NativeField> {
  const nodes = flatten((await m.hierarchy()) as Node)
  const rect = nodes.find(node => node.type === 'Window')?.bounds
  if (rect == null) throw new Error('The field window cannot be measured')
  return fieldProjection(rect)
}

/**
 * The scoring field drawn in `rect` with the screen's home view: the app's
 * window, or the web page's field canvas.
 */
export function fieldProjection(rect: Rect): NativeField {
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    width: rect.width,
    height: rect.height,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  const project = (x: number, z: number, y = 3): { x: number; y: number } => {
    const v = new Vector3(x, y, z).project(camera)
    return {
      x: rect.x + ((v.x + 1) * rect.width) / 2,
      y: rect.y + ((1 - v.y) * rect.height) / 2
    }
  }
  const players = createPlayers()
  return {
    rect,
    project,
    base: (index, y) => project(BASES[index].x, BASES[index].z, y),
    fielder: (position, y) => {
      const player = players.find(found => found.id === position)
      if (player == null) throw new Error(`No fielder plays ${position}`)
      return project(player.position.x, player.position.z, y)
    }
  }
}
