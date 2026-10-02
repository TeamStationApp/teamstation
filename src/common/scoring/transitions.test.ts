import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  ball,
  F,
  game,
  play,
  strike,
  walk
} from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyActions } from './apply'
import { type Transition, TRANSITION_TYPES } from './transitions'

const kinds = (transitions: Transition[]): string[] =>
  transitions.map(transition => transition.type)

describe('transitions', function () {
  it('throws a pitch', function () {
    expect(play(game(), ball).transitions).deep.equals([
      { type: 'pitchThrown', call: 'B', pitcher: F.P }
    ])
  })

  it('walks the batter, forces a runner, and brings up the next batter', function () {
    const applied = play(walk(game()), ball, ball, ball, ball, {
      type: 'gameFlow',
      kind: 'closePlay'
    })
    expect(applied.transitions.slice(3)).deep.equals([
      { type: 'pitchThrown', call: 'B', pitcher: F.P },
      {
        type: 'runnerMoved',
        runner: 2,
        from: 0,
        to: 1,
        pendingHome: false,
        automaticHome: false
      },
      {
        type: 'runnerMoved',
        runner: 1,
        from: 1,
        to: 2,
        pendingHome: false,
        automaticHome: false
      },
      { type: 'playClosed', atBatIndex: 1, eventType: 'walk' },
      { type: 'batterChanged', batter: 3 }
    ])
  })

  it('strikes the batter out', function () {
    const applied = play(game(), strike, strike, strike, {
      type: 'gameFlow',
      kind: 'closePlay'
    })
    expect(kinds(applied.transitions)).deep.equals([
      'pitchThrown',
      'pitchThrown',
      'pitchThrown',
      'outRecorded',
      'playClosed',
      'batterChanged'
    ])
    expect(applied.transitions[3]).deep.equals({
      type: 'outRecorded',
      runner: 1,
      from: 0,
      at: 0,
      outs: 1
    })
  })

  it('sends a runner home pending, then scores him', function () {
    const hit = play(
      walk(walk(game())),
      {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: F.LF
      },
      { type: 'result', eventType: 'double' }
    )
    expect(hit.transitions.slice(-5)).deep.equals(
      [
        { type: 'pitchThrown', call: 'X', pitcher: F.P },
        { type: 'ballFielded', fielder: F.LF },
        {
          type: 'runnerMoved',
          runner: 1,
          from: 2,
          to: 4,
          pendingHome: true,
          automaticHome: false
        },
        {
          type: 'runnerMoved',
          runner: 2,
          from: 1,
          to: 3,
          pendingHome: false,
          automaticHome: false
        },
        {
          type: 'runnerMoved',
          runner: 3,
          from: 0,
          to: 2,
          pendingHome: false,
          automaticHome: false
        }
      ].slice(-5)
    )
    const safe = play(hit.state, {
      type: 'runnerMovement',
      runner: 1,
      to: 'home'
    })
    expect(safe.transitions).deep.equals([
      { type: 'runScored', runner: 1, rbi: true }
    ])
  })

  it('scores every runner on a home run once nobody is waiting', function () {
    const applied = play(walk(game()), {
      type: 'result',
      eventType: 'home_run'
    })
    const moved = applied.transitions.filter(t => t.type === 'runnerMoved')
    expect(moved.every(t => t.automaticHome)).equals(true)
    expect(applied.transitions.filter(t => t.type === 'runScored')).deep.equals(
      [
        { type: 'runScored', runner: 1, rbi: true },
        { type: 'runScored', runner: 2, rbi: true }
      ]
    )
  })

  it('records two outs of a double play in the order they were made, with the throws', function () {
    const applied = play(
      walk(game()),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_out' },
      {
        type: 'runnerMovement',
        runner: 2,
        to: '1B',
        out: true,
        fielders: [F.SS, F['1B']]
      },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '2B',
        out: true,
        fielders: [F.SS, F['2B']]
      }
    )
    const outs = applied.transitions.filter(
      (t): t is Extract<Transition, { type: 'outRecorded' }> =>
        t.type === 'outRecorded'
    )
    expect(outs.map(t => [t.runner, t.outs])).deep.equals([
      [2, 1],
      [1, 2]
    ])
    expect(applied.transitions.filter(t => t.type === 'throwMade')).deep.equals(
      [
        { type: 'throwMade', from: F.SS, to: F['1B'] },
        { type: 'throwMade', from: F.SS, to: F['2B'] }
      ]
    )
  })

  it('ends a half and the game', function () {
    const half = play(game(), { type: 'gameFlow', kind: 'endHalf' })
    expect(half.transitions).deep.equals([
      { type: 'halfEnded', inning: 1, half: 'top' },
      { type: 'batterChanged', batter: 10 }
    ])
    const error = play(
      game(),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_error' },
      { type: 'fieldingPlay', fielders: [F.SS], error: F.SS }
    )
    expect(error.transitions.at(-1)).deep.equals({
      type: 'errorCharged',
      fielder: F.SS
    })
    const back = play(
      after(game(), { type: 'result', eventType: 'double' }),
      { type: 'result', eventType: 'double' },
      { type: 'runnerMovement', runner: 1, to: '3B', reason: 'Back' }
    )
    expect(back.transitions.at(-1)).deep.equals({
      type: 'runnerReturned',
      runner: 1,
      from: 4,
      to: 3
    })
  })

  it('never carries a coordinate or a duration, and names only known types', function () {
    const actions: ScoringAction[] = [
      ball,
      strike,
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 20,
        location: { x: 10, z: -80 },
        fielder: F.CF
      },
      { type: 'result', eventType: 'double' },
      { type: 'result', eventType: 'home_run' },
      { type: 'result', eventType: 'hit_by_pitch' },
      { type: 'baseRunning', kind: 'steal', runner: 3, to: '2B' },
      { type: 'batteryEvent', kind: 'balk' },
      { type: 'gameFlow', kind: 'endHalf' },
      { type: 'gameFlow', kind: 'endGame' }
    ]
    const applied = applyActions(game(), actions)
    expect(applied.problems).deep.equals([])
    const seen = new Set<string>()
    for (const transition of applied.transitions) {
      seen.add(transition.type)
      expect(TRANSITION_TYPES).to.include(transition.type)
      for (const [key, value] of Object.entries(transition)) {
        expect(['x', 'z', 'point', 'durationMs', 'ms']).not.to.include(key)
        expect(typeof value === 'object' && value != null, key).equals(false)
      }
    }
    expect(seen.size).greaterThan(6)
  })
})
