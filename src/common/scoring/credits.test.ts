import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  close,
  F,
  game,
  single,
  strike,
  strikeout,
  walk
} from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { statLines } from './credits'
import type { GamePlay, GameState } from './state'

const out = (
  runner: number,
  to: '1B' | '2B' | '3B' | 'home' | 'batter',
  fielders: number[]
): ScoringAction => ({
  type: 'runnerMovement',
  runner,
  to,
  out: true,
  fielders
})
const groundOut = (fielder: number): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder },
  { type: 'result', eventType: 'field_out', outBy: 'throw' }
]

function credits(play: GamePlay): string[] {
  return play.runners.flatMap(runner =>
    runner.credits.map(credit => `${credit.position} ${credit.credit}`)
  )
}
function last(state: GameState): GamePlay {
  return state.liveData.plays.allPlays[state.liveData.plays.allPlays.length - 1]
}

describe('fielding credits', function () {
  it('credits a 6-4-3 double play: the shortstop and second baseman assist, second and first put out', function () {
    const state = after(
      walk(game()),
      ...groundOut(F.SS),
      out(2, '1B', [F.SS, F['2B'], F['1B']]),
      out(1, '2B', [F.SS, F['2B']]),
      close
    )
    const dp = last(state)
    expect(dp.result.eventType).equals('grounded_into_double_play')
    expect(credits(dp)).deep.equals([
      'SS f_assist',
      '2B f_assist',
      '1B f_putout',
      'SS f_assist',
      '2B f_putout'
    ])
  })

  it('keeps both of the first baseman’s touches on a 3-6-3', function () {
    const state = after(
      walk(game()),
      ...groundOut(F['1B']),
      out(1, '2B', [F['1B'], F.SS]),
      out(2, '1B', [F['1B'], F.SS, F['1B']]),
      close
    )
    const dp = last(state)
    expect(credits(dp)).deep.equals([
      '1B f_assist',
      'SS f_putout',
      '1B f_assist',
      'SS f_assist',
      '1B f_putout'
    ])
  })

  it('credits the fielder who fielded a hit on the batter’s record', function () {
    const state = after(single(game()), close)
    expect(credits(last(state))).deep.equals(['CF f_fielded_ball'])
  })
})

describe('runs batted in', function () {
  it('bats in nobody when an error lets the runner score', function () {
    let state = after(
      game(),
      { type: 'result', eventType: 'triple' },
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_error' }
    )
    expect(state.homeQueue).deep.equals([1])
    state = after(
      state,
      { type: 'fieldingPlay', fielders: [F.SS], error: F.SS },
      { type: 'runnerMovement', runner: 1, to: 'home' },
      close
    )
    const error = last(state)
    expect(state.liveData.linescore.teams.away.runs).equals(1)
    expect(error.result.rbi).equals(0)
    expect(credits(error)).deep.equals([
      'SS f_fielded_ball',
      'SS f_fielding_error'
    ])
  })

  it('makes a caught fly that scores the runner from third a sacrifice fly, batted in and no at-bat', function () {
    const state = after(
      game(),
      { type: 'result', eventType: 'triple' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: F.CF,
        launchAngle: 40,
        location: { x: 0, z: -90 }
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 1, to: 'home' },
      close
    )
    const fly = last(state)
    expect(fly.result.eventType).equals('sac_fly')
    expect(fly.result.rbi).equals(1)
    const lines = statLines(state.liveData.plays.allPlays)
    expect(lines.batting[2]).deep.equals({
      pa: 1,
      ab: 0,
      r: 0,
      h: 0,
      rbi: 1,
      bb: 0,
      k: 0,
      hbp: 0
    })
    expect(lines.batting[1]).includes({ pa: 1, ab: 1, h: 1, r: 1 })
  })

  it('makes a sacrifice fly that also doubles a runner off a sacrifice fly double play', function () {
    const state = after(
      walk(after(game(), { type: 'result', eventType: 'triple' })),
      { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 1, to: 'home' },
      out(2, '1B', [F.CF, F['1B']]),
      close
    )
    expect(last(state).result.eventType).equals('sac_fly_double_play')
  })

  it('names a strikeout that also retires a runner, and triple plays', function () {
    const k = after(
      walk(game()),
      strike,
      strike,
      strike,
      out(1, '2B', [F.C, F.SS]),
      close
    )
    expect(last(k).result.eventType).equals('strikeout_double_play')
    const tp = after(
      walk(walk(game())),
      ...groundOut(F['3B']),
      out(3, '1B', [F['3B'], F['2B'], F['1B']]),
      out(1, '3B', [F['3B']]),
      out(2, '2B', [F['3B'], F['2B']]),
      close
    )
    expect(last(tp).result.eventType).equals('grounded_into_triple_play')
    // Caught on the fly, with both runners doubled off: not a ground ball.
    const liner = after(
      walk(walk(game())),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      out(2, '1B', [F.SS, F['1B']]),
      out(1, '2B', [F.SS]),
      close
    )
    expect(last(liner).result.eventType).equals('triple_play')
  })
})

