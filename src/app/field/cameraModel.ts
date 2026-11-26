import { type PerspectiveCamera, Vector3 } from 'three'

import { type CameraView, CATCHER_SPOT, type FieldPlayer } from './fieldModel'
import {
  nameplateLabel,
  nameplateSize,
  projectPlayerLabel
} from './playerPresentation'
import { OUTFIELD_HALF_ANGLE, OUTFIELD_RADIUS } from './stadiumBoundary'

export const SCOREBOARD_SCALE = 1.8
export const SCOREBOARD_Y = 28.2
export const SCOREBOARD_Z = -135
export const TILT_LIMIT = Math.PI / 3
export const HEIGHT_LIMIT = 70
export function cameraDragValue(
  kind: 'tilt' | 'height' | 'zoom',
  start: number,
  dy: number
): number {
  if (kind === 'zoom') return Math.max(0.7, Math.min(1.8, start - dy * 0.006))
  const limit = kind === 'tilt' ? TILT_LIMIT : HEIGHT_LIMIT
  const change = kind === 'tilt' ? dy * 0.003 : -dy * 0.3
  return Math.max(-limit, Math.min(limit, start + change))
}
export const MAX_VIEWPORT_HEIGHT = 682
export function fieldViewportHeight(width: number): number {
  return Math.min(MAX_VIEWPORT_HEIGHT, Math.round(Math.max(1, width) * 1.25))
}
/** Fixed home view shared by scoring and replay. */
export const SCORING_CAMERA = {
  zoom: 1.25,
  cameraTilt: (-11 * Math.PI) / 180,
  cameraHeight: 33
} as const
export const SCORING_BOTTOM_EXTENSION = 112

/** Clearances in the drawable canvas's own points. */
export interface CameraFrame {
  corners?: boolean
  cardInterval?: { left: number; right: number }
  top: number
  bottom: number
}

const referenceCatcher: FieldPlayer = {
  id: 'C',
  label: 'C',
  name: 'C',
  displayName: 'C',
  jersey: '2',
  team: 'defense',
  position: CATCHER_SPOT,
  target: CATCHER_SPOT,
  heading: Math.PI,
  speed: 0,
  stride: 0
}

// Only the numbered face's height enters the fit. An ordinary two-line label
// has the same height at every distance and on every platform.
let referenceSize: ReturnType<typeof nameplateSize> | undefined

export function catcherCardBottom(
  camera: PerspectiveCamera,
  width: number,
  height: number
): number {
  referenceSize ??= nameplateSize(nameplateLabel(referenceCatcher))
  const plate = projectPlayerLabel(
    referenceCatcher,
    camera,
    width,
    height,
    undefined,
    referenceSize
  )
  return plate.y + plate.height
}

// The wall endpoints, near edge of the roof and home apron. The home camera
// is centered on x = 0, so the opposite points have equal projected widths.
const sideExtents = [
  new Vector3(
    OUTFIELD_RADIUS * Math.sin(OUTFIELD_HALF_ANGLE),
    0,
    -OUTFIELD_RADIUS * Math.cos(OUTFIELD_HALF_ANGLE)
  ),
  new Vector3(
    34.5 * SCOREBOARD_SCALE,
    SCOREBOARD_Y + 9.95 * SCOREBOARD_SCALE,
    SCOREBOARD_Z + 2.9 * SCOREBOARD_SCALE
  ),
  new Vector3(12, 0, 10)
]

