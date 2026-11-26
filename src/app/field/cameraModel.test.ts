import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import {
  applyFieldCamera,
  cameraDragValue,
  catcherCardBottom,
  fieldViewportHeight,
  HEIGHT_LIMIT,
  SCOREBOARD_Z,
  TILT_LIMIT
} from './cameraModel'

describe('field camera controls', function () {
  for (const [width, height] of [
    [474, 1194],
    [773, 744],
    [834, 834]
  ]) {
    it(`fits the outfield wall and roof within 90 percent of the ${width}-point side field`, function () {
      const camera = new PerspectiveCamera()
      const frame = { top: 64, bottom: 172, corners: true }
      applyFieldCamera(camera, {
        width,
        height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112,
        frame
      })
      const roofTops: number[] = []
      for (const side of [-1, 1]) {
        for (const a of [Math.PI / 4, Math.PI / 3.5]) {
          const wall = new Vector3(
            side * 118 * Math.sin(a),
            0,
            -118 * Math.cos(a)
          ).project(camera)
          expect(Math.abs(wall.x)).at.most(0.90001)
          expect(Math.abs(wall.y)).lessThan(1)
        }
        for (const depth of [-2.1, 2.9]) {
          const roof = new Vector3(
            side * 34.5 * 1.8,
            28.2 + 9.95 * 1.8,
            -135 + depth * 1.8
          ).project(camera)
          expect(Math.abs(roof.x)).at.most(0.90001)
          roofTops.push(((1 - roof.y) * height) / 2)
        }
      }
      expect(Math.min(...roofTops)).closeTo(frame.top, 0.1)
    })
  }
  for (const [width, height] of [
    [393, 852],
    [600, 700],
    [1000, 742]
  ]) {
    it(`pins the scoreboard roof and fits the numbered catcher card at ${width}×${height}`, function () {
      const camera = new PerspectiveCamera()
      const options = {
        width,
        height,
        zoom: 1.25,
        view: 'home' as const,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      }
      function roof(): { top: number; width: number } {
        const points = []
        for (const x of [-34.5, 34.5])
          for (const z of [-2.1, 2.9])
            points.push(
              new Vector3(x * 1.8, 28.2 + 9.95 * 1.8, -135 + z * 1.8).project(
                camera
              )
            )
        return {
          top: Math.min(...points.map(p => ((1 - p.y) * height) / 2)),
          width:
            ((Math.max(...points.map(p => p.x)) -
              Math.min(...points.map(p => p.x))) *
              width) /
            2
        }
      }
      applyFieldCamera(camera, options)
      const old = roof().width
      const frame = { top: 64, bottom: 200 }
      const bottom = applyFieldCamera(camera, { ...options, frame })!
      expect(roof().top).closeTo(frame.top, 0.5)
      expect(catcherCardBottom(camera, width, height)).closeTo(bottom, 0.01)
      expect(bottom).at.most(height - frame.bottom)
      if (width === 393) {
        expect(roof().width).closeTo(old, 0.01)
        expect(roof().width).closeTo(419.977, 0.1)
      } else {
        expect(bottom).closeTo(height - frame.bottom, 0.05)
        expect(roof().width).lessThan(old)
      }
    })
  }
  it('keeps the replay home camera and its bottom extension at their original projection', function () {
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: 393,
      height: 852,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    expect(camera.position.toArray()).deep.equals([
      0, 137.26702971184517, 145.4970314300046
    ])
    expect(camera.projectionMatrix.toArray()).deep.equals([
      4.7801512539226145, 0, 0, 0, 0, 2.2049289234643044, 0, 0, 0,
      -0.13145539906103293, -1.0036429872495447, -1, 0, 0, -4.007285974499089, 0
    ])
  })
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