describe('stat lines', function () {
  it('counts each batter and pitcher from the plays', function () {
    let state = walk(game())
    state = strikeout(state)
    state = after(state, { type: 'result', eventType: 'hit_by_pitch' })
    state = single(state)
    state = after(state, close)
    const { batting, pitching } = statLines(state.liveData.plays.allPlays)
    expect(batting[1]).includes({ pa: 1, ab: 0, bb: 1 })
    expect(batting[2]).includes({ pa: 1, ab: 1, k: 1 })
    expect(batting[3]).includes({ pa: 1, ab: 0, hbp: 1 })
    expect(batting[4]).includes({ pa: 1, ab: 1, h: 1, rbi: 0 })
    expect(pitching[F.P]).deep.equals({
      pitches: 9,
      outs: 1,
      h: 1,
      r: 0,
      bb: 1,
      k: 1
    })
  })

  it('leaves out a play still open and a runner-only play', function () {
    const open = after(game(), { type: 'pitch', call: 'B' })
    const current = open.liveData.plays.currentPlay!
    const lines = statLines([current])
    expect(lines.batting).deep.equals({})
    expect(lines.pitching[F.P].pitches).equals(1)
  })
})

describe('a pinch hitter at two strikes (U25, 9.15(b))', function () {
  const ball: ScoringAction = { type: 'pitch', call: 'B' }
  const bench = (name: string): ScoringAction => ({
    type: 'lineup',
    kind: 'addPlayer',
    player: name === 'Bench One' ? 19 : 20,
    side: 'away',
    name
  })
  const hitsFor = (player: number, replaces: number): ScoringAction => ({
    type: 'lineup',
    kind: 'substitute',
    side: 'away',
    player,
    replaces
  })
  /** Away 1 bats; the bench players are 19 and 20. */
  const lines = (...actions: ScoringAction[]): ReturnType<typeof statLines> =>
    statLines(
      after(game(), bench('Bench One'), bench('Bench Two'), ...actions, close)
        .liveData.plays.allPlays
    )
  const line = (
    got: ReturnType<typeof statLines>,
    id: number
  ): { pa: number; ab: number; k: number; bb: number } | undefined => {
    const batting = got.batting[id]
    return batting == null
      ? undefined
      : { pa: batting.pa, ab: batting.ab, k: batting.k, bb: batting.bb }
  }

  it('charges the strikeout of one sent in at 0-2 to the batter he replaced', function () {
    const got = lines(strike, strike, hitsFor(19, 1), strike)
    expect(line(got, 1)).deep.equals({ pa: 1, ab: 1, k: 1, bb: 0 })
    expect(line(got, 19)).equals(undefined)
    expect(got.pitching[F.P].k).equals(1)
  })

  it('leaves the strikeout of one sent in at 1-1 with him', function () {
    const got = lines(ball, strike, hitsFor(19, 1), strike, strike)
    expect(line(got, 19)).deep.equals({ pa: 1, ab: 1, k: 1, bb: 0 })
    expect(line(got, 1)).equals(undefined)
  })

  it('leaves a walk after he came in at 0-2 with him', function () {
    const got = lines(strike, strike, hitsFor(19, 1), ball, ball, ball, ball)
    expect(line(got, 19)).deep.equals({ pa: 1, ab: 0, k: 0, bb: 1 })
    expect(line(got, 1)).equals(undefined)
  })

  it('charges the man the first sent in at two strikes replaced', function () {
    const second = lines(
      strike,
      hitsFor(19, 1),
      strike,
      hitsFor(20, 19),
      strike
    )
    expect(line(second, 19)).deep.equals({ pa: 1, ab: 1, k: 1, bb: 0 })
    expect(line(second, 1)).equals(undefined)
    expect(line(second, 20)).equals(undefined)
    const first = lines(strike, strike, hitsFor(19, 1), hitsFor(20, 19), strike)
    expect(line(first, 1)).deep.equals({ pa: 1, ab: 1, k: 1, bb: 0 })
    expect(line(first, 19)).equals(undefined)
    expect(line(first, 20)).equals(undefined)
  })
})
