import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  clearOf,
  dragSlots,
  dropTarget,
  edgeToEdge,
  gridBox,
  gridShape,
  move,
  type Rect,
  swap,
  tileRects
} from './layout'

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

describe('the grid on a phone held upright', function () {
  it('stacks the angles in one column when the box is taller than it is wide', function () {
    expect(gridShape(393, 760, 4)).deep.equals({ columns: 1, rows: 4 })
    expect(gridShape(393, 760, 2)).deep.equals({ columns: 1, rows: 2 })
    expect(gridShape(393, 760, 1)).deep.equals({ columns: 1, rows: 1 })
    expect(gridShape(852, 393, 4)).deep.equals({ columns: 2, rows: 2 })
    expect(gridShape(852, 393, 2)).deep.equals({ columns: 2, rows: 1 })
  })

  it('gives each of four angles a full-width row, one under another', function () {
    const rects = tileRects({ width: 393, height: 760, count: 4 })
    expect(rects).length(4)
    const [first] = rects
    for (const [index, rect] of rects.entries()) {
      expect(rect.x).equals(first.x)
      expect(rect.w).equals(first.w)
      expect(rect.y).closeTo(first.y + index * first.h, 0.001)
    }
    // As wide as 16:9 allows in a quarter of the height, which is far more
    // than half the width a two-by-two grid gave each one.
    expect(first.w).greaterThan(393 / 2)
    expect(first.w / first.h).closeTo(16 / 9, 0.001)
  })
})

describe('the grid on a phone, edge to edge', function () {
  // An iPhone 13 Pro, upright and sideways.
  const UPRIGHT = { width: 390, height: 844 }
  const UPRIGHT_INSETS = { top: 47, right: 0, bottom: 34, left: 0 }
  const SIDEWAYS = { width: 844, height: 390 }
  const SIDEWAYS_INSETS = { top: 0, right: 47, bottom: 21, left: 47 }

  it('lays the angles out over the whole screen, at their own shape', function () {
    const { top } = edgeToEdge(SIDEWAYS, SIDEWAYS_INSETS, 0, true)
    expect(top).equals(0)
    const rects = tileRects({ ...SIDEWAYS, count: 4, top })
    // A two-by-two of 16:9 is 16:9: the screen's full height, centred across.
    const box = gridBox({ ...SIDEWAYS, count: 4, aspect: 16 / 9 })
    expect(round(box.h)).equals(390)
    expect(round(box.y)).equals(0)
    expect(round(rects[0].w / rects[0].h)).equals(round(16 / 9))
    expect(round(rects[3].y + rects[3].h)).equals(390)
    // Under the home indicator, which the safe area leaves out.
    expect(rects[3].y + rects[3].h).greaterThan(390 - 21)
  })

  it('keeps the controls to what the hardware leaves', function () {
    expect(edgeToEdge(UPRIGHT, UPRIGHT_INSETS, 0, false).safe).deep.equals({
      x: 0,
      y: 47,
      w: 390,
      h: 763
    })
    expect(edgeToEdge(SIDEWAYS, SIDEWAYS_INSETS, 0, true).safe).deep.equals({
      x: 47,
      y: 0,
      w: 750,
      h: 369
    })
    expect(
      edgeToEdge({ width: 10, height: 10 }, UPRIGHT_INSETS, 0, false).safe.h
    ).equals(0)
  })

  it('takes the caller’s side for a square window, so a band is never laid over an angle', function () {
    const square = { width: 600, height: 600 }
    const insets = { top: 24, right: 0, bottom: 20, left: 0 }
    // Not sideways to the caller, which then keeps a band: the angles start
    // below it.
    expect(edgeToEdge(square, insets, 90, false).top).equals(114)
    expect(edgeToEdge(square, insets, 0, true).top).equals(0)
  })

  it('upright with no board, starts the angles below the island, not under it', function () {
    const { top } = edgeToEdge(UPRIGHT, UPRIGHT_INSETS, 0, false)
    expect(top).equals(47)
    const rects = tileRects({ ...UPRIGHT, count: 4, top })
    expect(round(rects[0].y)).equals(47)
    expect(round(rects[3].y + rects[3].h)).equals(844)
  })

  it('upright, starts the angles below the board’s band, and the band below the island', function () {
    const { top } = edgeToEdge(UPRIGHT, UPRIGHT_INSETS, 100, false)
    expect(top).equals(147)
    const rects = tileRects({ ...UPRIGHT, count: 4, top })
    expect(round(rects[0].y)).equals(147)
    // Four 16:9 rows are taller than what is left, so they take all of it,
    // down past the home indicator to the bottom edge, at their own shape.
    expect(round(rects[3].y + rects[3].h)).equals(844)
    expect(round(rects[0].w / rects[0].h)).equals(round(16 / 9))
  })
})

