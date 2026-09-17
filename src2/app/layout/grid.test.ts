import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  cardPosition,
  cardSize,
  columnsForWidth,
  highlightColumnsFor
} from './grid'

describe('grid', function () {
  it('gives a narrow window a single column', function () {
    expect(columnsForWidth(320)).equals(1)
    expect(columnsForWidth(480)).equals(1)
    expect(columnsForWidth(639)).equals(1)
  })

  it('widens in steps', function () {
    expect(columnsForWidth(640)).equals(2)
    expect(columnsForWidth(1000)).equals(3)
    expect(columnsForWidth(1400)).equals(4)
    expect(columnsForWidth(2560)).equals(5)
  })

  it('never returns fewer than one column, even at zero width', function () {
    expect(columnsForWidth(0)).equals(1)
    expect(columnsForWidth(-100)).equals(1)
  })

  it('fits the cards inside the window with even gutters', function () {
    const { columns, cardWidth, gutter } = cardSize({ width: 1000, gutter: 12 })
    expect(columns).equals(3)
    // Three cards and four gutters must not exceed the window.
    expect(cardWidth * columns + gutter * (columns + 1)).is.at.most(1000)
  })

  it('does not let one card fill a very wide window', function () {
    const wide = cardSize({ width: 3000, gutter: 12, maxCardWidth: 420 })
    expect(wide.cardWidth).equals(420)
  })

  it('does not return a negative width when there is no room', function () {
    const tiny = cardSize({ width: 10, gutter: 12 })
    expect(tiny.cardWidth).is.at.least(0)
  })

  it('lays cards out row by row, newest first', function () {
    // With the newest game at index 0, it belongs top-left.
    expect(cardPosition(0, 3)).deep.equals({ row: 0, column: 0 })
    expect(cardPosition(1, 3)).deep.equals({ row: 0, column: 1 })
    expect(cardPosition(2, 3)).deep.equals({ row: 0, column: 2 })
    expect(cardPosition(3, 3)).deep.equals({ row: 1, column: 0 })
  })

  it('puts everything in one column when there is only one', function () {
    expect(cardPosition(0, 1)).deep.equals({ row: 0, column: 0 })
    expect(cardPosition(5, 1)).deep.equals({ row: 5, column: 0 })
  })
})

describe('highlight columns', function () {
  it('is a single column on a phone', function () {
    expect(highlightColumnsFor(390)).equals(1)
    expect(highlightColumnsFor(599)).equals(1)
  })

  it('widens as the width allows', function () {
    expect(highlightColumnsFor(800)).equals(2)
    expect(highlightColumnsFor(1280)).equals(3)
    expect(highlightColumnsFor(1600)).equals(4)
  })

  it('never goes past four, however wide the monitor', function () {
    expect(highlightColumnsFor(2560)).equals(4)
  })

  it('never returns nothing', function () {
    expect(highlightColumnsFor(0)).equals(1)
  })
})
