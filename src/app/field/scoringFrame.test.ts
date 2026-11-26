import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera } from 'three'

import {
  applyFieldCamera,
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from './cameraModel'
import { createPlayers } from './fieldModel'
import { nameplateContains, projectPlayerLabel } from './playerPresentation'
import { scoringFrame } from './scoringFrame'

describe('scoring field frame', function () {
  for (const [top, bottom, platform, band, offset] of [
    [0, 0, 'web', 0, 0],
    [59, 34, 'ios', 0, -24],
    [59, 34, 'android', 0, 0],
    [59, 34, 'ios', 48, 48]
  ] as const) {
    it(`places the roof and card in root coordinates on ${platform} with inset ${top} and band ${band}`, function () {
      const width = 393
      const height = 852
      const frame = scoringFrame({
        width,
        height,
        insets: { top, bottom, left: 0, right: 0 },
        platform,
        topBand: band
      })
      expect(frame.side).equals(false)
      expect(frame.fieldWidth).equals(width)
      expect(frame.boardTop).equals(Math.max(8, top) + offset + 56)
      const drawableHeight = height + (platform === 'ios' ? 24 : 0)
      expect(drawableHeight - frame.camera.bottom + offset).equals(
        height - bottom - 200
      )
      const camera = new PerspectiveCamera()
      const slot = applyFieldCamera(camera, {
        width,
        height: drawableHeight,
        view: 'home',
        zoom: SCORING_CAMERA.zoom,
        tilt: SCORING_CAMERA.cameraTilt,
        heightOffset: SCORING_CAMERA.cameraHeight,
        bottomExtension: SCORING_BOTTOM_EXTENSION,
        frame: frame.camera
      })!
      expect(slot + offset).closeTo(frame.catcherCardBottom, 0.001)
      const catcher = createPlayers().find(player => player.label === 'C')!
      for (const variant of [
        catcher,
        { ...catcher, jersey: '', hasBall: true, position: { x: 12, z: -15 } },
        { ...catcher, emptyPosition: true }
      ]) {
        const face = projectPlayerLabel(
          variant,
          camera,
          width,
          drawableHeight,
          slot
        )
        expect(face.y + (1 - face.anchorY) * face.height).closeTo(slot, 0.001)
        expect(
          nameplateContains(
            variant,
            camera,
            width,
            drawableHeight,
            face.x,
            slot - 1,
            slot
          )
        ).equals(true)
        expect(
          nameplateContains(
            variant,
            camera,
            width,
            drawableHeight,
            face.x,
            slot + 1,
            slot
          )
        ).equals(false)
      }
    })
  }
})
