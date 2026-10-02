import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from './cameraModel'
import { relativeLandingPointer } from './relativeLanding'
import { TERRAIN } from './terrain'

describe('relative landing projection', function () {
  it('preserves target projection at any grab origin and adds the same screen displacement without moving the camera', function () {
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: 390,
      height: 740,
      view: 'home',
      zoom: 1.25,
      tilt: -0.19,
      heightOffset: 33,
      bottomExtension: 112
    })
    const pose = [
      ...camera.position.toArray(),
      ...camera.quaternion.toArray(),
      ...camera.projectionMatrix.elements
    ]
    for (const height of [undefined, 9]) {
      const initial = {
        target: { x: 5, z: -70 },
        angle: 45,
        landingHeight: height
      }
      const projected = new Vector3(5, height ?? TERRAIN.players, -70).project(
        camera
      )
      for (const start of [
        { x: -0.8, y: 0.9 },
        { x: 0.7, y: -0.6 }
      ]) {
        const unchanged = relativeLandingPointer(initial, start, start, camera)
        expect(unchanged.x).closeTo(projected.x, 1e-10)
        expect(unchanged.y).closeTo(projected.y, 1e-10)
        const moved = relativeLandingPointer(
          initial,
          start,
          { x: start.x + 0.2, y: start.y + 0.3 },
          camera
        )
        expect(moved.x - unchanged.x).closeTo(0.2, 1e-10)
        expect(moved.y - unchanged.y).closeTo(0.3, 1e-10)
      }
    }
    expect([
      ...camera.position.toArray(),
      ...camera.quaternion.toArray(),
      ...camera.projectionMatrix.elements
    ]).deep.equals(pose)
  })
})
