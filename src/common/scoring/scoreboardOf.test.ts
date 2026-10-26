import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GameScoreboard } from '../scoreboard'
import { userIdOfGumbo } from '../userId'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { freshGame, newSetup } from './lineup'
import { nextDecision } from './rules'
import { scoreboardOfGame } from './scoreboardOf'
import type { GameState } from './state'

/**
 * An action list with named points in it: a top half with a run, then a
 * bottom half to runners on first and third at 2-1, then its third out.
 */
function situationEntries(): Array<ScoringAction | { point: string }> {
  return JSON.parse(
    readFileSync(
      'src/common/scoring/fixtures/scoreboardSituations.actions.json',
      'utf8'
    )
  ) as Array<ScoringAction | { point: string }>
}

const TEAMS = {
  away: { id: 'away', name: 'Away', logoUrl: null },
  home: { id: 'home', name: 'Home', logoUrl: null }
}
const setup = newSetup(TEAMS, {
  away: Array.from({ length: 9 }, (_, i) => ({
    userId: userIdOfGumbo(1 + i),
    gumboId: 1 + i,
    shortName: `Away ${i + 1}`
  })),
  home: Array.from({ length: 9 }, (_, i) => ({
    userId: userIdOfGumbo(10 + i),
    gumboId: 10 + i,
    shortName: `Home ${i + 1}`
  }))
})

/** The board at each named point of the fixture. */
function snapshots(): Record<string, GameScoreboard> {
  let state: GameState = freshGame('g1', TEAMS, setup)
  const out: Record<string, GameScoreboard> = {}
  for (const entry of situationEntries()) {
    if ('point' in entry) {
      out[entry.point] = scoreboardOfGame(state)
      continue
    }
    const applied = applyAction(state, entry)
    expect(applied.problems, JSON.stringify(entry)).deep.equals([])
    state = applied.state
  }
  return out
}

describe('what a scored game puts on its scoreboard', function () {
  const at = snapshots()

  it('gives the count, outs, runners, inning, half, batter, pitcher, pitches and score mid at-bat', function () {
    expect(at.midAtBat).deep.equals({
      inGame: true,
      balls: 2,
      strikes: 1,
      outs: 1,
      base1: true,
      base2: false,
      base3: true,
      inning: 1,
      half: 'bottom',
      batterName: 'Home 4',
      pitcherName: 'Away 1',
      batterNumHits: 0,
      batterAtBats: 0,
      numPitches: 8,
      awayScore: 1,
      homeScore: 0
    })
  })

  it('gives the next half-inning, with no outs and nobody on, after a third out', function () {
    expect(at.bottomFirst).includes({ inning: 1, half: 'bottom', outs: 0 })
    expect(at.afterThirdOut).deep.equals({
      inGame: true,
      balls: 0,
      strikes: 0,
      outs: 0,
      base1: false,
      base2: false,
      base3: false,
      inning: 2,
      half: 'top',
      batterName: 'Away 6',
      pitcherName: 'Home 1',
      batterNumHits: 0,
      batterAtBats: 0,
      numPitches: 11,
      awayScore: 1,
      homeScore: 0
    })
  })

  it('shows no pitcher and no count for a game with nobody in the field', function () {
    const empty = freshGame('g2', TEAMS, setup)
    empty.liveData.linescore.defense.P = null
    empty.liveData.linescore.offense.batter = null
    expect(scoreboardOfGame(empty)).includes({
      pitcherName: '',
      batterName: '',
      batterNumHits: 0,
      batterAtBats: 0,
      numPitches: 0
    })
  })

  it("shows the batter's hits and at-bats in this game, and keeps them while the next at-bat is open", function () {
    const fresh = freshGame('g3', TEAMS, setup)
    const leadoff = fresh.liveData.linescore.offense.batter?.id
    if (leadoff == null) throw new Error('Missing leadoff batter')
    const back = (state: GameState): GameState => {
      for (
        let i = 0;
        i < 40 && state.liveData.linescore.offense.batter?.id !== leadoff;
        i++
      )
        state = punchOut(state)
      expect(state.liveData.linescore.offense.batter?.id).equals(leadoff)
      return state
    }

    const afterSingle = back(finish(drive(fresh, ...SINGLE)))
    expect(scoreboardOfGame(afterSingle)).includes({
      batterName: 'Away 1',
      batterNumHits: 1,
      batterAtBats: 1
    })
    expect(
      scoreboardOfGame(drive(afterSingle, { type: 'pitch', call: 'B' }))
    ).includes({ batterNumHits: 1, batterAtBats: 1, balls: 1 })

    const afterStrikeout = back(punchOut(fresh))
    expect(scoreboardOfGame(afterStrikeout)).includes({
      batterName: 'Away 1',
      batterNumHits: 0,
      batterAtBats: 1
    })

    const afterWalk = back(baseOnBalls(fresh))
    expect(scoreboardOfGame(afterWalk)).includes({
      batterName: 'Away 1',
      batterNumHits: 0,
      batterAtBats: 0
    })
  })
})

const SINGLE: ScoringAction[] = [
  {
    type: 'ballInPlay',
    contact: 'swing',
    launchAngle: 10,
    location: { x: 5, z: -80 },
    fielder: 17
  },
  { type: 'result', eventType: 'single' }
]

function drive(state: GameState, ...actions: ScoringAction[]): GameState {
  for (const action of actions) {
    const applied = applyAction(state, action)
    expect(applied.problems, JSON.stringify(action)).deep.equals([])
    state = applied.state
  }
  return state
}

/** Closes a decided play, as the scorer's next plate appearance would. */
function finish(state: GameState): GameState {
  return nextDecision(state) === 'close'
    ? drive(state, { type: 'gameFlow', kind: 'closePlay' })
    : state
}

function punchOut(state: GameState): GameState {
  return finish(
    drive(
      state,
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' }
    )
  )
}

function baseOnBalls(state: GameState): GameState {
  return finish(
    drive(
      state,
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    )
  )
}