/** Pin the top of the physical scoreboard roof, including its depth. */
function fitScoringCamera(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  referenceHeight: number,
  target: Vector3,
  backward: Vector3,
  distance: number,
  tilt: number,
  heightOffset: number,
  frame: CameraFrame
): number {
  function place(distance: number): number {
    camera.position.copy(target).addScaledVector(backward, distance)
    camera.lookAt(target)
    camera.rotateX(tilt)
    camera.position.y += heightOffset
    camera.far = Math.max(1100, camera.position.length() + 400)
    camera.updateMatrixWorld()
    camera.setViewOffset(width, referenceHeight, 0, 0, width, height)
    const roofY = SCOREBOARD_Y + (9.7 + 0.25) * SCOREBOARD_SCALE
    const roofTop = Math.min(
      ...[-2.1, 2.9].map(depth => {
        const ndc = new Vector3(
          0,
          roofY,
          SCOREBOARD_Z + depth * SCOREBOARD_SCALE
        ).project(camera)
        return ((1 - ndc.y) * height) / 2
      })
    )
    camera.setViewOffset(
      width,
      referenceHeight,
      0,
      roofTop - frame.top,
      width,
      height
    )
    return catcherCardBottom(camera, width, height)
  }

  const limit = height - frame.bottom
  const overflow = (bottom: number): number => {
    let excess = bottom - limit
    if (frame.corners === true)
      for (const point of sideExtents) {
        const projected = point.clone().project(camera)
        excess = Math.max(excess, ((Math.abs(projected.x) - 0.9) * width) / 2)
      }
    return excess
  }
  let bottom = place(distance)
  if (overflow(bottom) <= 0) return bottom
  let low = distance
  let high = distance * 2
  // A transient zero-height layout can leave less than the card's own height.
  while (overflow(place(high)) > 0 && high < 1e7) high *= 2
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2
    bottom = place(middle)
    const excess = overflow(bottom)
    if (excess > 0) low = middle
    else if (-excess < 0.001) return bottom
    else high = middle
  }
  return place(high)
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
    frame?: CameraFrame
    bottomExtension?: number
  }
): number | undefined {
  const { width, height, view, zoom, tilt = 0, heightOffset = 0 } = options
  const referenceHeight = Math.max(1, height - (options.bottomExtension ?? 0))
  const aspect = Math.max(0.2, width / referenceHeight)
  camera.aspect = aspect
  camera.fov = 43
  camera.near = 2
  camera.far = 1100
  const tangent = Math.tan((camera.fov * Math.PI) / 360)
  if (view === 'home') {
    const target = new Vector3(0, 15, -55)
    const pitch = (24 * Math.PI) / 180
    const backward = new Vector3(0, Math.sin(pitch), Math.cos(pitch))
    const up = new Vector3(0, Math.cos(pitch), -Math.sin(pitch))
    // Frame the board's outer corners and the home-plate apron, reserving room
    // for the camera bar and top badges. Deliberately prioritize these on phones.
    const points = [new Vector3(-12, 0, 10), new Vector3(12, 0, 10)]
    for (const x of [-63, 63])
      for (const y of [11.5, 46.5]) points.push(new Vector3(x, y, SCOREBOARD_Z))
    let distance = 130
    for (const point of points) {
      const local = point.clone().sub(target)
      distance = Math.max(
        distance,
        local.dot(backward) +
          Math.max(
            Math.abs(local.x) / (tangent * aspect * 0.9),
            options.frame == null
              ? Math.abs(local.dot(up)) / (tangent * 0.76)
              : 0
          )
      )
    }
    if (options.frame != null)
      return fitScoringCamera(
        camera,
        width,
        height,
        referenceHeight,
        target,
        backward,
        distance / zoom,
        tilt,
        heightOffset,
        options.frame
      )
    camera.position.copy(target).addScaledVector(backward, distance / zoom)
    camera.lookAt(target)
  } else if (view === 'scoreboard') {
    const visibleHeight = Math.max(130 / aspect, 38)
    const distance = visibleHeight / (2 * tangent) / zoom
    camera.position.set(0, SCOREBOARD_Y, SCOREBOARD_Z + distance)
    camera.lookAt(0, SCOREBOARD_Y, SCOREBOARD_Z)
  } else {
    const distance = (width < referenceHeight ? 1.4 : 1) / zoom
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
  camera.clearViewOffset()
  if (height > referenceHeight)
    camera.setViewOffset(width, referenceHeight, 0, 0, width, height)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
}
