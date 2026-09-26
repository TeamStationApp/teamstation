import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  ball,
  bases,
  close,
  closed,
  F,
  game,
  runs,
  single,
  strike,
  strikeout,
  walk
} from '../../test/scoringGames'
import type { GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { earnsRbi } from './earnedRuns'
import { foldPlay, replayPlays } from './gumbo'
import { playerRef } from './lineup'
import { type EventStore, ScoringSession, type StoredGame } from './session'
import {
  asGameState,
  copyState,
  type GamePlay,
  type GameState,
  setupOf
} from './state'

type Runner = GamePlay['runners'][number]
type RunnerTo = 'batter' | '1B' | '2B' | '3B' | 'home'

const move = (
  runner: number,
  to: RunnerTo,
  extra: Partial<Extract<ScoringAction, { type: 'runnerMovement' }>> = {}
): ScoringAction => ({ type: 'runnerMovement', runner, to, ...extra })
const out = (runner: number, to: RunnerTo, fielders: number[]): ScoringAction =>
  move(runner, to, { out: true, fielders })
const result = (
  eventType: Extract<ScoringAction, { type: 'result' }>['eventType'],
  extra: Partial<Extract<ScoringAction, { type: 'result' }>> = {}
): ScoringAction => ({ type: 'result', eventType, ...extra })
const hit = (
  eventType: 'single' | 'double' | 'triple' | 'home_run',
  fielder: number = F.CF
): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder },
  result(eventType)
]
const reachOnError = (fielder: number = F.SS): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder },
  result('field_error'),
  { type: 'fieldingPlay', fielders: [fielder], error: fielder }
]
const flyOut: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
  result('field_out', { outBy: 'catch' })
]
/** The shortstop goes to the mound; the starter, 10, leaves it. */
const relief: ScoringAction = {
  type: 'lineup',
  kind: 'position',
  side: 'home',
  position: 'P',
  player: F.SS
}
const RELIEVER = F.SS
const STARTER = F.P

/** Every runner entry of every play, the current one last. */
function entries(state: GameState): Runner[] {
  const plays = [
    ...state.liveData.plays.allPlays,
    ...(state.liveData.plays.currentPlay == null
      ? []
      : [state.liveData.plays.currentPlay])
  ]
  return plays.flatMap(play => play.runners)
}
/** The entry of the run the runner scored. */
function scored(state: GameState, runner: number): Runner['details'] {
  const entry = entries(state).find(
    r => r.details.runner.id === runner && r.movement.runScored === true
  )
  expect(entry, `run by ${runner}`).not.equals(undefined)
  return entry!.details
}
/** The pitcher each base's runner is charged to. */
function charged(state: GameState): Array<number | null> {
  const charges = state.liveData.linescore.offense.responsiblePitcher
  return (['first', 'second', 'third'] as const).map(
    key => charges?.[key]?.id ?? null
  )
}
function lastPlay(state: GameState): GamePlay {
  return state.liveData.plays.allPlays.at(-1)!
}
function pitches(state: GameState, calls: string): GameState {
  return after(
    state,
    ...calls.split('').map((call): ScoringAction => ({
      type: 'pitch',
      call: call as 'B' | 'C'
    }))
  )
}

