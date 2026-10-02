import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  countLights,
  DEMO_SCOREBOARD,
  pitchLabel,
  scoreDigits,
  shortName
} from './scoreboardModel'
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  COUNT_LAMP_RADIUS,
  COUNT_LAMP_X,
  COUNT_LAMP_Y,
  makeScoreboardPixels,
  SCOREBOARD_MARGIN,
  SCOREBOARD_RULE_X,
  SCOREBOARD_RULE_Y,
  SCOREBOARD_TEXT_LEFT
} from './scoreboardTexture'

describe('vintage scoreboard', function () {
  it('formats names as first name and last initial', function () {
    expect(shortName({ firstName: ' Alex ', lastName: 'Rivera' })).equals(
      'ALEX R.'
    )
  })
  it('keeps counts within three green, two yellow and two red lamps', function () {
    expect(countLights(4, 3)).deep.equals([true, true, true])
    expect(countLights(3, 2)).deep.equals([true, true])
    expect(countLights(1, 2)).deep.equals([true, false])
    expect(countLights(-1, 3)).deep.equals([false, false, false])
    expect(countLights(NaN, 2)).deep.equals([false, false])
  })
  it('writes a score without a leading zero and keeps the pitch count against P:', function () {
    expect(scoreDigits(2)).equals('2')
    expect(scoreDigits(12)).equals('12')
    expect(scoreDigits(0)).equals('0')
    expect(pitchLabel(64)).equals('P:64')
    expect(pitchLabel(7)).equals('P:7')
  })
  it('lights scoreboard lettering to white-hot centers while retaining colored count lamps', () => {
    const pixels = makeScoreboardPixels({ ...DEMO_SCOREBOARD, awayTeam: 'H' })
    const pixel = (x: number, y: number): number[] => {
      const offset = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
      return Array.from(pixels.slice(offset, offset + 3))
    }
    expect(pixel(SCOREBOARD_TEXT_LEFT, 25)).deep.equals([255, 255, 255])
    // The halo around a letter is what survives once the board is scaled down.
    expect(pixel(SCOREBOARD_TEXT_LEFT + 2, 25)[0]).greaterThan(120)
    const green = pixel(COUNT_LAMP_X[0], COUNT_LAMP_Y[0])
    expect(green[1]).greaterThan(green[0])
    expect(green[1]).greaterThan(green[2])
  })
  it('renders count colors and responds to changing game data', function () {
    const pixels = makeScoreboardPixels(DEMO_SCOREBOARD)
    expect(pixels.length).equals(BOARD_WIDTH * BOARD_HEIGHT * 4)
    const rgb = (x: number, y: number): number[] => {
      const ix = Math.round(x)
      const iy = Math.round(y)
      const index = ((BOARD_HEIGHT - 1 - iy) * BOARD_WIDTH + ix) * 4
      return Array.from(pixels.slice(index, index + 3))
    }
    const green = rgb(COUNT_LAMP_X[0], COUNT_LAMP_Y[0])
    const yellow = rgb(COUNT_LAMP_X[0], COUNT_LAMP_Y[1])
    const red = rgb(COUNT_LAMP_X[0], COUNT_LAMP_Y[2])
    expect(green[1]).greaterThan(green[0])
    expect(yellow[0]).greaterThan(yellow[2])
    expect(yellow[1]).greaterThan(yellow[2])
    expect(red[0]).greaterThan(red[1])
    expect(rgb(COUNT_LAMP_X[2], COUNT_LAMP_Y[0])[1]).lessThan(60)
    const updated = makeScoreboardPixels({
      ...DEMO_SCOREBOARD,
      balls: 3,
      homeScore: 9,
      pitchCount: 99
    })
    expect(
      Buffer.compare(Buffer.from(updated), Buffer.from(pixels))
    ).not.equals(0)
  })
  it('splits the board into equal bands with the inning above the count', function () {
    const pixels = makeScoreboardPixels({ ...DEMO_SCOREBOARD, balls: 3 })
    const rgb = (x: number, y: number): number[] => {
      const ix = Math.round(x)
      const iy = Math.round(y)
      const index = ((BOARD_HEIGHT - 1 - iy) * BOARD_WIDTH + ix) * 4
      return Array.from(pixels.slice(index, index + 3))
    }
    const brass = (x: number, y: number): boolean => {
      const color = rgb(x, y)
      return color[0] === 86 && color[1] === 92 && color[2] === 65
    }
    expect(brass(400, SCOREBOARD_RULE_Y)).equals(true)
    expect(brass(SCOREBOARD_RULE_X, 40)).equals(true)
    expect(brass(SCOREBOARD_RULE_X, 180)).equals(true)
    // The band above the rule matches the band below it.
    expect(SCOREBOARD_RULE_Y - 12).equals(244 - (SCOREBOARD_RULE_Y + 2))
    const lampRight = COUNT_LAMP_X[2] + COUNT_LAMP_RADIUS
    const lampTop = COUNT_LAMP_Y[0] - COUNT_LAMP_RADIUS
    expect(SCOREBOARD_RULE_X - lampRight).equals(SCOREBOARD_MARGIN)
    expect(lampTop - (SCOREBOARD_RULE_Y + 2)).equals(SCOREBOARD_MARGIN)
    // A single-digit score does not grow a leading zero, and it shares the
    // ones column with a two-digit score.
    const rightmost = (board: Uint8Array, y0: number, y1: number): number => {
      for (let x = 1004; x >= SCOREBOARD_RULE_X; x--)
        for (let y = y0; y <= y1; y++) {
          const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
          if (board[index] > 200) return x
        }
      return 0
    }
    const single = makeScoreboardPixels({ ...DEMO_SCOREBOARD, awayScore: 2 })
    const doubled = makeScoreboardPixels({ ...DEMO_SCOREBOARD, awayScore: 12 })
    expect(rightmost(single, 20, 70)).closeTo(rightmost(doubled, 20, 70), 2)
    const ones = rightmost(single, 20, 70)
    let tens = false
    for (let x = ones - 50; x <= ones - 28; x++)
      for (let y = 20; y <= 70; y++) {
        const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
        if (single[index] > 200) tens = true
      }
    expect(tens).equals(false)
  })
  it('draws a four-light half-inning triangle with one centered tip', function () {
    const litRows = (
      board: Uint8Array,
      y0: number,
      y1: number
    ): Array<{ y: number; min: number; width: number }> => {
      const rows = []
      for (let y = y0; y <= y1; y++) {
        let min = BOARD_WIDTH
        let max = -1
        for (let x = 16; x < 96; x++) {
          const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
          if (board[index] > 200) {
            if (max >= 0 && x > max + 8) break
            if (x < min) min = x
            max = x
          }
        }
        if (max >= 0) rows.push({ y, min, width: max - min + 1 })
      }
      return rows
    }
    const top = litRows(
      makeScoreboardPixels(DEMO_SCOREBOARD),
      12,
      SCOREBOARD_RULE_Y - 1
    )
    const tip = top[0]
    const base = top[top.length - 1]
    expect(tip.width).lessThan(12)
    expect(base.width).greaterThan(tip.width + 20)
    expect(base.y - tip.y).within(16, 24)
    expect(
      Math.abs(base.min + base.width / 2 - (tip.min + tip.width / 2))
    ).lessThan(3)
    const bottom = litRows(
      makeScoreboardPixels({ ...DEMO_SCOREBOARD, half: 'bottom' }),
      12,
      SCOREBOARD_RULE_Y - 1
    )
    expect(bottom[0].width).greaterThan(bottom[bottom.length - 1].width + 20)
    let countLeft = BOARD_WIDTH
    const count = makeScoreboardPixels(DEMO_SCOREBOARD)
    for (let y = SCOREBOARD_RULE_Y + 2; y < 180; y++)
      for (let x = 16; x < COUNT_LAMP_X[0] - 8; x++) {
        const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
        if (count[index] > 200 && x < countLeft) countLeft = x
      }
    expect(base.min - countLeft).lessThan(24)
  })
  it('centers a one-digit and a two-digit inning in the same box', function () {
    const span = (inning: number): { min: number; max: number } => {
      const board = makeScoreboardPixels({ ...DEMO_SCOREBOARD, inning })
      let min = BOARD_WIDTH
      let max = -1
      for (let y = 12; y < SCOREBOARD_RULE_Y; y++)
        for (let x = 16; x < SCOREBOARD_RULE_X; x++) {
          const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
          if (board[index] > 200) {
            if (x < min) min = x
            if (x > max) max = x
          }
        }
      return { min, max }
    }
    const boxCenter = (16 + SCOREBOARD_RULE_X) / 2
    const one = span(5)
    const two = span(12)
    expect((one.min + one.max) / 2).closeTo(boxCenter, 4)
    expect((two.min + two.max) / 2).closeTo(boxCenter, 4)
    expect(two.max - two.min).greaterThan(one.max - one.min)
  })
})
