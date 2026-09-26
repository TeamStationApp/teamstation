import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  ball,
  bases,
  close,
  F,
  game,
  outs,
  play,
  runs,
  single,
  strike,
  strikeout,
  walk
} from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import type { GameState } from './state'

const move = (
  runner: number,
  to: 'batter' | '1B' | '2B' | '3B' | 'home',
  extra: Partial<Extract<ScoringAction, { type: 'runnerMovement' }>> = {}
): ScoringAction => ({ type: 'runnerMovement', runner, to, ...extra })
const out = (
  runner: number,
  to: 'batter' | '1B' | '2B' | '3B' | 'home',
  fielders: number[],
  reason?: Extract<ScoringAction, { type: 'runnerMovement' }>['reason']
): ScoringAction => ({
  type: 'runnerMovement',
  runner,
  to,
  out: true,
  fielders,
  ...(reason == null ? {} : { reason })
})
const result = (
  eventType: Extract<ScoringAction, { type: 'result' }>['eventType'],
  extra: Partial<Extract<ScoringAction, { type: 'result' }>> = {}
): ScoringAction => ({ type: 'result', eventType, ...extra })

function twoOuts(state: GameState): GameState {
  return strikeout(strikeout(state))
}

describe('runners on a hit', function () {
  it('forces the runner on first to second on a single', function () {
    const state = single(walk(game()))
    expect(bases(state)).deep.equals([2, 1, null])
    const records = state.liveData.plays.currentPlay!.runners
    expect(records.map(r => [r.details.runner.id, r.movement.end])).deep.equals(
      [
        [1, 2],
        [2, 1]
      ]
    )
  })

  it('sends a runner home on a double and waits to hear whether he was safe', function () {
    let state = after(walk(walk(game())), result('double'))
    expect(state.homeQueue).deep.equals([1])
    expect(bases(state)).deep.equals([null, 3, 2])
    state = after(state, move(1, 'home'))
    expect(runs(state)).equals(1)
    expect(state.homeQueue).deep.equals([])
    const scored = state.liveData.plays.currentPlay!
    expect(scored.result.rbi).equals(1)
    expect(scored.runners.at(-1)!.details.movementReason).equals('Safe at home')
  })

  it('puts the lead runner out at home with the fielders who made the play', function () {
    let state = after(walk(walk(game())), result('double'))
    state = after(state, out(1, 'home', [F.CF, F.SS, F.C]))
    expect(outs(state)).equals(1)
    expect(runs(state)).equals(0)
    const record = state.liveData.plays.currentPlay!.runners.at(-1)!
    expect(record.movement).includes({ isOut: true, end: 4, forceOut: false })
    expect(record.credits.map(c => [c.player.id, c.credit])).deep.equals([
      [F.CF, 'f_assist'],
      [F.SS, 'f_assist'],
      [F.C, 'f_putout']
    ])
  })

  it('sends the lead runner back to third, and refuses when the runners behind him cannot give ground', function () {
    const onSecond = after(game(), result('double'))
    let state = after(onSecond, result('double'))
    expect(state.homeQueue).deep.equals([1])
    expect(applyAction(state, move(2, '3B')).problems[0].message).equals(
      'Decide the runner headed home first'
    )
    state = after(state, move(1, '3B', { reason: 'Back' }))
    expect(bases(state)).deep.equals([null, 2, 1])
    expect(state.homeQueue).deep.equals([])
    const blocked = after(walk(walk(game())), result('double'))
    expect(applyAction(blocked, move(1, '3B')).problems[0].message).equals(
      'The runners behind him cannot give ground'
    )
  })

  it('refuses to send back a runner who was forced', function () {
    let state = walk(walk(walk(game())))
    state = after(state, result('single'))
    expect(state.homeQueue).deep.equals([1])
    expect(applyAction(state, move(1, '3B')).problems[0].message).equals(
      'The runners behind him cannot give ground'
    )
  })

  it('only decides the lead runner headed home', function () {
    let state = after(walk(walk(game())), result('triple'))
    expect(state.homeQueue).deep.equals([1, 2])
    expect(applyAction(state, move(2, 'home')).problems[0].message).equals(
      'Decide the lead runner headed home first'
    )
    state = after(state, move(1, 'home'), move(2, 'home'))
    expect(runs(state)).equals(2)
  })
})