describe('the responsible pitcher (U5)', function () {
  it('keeps a runner charged to the starter after a pitching change', function () {
    let state = after(single(game()), close, relief)
    expect(state.liveData.linescore.defense.P!.id).equals(RELIEVER)
    expect(charged(state)).deep.equals([STARTER, null, null])
    state = after(state, ...hit('double'), move(1, 'home'))
    expect(scored(state, 1).responsiblePitcher!.id).equals(STARTER)
    expect(charged(state)).deep.equals([null, RELIEVER, null])
    const batter = state.liveData.plays.currentPlay!.runners.find(
      r => r.details.runner.id === 2
    )!
    expect(batter.details.responsiblePitcher!.id).equals(RELIEVER)
  })

  it('charges a walk after a change with the batter ahead to the previous pitcher (9.16(h))', function () {
    // The count when the reliever came in, and the pitches that walk him.
    const cases: Array<[string, string, number]> = [
      ['BB', 'BB', STARTER],
      ['BBC', 'BB', STARTER],
      ['BBB', 'B', STARTER],
      ['BBBC', 'B', STARTER],
      ['BBBCC', 'B', STARTER],
      ['', 'BBBB', RELIEVER],
      ['B', 'BBB', RELIEVER],
      ['BCC', 'BBB', RELIEVER],
      ['BBCC', 'BB', RELIEVER],
      ['BC', 'BBB', RELIEVER]
    ]
    for (const [before, rest, pitcher] of cases) {
      let state = after(pitches(game(), before), relief)
      state = closed(pitches(state, rest))
      const walked = lastPlay(state)
      expect(walked.result.eventType, before).equals('walk')
      expect(walked.matchup.pitcher.id).equals(RELIEVER)
      expect(charged(state), before).deep.equals([pitcher, null, null])
      expect(walked.runners[0].details.responsiblePitcher!.id).equals(pitcher)
    }
  })

  it('charges an intentional walk after a 3-1 change to the previous pitcher', function () {
    let state = after(pitches(game(), 'BBBC'), relief, result('intent_walk'))
    expect(charged(state)).deep.equals([STARTER, null, null])
    state = after(pitches(game(), 'BCC'), relief, result('intent_walk'))
    expect(charged(state)).deep.equals([RELIEVER, null, null])
  })

  it('passes the walk back through two changes in one count', function () {
    const second: ScoringAction = {
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position: 'P',
      player: F['3B']
    }
    const state = closed(
      pitches(after(pitches(game(), 'BB'), relief, ball, second), 'BB')
    )
    expect(charged(state)).deep.equals([STARTER, null, null])
  })

  it("gives the batter the charge of the runner forced out on a fielder's choice (9.16(g))", function () {
    const onFirst = after(single(game()), close, relief)
    const choice = after(onFirst, result('fielders_choice'))
    for (const order of [
      [out(1, '2B', [F['3B'], F['2B']]), move(2, '1B')],
      [move(2, '1B'), out(1, '2B', [F['3B'], F['2B']])]
    ]) {
      const state = after(choice, ...order)
      expect(bases(state)).deep.equals([2, null, null])
      expect(charged(state)).deep.equals([STARTER, null, null])
      const batter = state.liveData.plays.currentPlay!.runners.find(
        r => r.details.runner.id === 2
      )!
      expect(batter.details.responsiblePitcher!.id).equals(STARTER)
      // He keeps the charge after the play closes.
      expect(charged(after(state, close))).deep.equals([STARTER, null, null])
    }
    // With nobody put out, the batter is the reliever's.
    const hitAfter = after(onFirst, ...hit('single'))
    expect(charged(hitAfter)).deep.equals([RELIEVER, STARTER, null])
  })

  it("charges the placed runner to the half's first pitcher", function () {
    const state = after(game(), relief, {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 9,
      base: '2B'
    })
    expect(charged(state)).deep.equals([null, STARTER, null])
    expect(state.liveData.linescore.offense.reachedOnError!.second).equals(true)
  })

  it('charges a runner placed by hand or by an override to the pitcher on the mound', function () {
    const byHand = game()
    byHand.liveData.linescore.offense.first = playerRef(byHand, 5)
    let state = after(byHand, relief)
    expect(charged(state)).deep.equals([STARTER, null, null])
    state = after(state, {
      type: 'gameFlow',
      kind: 'override',
      pitcher: F['3B'],
      bases: [5, 6, null]
    })
    expect(charged(state)).deep.equals([STARTER, F['3B'], null])
    // A new half by override starts the charges again.
    state = after(state, {
      type: 'gameFlow',
      kind: 'override',
      inning: 2,
      top: true,
      batter: 1,
      pitcher: F['2B'],
      bases: [5, null, null]
    })
    expect(charged(state)).deep.equals([F['2B'], null, null])
    expect(state.liveData.linescore.errorlessOuts).deep.equals({
      team: 0,
      pitchers: [{ pitcher: playerRef(state, F['2B']), outs: 0 }]
    })
  })

  it('restores the charges on undo', async function () {
    const store: EventStore = {
      load: async (): Promise<StoredGame> => ({ plays: [], currentPlay: null }),
      save: async (): Promise<StoredGame> => ({ plays: [], currentPlay: null })
    }
    const session = ScoringSession.start(store, 'g1', game(), {
      setTimer: () => null,
      clearTimer: () => undefined
    })
    for (const action of [...hit('single'), close, ball, relief])
      session.apply(action)
    for (const action of [ball, ball, ball, close]) session.apply(action)
    expect(charged(session.state)).deep.equals([RELIEVER, STARTER, null])
    for (let i = 0; i < 5; i++) session.undo()
    expect(charged(session.state)).deep.equals([STARTER, null, null])
    expect(session.state.liveData.linescore.defense.P!.id).equals(STARTER)
    expect(session.state.liveData.linescore.errorlessOuts!.pitchers).length(1)
    for (const action of [ball, ball, ball, close]) session.apply(action)
    expect(charged(session.state)).deep.equals([STARTER, STARTER, null])
  })

  it('replays a stored game, and cleans a game with or without the charges', function () {
    const actions = [
      ...hit('single'),
      close,
      relief,
      ball,
      ball,
      ball,
      ball,
      close,
      ...hit('double')
    ]
    const live = after(game(), ...actions)
    // Stored as the plays were before this change: a setup and actions.
    const setupBefore = setupOf(game())
    const stored = {
      plays: [] as GumboPlay[],
      currentPlay: {
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: false
        },
        gameStation: { version: 1, setupBefore, actions }
      } as unknown as StoredGame['currentPlay']
    }
    const replayed = replayPlays(stored, {
      gamePk: 'g1',
      teams: { away: live.gameData.teams.away, home: live.gameData.teams.home },
      setup: setupBefore
    })
    expect(replayed.problems).deep.equals([])
    expect(replayed.state.liveData.linescore).deep.equals(
      live.liveData.linescore
    )
    expect(replayed.state.pending).deep.equals(live.pending)
    const kept = copyState(live)
    expect(kept.liveData.linescore.errorlessOuts!.pitchers).length(2)
    expect(kept.pending!.charges).not.equals(undefined)
    expect(asGameState(copyState(kept))).deep.equals(kept)
    // A game kept before the charges existed cleans, and plays on.
    const old = copyState(live)
    delete old.liveData.linescore.errorlessOuts
    delete old.liveData.linescore.offense.responsiblePitcher
    delete old.liveData.linescore.offense.reachedOnError
    delete old.pending!.charges
    for (const play of old.liveData.plays.allPlays)
      for (const runner of play.runners) {
        delete runner.details.responsiblePitcher
        delete runner.details.earned
        delete runner.details.teamUnearned
        delete runner.details.rbi
      }
    expect(asGameState(copyState(old))).deep.equals(old)
    const onward = applyAction(old, move(1, 'home'))
    expect(onward.problems).deep.equals([])
    expect(runs(onward.state)).equals(1)
  })

  it('keeps the new facts out of the stored play until the document says them', function () {
    const state = after(game(), ...reachOnError(), close, ...hit('home_run'))
    const play = state.liveData.plays.currentPlay!
    expect(play.runners.some(r => r.details.earned === true)).equals(true)
    const stored = foldPlay(state, play, {
      setupBefore: setupOf(game()),
      actions: []
    })
    for (const runner of stored.runners ?? [])
      expect(Object.keys(runner.details ?? {}).sort()).deep.equals([
        'movementReason',
        'runner'
      ])
    expect(JSON.stringify(stored.gameStation)).not.contains('errorlessOuts')
  })
})

