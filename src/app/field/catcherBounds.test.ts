import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera } from 'three'

import { catcherBounds, movedRect } from './catcherBounds'

/** A camera behind the plate, looking out to center field. */
function behindThePlate(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 400 / 800, 0.1, 1000)
  camera.position.set(0, 30, 60)
  camera.lookAt(0, 0, -60)
  camera.updateMatrixWorld()
  return camera
}

describe('where the catcher is on screen', function () {
  it('frames the catcher from the head to the feet, centred on the figure', function () {
    const rect = catcherBounds(behindThePlate(), 400, 800, { x: 0, z: 4 })
    expect(rect.x + rect.width / 2).closeTo(200, 1e-6)
    expect(rect.width).greaterThan(0)
    expect(rect.height).greaterThan(0)
    expect(rect.y).greaterThan(0)
    expect(rect.y + rect.height).lessThan(800)
  })

  it('moves with the catcher and grows as the catcher comes closer', function () {
    const camera = behindThePlate()
    const far = catcherBounds(camera, 400, 800, { x: 0, z: -10 })
    const near = catcherBounds(camera, 400, 800, { x: 0, z: 20 })
    expect(near.height).greaterThan(far.height)
    expect(near.y).greaterThan(far.y)
    const left = catcherBounds(camera, 400, 800, { x: -10, z: 4 })
    expect(left.x).lessThan(near.x)
  })

  it('reports a rect only when it has moved by more than a point', function () {
    const rect = { x: 10, y: 20, width: 30, height: 40 }
    expect(movedRect(null, rect)).equals(true)
    expect(movedRect(rect, { ...rect, x: 10.5, height: 40.9 })).equals(false)
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(movedRect(rect, { ...rect, [key]: rect[key] + 2 })).equals(true)
  })
})
