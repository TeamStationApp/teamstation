import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { foldPlay } from '../../common/scoring/gumbo'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { type GameState, setupOf } from '../../common/scoring/state'
import { after, F, TEAMS } from '../../test/scoringGames'
import { gameStatLines, type PlayerGameLine } from './gumboStats'

/**
 * A game scored in GameStation builds stat lines: the engine's plays, folded
 * into the documents the server stores, go straight into the stats builder.
 * The visitors are users 101-109 batting in order; the home pitcher is 201.
 */
const AWAY = Array.from({ length: 9 }, (_, i) => 101 + i)
const HOME = Array.from({ length: 9 }, (_, i) => 201 + i)
const PITCHER = HOME[0]
const teams = { homeTeamId: TEAMS.home.id, awayTeamId: TEAMS.away.id }
const known = new Set([...AWAY, ...HOME])

function start(): GameState {
  return freshGame(
    'g1',
    TEAMS,
    newSetup(TEAMS, {
      away: AWAY.map((userId, i) => ({ userId, shortName: `Away ${i + 1}` })),
      home: HOME.map((userId, i) => ({ userId, shortName: `Home ${i + 1}` }))
    })
  )
}

/** Scores the actions and returns every completed play as it is stored. */
function scored(...actions: ScoringAction[]): GumboPlay[] {
  const state = after(start(), ...actions)
  return state.liveData.plays.allPlays.map(play =>
    foldPlay(state, play, { setupBefore: setupOf(state), actions })
  )
}

function lines(plays: GumboPlay[]): Map<number, PlayerGameLine> {
  const result = gameStatLines(plays, teams, known)
  if (result.kind !== 'lines') throw new Error(result.detail)
  return new Map(result.lines.map(line => [line.userId, line]))
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const strikeout = [strike, strike, strike, close]
const hit = (eventType: 'single' | 'double'): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
  { type: 'result', eventType }
]
/** Session id n is the nth visitor; runner 1 is user 101. */
const home = (runner: number, reason?: 'Wild Pitch'): ScoringAction =>
  reason == null
    ? { type: 'runnerMovement', runner, to: 'home' }
    : {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner, to: 'home' }]
      }

describe('a game scored in GameStation builds stats (U10)', function () {
  it('a single, a run on a double, and a strikeout', function () {
    const plays = scored(
      ...hit('single'),
      close,
      ...hit('double'),
      home(1),
      close,
      ...strikeout
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 1, h: 1, singles: 1, r: 1 })
    expect(got.get(102)).includes({ pa: 1, doubles: 1, rbi: 1, r: 0 })
    expect(got.get(103)).includes({ pa: 1, ab: 1, k: 1 })
    expect(got.get(PITCHER)).includes({
      pitch_bf: 3,
      pitch_outs: 1,
      pitch_h: 2,
      pitch_k: 1,
      pitch_r: 1,
      pitch_er: 1
    })
  })

  it('an error, then a run: unearned, and still batted in', function () {
    const plays = scored(
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_error' },
      { type: 'fieldingPlay', fielders: [F.SS], error: F.SS },
      close,
      ...hit('double'),
      home(1),
      close
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 1, h: 0, r: 1 })
    expect(got.get(102)).includes({ doubles: 1, rbi: 1 })
    expect(got.get(PITCHER)).includes({ pitch_r: 1, pitch_er: 0, pitch_h: 1 })
  })

  it('a walk, a steal, then wild pitches home: a stolen base and an earned run nobody batted in', function () {
    const plays = scored(
      ball,
      ball,
      ball,
      ball,
      close,
      { type: 'baseRunning', kind: 'steal', runner: 1 },
      ball,
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: '3B' }]
      },
      ball,
      home(1, 'Wild Pitch'),
      ...strikeout
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 0, bb: 1, sb: 1, r: 1 })
    expect(got.get(102)).includes({ pa: 1, ab: 1, k: 1, rbi: 0 })
    expect(got.get(PITCHER)).includes({
      pitch_bb: 1,
      pitch_k: 1,
      pitch_r: 1,
      pitch_er: 1
    })
  })
})
