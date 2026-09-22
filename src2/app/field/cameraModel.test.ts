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
