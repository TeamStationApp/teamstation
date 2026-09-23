import { expect } from 'chai'
import { describe, it } from 'mocha'

import { camerasFromTiles } from '../media/cameras'

/**
 * Tiles are not cameras. One tile of a multi-angle mosaic is always the
 * program output, which is not a camera, so the count is one less than what
 * you see.
 */
describe('reading a mosaic', function () {
  it('calls four tiles three cameras', function () {
    expect(camerasFromTiles(4)).equals(3)
  })

  it('calls three tiles two cameras', function () {
    expect(camerasFromTiles(3)).equals(2)
  })

  it('refuses to guess from one tile or none', function () {
    expect(camerasFromTiles(1)).equals(null)
    expect(camerasFromTiles(0)).equals(null)
  })

  it('refuses anything that is not a whole number of tiles', function () {
    expect(camerasFromTiles(Number.NaN)).equals(null)
    expect(camerasFromTiles(2.5)).equals(null)
  })
})