describe('outs and the third out', function () {
  it('ends the half when a runner is thrown out at third with two outs', function () {
    let state = twoOuts(single(game()))
    expect(outs(state)).equals(2)
    state = after(state, {
      type: 'baseRunning',
      kind: 'caught_stealing',
      runner: 1,
      to: '3B',
      fielders: [F.C, F['3B']]
    })
    expect(state.liveData.linescore.isTopInning).equals(false)
    const last = state.liveData.plays.allPlays.at(-1)!
    expect(last.result).includes({
      event: 'Runner out',
      eventType: 'caught_stealing_3b'
    })
  })

  it('lets a run stand that crossed before a third out that was no force', function () {
    let state = twoOuts(walk(walk(walk(game()))))
    expect(bases(state)).deep.equals([3, 2, 1])
    state = after(state, result('double'))
    expect(state.homeQueue).deep.equals([1, 2])
    state = after(
      state,
      move(1, 'home'),
      out(2, 'home', [F.CF, F.SS, F.C]),
      close
    )
    expect(runs(state)).equals(1)
    expect(state.liveData.linescore.isTopInning).equals(false)
    expect(state.liveData.plays.allPlays.at(-1)!.result.rbi).equals(1)
  })

  it('makes a forced third out at home score nothing and bat in nobody', function () {
    let state = twoOuts(walk(walk(walk(game()))))
    state = after(state, result('single'))
    expect(state.homeQueue).deep.equals([1])
    state = after(state, out(1, 'home', [F.LF, F.C]), close)
    expect(runs(state)).equals(0)
    const closed = state.liveData.plays.allPlays.at(-1)!
    expect(
      closed.runners.find(r => r.movement.isOut)!.movement.forceOut
    ).equals(true)
    expect(closed.result.rbi).equals(0)
  })

  it('discards a run the play counted before a forced third out', function () {
    let state = twoOuts(walk(walk(walk(game()))))
    state = after(state, result('single'))
    // A run the play already counted, as a correction during it would have.
    state.liveData.linescore.teams.away.runs += 1
    state.liveData.plays.currentPlay!.result.rbi = 1
    const applied = play(state, out(1, 'home', [F.LF, F.C]))
    expect(applied.state.liveData.linescore.teams.away.runs).equals(0)
    expect(
      applied.transitions.find(t => t.type === 'runsTakenBack')
    ).deep.equals({ type: 'runsTakenBack', runs: 1 })
    expect(applied.state.liveData.plays.allPlays.at(-1)!.result.rbi).equals(0)
  })

  it('credits a rundown to each fielder once', function () {
    let state = after(single(game()), close)
    state = after(state, {
      type: 'runnerMovement',
      runner: 1,
      to: '2B',
      out: true,
      reason: 'Caught Stealing',
      fielders: [F.C, F.SS, F['1B'], F.SS, F['1B']],
      locations: [
        { x: 0, z: 0 },
        { x: 1, z: -40 },
        { x: 20, z: -20 }
      ],
      runnerLocation: { x: 10, z: -30 }
    })
    const record = state.liveData.plays.currentPlay!.runners.at(-1)!
    expect(outs(state)).equals(1)
    expect(record.credits.map(c => [c.player.id, c.credit])).deep.equals([
      [F.C, 'f_assist'],
      [F.SS, 'f_assist'],
      [F['1B'], 'f_assist'],
      [F['1B'], 'f_putout']
    ])
    const action =
      state.liveData.plays.currentPlay!.source.gamestation.runnerActions!.at(
        -1
      )!
    expect(action.defensiveRoute).length(5)
    expect(action.throwerLocation).deep.equals({ x: 0, z: 0 })
    expect(action.defenderLocation).deep.equals({ x: 10, z: -30 })
  })
})

