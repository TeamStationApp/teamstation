import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  fieldPixelRatio,
  fieldPixelRatioRange,
  fieldRenderBox
} from './fieldResolution'

describe('the field pixel ratio', function () {
  it('caps a phone at 1.25 and anything wider at 1.5, and never goes below 1', function () {
    expect(fieldPixelRatioRange(true)).deep.equals([1, 1.25])
    expect(fieldPixelRatioRange(false)).deep.equals([1, 1.5])
    expect(fieldPixelRatio(2.625, true)).equals(1.25)
    expect(fieldPixelRatio(3, false)).equals(1.5)
    expect(fieldPixelRatio(1.1, true)).equals(1.1)
    expect(fieldPixelRatio(0.75, true)).equals(1)
  })
  it('draws a phone field into a smaller view stretched over it', function () {
    const box = fieldRenderBox(400, 800, 2.5, true)
    expect(box.ratio).equals(1.25)
    expect(box.width).equals(200)
    expect(box.height).equals(400)
    expect(box.stretch).equals(2)
    // Stretched about its centre, the view covers the field exactly.
    expect(box.left - (box.width * (box.stretch - 1)) / 2).equals(0)
    expect(box.top - (box.height * (box.stretch - 1)) / 2).equals(0)
  })
  it('leaves a screen already under the cap as it is', function () {
    expect(fieldRenderBox(300, 500, 1, true)).deep.equals({
      width: 300,
      height: 500,
      left: 0,
      top: 0,
      stretch: 1,
      ratio: 1
    })
  })
})