describe('a tile’s name, clear of the hardware', function () {
  const SAFE = { x: 47, y: 47, w: 700, h: 300 }

  it('comes in only as far as the safe area starts inside the tile', function () {
    expect(clearOf({ x: 0, y: 0, w: 400, h: 225 }, SAFE)).deep.equals({
      left: 47,
      top: 47
    })
    expect(clearOf({ x: 20, y: 100, w: 400, h: 225 }, SAFE)).deep.equals({
      left: 27,
      top: 0
    })
  })

  it('stays where it is in a tile already clear, or with no tile', function () {
    expect(clearOf({ x: 75, y: 60, w: 400, h: 225 }, SAFE)).deep.equals({
      left: 0,
      top: 0
    })
    expect(clearOf(undefined, SAFE)).deep.equals({ left: 0, top: 0 })
  })
})

describe('moving a tile by hand', function () {
  const column = tileRects({ width: 393, height: 760, count: 4 })
  const grid = tileRects({ width: 1600, height: 900, count: 4 })
  const rowH = column[0].h

  it('puts one tile at a new place and closes the gap behind it', function () {
    expect(move(['a', 'b', 'c', 'd'], 0, 2)).deep.equals(['b', 'c', 'a', 'd'])
    expect(move(['a', 'b', 'c', 'd'], 3, 0)).deep.equals(['d', 'a', 'b', 'c'])
    const order = ['a', 'b']
    expect(move(order, 1, 1)).equals(order)
    expect(move(order, 0, 5)).equals(order)
    expect(move(order, -1, 0)).equals(order)
  })

  it('upright, slides the rows between up to make room below', function () {
    // The first row's centre carried down into the third.
    const { target, slots } = dragSlots(column, 1, 0, { x: 0, y: rowH * 2 })
    expect(target).equals(2)
    expect(slots).deep.equals([0, 0, 1, 3])
  })

  it('upright, slides the rows between down to make room above', function () {
    const { target, slots } = dragSlots(column, 1, 3, { x: 0, y: -rowH * 2 })
    expect(target).equals(1)
    expect(slots).deep.equals([0, 2, 3, 3])
  })

  it('upright, holds the first or last row past either end', function () {
    expect(dragSlots(column, 1, 1, { x: 0, y: -2000 }).target).equals(0)
    expect(dragSlots(column, 1, 1, { x: 0, y: 2000 }).target).equals(3)
  })

  it('upright, leaves everything still over its own row', function () {
    const { target, slots } = dragSlots(column, 1, 2, { x: 30, y: 5 })
    expect(target).equals(2)
    expect(slots).deep.equals([0, 1, 2, 3])
  })

  it('sideways, slides only the tile underneath into the gap', function () {
    // The top-left tile's centre carried onto the bottom-right one.
    const { target, slots } = dragSlots(grid, 2, 0, {
      x: grid[3].x - grid[0].x,
      y: grid[3].y - grid[0].y
    })
    expect(target).equals(3)
    expect(slots).deep.equals([0, 1, 2, 0])
  })

  it('sideways, moves nothing over its own slot or off the grid', function () {
    expect(dragSlots(grid, 2, 1, { x: 4, y: 4 }).slots).deep.equals([
      0, 1, 2, 3
    ])
    const off = dragSlots(grid, 2, 1, { x: 5000, y: 0 })
    expect(off.target).equals(null)
    expect(off.slots).deep.equals([0, 1, 2, 3])
  })

  it('has nothing to say about a tile that is not there', function () {
    expect(dragSlots(grid, 2, 7, { x: 0, y: 0 })).deep.equals({
      target: null,
      slots: [0, 1, 2, 3]
    })
  })
})

describe('where a grid sits up and down its box (U7)', function () {
  it('is in the middle by default, at the top or at the bottom when asked, the arrangement the same', function () {
    const middle = tileRects({ width: 874, height: 402, count: 2 })
    const top = tileRects({ width: 874, height: 402, count: 2, align: 'top' })
    const bottom = tileRects({
      width: 874,
      height: 402,
      count: 2,
      align: 'bottom'
    })
    expect(middle[0].y).closeTo((402 - middle[0].h) / 2, 1e-6)
    expect(top[0].y).equals(0)
    expect(bottom[0].y + bottom[0].h).closeTo(402, 1e-6)
    for (const rects of [top, bottom])
      rects.forEach((rect, index) => {
        expect(rect.x).closeTo(middle[index].x, 1e-6)
        expect(rect.w).closeTo(middle[index].w, 1e-6)
      })
    // Below a band, at the top of what is left.
    const stacked = tileRects({
      width: 402,
      height: 874,
      count: 2,
      top: 100,
      align: 'top'
    })
    expect(stacked[0].y).equals(100)
  })
})
