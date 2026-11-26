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
  for (const [width, height, top, bottom, platform, lines] of [
    [320, 568, 0, 0, 'web', 0],
    [375, 667, 20, 0, 'ios', 1],
    [390, 844, 0, 0, 'web', 4],
    [393, 852, 59, 34, 'ios', 1],
    [412, 915, 24, 24, 'android', 4],
    [852, 393, 0, 0, 'ios', 1]
  ] as const) {
    it(`fits ${lines} log lines on the ${width}×${height} ${platform} screen`, function () {
      const input = {
        width,
        height,
        insets: { top, bottom, left: 0, right: 0 },
        platform
      }
      const frame = scoringFrame(input)
      expect(frame.logLines).equals(lines)
      expect(frame.stripHeight).equals(40 + bottom)
      expect(frame.stripTop).equals(height - 40 - bottom)
      expect(frame.logTop).at.most(frame.stripTop + 0.01)
      if (lines > 0)
        expect(frame.logTop + 44 + lines * 20).at.most(frame.stripTop + 0.01)
      const camera = new PerspectiveCamera()
      const catcher = createPlayers().find(p => p.label === 'C')!
      const interval = frame.camera.cardInterval!
      for (const variant of [
        catcher,
        {
          ...catcher,
          jersey: '',
          displayName: 'Extraordinarilylongcatchername',
          position: { x: 100, z: -20 }
        },
        { ...catcher, emptyPosition: true, position: { x: -100, z: -20 } }
      ]) {
        const slot = applyFieldCamera(camera, {
          view: 'home',
          zoom: SCORING_CAMERA.zoom,
          tilt: SCORING_CAMERA.cameraTilt,
          heightOffset: SCORING_CAMERA.cameraHeight,
          width,
          height,
          bottomExtension: SCORING_BOTTOM_EXTENSION,
          frame: frame.camera
        })!
        const face = projectPlayerLabel(
          variant,
          camera,
          width,
          height,
          slot,
          undefined,
          interval
        )
        expect(face.x - face.width / 2).at.least(interval.left - 0.001)
        expect(face.x + face.width / 2).at.most(interval.right + 0.001)
        expect(
          nameplateContains(
            variant,
            camera,
            width,
            height,
            face.x,
            slot - 1,
            slot,
            interval
          )
        ).equals(true)
        expect(
          nameplateContains(
            variant,
            camera,
            width,
            height,
            face.x + face.width / 2 + 1,
            slot - 1,
            slot,
            interval
          )
        ).equals(false)
        expect(scoringFrame(input)).deep.equals(frame)
      }
    })
  }
  for (const [top, bottom, platform, offset] of [
    [0, 0, 'web', 0],
    [59, 34, 'ios', -24],
    [59, 34, 'android', 0]
  ] as const) {
    it(`places the roof and card in root coordinates on ${platform} with inset ${top}`, function () {
      const width = 393
      const height = 852
      const frame = scoringFrame({
        width,
        height,
        insets: { top, bottom, left: 0, right: 0 },
        platform
      })
      expect(frame.side).equals(false)
      expect(frame.fieldWidth).equals(width)
      expect(frame.boardTop).equals(Math.max(8, top) + offset + 56)
      const drawableHeight = height + (platform === 'ios' ? 24 : 0)
      expect(drawableHeight - frame.camera.bottom + offset).equals(
        height - bottom - 172 - (platform === 'web' ? 0 : 64)
      )
      expect(frame.deckTop).equals(frame.catcherCardBottom + 4)
      expect(frame.logTop).equals(frame.deckTop + 128)
      expect(frame.stripTop).equals(height - 40 - bottom)
      expect(frame.logLines).equals(
        Math.max(
          platform === 'web' ? 0 : 1,
          Math.min(5, Math.floor((frame.stripTop - 8 - frame.logTop - 44) / 20))
        )
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
  it('anchors the strip to the measured web root across toolbar changes and rotation', function () {
    const input = {
      width: 390,
      height: 635,
      platform: 'web',
      insets: { top: 0, bottom: 34, left: 0, right: 0 }
    }
    const viewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    try {
      for (const height of [635, 735, 635]) {
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: { height }
        })
        const frame = scoringFrame(input)
        expect(frame.stripTop + frame.stripHeight).equals(input.height)
        expect(frame.stripHeight).equals(74)
      }
    } finally {
      if (viewport != null)
        Object.defineProperty(window, 'visualViewport', viewport)
      else Reflect.deleteProperty(window, 'visualViewport')
    }
    for (const [width, height, left] of [
      [390, 664, 0],
      [844, 390, 59]
    ]) {
      const frame = scoringFrame({
        width,
        height,
        platform: 'web',
        insets: { top: 0, bottom: 0, left, right: left }
      })
      expect(frame.stripTop + frame.stripHeight).equals(height)
      expect(frame.stripHeight).equals(40)
    }
  })
})
