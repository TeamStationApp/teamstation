import { PerspectiveCamera } from 'three'

import type { Insets } from '../platform/insets'
import {
  CONTROL_DECK_HEIGHT,
  LOG_HEADER,
  LOG_LINE,
  NOTICE_TEXT_AREA,
  scoringControlRow
} from '../scoring/scoringControlStyle'
import {
  applyFieldCamera,
  type CameraFrame,
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from './cameraModel'
import { FIELD_EDGE_GAP, SCORING_SIDE_WIDTH, topLift } from './fieldSafeArea'

export interface ScoringFrame {
  side: boolean
  fieldWidth: number
  boardTop: number
  catcherCardBottom: number
  deckTop: number
  logTop: number
  logLines: number
  stripTop: number
  stripHeight: number
  camera: CameraFrame
}

const SIDE_FIELD_MIN_WIDTH = 460
const SIDE_MIN_HEIGHT = 640

export function scoringLayout(
  width: number,
  height: number
): Pick<ScoringFrame, 'side' | 'fieldWidth'> {
  const side =
    width - SCORING_SIDE_WIDTH >= SIDE_FIELD_MIN_WIDTH &&
    height >= SIDE_MIN_HEIGHT
  return { side, fieldWidth: side ? width - SCORING_SIDE_WIDTH : width }
}

/** Fit the field above its deck, the minimum log, and the bottom notice strip. */
export function scoringFrame({
  width,
  height,
  insets,
  platform
}: {
  width: number
  height: number
  insets: Insets
  platform: string
}): ScoringFrame {
  const layout = scoringLayout(width, height)
  const lift = topLift(insets.top, platform)
  const offset = -lift
  const boardTop =
    Math.max(FIELD_EDGE_GAP, insets.top) + offset + 48 + FIELD_EDGE_GAP
  const stripHeight = NOTICE_TEXT_AREA + insets.bottom
  const stripTop = height - stripHeight
  const minLines = layout.side || platform === 'web' ? 0 : 1
  const logMin = minLines === 0 ? 0 : LOG_HEADER + minLines * LOG_LINE
  const bottomReserve = 4 + CONTROL_DECK_HEIGHT + 8 + logMin + stripHeight
  const { cardLeft, cardRight } = scoringControlRow(layout.fieldWidth, insets)
  const camera = {
    top: boardTop - offset,
    corners: layout.side,
    bottom: bottomReserve,
    cardInterval: { left: cardLeft, right: cardRight }
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
  const catcherCardBottom = card + offset
  const deckTop = catcherCardBottom + 4
  const logTop = deckTop + CONTROL_DECK_HEIGHT + 8
  const logLines = layout.side
    ? 0
    : Math.max(
        minLines,
        Math.min(5, Math.floor((stripTop - 8 - logTop - LOG_HEADER) / LOG_LINE))
      )
  return {
    ...layout,
    camera,
    boardTop,
    catcherCardBottom,
    deckTop,
    logTop,
    logLines,
    stripTop,
    stripHeight
  }
}
