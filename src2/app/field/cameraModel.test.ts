import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import {
  applyFieldCamera,
  cameraDragValue,
  fieldViewportHeight,
  HEIGHT_LIMIT,
  SCOREBOARD_Z,
  TILT_LIMIT
} from './cameraModel'

describe('field camera controls', function () {
  it('extends only the bottom while retaining world scale and reference pixels', function () {
    for (const [width, height] of [
      [320, 520],
      [390, 600],
      [874, 180]
    ]) {
      const old = new PerspectiveCamera()
      const extended = new PerspectiveCamera()
      const options = {
        width,
        height,
        view: 'home' as const,
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33
      }
      applyFieldCamera(old, options)
      applyFieldCamera(extended, {
        ...options,
        height: height + 112,
        bottomExtension: 112
      })
      expect(old.position.distanceTo(extended.position)).lessThan(0.000001)
      expect(old.quaternion.angleTo(extended.quaternion)).lessThan(0.000001)
      for (const point of [
        new Vector3(0, 0, 0),
        new Vector3(19, 9, -19),
        new Vector3(0, 28, -135)
      ]) {
        const a = point.clone().project(old)
        const b = point.clone().project(extended)
        expect(((a.x + 1) * width) / 2).closeTo(((b.x + 1) * width) / 2, 0.001)
        expect(((1 - a.y) * height) / 2).closeTo(
          ((1 - b.y) * (height + 112)) / 2,
          0.001
        )
        expect(b.clone().unproject(extended).distanceTo(point)).lessThan(
          0.00001
        )
      }
    }
  })
  it('maps drag directions and bounds long gestures', function () {
    expect(cameraDragValue('tilt', 0, 100)).greaterThan(0)
    expect(cameraDragValue('tilt', 0, -100)).lessThan(0)
    expect(cameraDragValue('height', 0, -100)).greaterThan(0)
    expect(cameraDragValue('height', 0, 100)).lessThan(0)
    expect(cameraDragValue('tilt', 0, 10000)).equals(TILT_LIMIT)
    expect(cameraDragValue('height', 0, 10000)).equals(-HEIGHT_LIMIT)
    expect(fieldViewportHeight(390)).equals(488)
  })
  it('tilts upward on downward drags and translates height without changing orientation', function () {
    const camera = new PerspectiveCamera()
    const options = { width: 390, height: 556, view: 'home' as const, zoom: 1 }
    applyFieldCamera(camera, options)
    const direction = camera.getWorldDirection(new Vector3())
    applyFieldCamera(camera, {
      ...options,
      tilt: cameraDragValue('tilt', 0, 100)
    })
    expect(camera.getWorldDirection(new Vector3()).y).greaterThan(direction.y)
    const rotation = camera.quaternion.clone()
    const position = camera.position.clone()
    applyFieldCamera(camera, { ...options, tilt: 0.3, heightOffset: 20 })
    expect(camera.quaternion.angleTo(rotation)).closeTo(0, 0.000001)
    expect(camera.position.x).equals(position.x)
    expect(camera.position.z).equals(position.z)
    expect(camera.position.y).closeTo(position.y + 20, 0.000001)
  })
  for (const [width, height] of [
    [390, 556],
    [1440, 798],
    [360, 400]
  ]) {
    it(`frames home plate and the entire board at ${width}x${height}`, function () {
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, { width, height, view: 'home', zoom: 1 })
      const points = [new Vector3(0, 0, 10)]
      for (const x of [-63, 63])
        for (const y of [11.5, 46.5])
          points.push(new Vector3(x, y, SCOREBOARD_Z))
      for (const point of points) {
        point.project(camera)
        expect(Math.abs(point.x)).at.most(0.901)
        expect(Math.abs(point.y)).at.most(0.761)
        expect(point.z).within(-1, 1)
      }
    })
  }
})
