import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import { CONTROL_DECK_HEIGHT } from '../scoring/scoringControlStyle'
import {
  applyFieldCamera,
  type CameraFrame,
  PHONE_BOARD_RATIO,
  SCOREBOARD_SCALE,
  SCOREBOARD_Y,
  SCOREBOARD_Z,
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from './cameraModel'
import { createPlayers } from './fieldModel'
import { topLift } from './fieldSafeArea'
import { nameplateContains, projectPlayerLabel } from './playerPresentation'
import { type ScoringFrame, scoringFrame, scoringLayout } from './scoringFrame'

/** The framed camera's card slot and the scoreboard roof's projected width. */
function fitted(
  width: number,
  height: number,
  top: number,
  platform: string,
  frame: CameraFrame
): {
  card: number
  roof: number
  board: number
  face: { left: number; right: number }
} {
  const camera = new PerspectiveCamera()
  const lift = topLift(top, platform)
  const card = applyFieldCamera(camera, {
    width,
    height: height + lift,
    view: 'home',
    zoom: SCORING_CAMERA.zoom,
    tilt: SCORING_CAMERA.cameraTilt,
    heightOffset: SCORING_CAMERA.cameraHeight,
    bottomExtension: SCORING_BOTTOM_EXTENSION,
    frame
  })!
  const roofY = SCOREBOARD_Y + 9.95 * SCOREBOARD_SCALE
  const [left, right] = [-1, 1].map(
    side =>
      new Vector3(side * 34.5 * SCOREBOARD_SCALE, roofY, SCOREBOARD_Z).project(
        camera
      ).x
  )
  const toX = (x: number): number => ((x + 1) * width) / 2
  // The near roof edge spans the board's widest extent, as E1 measures it.
  const [nearLeft, nearRight] = [-1, 1].map(side =>
    toX(
      new Vector3(
        side * 34.5 * SCOREBOARD_SCALE,
        roofY,
        SCOREBOARD_Z + 2.9 * SCOREBOARD_SCALE
      ).project(camera).x
    )
  )
  // The board's lit face (64 by 16, in front of its body), whose letters
  // and line score must all show.
  const faceXs = [-32, 32].flatMap(x =>
    [-8, 8].map(y =>
      toX(
        new Vector3(
          x * SCOREBOARD_SCALE,
          SCOREBOARD_Y + y * SCOREBOARD_SCALE,
          SCOREBOARD_Z + 1.02 * SCOREBOARD_SCALE
        ).project(camera).x
      )
    )
  )
  return {
    card: card - lift,
    roof: ((right - left) * width) / 2,
    board: nearRight - nearLeft,
    face: { left: Math.min(...faceXs), right: Math.max(...faceXs) }
  }
}

describe('scoring field frame', function () {
  for (const [width, height, side] of [
    [393, 852, false],
    [852, 393, false],
    [744, 1133, false],
    [1133, 744, true],
    [834, 1194, true],
    [1194, 834, true],
    [820, 1180, true],
    [819, 1180, false],
    [1200, 640, true],
    [1200, 639, false]
  ] as const) {
    it(`uses the measured field-column width at ${width}×${height}`, function () {
      const layout = scoringLayout(width, height)
      expect(layout).deep.equals({
        side,
        fieldWidth: side ? width - 360 : width
      })
      const frame = scoringFrame({
        width,
        height,
        platform: 'ios',
        insets: { left: 0, top: 24, right: 0, bottom: 20 }
      })
      // A field column taller than wide is framed as a phone is.
      expect(frame.camera.corners).equals(side && width - 360 >= height)
      expect(frame.logLines === 0).equals(side)
    })
  }
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
  for (const [width, height, top, bottom, platform] of [
    [834, 1194, 24, 20, 'ios'],
    [834, 1210, 24, 20, 'ios'],
    [834, 1194, 0, 0, 'web']
  ] as const) {
    it(`frames the tall side column at ${width}×${height} ${platform} at an iPhone 15's board proportion`, function () {
      const frame = scoringFrame({
        width,
        height,
        platform,
        insets: { top, bottom, left: 0, right: 0 }
      })
      expect(frame.side).equals(true)
      expect(frame.fieldWidth).equals(474)
      expect(frame.camera.corners).equals(false)
      expect(frame.boardTop).equals(
        Math.max(8, top) - topLift(top, platform) + 56
      )
      expect(frame.logLines).equals(0)
      expect(frame.deckTop).equals(frame.catcherCardBottom + 4)
      expect(frame.deckTop + CONTROL_DECK_HEIGHT).at.most(frame.stripTop)
      const now = fitted(474, height, top, platform, frame.camera)
      expect(now.card).closeTo(frame.catcherCardBottom, 0.001)
      // The board spans the column as on an iPhone 15 (419.977 / 393), its
      // face inside the column; the spare height stays below the deck.
      expect(now.board / 474).closeTo(
        PHONE_BOARD_RATIO,
        PHONE_BOARD_RATIO * 0.02
      )
      expect(now.face.left).at.least(0)
      expect(now.face.right).at.most(474)
      // Before: both corners framed, the deck under the card, empty below.
      const corners = fitted(474, height, top, platform, {
        ...frame.camera,
        corners: true,
        fill: undefined,
        bottom: frame.camera.bottom + 8
      })
      expect(now.card - corners.card).at.least(200)
      expect(now.roof / corners.roof).at.least(1.5)
    })
  }
  it('gives spare height to the field only until the board spans an iPhone 15 column', function () {
    const web = { top: 0, bottom: 0, left: 0, right: 0 }
    const measure = (
      width: number,
      height: number
    ): { frame: ScoringFrame; fit: ReturnType<typeof fitted> } => {
      const frame = scoringFrame({
        width,
        height,
        platform: 'web',
        insets: web
      })
      return {
        frame,
        fit: fitted(frame.fieldWidth, height, 0, 'web', frame.camera)
      }
    }
    // A side column the board does not yet fill: zoomed until the deck
    // meets the strip, the board still narrower than an iPhone 15's.
    const short = measure(1000, 742)
    expect(short.frame.deckTop + CONTROL_DECK_HEIGHT).closeTo(
      short.frame.stripTop,
      0.01
    )
    expect(short.fit.board / 640).lessThan(PHONE_BOARD_RATIO)
    // A taller one stops at the iPhone 15's proportion, spare height below.
    const tall = measure(1000, 1300)
    expect(tall.fit.board / 640).closeTo(PHONE_BOARD_RATIO, 0.001)
    expect(tall.frame.deckTop + CONTROL_DECK_HEIGHT).lessThan(
      tall.frame.stripTop - 100
    )
    // Stacked windows past five log lines whose width-bound board is already
    // that wide are not zoomed at all.
    for (const [width, height, card] of [
      [500, 1400, 623.52],
      [412, 915, 554.63],
      [430, 932, 577.15]
    ]) {
      const { frame, fit } = measure(width, height)
      expect(frame.logLines).equals(5)
      expect(frame.catcherCardBottom).closeTo(card, 0.01)
      expect(fit.board / width).closeTo(
        PHONE_BOARD_RATIO,
        PHONE_BOARD_RATIO * 0.02
      )
    }
  })
  it('keeps the iPad mini portrait height-bound with no spare under the log', function () {
    for (const [top, bottom, platform, lines] of [
      [24, 20, 'ios', 1],
      [0, 0, 'web', 0]
    ] as const) {
      const frame = scoringFrame({
        width: 744,
        height: 1133,
        platform,
        insets: { top, bottom, left: 0, right: 0 }
      })
      expect(frame.side).equals(false)
      expect(frame.logLines).equals(lines)
      const logBottom = frame.logTop + (lines === 0 ? 0 : 44 + lines * 20)
      expect(frame.stripTop - logBottom).closeTo(0, 0.01)
    }
  })
  // Today's values on these screens, measured before the tall fit existed.
  for (const [width, height, top, bottom, platform, card, roof] of [
    [393, 852, 59, 34, 'ios', 560.74, 414.5],
    [393, 852, 0, 0, 'web', 537.12, 413.61],
    [375, 667, 20, 0, 'ios', 431, 314.81],
    [375, 667, 0, 0, 'web', 495, 355.38],
    [320, 568, 20, 0, 'ios', 332, 230.15],
    [320, 568, 0, 0, 'web', 396, 274.07],
    [412, 915, 24, 24, 'android', 570.63, 434.61],
    [390, 844, 0, 0, 'web', 534.1, 410.36],
    [1133, 744, 24, 20, 'ios', 552, 408.71],
    [1194, 834, 24, 20, 'ios', 603.32, 457.79],
    [1194, 834, 0, 0, 'web', 606.37, 456.84]
  ] as const) {
    it(`keeps the ${width}×${height} ${platform} field as it was`, function () {
      const frame = scoringFrame({
        width,
        height,
        platform,
        insets: { top, bottom, left: 0, right: 0 }
      })
      expect(frame.camera.corners).equals(frame.side)
      expect(frame.catcherCardBottom).closeTo(card, 0.01)
      expect(
        fitted(frame.fieldWidth, height, top, platform, frame.camera).roof
      ).closeTo(roof, 0.01)
    })
  }
})
