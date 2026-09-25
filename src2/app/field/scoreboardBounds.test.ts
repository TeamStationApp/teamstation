import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera } from 'three'

import { applyFieldCamera } from './cameraModel'
import { scoreboardBounds } from './scoreboardBounds'
describe('scoring toast projection', function () {
  for (const [width, height] of [
    [390, 730],
    [1200, 788],
    [844, 278]
  ])
    it(`keeps the scoreboard toast inside ${width} by ${height}`, function () {
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width,
        height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33
      })
      const bounds = scoreboardBounds(camera, width, height)
      expect(bounds.x).at.least(12)
      expect(bounds.x + bounds.width).at.most(width - 12)
      expect(bounds.y).at.least(62)
      expect(bounds.height).at.least(60)
    })
})
