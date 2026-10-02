import { expect } from 'chai'
import { describe, it } from 'mocha'

import { AT_BAT_BLUE, AT_BAT_GREEN, AT_BAT_PURPLE } from './atBatColors'
import { ringColor, roundedRectPoints } from './perimeterRing'

describe('the at-bat string', function () {
  it('runs clockwise around the whole card', function () {
    const points = roundedRectPoints(200, 80, 12, 80)
    const top = points.filter(point => point.y < 0.5)
    const right = points.filter(point => point.x > 199.5)
    const bottom = points.filter(point => point.y > 79.5)
    const left = points.filter(point => point.x < 0.5)
    expect(top.length).greaterThan(2)
    expect(right.length).greaterThan(2)
    expect(bottom.length).greaterThan(2)
    expect(left.length).greaterThan(2)
    expect(top[top.length - 1].x).greaterThan(top[0].x)
    expect(right[right.length - 1].y).greaterThan(right[0].y)
    expect(bottom[bottom.length - 1].x).lessThan(bottom[0].x)
    expect(left[left.length - 1].y).lessThan(left[0].y)
  })

  it('blends blue, purple and green, and a pull moves that blend clockwise', function () {
    expect(ringColor(0)).equals(css(AT_BAT_BLUE))
    expect(ringColor(1 / 3)).equals(css(AT_BAT_PURPLE))
    expect(ringColor(2 / 3)).equals(css(AT_BAT_GREEN))
    expect(ringColor(1 / 6)).not.equals(css(AT_BAT_BLUE))
    expect(ringColor(1 / 6)).not.equals(css(AT_BAT_PURPLE))
    // The color now at 0.2 is the one that sat just counterclockwise of it.
    expect(ringColor(0.2 - 0.05)).equals(ringColor(0.15))
  })
})

function css(hex: string): string {
  const n = (start: number): number =>
    Number.parseInt(hex.slice(start, start + 2), 16)
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`
}