describe('earned runs (U6)', function () {
  it('makes a run unearned when the runner reached on an error, and the home run earned', function () {
    const state = after(game(), ...reachOnError(), close, ...hit('home_run'))
    expect(runs(state)).equals(2)
    expect(scored(state, 1)).includes({ earned: false, teamUnearned: true })
    expect(scored(state, 2)).includes({ earned: true, teamUnearned: false })
  })

  it('makes a run unearned on catcher’s interference or a dropped third strike on a passed ball', function () {
    let state = after(game(), result('catcher_interference'), close)
    state = after(state, ...hit('home_run'))
    expect(scored(state, 1)).includes({ earned: false, teamUnearned: true })
    expect(state.liveData.linescore.errorlessOuts!.team).equals(1)
    state = after(
      game(),
      strike,
      strike,
      result('strikeout'),
      move(1, '1B', { reason: 'Passed Ball' }),
      close,
      ...hit('home_run')
    )
    expect(scored(state, 1)).includes({ earned: false, teamUnearned: true })
    expect(state.liveData.linescore.errorlessOuts!.team).equals(1)
    // Reaching on strike three the catcher missed with no error is earned.
    state = after(
      game(),
      strike,
      strike,
      result('strikeout'),
      move(1, '1B'),
      close,
      ...hit('home_run')
    )
    expect(scored(state, 1)).includes({ earned: true, teamUnearned: false })
  })

  it('makes the placed runner’s run unearned', function () {
    const state = after(
      game(),
      { type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' },
      ...hit('home_run')
    )
    expect(scored(state, 9)).includes({ earned: false, teamUnearned: true })
    expect(scored(state, 1)).includes({ earned: true, teamUnearned: false })
  })

  it('makes a run unearned after the would-be third out', function () {
    const inning = (second: ScoringAction[]): GameState => {
      let state = strikeout(game())
      state = after(state, ...second, close)
      state = after(state, ...flyOut, close)
      state = walk(state)
      return after(state, ...hit('home_run'))
    }
    const withError = inning(reachOnError())
    expect(runs(withError)).equals(3)
    expect(withError.liveData.linescore.errorlessOuts!.team).equals(3)
    for (const runner of [2, 4, 5])
      expect(scored(withError, runner), `${runner}`).includes({
        earned: false,
        teamUnearned: true
      })
    const clean = inning(hit('single'))
    for (const runner of [2, 4, 5])
      expect(scored(clean, runner), `${runner}`).includes({
        earned: true,
        teamUnearned: false
      })
  })

  it('makes a run scoring on a passed ball unearned, and on a wild pitch earned', function () {
    const onThird = after(game(), ...hit('triple'), close, ball)
    for (const [kind, earned] of [
      ['passed_ball', false],
      ['wild_pitch', true]
    ] as const) {
      const state = after(onThird, {
        type: 'batteryEvent',
        kind,
        advances: [{ runner: 1, to: 'home' }]
      })
      expect(runs(state)).equals(1)
      expect(scored(state, 1), kind).includes({
        earned,
        teamUnearned: !earned,
        rbi: false
      })
    }
  })

  it('makes both runs unearned after two out and an error, and a reliever’s run earned to him only', function () {
    const twoOutError = after(
      strikeout(strikeout(game())),
      ...reachOnError(),
      close
    )
    const starter = after(twoOutError, ...hit('home_run'))
    expect(runs(starter)).equals(2)
    for (const runner of [3, 4])
      expect(scored(starter, runner), `${runner}`).includes({
        earned: false,
        teamUnearned: true
      })
    expect(scored(starter, 4).responsiblePitcher!.id).equals(STARTER)
    const reliever = after(twoOutError, relief, ...hit('home_run'))
    expect(scored(reliever, 3)).includes({ earned: false, teamUnearned: true })
    expect(scored(reliever, 3).responsiblePitcher!.id).equals(STARTER)
    expect(scored(reliever, 4)).includes({ earned: true, teamUnearned: true })
    expect(scored(reliever, 4).responsiblePitcher!.id).equals(RELIEVER)
    expect(reliever.liveData.linescore.errorlessOuts!.pitchers).deep.equals([
      { pitcher: playerRef(reliever, STARTER), outs: 3 },
      {
        pitcher: playerRef(reliever, RELIEVER),
        outs: 2,
        relieved: {
          pitcher: playerRef(reliever, STARTER),
          atBatIndex: 3,
          balls: 0,
          strikes: 0
        }
      }
    ])
  })

  it('counts one would-be out when the batter who reached on an error is put out on the same play', function () {
    const safe = after(game(), ...reachOnError())
    expect(safe.liveData.linescore.errorlessOuts!.team).equals(1)
    const thrownOut = after(safe, out(1, '2B', [F.CF, F['2B']]))
    expect(thrownOut.liveData.linescore.outs).equals(1)
    expect(thrownOut.liveData.linescore.errorlessOuts!.team).equals(1)
    expect(thrownOut.liveData.linescore.errorlessOuts!.pitchers[0].outs).equals(
      1
    )
    // Any other runner put out on that play is an out of his own.
    const onFirst = after(single(game()), close)
    const both = after(
      onFirst,
      ...reachOnError(),
      out(1, '3B', [F.CF, F['3B']])
    )
    expect(both.liveData.linescore.errorlessOuts!.team).equals(2)
  })

  it('counts a runner kept safe by an error only through the play’s error, as the engine records it', function () {
    // A dropped throw on a force at second is scored as the batter reaching
    // on the error: one would-be out for the play, the runner safe at second.
    const onFirst = after(single(game()), close)
    const dropped = after(onFirst, ...reachOnError(F['2B']))
    expect(bases(dropped)).deep.equals([2, 1, null])
    expect(dropped.liveData.linescore.errorlessOuts!.team).equals(1)
    const errorRunners = dropped.liveData.plays.currentPlay!.runners.filter(r =>
      r.credits.some(c => c.credit === 'f_fielding_error')
    )
    expect(errorRunners.map(r => r.details.runner.id)).deep.equals([2])
    // An extra base taken on a throwing error says nothing of an out saved:
    // it adds no would-be out, and a run it scores is unearned.
    const extra = after(
      onFirst,
      ...hit('single'),
      move(1, 'home', { reason: 'Throwing Error' })
    )
    expect(extra.liveData.linescore.errorlessOuts!.team).equals(0)
    expect(scored(extra, 1)).includes({ earned: false, teamUnearned: true })
  })

  it('counts the outs a corrected half already had', function () {
    let state = after(game(), {
      type: 'gameFlow',
      kind: 'override',
      outs: 2
    })
    expect(state.liveData.linescore.errorlessOuts!.team).equals(2)
    state = after(state, ...reachOnError(), close, ...hit('home_run'))
    expect(scored(state, 2)).includes({ earned: false, teamUnearned: true })
    // Taking an out back by hand takes it back from every count.
    state = after(game(), ...reachOnError(), close, {
      type: 'gameFlow',
      kind: 'override',
      outs: 0
    })
    expect(state.liveData.linescore.errorlessOuts!.team).equals(1)
  })
})

describe('runs batted in (U7)', function () {
  it('bats in the run on a sacrifice fly', function () {
    const state = after(
      game(),
      ...hit('triple'),
      close,
      ...flyOut,
      move(1, 'home'),
      close
    )
    const fly = lastPlay(state)
    expect(fly.result.eventType).equals('sac_fly')
    expect(scored(state, 1).rbi).equals(true)
    expect(fly.result.rbi).equals(1)
  })

  it('bats in the run on a bases-loaded walk, hit batsman or catcher’s interference', function () {
    const loaded = walk(walk(walk(game())))
    expect(bases(loaded)).deep.equals([3, 2, 1])
    const walked = walk(loaded)
    expect(scored(walked, 1).rbi).equals(true)
    expect(lastPlay(walked).result.rbi).equals(1)
    for (const type of ['hit_by_pitch', 'catcher_interference'] as const) {
      const state = after(loaded, result(type), close)
      expect(scored(state, 1).rbi, type).equals(true)
      expect(lastPlay(state).result.rbi, type).equals(1)
    }
  })

  it('bats in nobody on a ground ball into a double play, though the run counts', function () {
    const firstAndThird = walk(after(game(), ...hit('triple'), close))
    expect(bases(firstAndThird)).deep.equals([2, null, 1])
    const groundBall: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      result('field_out', { outBy: 'throw' })
    ]
    const dp = after(
      firstAndThird,
      ...groundBall,
      out(2, '2B', [F.SS, F['2B']]),
      out(3, '1B', [F.SS, F['2B'], F['1B']]),
      move(1, 'home'),
      close
    )
    expect(runs(dp)).equals(1)
    const gidp = lastPlay(dp)
    expect(gidp.result.eventType).equals('grounded_into_double_play')
    expect(gidp.result.rbi).equals(0)
    expect(scored(dp, 1).rbi).equals(false)
    // The same ground ball with one out made bats the run in.
    const groundOut = after(
      firstAndThird,
      ...groundBall,
      out(3, '1B', [F.SS, F['1B']]),
      move(1, 'home'),
      close
    )
    expect(lastPlay(groundOut).result.eventType).equals('field_out')
    expect(lastPlay(groundOut).result.rbi).equals(1)
  })

  it('bats in nobody on a wild pitch or an error', function () {
    const wild = after(game(), ...hit('triple'), close, ball, {
      type: 'batteryEvent',
      kind: 'wild_pitch',
      advances: [{ runner: 1, to: 'home' }]
    })
    expect(scored(wild, 1).rbi).equals(false)
    expect(wild.liveData.plays.currentPlay!.result.rbi).equals(0)
    const error = after(
      game(),
      ...hit('triple'),
      close,
      ...reachOnError(),
      move(1, 'home'),
      close
    )
    expect(scored(error, 1)).includes({ rbi: false, earned: false })
    expect(lastPlay(error).result.rbi).equals(0)
    // A runner the scorer sends home on a throwing error is not batted in.
    const thrown = after(
      game(),
      ...hit('triple'),
      close,
      ...hit('single'),
      move(1, 'home', { reason: 'Throwing Error' })
    )
    expect(scored(thrown, 1)).includes({ rbi: false, earned: false })
  })

  it('says which plays and reasons bat a run in', function () {
    expect(earnsRbi('Single', 'Safe at home')).equals(true)
    expect(earnsRbi('Walk', 'Walk')).equals(true)
    expect(earnsRbi('Error', 'Safe at home')).equals(false)
    expect(earnsRbi('Balk', 'Balk')).equals(false)
    expect(earnsRbi('Dropped Third Strike', 'Safe at home')).equals(false)
    expect(earnsRbi('Ball Caught', 'Advance')).equals(true)
    expect(earnsRbi('Ball Caught', 'Wild Pitch')).equals(false)
    expect(earnsRbi(undefined, 'Advance')).equals(false)
    expect(earnsRbi(undefined, 'Steal')).equals(false)
  })

  it('counts result.rbi from the runner flags on every play of the engine-to-stats games', function () {
    const steal: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 1
    }
    const games = [
      // Single, a run on a double, strikeout.
      after(
        single(game()),
        close,
        ...hit('double'),
        move(1, 'home'),
        close,
        strike,
        strike,
        strike,
        close
      ),
      // An error, then a run.
      after(
        game(),
        ...reachOnError(),
        close,
        ...hit('double'),
        move(1, 'home'),
        close
      ),
      // A steal, then a wild pitch.
      after(single(game()), close, steal, ball, {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: '3B' }]
      })
    ]
    let checked = 0
    for (const state of games)
      for (const play of [
        ...state.liveData.plays.allPlays,
        state.liveData.plays.currentPlay
      ]) {
        if (play == null) continue
        expect(play.result.rbi).equals(
          play.runners.filter(r => r.details.rbi === true).length
        )
        checked++
      }
    expect(checked).equals(9)
    expect(scored(games[0], 1)).includes({ rbi: true, earned: true })
    expect(scored(games[1], 1)).includes({ rbi: true, earned: false })
  })
})
