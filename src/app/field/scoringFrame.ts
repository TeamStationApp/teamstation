import { PerspectiveCamera } from 'three'

import type { Insets } from '../platform/insets'
import {
  CONTROL_DECK_HEIGHT,
  CONTROL_GAP,
  CONTROL_HEIGHT
} from '../scoring/scoringControlStyle'
import {
  applyFieldCamera,
  type CameraFrame,
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from './cameraModel'
import { FIELD_EDGE_GAP, topLift } from './fieldSafeArea'

export interface ScoringFrame {
  side: boolean
  fieldWidth: number
  boardTop: number
  catcherCardBottom: number
  camera: CameraFrame
}

export function scoringLayout(
  width: number,
  _height: number
): Pick<ScoringFrame, 'side' | 'fieldWidth'> {
  return { side: false, fieldWidth: width }
}

/** Fit the stable card slot above the existing walk-up and pitch controls. */
export function scoringFrame({
  width,
  height,
  insets,
  platform,
  topBand = 0
}: {
  width: number
  height: number
  insets: Insets
  platform: string
  topBand?: number
}): ScoringFrame {
  const layout = scoringLayout(width, height)
  const lift = topLift(insets.top, platform)
  const offset = topBand > 0 ? topBand : -lift
  const boardTop =
    Math.max(FIELD_EDGE_GAP, insets.top) + offset + 48 + FIELD_EDGE_GAP
  const bottomReserve =
    insets.bottom +
    FIELD_EDGE_GAP +
    CONTROL_DECK_HEIGHT +
    CONTROL_GAP +
    CONTROL_HEIGHT +
    CONTROL_GAP
  const camera = {
    top: boardTop - offset,
    bottom: bottomReserve + lift + offset
  }
  const card = applyFieldCamera(new PerspectiveCamera(), {
    width: Math.max(1, layout.fieldWidth),
    height: Math.max(1, height + lift),
    view: 'home',
    zoom: SCORING_CAMERA.zoom,
    tilt: SCORING_CAMERA.cameraTilt,
    heightOffset: SCORING_CAMERA.cameraHeight,
    bottomExtension: SCORING_BOTTOM_EXTENSION,
    frame: camera
  })!
  return { ...layout, camera, boardTop, catcherCardBottom: card + offset }
}
