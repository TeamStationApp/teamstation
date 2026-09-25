import { expect } from 'chai'
import { describe, it } from 'mocha'

import { countLights, DEMO_SCOREBOARD, shortName } from './scoreboardModel'
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  makeScoreboardPixels
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
  it('lights scoreboard lettering to white-hot centers while retaining colored count lamps', () => {
    const pixels = makeScoreboardPixels({ ...DEMO_SCOREBOARD, awayTeam: 'H' })
    const pixel = (x: number, y: number): number[] => {
      const offset = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
      return Array.from(pixels.slice(offset, offset + 3))
    }
    expect(pixel(40, 30)).deep.equals([255, 255, 255])
    const green = pixel(866, 37)
    expect(green[1]).greaterThan(green[0])
    expect(green[1]).greaterThan(green[2])
  })
  it('renders count colors and responds to changing game data', function () {
    const pixels = makeScoreboardPixels(DEMO_SCOREBOARD)
    expect(pixels.length).equals(BOARD_WIDTH * BOARD_HEIGHT * 4)
    const rgb = (x: number, y: number): number[] => {
      const index = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
      return Array.from(pixels.slice(index, index + 3))
    }
    const green = rgb(866, 37)
    const yellow = rgb(866, 81)
    const red = rgb(866, 125)
    expect(green[1]).greaterThan(green[0])
    expect(yellow[0]).greaterThan(yellow[2])
    expect(yellow[1]).greaterThan(yellow[2])
    expect(red[0]).greaterThan(red[1])
    expect(rgb(936, 37)[1]).lessThan(60) // Unlit third ball.
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
})
