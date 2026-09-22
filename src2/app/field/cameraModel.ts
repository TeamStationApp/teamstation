import { type PerspectiveCamera, Vector3 } from 'three'

import type { CameraView } from './fieldModel'

export const SCOREBOARD_SCALE = 1.8
export const SCOREBOARD_Y = 50
export const SCOREBOARD_Z = -158
export const TILT_LIMIT = Math.PI / 3
export const HEIGHT_LIMIT = 70
export function cameraDragValue(
  kind: 'tilt' | 'height',
  start: number,
  dy: number
): number {
  const limit = kind === 'tilt' ? TILT_LIMIT : HEIGHT_LIMIT
  const change = kind === 'tilt' ? dy * 0.003 : -dy * 0.3
  return Math.max(-limit, Math.min(limit, start + change))
}
export function fieldViewportHeight(
  windowHeight: number,
  header: number,
  bottom: number
): number {
  // Previous layout: 102px introduction and 132px roster/actions. Give the scene
  // 25% more space; the outer screen scrolls to keep all controls reachable.
  return Math.max(
    300,
    Math.round(Math.max(240, windowHeight - header - bottom - 234) * 1.25)
  )
}
export function applyFieldCamera(
  camera: PerspectiveCamera,
  options: {
    width: number
    height: number
    view: CameraView
    zoom: number
    tilt?: number
    heightOffset?: number
  }
): void {
  const { width, height, view, zoom, tilt = 0, heightOffset = 0 } = options
  const aspect = Math.max(0.2, width / Math.max(1, height))
  camera.aspect = aspect
  camera.fov = 43
  camera.near = 2
  camera.far = 1100
  const tangent = Math.tan((camera.fov * Math.PI) / 360)
  if (view === 'home') {
    const target = new Vector3(0, 31, -57)
    const pitch = (24 * Math.PI) / 180
    const backward = new Vector3(0, Math.sin(pitch), Math.cos(pitch))
    const up = new Vector3(0, Math.cos(pitch), -Math.sin(pitch))
    // Frame the board's outer corners and the home-plate apron, reserving room
    // for the camera bar and top badges. Deliberately prioritize these on phones.
    const points = [new Vector3(-12, 0, 10), new Vector3(12, 0, 10)]
    for (const x of [-63, 63])
      for (const y of [18, 83]) points.push(new Vector3(x, y, SCOREBOARD_Z))
    let distance = 130
    for (const point of points) {
      const local = point.clone().sub(target)
      distance = Math.max(
        distance,
        local.dot(backward) +
          Math.max(
            Math.abs(local.x) / (tangent * aspect * 0.9),
            Math.abs(local.dot(up)) / (tangent * 0.76)
          )
      )
    }
    camera.position.copy(target).addScaledVector(backward, distance / zoom)
    camera.lookAt(target)
  } else if (view === 'scoreboard') {
    const visibleHeight = Math.max(130 / aspect, 76)
    const distance = visibleHeight / (2 * tangent) / zoom
    camera.position.set(0, SCOREBOARD_Y, SCOREBOARD_Z + distance)
    camera.lookAt(0, SCOREBOARD_Y, SCOREBOARD_Z)
  } else {
    const distance = (width < height ? 1.4 : 1) / zoom
    const center = view === 'infield' ? -24 : -48
    const pose = view === 'infield' ? [37, 54, 55] : [0, 185, -35]
    camera.position.set(
      pose[0] * distance,
      pose[1] * distance,
      center + (pose[2] - center) * distance
    )
    camera.lookAt(0, 0, center)
  }
  // Rotate around the camera's own X axis. Positive pitch looks upward.
  camera.rotateX(tilt)
  // World-space translation, deliberately preserving the viewing angle.
  camera.position.y = Math.max(3, camera.position.y + heightOffset)
  // Extremely narrow, tall desktop windows can pull the fit camera past 1km.
  camera.far = Math.max(1100, camera.position.length() + 400)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
}