describe('the batter on a ball in play', function () {
  it('waits for the throw that puts the batter out', function () {
    let state = after(
      game(),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      result('field_out')
    )
    expect(outs(state)).equals(0)
    expect(applyAction(state, move(1, '1B')).problems[0].message).equals(
      'Say who put the batter out'
    )
    state = after(state, out(1, '1B', [F.SS, F['1B']]), close)
    expect(outs(state)).equals(1)
    const thrown = state.liveData.plays.allPlays[0]
    expect(thrown.runners[0].movement).includes({ forceOut: true, end: 1 })
    expect(thrown.result.event).equals('Throw Out')
  })

  it("gives the batter and the runners their bases on a fielder's choice", function () {
    let state = after(walk(game()), result('fielders_choice'))
    state = after(state, out(1, '2B', [F.SS, F['2B']]))
    expect(outs(state)).equals(1)
    state = after(state, move(2, '1B'))
    expect(bases(state)).deep.equals([2, null, null])
    const records = state.liveData.plays.currentPlay!.runners
    expect(records.at(-1)!.details.movementReason).equals("Fielder's Choice")
    expect(records.find(r => r.movement.isOut)!.movement.forceOut).equals(true)
  })

  it("keeps a runner behind the batter's base during the choice", function () {
    let state = after(walk(game()), result('fielders_choice'))
    expect(applyAction(state, move(2, 'batter')).problems[0].message).equals(
      'The batter must reach a base to be safe.'
    )
    state = after(state, move(2, '2B'))
    expect(applyAction(state, move(1, '2B')).problems[0].message).equals(
      'Choose a base ahead of the trailing runners.'
    )
    state = after(state, move(1, '3B'))
    expect(bases(state)).deep.equals([null, 2, 1])
  })

  it('lets the batter run on strike three not caught', function () {
    let state = after(game(), strike, strike, result('strikeout'))
    expect(state.liveData.linescore.strikes).equals(3)
    state = after(state, move(1, '1B'), close)
    expect(bases(state)).deep.equals([1, null, null])
    const play = state.liveData.plays.allPlays[0]
    expect(play.result).includes({ event: 'Strikeout', eventType: 'strikeout' })
    // Strike three the catcher dropped is a strike, not a ball in play.
    expect(play.playEvents.at(-1)!.details).deep.includes({
      code: 'S',
      isInPlay: false
    })
  })

  it('stands the batter on first after a dropped third strike until his call', function () {
    const dropped = after(game(), strike, strike, result('strikeout'))
    expect(bases(dropped)).deep.equals([1, null, null])
    expect(dropped.liveData.plays.currentPlay!.runners).deep.equals([])
    const safe = after(dropped, move(1, '1B'))
    const reached = safe.liveData.plays.currentPlay!.runners
    expect(reached.map(runner => runner.details.movementReason)).deep.equals([
      'Dropped Third Strike'
    ])
    const thrown = after(dropped, out(1, '1B', [F.C]))
    expect(outs(thrown)).equals(1)
    expect(bases(thrown)).deep.equals([null, null, null])
    const retired = thrown.liveData.plays.currentPlay!.runners[0]
    expect(retired.movement).includes({ start: 0, isOut: true, forceOut: true })
    expect(retired.details.movementReason).equals('Dropped Third Strike')
    expect(retired.credits.map(credit => credit.credit)).deep.equals([
      'f_putout'
    ])
  })

  it('forces every runner on a dropped third strike with the bases loaded, and bats nobody in', function () {
    const loaded = walk(walk(walk(twoOuts(game()))))
    expect(bases(loaded)).deep.equals([5, 4, 3])
    const dropped = after(loaded, strike, strike, result('strikeout'))
    expect(bases(dropped)).deep.equals([6, 5, 4])
    expect(dropped.homeQueue).deep.equals([3])
    const scored = after(dropped, move(3, 'home'))
    expect(runs(scored)).equals(1)
    expect(scored.liveData.plays.currentPlay!.result.rbi).equals(0)
  })

  it('turns a 6-4-3 with the lead runner forced at second before the batter', function () {
    let state = after(
      walk(game()),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      result('field_out', { outBy: 'throw' })
    )
    state = after(state, out(1, '2B', [F.SS, F['2B']], 'Force Out'))
    expect(outs(state)).equals(1)
    expect(bases(state)).deep.equals([null, null, null])
    state = after(state, out(2, '1B', [F['2B'], F['1B']]), close)
    const play = state.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('grounded_into_double_play')
    expect(
      play.runners.map(runner => [
        runner.details.runner.id,
        runner.movement.outNumber,
        runner.movement.forceOut,
        runner.credits.map(credit => `${credit.credit} ${credit.player.id}`)
      ])
    ).deep.equals([
      [1, 1, true, [`f_assist ${F.SS}`, `f_putout ${F['2B']}`]],
      [2, 2, true, [`f_assist ${F['2B']}`, `f_putout ${F['1B']}`]]
    ])
  })

  it('forces only a runner with every base behind him taken, while the batter runs', function () {
    const twoOn = after(
      walk(walk(game())),
      { type: 'ballInPlay', contact: 'swing', fielder: F['3B'] },
      result('field_out', { outBy: 'throw' })
    )
    const atThird = after(twoOn, out(1, '3B', [F['3B']], 'Force Out'))
    expect(
      atThird.liveData.plays.currentPlay!.runners[0].movement.forceOut
    ).equals(true)
    // Once the runner behind him is out, the lead runner must be tagged.
    expect(bases(twoOn)).deep.equals([2, 1, null])
    const afterForce = after(
      twoOn,
      out(2, '2B', [F['3B'], F['2B']], 'Force Out')
    )
    expect(
      afterForce.liveData.plays.currentPlay!.runners.at(-1)!.movement.forceOut
    ).equals(true)
    const tag = after(afterForce, out(1, '3B', [F['2B'], F['3B']]))
    expect(
      tag.liveData.plays.currentPlay!.runners.at(-1)!.movement.forceOut
    ).equals(false)
    const secondAndThird = after(
      walk(game()),
      move(1, '2B', { reason: 'Steal' }),
      { type: 'ballInPlay', contact: 'swing', fielder: F['3B'] },
      result('field_out', { outBy: 'throw' })
    )
    const tagged = after(secondAndThird, out(1, '3B', [F['3B']]))
    expect(
      tagged.liveData.plays.currentPlay!.runners.at(-1)!.movement.forceOut
    ).equals(false)
  })

  it('puts the batter out another way', function () {
    let state = after(game(), result('other_out'))
    state = after(state, out(1, 'batter', [F.C]), close)
    expect(outs(state)).equals(1)
    expect(state.liveData.plays.allPlays[0].result.eventType).equals(
      'other_out'
    )
  })

  it('charges an error to one of the fielders who handled the ball', function () {
    let state = after(
      walk(game()),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      result('field_error')
    )
    expect(bases(state)).deep.equals([2, 1, null])
    expect(state.liveData.linescore.teams.away.hits).equals(0)
    expect(applyAction(state, move(2, '2B')).problems[0].message).equals(
      'Charge the error first'
    )
    expect(
      applyAction(state, {
        type: 'fieldingPlay',
        fielders: [F.SS],
        error: F['2B']
      }).problems[0].message
    ).equals('The fielder charged must have handled the ball')
    expect(
      applyAction(state, { type: 'fieldingPlay', fielders: [3], error: 3 })
        .problems[0].message
    ).equals('That player is not in the field')
    state = after(state, {
      type: 'fieldingPlay',
      fielders: [F.SS, F['1B']],
      error: F['1B'],
      errorKind: 'throwing',
      locations: [{ x: 1, z: -30 }]
    })
    expect(state.liveData.linescore.teams.home.errors).equals(1)
    const credit =
      state.liveData.plays.currentPlay!.source.gamestation.errorCredit!
    expect(credit.player.id).equals(F['1B'])
    expect(credit.defensiveRoute.map(hop => hop.location)).deep.equals([
      { x: 1, z: -30 },
      { x: 0, z: 0 }
    ])
    expect(
      applyAction(state, {
        type: 'fieldingPlay',
        fielders: [F.SS],
        error: F.SS
      }).problems[0].message
    ).equals('No error is waiting to be charged')
  })
})

