import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import {
  foldCurrentPlay,
  foldPlay,
  type Segment,
  segmentAfter
} from '../../common/scoring/gumbo'
import type { StoredGame } from '../../common/scoring/session'
import { type GameState, setupOf } from '../../common/scoring/state'
import { ball, close, game, TEAMS } from '../../test/scoringGames'
import {
  interruptedEndHalves,
  keepingAtBats,
  movedBy
} from './keepInterruptedAtBats'

/** The plays a game stores once `actions` are scored on `start`. */
function stored(start: GameState, actions: ScoringAction[]): StoredGame {
  let state = start
  let segment: Segment = { setupBefore: setupOf(start), actions: [] }
  const plays: GumboPlay[] = []
  for (const action of actions) {
    const applied = applyAction(state, action)
    expect(applied.problems, JSON.stringify(action)).deep.equals([])
    const split = segmentAfter(state, action, applied, segment)
    for (const { play, segment: done } of split.finished)
      plays.push(foldPlay(applied.state, play, done))
    segment = split.current
    state = applied.state
  }
  return {
    plays,
    currentPlay: foldCurrentPlay(
      state,
      state.liveData.plays.currentPlay,
      segment
    )
  }
}

const endHalf: ScoringAction = { type: 'gameFlow', kind: 'endHalf' }
const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const walked: ScoringAction[] = [ball, ball, ball, ball, close]

describe('finding the at-bats a build dropped when the half was ended by hand', function () {
  it('finds an end of the half taken with pitches thrown, and marks it to keep the at-bat', function () {
    const game0 = game()
    const before = stored(game0, [...walked, ball, endHalf, ball])
    const ends = interruptedEndHalves(before, context)
    expect(ends).length(1)
    const kept = keepingAtBats(before, ends!)
    const records = [...kept.plays, kept.currentPlay].filter(
      play => play?.about.atBatIndex === ends![0].atBatIndex
    )
    const marked = (
      records.at(-1)?.teamStation as { actions: unknown[] } | undefined
    )?.actions[ends![0].position]
    expect(marked).deep.equals({ ...endHalf, keepAtBat: true })
    // The game itself is left as it was.
    expect(JSON.stringify(before)).not.includes('keepAtBat')
  })

  it('leaves an end of the half taken after only a courtesy runner, or between at-bats', function () {
    const bench: ScoringAction[] = [
      {
        type: 'lineup',
        kind: 'addPlayer',
        player: 19,
        side: 'away',
        name: 'Freeman'
      },
      { type: 'lineup', kind: 'runner', side: 'away', base: '1B', player: 19 }
    ]
    expect(
      interruptedEndHalves(
        stored(game(), [...walked, ...bench, endHalf, ball]),
        context
      )
    ).deep.equals([])
    expect(
      interruptedEndHalves(stored(game(), [...walked, endHalf, ball]), context)
    ).deep.equals([])
  })

  it('moves each stored play up one for each kept at-bat at or before it, the final score not at all', function () {
    const moved = movedBy([
      { atBatIndex: 3, position: 2 },
      { atBatIndex: 7, position: 0 }
    ])
    expect([0, 2, 3, 6, 7, 10, 9999].map(moved)).deep.equals([
      0, 2, 4, 7, 9, 12, 9999
    ])
  })
})
