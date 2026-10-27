import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  currentInning,
  inningText,
  LINE_BORDER,
  LINE_BOX_HEIGHT,
  LINE_BOX_WIDTH,
  LINE_INNING_WIDTH,
  LINE_INNINGS_SHAPED,
  LINE_NAME_WIDTH,
  LINE_SIDE,
  LINE_TOTAL_WIDTH,
  lineBoxHeight,
  lineColumns,
  totalText
} from './lineScoreLayout'

describe('the line score box’s columns (U4)', function () {
  /** A box room for exactly `n` innings beside the names and the totals. */
  const roomFor = (n: number): number =>
    2 * LINE_BORDER +
    2 * LINE_SIDE +
    LINE_NAME_WIDTH +
    3 * LINE_TOTAL_WIDTH +
    n * LINE_INNING_WIDTH

  it('shows every inning so far, up to six', function () {
    expect(LINE_INNINGS_SHAPED).equals(6)
    expect(lineColumns(roomFor(6), 1)).deep.equals([1])
    expect(lineColumns(roomFor(6), 3)).deep.equals([1, 2, 3])
    expect(lineColumns(roomFor(6), 6)).deep.equals([1, 2, 3, 4, 5, 6])
  })

  it('moves along to the latest six past the sixth, however wide the box', function () {
    expect(lineColumns(roomFor(6), 7)).deep.equals([2, 3, 4, 5, 6, 7])
    expect(lineColumns(roomFor(6), 12)).deep.equals([7, 8, 9, 10, 11, 12])
    expect(lineColumns(roomFor(9), 12)).deep.equals([7, 8, 9, 10, 11, 12])
    // Narrower than six, as many of the latest as fit.
    expect(lineColumns(roomFor(4) + 20, 12)).deep.equals([9, 10, 11, 12])
  })

  it('fits every inning its width holds when the cap is lifted', function () {
    // A compact box: the shaped width drawn at three quarters of its height.
    const compact = roomFor(6) / 0.75
    expect(lineColumns(compact, 12, Infinity).length).greaterThan(6)
    expect(lineColumns(compact, 12, Infinity).at(-1)).equals(12)
    expect(lineColumns(compact, 12)).deep.equals([7, 8, 9, 10, 11, 12])
    expect(lineColumns(roomFor(9), 12, Infinity)).deep.equals([
      4, 5, 6, 7, 8, 9, 10, 11, 12
    ])
    // Never more than the game has played.
    expect(lineColumns(roomFor(9), 3, Infinity)).deep.equals([1, 2, 3])
  })

  it('is shaped for six innings beside the names and the totals', function () {
    expect(LINE_BOX_WIDTH).equals(roomFor(6))
  })

  it('shows six innings in a box drawn at its own shape, at every width', function () {
    // As the box reads its width back from the rect the layout gives it.
    for (let w = 50; w <= 2000; w += 0.25) {
      const width = w / (lineBoxHeight(w) / LINE_BOX_HEIGHT)
      expect(lineColumns(width, 12), `at ${w} px`).length(6)
    }
  })

  it('always shows one inning, however narrow, and the first before any', function () {
    expect(lineColumns(10, 7)).deep.equals([7])
    expect(lineColumns(roomFor(6), 0)).deep.equals([1])
  })

  it('follows the inning the game is in', function () {
    const line = {
      away: { innings: [0, 1, 2], r: 3, h: 4, e: 0 },
      home: { innings: [1, 0], r: 1, h: 2, e: 1 }
    }
    expect(currentInning(line)).equals(3)
    expect(
      currentInning({
        away: { innings: [], r: 0, h: 0, e: 0 },
        home: { innings: [], r: 0, h: 0, e: 0 }
      })
    ).equals(1)
  })

  it('leaves a half not started blank and an unknown figure a dash', function () {
    expect(inningText(null)).equals('')
    expect(inningText(undefined)).equals('')
    expect(inningText(0)).equals('0')
    expect(totalText(null)).equals('–')
    expect(totalText(5)).equals('5')
  })
})
