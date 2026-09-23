import { expect } from 'chai'
import { describe, it } from 'mocha'

import { dropTarget, gridBox, type Rect, swap, tileRects } from './layout'

const area = (rect: Rect): number => rect.w * rect.h
const round = (value: number): number => Math.round(value * 100) / 100

describe('where the tiles go', function () {
  const window = { width: 1600, height: 900 }

  it('gives four tiles the quadrants, in reading order', function () {
    const rects = tileRects({ ...window, count: 4 })
    expect(rects).has.length(4)
    expect(rects[0].x).lessThan(rects[1].x)
    expect(rects[0].y).equals(rects[1].y)
    expect(rects[2].y).greaterThan(rects[0].y)
    expect(rects[3].x).equals(rects[1].x)
    for (const rect of rects)
      expect(round(area(rect))).equals(round(area(rects[0])))
  })

  it('gives two tiles a side each', function () {
    const rects = tileRects({ ...window, count: 2 })
    expect(rects).has.length(2)
    expect(rects[0].h).equals(rects[1].h)
    expect(rects[0].x + rects[0].w).equals(rects[1].x)
  })

  it('leaves the fourth quadrant empty for three', function () {
    const rects = tileRects({ ...window, count: 3 })
    expect(rects).has.length(3)
    const four = tileRects({ ...window, count: 4 })
    expect(rects[0]).deep.equals(four[0])
    expect(rects[2]).deep.equals(four[2])
  })

  it('letterboxes the grid once, not every tile', function () {
    // A window taller than a two-by-two of 16:9 leaves bars top and bottom of
    // the grid as a whole, and none inside the quadrants.
    const box = gridBox({ width: 1600, height: 1200, count: 4, aspect: 16 / 9 })
    expect(round(box.w / box.h)).equals(round(16 / 9))
    expect(box.y).greaterThan(0)
    expect(box.x).equals(0)
  })

  it('keeps the tiles shape when the window is wider than they are', function () {
    const box = gridBox({ width: 2400, height: 900, count: 4, aspect: 16 / 9 })
    expect(round(box.w / box.h)).equals(round(16 / 9))
    expect(box.x).greaterThan(0)
  })

  it('gives a zoomed tile the whole box and leaves the rest where they were', function () {
    const plain = tileRects({ ...window, count: 4 })
    const zoomed = tileRects({ ...window, count: 4, zoomed: 2 })
    expect(area(zoomed[2])).greaterThan(area(plain[2]))
    expect(zoomed[0]).deep.equals(plain[0])
    expect(zoomed[1]).deep.equals(plain[1])
    expect(zoomed[3]).deep.equals(plain[3])
  })

  it('never draws more than four, whatever it is asked for', function () {
    expect(tileRects({ ...window, count: 9 })).has.length(4)
    expect(tileRects({ ...window, count: 0 })).has.length(0)
  })
})

describe('dragging one tile onto another', function () {
  const rects = tileRects({ width: 1600, height: 900, count: 4 })

  it('finds the tile under the finger', function () {
    const middle = (rect: Rect): { x: number; y: number } => ({
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2
    })
    expect(dropTarget(rects, middle(rects[3]))).equals(3)
    expect(dropTarget(rects, middle(rects[0]))).equals(0)
  })

  it('answers nothing when the finger is off the grid', function () {
    expect(dropTarget(rects, { x: -20, y: -20 })).equals(null)
  })

  it('swaps two tiles and moves no others', function () {
    expect(swap(['a', 'b', 'c', 'd'], 0, 3)).deep.equals(['d', 'b', 'c', 'a'])
  })

  it('leaves the order alone when the drag went nowhere', function () {
    const order = ['a', 'b', 'c', 'd']
    expect(swap(order, 1, 1)).equals(order)
    expect(swap(order, 1, 9)).equals(order)
    expect(swap(order, -1, 2)).equals(order)
  })
})