describe('runners between pitches', function () {
  it('steals, and records a runner action on the play', function () {
    let state = after(single(game()), close)
    state = after(state, { type: 'baseRunning', kind: 'steal', runner: 1 })
    expect(bases(state)).deep.equals([null, 1, null])
    const current = state.liveData.plays.currentPlay!
    expect(current.playEvents.at(-1)!).deep.include({ type: 'action' })
    expect(current.runners.at(-1)!.details.movementReason).equals('Steal')
  })

  it('scores a runner who steals home, and is safe from a pickoff attempt', function () {
    let state = after(single(game()), close)
    state = after(state, {
      type: 'baseRunning',
      kind: 'pickoff_safe',
      runner: 1
    })
    expect(
      state.liveData.plays.currentPlay!.runners.at(-1)!.details.movementReason
    ).equals('Safe from Pickoff')
    state = after(state, {
      type: 'baseRunning',
      kind: 'defensive_indifference',
      runner: 1,
      to: 'home'
    })
    expect(runs(state)).equals(1)
  })

  it('picks a runner off for the third out and names the base', function () {
    let state = twoOuts(single(game()))
    state = after(state, {
      type: 'baseRunning',
      kind: 'pickoff',
      runner: 1,
      fielders: [F.P, F['1B']]
    })
    expect(state.liveData.plays.allPlays.at(-1)!.result.eventType).equals(
      'pickoff_1b'
    )
    expect(state.liveData.linescore.isTopInning).equals(false)
  })

  it('calls an out made another way between pitches an other out', function () {
    let state = twoOuts(single(game()))
    state = after(state, out(1, '1B', [F.P, F['1B']], 'Out on Appeal'))
    expect(state.liveData.plays.allPlays.at(-1)!.result.eventType).equals(
      'other_out'
    )
  })

  it('refuses a runner going backwards, passing another, or a runner not on base', function () {
    const state = after(walk(walk(game())), ball)
    expect(applyAction(state, move(1, '1B')).problems[0].message).equals(
      'A runner cannot go back'
    )
    expect(applyAction(state, move(2, '3B')).problems[0].message).equals(
      'Move the lead runner first; runners cannot pass each other.'
    )
    expect(applyAction(state, move(2, '2B')).problems[0].message).equals(
      'That base is occupied. Move the lead runner first.'
    )
    expect(applyAction(state, move(9, '2B')).problems[0].code).equals(
      'unknownPlayer'
    )
    expect(applyAction(state, move(3, '1B')).problems[0].message).equals(
      'The batter is not running'
    )
    expect(
      applyAction(state, { type: 'baseRunning', kind: 'steal', runner: 9 })
        .problems[0].code
    ).equals('unknownPlayer')
  })

  it('refuses a steal, or any advance, to the base the runner is on (QA 32)', function () {
    const state = after(walk(walk(game())), ball)
    const refused = (action: ScoringAction): string | undefined =>
      applyAction(state, action).problems[0]?.message
    for (const kind of [
      'steal',
      'caught_stealing',
      'defensive_indifference'
    ] as const)
      expect(
        refused({ type: 'baseRunning', kind, runner: 1, to: '2B' }),
        kind
      ).equals('That runner is already on 2B')
    for (const reason of ['Advance', 'Steal', 'Wild Pitch', 'Other'] as const)
      expect(refused(move(2, '1B', { reason })), reason).equals(
        'That runner is already on 1B'
      )
    expect(
      refused({
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: '2B' }]
      })
    ).equals('That runner is already on 2B')
    // Staying put is being safe on a pickoff, said or not.
    for (const action of [
      move(1, '2B'),
      move(1, '2B', { reason: 'Safe from Pickoff' }),
      { type: 'baseRunning', kind: 'pickoff_safe', runner: 1 } as const
    ])
      expect(refused(action), JSON.stringify(action)).equals(undefined)
  })

  it('advances runners on a wild pitch charged to the last pitch', function () {
    let state = after(single(game()), close, ball)
    state = after(state, {
      type: 'batteryEvent',
      kind: 'wild_pitch',
      advances: [{ runner: 1, to: '2B' }]
    })
    const action =
      state.liveData.plays.currentPlay!.source.gamestation.runnerActions!.at(
        -1
      )!
    expect(action.reason).equals('Wild Pitch')
    expect(action.pitchReference).deep.equals({ atBatIndex: 1, index: 0 })
    expect(
      state.liveData.plays.currentPlay!.playEvents.at(-1)!.details.code
    ).equals('wild_pitch')
    const passed = after(state, strike, {
      type: 'batteryEvent',
      kind: 'passed_ball',
      advances: [{ runner: 1, to: '3B' }]
    })
    expect(bases(passed)).deep.equals([null, null, 1])
    expect(
      applyAction(after(state, { type: 'pitch', call: 'F' }), {
        type: 'batteryEvent',
        kind: 'passed_ball'
      }).problems[0].message
    ).equals('Record an eligible pitch first')
    expect(
      applyAction(after(state, ball), {
        type: 'batteryEvent',
        kind: 'passed_ball'
      }).problems[0].message
    ).equals('Say where each runner went')
  })

  it('moves every runner up a base on a balk without ending the appearance', function () {
    let state = after(walk(walk(walk(game()))), ball)
    expect(bases(state)).deep.equals([3, 2, 1])
    // The balk scores the runner from third and keeps the count.
    state = after(state, { type: 'batteryEvent', kind: 'balk' })
    expect(bases(state)).deep.equals([null, 3, 2])
    expect(runs(state)).equals(1)
    expect(state.pending).equals(null)
    expect(state.liveData.linescore.balls).equals(1)
    const current = state.liveData.plays.currentPlay!
    expect(current.result.rbi).equals(0)
    expect(current.runners.at(-1)!.details.movementReason).equals('Balk')
    expect(
      applyAction(after(game()), { type: 'batteryEvent', kind: 'balk' })
        .problems[0].message
    ).equals('No runners on base')
  })

  it('places a tiebreaker runner', function () {
    const state = after(game(), {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 9,
      base: '2B'
    })
    expect(bases(state)).deep.equals([null, 9, null])
    expect(
      state.liveData.plays.currentPlay!.runners[0].details.movementReason
    ).equals('Place a Runner (Tiebreaker)')
    const bad: ScoringAction[] = [
      { type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' },
      { type: 'gameFlow', kind: 'placeRunner', runner: 1, base: '1B' },
      { type: 'gameFlow', kind: 'placeRunner', runner: 12, base: '1B' },
      { type: 'gameFlow', kind: 'placeRunner', runner: 9 }
    ]
    for (const action of bad)
      expect(applyAction(state, action).problems[0].code).equals('illegal')
  })
})

