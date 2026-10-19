import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  closed,
  game,
  single,
  strikeout,
  walk
} from '../../test/scoringGames'
import type { GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { boardLineOf, boardLineOfPlays, ZERO_LINE } from './boardLine'
import { fieldingSide } from './lineup'
import type { GameState } from './state'

const swing: ScoringAction = { type: 'ballInPlay', contact: 'swing' }
function homeRun(state: GameState): GameState {
  return closed(after(state, swing, { type: 'result', eventType: 'home_run' }))
}
function reachOnError(state: GameState): GameState {
  const reached = after(state, swing, {
    type: 'result',
    eventType: 'field_error'
  })
  const shortstop =
    reached.liveData.boxscore.teams[fieldingSide(reached)].defense.SS!
  return closed(
    after(reached, {
      type: 'fieldingPlay',
      fielders: [shortstop],
      error: shortstop
    })
  )
}
function threeOuts(state: GameState): GameState {
  return strikeout(strikeout(strikeout(state)))
}

describe('the line score at a moment of the game (U1)', function () {
  it('starts with the visitors batting in the first and nobody scored', function () {
    expect(boardLineOf(game())).deep.equals({
      away: { innings: [0], r: 0, h: 0, e: 0 },
      home: { innings: [null], r: 0, h: 0, e: 0 }
    })
    expect(ZERO_LINE.away.innings).deep.equals([])
  })

  it('counts the half in progress from the runs so far', function () {
    let state = homeRun(game())
    state = single(state)
    expect(boardLineOf(state).away).deep.equals({
      innings: [1],
      r: 1,
      h: 2,
      e: 0
    })
    expect(boardLineOf(state).home.innings).deep.equals([null])
  })

  it('closes a half with its last play and opens the next', function () {
    let state = threeOuts(homeRun(game()))
    expect(boardLineOf(state)).deep.equals({
      away: { innings: [1], r: 1, h: 1, e: 0 },
      home: { innings: [0], r: 0, h: 0, e: 0 }
    })
    state = threeOuts(homeRun(homeRun(state)))
    expect(boardLineOf(state)).deep.equals({
      away: { innings: [1, 0], r: 1, h: 1, e: 0 },
      home: { innings: [2, null], r: 2, h: 2, e: 0 }
    })
  })

  it('charges an error to the side in the field', function () {
    const state = reachOnError(game())
    const line = boardLineOf(state)
    expect(line.away.e).equals(0)
    expect(line.home.e).equals(1)
    expect(line.away.h).equals(0)
  })

  it('scores a run forced home in the half it came in', function () {
    let state = walk(walk(walk(walk(game()))))
    expect(boardLineOf(state).away).deep.equals({
      innings: [1],
      r: 1,
      h: 0,
      e: 0
    })
    state = threeOuts(state)
    expect(boardLineOf(state).away.innings).deep.equals([1])
  })

  it('runs into extra innings, and leaves out the inning a finished game never played', function () {
    let state = game()
    for (let inning = 1; inning <= 9; inning++)
      state = threeOuts(threeOuts(state))
    expect(boardLineOf(state).away.innings).deep.equals([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])
    state = threeOuts(homeRun(state))
    state = threeOuts(state)
    // Visitors ahead after ten: the scorer ends it, and the eleventh nobody
    // batted in is not shown.
    state = after(state, { type: 'gameFlow', kind: 'endGame' })
    const line = boardLineOf(state)
    expect(state.final).equals(true)
    expect(line.away.innings).deep.equals([0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(line.home.innings).deep.equals([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(line.away.r).equals(1)
  })

  it('reads imported plays inning by inning, with a half nobody played', function () {
    const play = (
      index: number,
      inning: number,
      half: 'top' | 'bottom',
      away: number,
      home: number,
      eventType = 'single'
    ): GumboPlay =>
      ({
        about: { atBatIndex: index, inning, halfInning: half },
        result: { eventType, awayScore: away, homeScore: home },
        count: { outs: 3 }
      }) as unknown as GumboPlay
    const line = boardLineOfPlays([
      play(0, 1, 'top', 2, 0, 'home_run'),
      play(1, 1, 'bottom', 2, 1),
      play(2, 2, 'top', 2, 1, 'field_error'),
      play(3, 3, 'top', 3, 1)
    ])
    expect(line.away.innings).deep.equals([2, 0, 1])
    expect(line.home.innings).deep.equals([1, null, null])
    expect(line.away.r).equals(3)
    expect(line.home.r).equals(1)
    expect(line.away.h).equals(2)
    expect(line.home.e).equals(1)
  })
})
