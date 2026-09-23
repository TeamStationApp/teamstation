import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GameScoreboard } from '../scoreboard'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { freshGame, newSetup } from './lineup'
import { scoreboardOfGame } from './scoreboardOf'
import type { GameState } from './state'

/**
 * An action list with named points in it: a top half with a run, then a
 * bottom half to runners on first and third at 2-1, then its third out.
 */
function situationEntries(): Array<ScoringAction | { point: string }> {
  return JSON.parse(
    readFileSync(
      'src2/common/scoring/fixtures/scoreboardSituations.actions.json',
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
    userId: 1000 + i,
    shortName: `Away ${i + 1}`
  })),
  home: Array.from({ length: 9 }, (_, i) => ({
    userId: 2000 + i,
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
      numPitches: 0
    })
  })
})