describe('closing and ending', function () {
  it('ends a half by hand and refuses to close an undecided play', function () {
    const state = after(game(), { type: 'gameFlow', kind: 'endHalf' })
    expect(state.liveData.linescore.isTopInning).equals(false)
    expect(
      applyAction(after(game(), result('field_out')), close).problems[0].message
    ).equals('The play is not decided yet')
    expect(
      applyAction(after(game(), result('field_out')), {
        type: 'gameFlow',
        kind: 'endHalf'
      }).problems[0].message
    ).equals('Finish the current play first')
  })

  it('ends the game between at-bats and then takes nothing more', function () {
    const ended = play(game(), { type: 'gameFlow', kind: 'endGame' })
    expect(ended.state.final).equals(true)
    expect(ended.transitions).deep.equals([{ type: 'gameEnded' }])
    expect(applyAction(ended.state, ball).problems[0].code).equals('gameOver')
    expect(
      applyAction(after(game(), ball), { type: 'gameFlow', kind: 'endGame' })
        .problems[0].message
    ).equals('Finish the at-bat first')
  })

  it('keeps a game going while the lineup changed during the at-bat', function () {
    const switched = after(strikeout(game()), {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'L'
    })
    expect(
      applyAction(switched, { type: 'gameFlow', kind: 'endGame' }).problems[0]
        .message
    ).equals('Finish the at-bat first')
    const added = after(strikeout(game()), {
      type: 'lineup',
      kind: 'addPlayer',
      side: 'away',
      name: 'Late Arrival'
    })
    expect(
      applyAction(added, { type: 'gameFlow', kind: 'endGame' }).problems[0]
        .message
    ).equals('Finish the at-bat first')
  })

  it('closes a decided play before ending the game', function () {
    const state = after(single(game()), { type: 'gameFlow', kind: 'endGame' })
    expect(state.final).equals(true)
    expect(state.liveData.plays.allPlays).length(1)
  })

  it('moves a runner after the play is decided and before it closes', function () {
    let state = single(game())
    expect(applyAction(state, move(1, '1B')).problems[0].message).equals(
      'The runner is already there'
    )
    state = after(state, move(1, '2B'))
    expect(bases(state)).deep.equals([null, 1, null])
    expect(
      state.liveData.plays.currentPlay!.runners.at(-1)!.details.movementReason
    ).equals('Advance')
    state = after(state, out(1, '3B', [F.LF, F['3B']]))
    expect(outs(state)).equals(1)
  })
})
