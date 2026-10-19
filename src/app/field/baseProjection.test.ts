import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import { projectBases } from './baseProjection'
import { applyFieldCamera } from './cameraModel'
import { BASES } from './fieldModel'
import { HEAD_RADIUS, PLAYER_SCALE } from './playerPresentation'
import { TERRAIN } from './terrain'

describe('runner decision base projections', function () {
  for (const [width, height] of [
    [402, 579],
    [844, 390],
    [1200, 900]
  ])
    for (const view of ['home', 'infield', 'overhead'] as const)
      it(`projects heads and feet without moving existing anchors, ${width}x${height} ${view}`, function () {
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          width,
          height,
          view,
          zoom: 1.25,
          tilt: -0.2,
          heightOffset: 33,
          bottomExtension: 112
        })
        const actual = projectBases(camera, width, height)
        for (const [index, point] of BASES.entries()) {
          for (const [points, y] of [
            [actual.bases, 9],
            [actual.feet!, TERRAIN.players],
            [
              actual.heads!,
              TERRAIN.players + (2.9 + HEAD_RADIUS) * PLAYER_SCALE
            ]
          ] as const) {
            const expected = new Vector3(point.x, y, point.z).project(camera)
            expect(points[index].x).closeTo(
              ((expected.x + 1) * width) / 2,
              0.001
            )
            expect(points[index].y).closeTo(
              ((1 - expected.y) * height) / 2,
              0.001
            )
          }
        }
        expect(actual.width).equals(width)
        expect(actual.height).equals(height)
      })
})
