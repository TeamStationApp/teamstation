import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { Position } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { fieldingLocation } from '../field/fieldingLocation'
import { BASES, createPlayers } from '../field/fieldModel'
import {
  continueDoublePlay,
  DOUBLE_PLAYS,
  doublePlayChoices,
  type DoublePlayKind,
  doublePlayPositions,
  doublePlayRows,
  startDoublePlay
} from './doublePlay'
import { gameFixture } from './isUnscoredGame.test'
import { moreEligibility } from './moreActions'
import { chainBackError, chainOutError } from './runnerChain'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

const GROUND = DOUBLE_PLAYS.filter(kind => kind !== 'caught')

/** A fresh game with runners on the bases `mask` names (1st = 1) and `outs`. */
function initial(mask = 0, outs = 0, presentations = false): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture), presentations)
  for (const [i, key] of (['first', 'second', 'third'] as const).entries())
    if ((mask & (1 << i)) !== 0)
      state.session.liveData.linescore.offense[key] = playerRef(
        state.session,
        i + 2
      )
  state.session.liveData.linescore.outs = outs
  return state
}

/** Where `position`'s fielder stands at the start of a play. */
function standing(position: Position): { x: number; z: number } {
  return createPlayers().find(player => player.id === position)!.position
}

describe('Double Play in More', function () {
  it('offers its rows for every base mask at 0, 1 and 2 outs', function () {
    for (const outs of [0, 1, 2])
      for (let mask = 0; mask < 8; mask++) {
        const choices = doublePlayChoices(initial(mask, outs))
        const expected =
          outs === 2 || mask === 0
            ? []
            : (mask & 1) !== 0
              ? [...DOUBLE_PLAYS]
              : ['caught']
        expect(choices, `mask ${mask}, ${outs} out`).deep.equals(expected)
        expect(
          moreEligibility(initial(mask, outs), 'Double Play'),
          `mask ${mask}, ${outs} out`
        ).equals(
          expected.length === 0
            ? 'Requires fewer than two outs and a runner on base'
            : undefined
        )
      }
  })
  it('offers nothing while the play is not settled, the game is over or nobody bats', function () {
    const busy = { ...initial(1), phase: 'trajectory' as const }
    expect(doublePlayChoices(busy)).deep.equals([])
    expect(moreEligibility(busy, 'Double Play')).equals(
      'Finish the current play first'
    )
    const gesture = { ...initial(1), activeGesture: true }
    expect(doublePlayChoices(gesture)).deep.equals([])
    const final = initial(1)
    final.session.final = true
    expect(doublePlayChoices(final)).deep.equals([])
    const nobody = initial(1)
    nobody.session.liveData.linescore.offense.batter = null
    expect(doublePlayChoices(nobody)).deep.equals([])
  })
  it('labels Caught out "Did not tag" and the ground rows by their numbers', function () {
    expect(doublePlayRows(initial(2))).deep.equals([
      { key: 'caught', label: 'Caught out', subtext: 'Did not tag' }
    ])
    expect(doublePlayRows(initial(1)).map(row => row.label)).deep.equals([
      ...GROUND,
      'Caught out'
    ])
    expect(doublePlayPositions('6-4-3')).deep.equals(['SS', '2B', '1B'])
    expect(doublePlayPositions('1-4-3')).deep.equals(['P', '2B', '1B'])
    expect(doublePlayPositions('caught')).deep.equals([])
  })
  for (const kind of GROUND)
    it(`starts a ${kind} with its fielder at his position and the trajectory to drag`, function () {
      const before = initial(1)
      const position = doublePlayPositions(kind)[0]
      const fielder = before.session.liveData.linescore.defense[position]!.id
      const started = scoringReducer(before, {
        type: 'MORE',
        input: { action: 'Double Play', doublePlay: kind }
      })
      expect(started.phase).equals('trajectory')
      expect(started.pendingPlay).deep.equals({
        outcome: 'Ground Out',
        contactKind: 'swing',
        trajectoryAccepted: false,
        doublePlay: { kind },
        fielder,
        location: fieldingLocation('Ground Out', standing(position)),
        angle: 45
      })
      expect(started.log.slice(before.log.length)).deep.equals([
        { type: 'ballInPlay', contact: 'swing' }
      ])
      expect(started.past.at(-1)?.label).equals(`Double Play ${kind}`)
      // One Undo step takes the whole start back.
      const undone = scoringReducer(started, { type: 'UNDO' })
      expect(undone.phase).equals('ready')
      expect(undone.pendingPlay == null).equals(true)
      expect(undone.session).deep.equals(before.session)
    })
  it('assumes a stand-in at an empty position', function () {
    const state = initial(1)
    state.session.liveData.linescore.defense.SS = null
    const started = startDoublePlay(state, '6-4-3')
    expect(started.pendingPlay?.fielder).equals('SS')
    expect(started.pendingPlay?.location).deep.equals(
      fieldingLocation('Ground Out', standing('SS'))
    )
  })
  it('records the trajectory as a hand-scored Ground Out to the same fielder does', function () {
    const before = initial(1)
    const started = startDoublePlay(before, '6-4-3')
    const pending = started.pendingPlay!
    const viaMenu = scoringReducer(started, {
      type: 'TRAJECTORY',
      angle: 5,
      generation: started.generation,
      dragged: true
    })
    let byHand = scoringReducer(before, {
      type: 'OUTCOME',
      outcome: 'Ground Out'
    })
    byHand = scoringReducer(byHand, {
      type: 'FIELDER',
      id: pending.fielder!,
      point: pending.location!,
      generation: byHand.generation
    })
    byHand = scoringReducer(byHand, {
      type: 'TRAJECTORY',
      angle: 5,
      generation: byHand.generation,
      dragged: true
    })
    // The menu then plays the relay on; the trajectory's actions match.
    expect(viaMenu.log.slice(before.log.length, byHand.log.length)).deep.equals(
      byHand.log.slice(before.log.length)
    )
    // Undo from the trajectory returns to it, then to `ready`.
    const back = scoringReducer(viaMenu, { type: 'UNDO' })
    expect(back.phase).equals('trajectory')
    expect(scoringReducer(back, { type: 'UNDO' }).phase).equals('ready')
  })
  it('starts Caught out as a Ball Caught whose fielder the scorer places', function () {
    const before = initial(4)
    const started = scoringReducer(before, {
      type: 'MORE',
      input: { action: 'Double Play', doublePlay: 'caught' }
    })
    expect(started.phase).equals('locateFielder')
    expect(started.pendingPlay).deep.equals({
      outcome: 'Ball Caught',
      contactKind: 'swing',
      trajectoryAccepted: false,
      doublePlay: { kind: 'caught' }
    })
    expect(started.past.at(-1)?.label).equals('Double Play: caught out')
    expect(scoringReducer(started, { type: 'UNDO' }).phase).equals('ready')
  })
  it('refuses a kind the bases do not allow, or none at all', function () {
    const second = initial(2)
    expect(startDoublePlay(second, '6-4-3')).equals(second)
    expect(
      scoringReducer(second, { type: 'MORE', input: { action: 'Double Play' } })
    ).equals(second)
    const twoOuts = initial(1, 2)
    expect(startDoublePlay(twoOuts, 'caught')).equals(twoOuts)
  })
})

/** Who plays `position` in the fixture's defense. */
function at(state: ScoringState, position: Position): number {
  return state.session.liveData.linescore.defense[position]!.id
}

/**
 * Plays every presentation through to its end, then every motion; `assumed`
 * when no step may stop for the scorer to pick a defender.
 */
function played(state: ScoringState, assumed = true): ScoringState {
  for (let count = 0; count < 20 && state.presentation != null; count++) {
    const sequence = state.presentation
    state =
      sequence.kind === 'hit' && sequence.stage === 'swing'
        ? scoringReducer(state, {
            type: 'PRESENTATION_CONTACT',
            id: sequence.id,
            generation: state.generation
          })
        : scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: sequence.id,
            generation: state.generation,
            stage: sequence.stage
          })
    // The relay is assumed: it never waits on the scorer for a defender.
    if (assumed && state.presentation == null)
      expect(state.phase).not.equals('chooseDefender')
  }
  return completeMotions(state)
}

/** The menu's `kind` from `before`, its trajectory dragged to 5°. */
function menuPlay(
  before: ScoringState,
  kind: DoublePlayKind = '6-4-3'
): ScoringState {
  const started = scoringReducer(before, {
    type: 'MORE',
    input: { action: 'Double Play', doublePlay: kind }
  })
  return played(
    scoringReducer(started, {
      type: 'TRAJECTORY',
      angle: 5,
      generation: started.generation,
      dragged: true
    })
  )
}

/** The same play scored by hand: Ground Out, fielder, trajectory, relay. */
function handPlay(before: ScoringState, kind: DoublePlayKind): ScoringState {
  const [fielded, pivot] = doublePlayPositions(kind)
  const started = startDoublePlay(before, kind)
  const step = (
    state: ScoringState,
    event: Parameters<typeof scoringReducer>[1]
  ): ScoringState => played(scoringReducer(state, event), false)
  let state = step(before, { type: 'OUTCOME', outcome: 'Ground Out' })
  state = step(state, {
    type: 'FIELDER',
    id: at(before, fielded),
    point: started.pendingPlay!.location!,
    generation: state.generation
  })
  state = step(state, {
    type: 'TRAJECTORY',
    angle: 5,
    generation: state.generation,
    dragged: true
  })
  state = step(state, {
    type: 'DEFENDER',
    id: at(before, pivot),
    point: { ...BASES[2] },
    generation: state.generation
  })
  state = step(state, {
    type: 'RUNNER_DROP',
    id: before.session.liveData.linescore.offense.first!.id,
    to: 2,
    decision: 'out',
    generation: state.generation
  })
  state = step(state, {
    type: 'DEFENDER',
    id: at(before, '1B'),
    point: { ...BASES[1] },
    generation: state.generation
  })
  return step(state, { type: 'DEFENDER', generation: state.generation })
}

/** Each scored runner of the last play: who, why, which out, credits. */
function credits(state: ScoringState): unknown[] {
  return state.session.liveData.plays.allPlays
    .at(-1)!
    .runners.map(runner => [
      runner.details.runner.id,
      runner.details.movementReason,
      runner.movement.outNumber,
      runner.credits.map(credit => `${credit.credit} ${credit.player?.id}`)
    ])
}

const decide = (
  state: ScoringState,
  id: number,
  decision: 'safe' | 'out' | 'back'
): ScoringState =>
  completeMotions(
    scoringReducer(state, {
      type: 'CHAIN_DECIDE',
      id,
      decision,
      generation: state.generation
    })
  )

const bases = (state: ScoringState): Array<number | undefined> => {
  const offense = state.session.liveData.linescore.offense
  return [offense.first?.id, offense.second?.id, offense.third?.id]
}

describe('a ground double play from the menu', function () {
  for (const kind of GROUND)
    for (const presentations of [false, true])
      it(`plays out ${kind} after the trajectory, presentations ${presentations ? 'on' : 'off'}`, function () {
        const before = initial(1, 0, presentations)
        const played = menuPlay(before, kind)
        // Both outs, the bases empty and the play closed with no window.
        expect(played.session.liveData.linescore.outs).equals(2)
        expect(bases(played)).deep.equals([undefined, undefined, undefined])
        expect(played.phase).equals('ready')
        expect(played.correctionWindow).equals(null)
        expect(played.session.pending).equals(null)
        // The same actions and credits as the scorer's hand relay.
        const byHand = handPlay(initial(1, 0, presentations), kind)
        expect(played.log.slice(before.log.length)).deep.equals(
          byHand.log.slice(before.log.length)
        )
        expect(credits(played)).deep.equals(credits(byHand))
        const [fielded, pivot] = doublePlayPositions(kind).map(position =>
          at(before, position)
        )
        const runner = before.session.liveData.linescore.offense.first!.id
        const batter =
          before.session.liveData.plays.currentPlay!.matchup.batter.id
        expect(credits(played)).deep.equals([
          [
            runner,
            'Force Out',
            1,
            [`f_assist ${fielded}`, `f_putout ${pivot}`]
          ],
          [
            batter,
            'Ground Out',
            2,
            [`f_assist ${pivot}`, `f_putout ${at(before, '1B')}`]
          ]
        ])
        expect(
          played.session.liveData.plays.allPlays.at(-1)!.result.eventType
        ).equals('grounded_into_double_play')
      })
  it('throws to 2nd only once the hit has been drawn', function () {
    const before = initial(1, 0, true)
    const started = startDoublePlay(before, '6-4-3')
    let state = scoringReducer(started, {
      type: 'TRAJECTORY',
      angle: 5,
      generation: started.generation,
      dragged: true
    })
    expect(state.presentation?.kind).equals('hit')
    expect(state.session.liveData.linescore.outs).equals(0)
    const hit = state.presentation!
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: hit.id,
      generation: state.generation
    })
    state = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: hit.id,
      generation: state.generation,
      stage: 'flight'
    })
    expect(state.presentation).includes({
      kind: 'throw',
      thrower: at(before, 'SS'),
      receiver: at(before, '2B')
    })
    // Nothing more happens until that throw has been drawn.
    expect(state.session.liveData.linescore.outs).equals(0)
    expect(state.past.at(-1)?.label).equals('5° Ground Ball')
  })
  it('routes 3-6-3 and 1-6-3 through the first baseman and the pitcher', function () {
    const before = initial(1)
    for (const [kind, route] of [
      ['3-6-3', ['1B', 'SS', '1B']],
      ['1-6-3', ['P', 'SS', '1B']]
    ] as const) {
      const outs = menuPlay(before, kind)
        .log.slice(before.log.length)
        .filter(action => action.type === 'runnerMovement')
      expect(
        outs.map(action => action.type === 'runnerMovement' && action.fielders)
      ).deep.equals([
        [at(before, route[0]), at(before, route[1])],
        [at(before, route[1]), at(before, route[2])]
      ])
    }
  })
  it('ends the inning at the force with one out, asking about nobody', function () {
    const before = initial(5, 1)
    const played = menuPlay(before)
    expect(played.runnerChain).equals(undefined)
    expect(played.session.liveData.linescore.outs).equals(0)
    expect(played.session.liveData.linescore.isTopInning).equals(false)
    expect(played.session.liveData.linescore.teams.away.runs).equals(0)
    expect(played.phase).not.equals('chainDecision')
  })
  it('takes the whole relay back with the trajectory, then the menu choice', function () {
    const before = initial(1)
    const played = menuPlay(before)
    expect(played.past.map(step => step.label)).deep.equals([
      'Double Play 6-4-3',
      '5° Ground Ball'
    ])
    const once = scoringReducer(played, { type: 'UNDO' })
    expect(once.phase).equals('trajectory')
    expect(once.session.liveData.linescore.outs).equals(0)
    const twice = scoringReducer(once, { type: 'UNDO' })
    expect(twice.phase).equals('ready')
    expect(twice.session).deep.equals(before.session)
  })
  it('does nothing for a play the menu did not start, or a caught out', function () {
    const state = initial(1)
    continueDoublePlay(state)
    expect(state).deep.equals(initial(1))
    const caught = startDoublePlay(initial(1), 'caught')
    const copy = structuredClone(caught)
    continueDoublePlay(caught)
    expect(caught).deep.equals(copy)
  })
})

describe('the runners a ground double play leaves', function () {
  it('asks the runner from 2nd, now on 3rd, with Back open at once', function () {
    const played = menuPlay(initial(3))
    expect(played.phase).equals('chainDecision')
    expect(played.correctionWindow).equals(null)
    expect(played.runnerChain).deep.equals({
      pushed: [{ playerId: 3, from: 2, to: 3 }]
    })
    expect(chainBackError(played, 3)).equals(undefined)
    // No timer while he is asked.
    const ticked = scoringReducer(played, {
      type: 'TIMER_TICK',
      elapsedMs: 1000
    })
    expect(ticked.correctionWindow ?? null).equals(null)
    const back = decide(played, 3, 'back')
    expect(bases(back)).deep.equals([undefined, 3, undefined])
    expect(back.session.liveData.linescore.outs).equals(2)
    expect(back.phase).equals('correctionWindow')
    expect(back.correctionWindow?.remainingMs).equals(5000)
    const safe = decide(played, 3, 'safe')
    expect(bases(safe)).deep.equals([undefined, undefined, 3])
    expect(safe.phase).equals('correctionWindow')
  })
  it('puts him out at 3rd with the hand drag’s Out, from the ball’s holder', function () {
    const played = menuPlay(initial(3))
    let out = decide(played, 3, 'out')
    expect(out.phase).equals('chooseDefender')
    expect(out.runnerAction).includes({ thrower: at(played, '1B'), to: 3 })
    out = completeMotions(
      scoringReducer(out, {
        type: 'DEFENDER',
        id: at(played, '3B'),
        point: { ...BASES[3] },
        generation: out.generation
      })
    )
    out = completeMotions(
      scoringReducer(out, { type: 'DEFENDER', generation: out.generation })
    )
    // The third out ends the half.
    expect(out.session.liveData.linescore.isTopInning).equals(false)
    expect(out.runnerChain).equals(undefined)
  })
  it('lets the runner from 3rd, with nobody behind him, score or go back', function () {
    const played = menuPlay(initial(5))
    expect(played.phase).equals('chainDecision')
    expect(played.runnerChain?.pushed).deep.equals([
      { playerId: 4, from: 3, to: 4 }
    ])
    expect(chainBackError(played, 4)).equals(undefined)
    const back = decide(played, 4, 'back')
    expect(bases(back)).deep.equals([undefined, undefined, 4])
    expect(back.session.liveData.linescore.teams.away.runs).equals(0)
    expect(back.phase).equals('correctionWindow')
    const safe = decide(played, 4, 'safe')
    expect(safe.session.liveData.linescore.teams.away.runs).equals(1)
    // The bases are empty: the play closes with no window.
    expect(safe.phase).equals('ready')
  })
  it('asks both runners with the bases loaded; home goes Back only once 3rd is Out', function () {
    const played = menuPlay(initial(7))
    expect(played.runnerChain?.pushed).deep.equals([
      { playerId: 3, from: 2, to: 3 },
      { playerId: 4, from: 3, to: 4 }
    ])
    expect(chainBackError(played, 3)).equals(undefined)
    expect(chainBackError(played, 4)).equals(
      'He can go back only once the runner behind him is out.'
    )
    expect(decide(played, 4, 'back')).equals(completeMotions(played))
    // A Back behind him does not open it.
    const third = decide(played, 3, 'back')
    expect(third.phase).equals('chainDecision')
    expect(chainBackError(third, 4)).not.equals(undefined)
    const scored = decide(third, 4, 'safe')
    expect(bases(scored)).deep.equals([undefined, 3, undefined])
    expect(scored.session.liveData.linescore.teams.away.runs).equals(1)
    expect(scored.phase).equals('correctionWindow')
    expect(scored.correctionWindow?.remainingMs).equals(5000)
    // Undo: the last answer, the one before, then the relay, then the menu.
    expect(scored.past.map(step => step.label)).deep.equals([
      'Double Play 6-4-3',
      '5° Ground Ball',
      'Back Player 3',
      'Safe Player 4'
    ])
    const one = scoringReducer(scored, { type: 'UNDO' })
    expect(one.phase).equals('chainDecision')
    expect(one.runnerChain?.pushed[0].decision).equals('back')
    expect(one.runnerChain?.pushed[1].decision).equals(undefined)
    const two = scoringReducer(one, { type: 'UNDO' })
    expect(
      two.runnerChain?.pushed.every(runner => runner.decision == null)
    ).equals(true)
    const three = scoringReducer(two, { type: 'UNDO' })
    expect(three.phase).equals('trajectory')
    expect(three.runnerChain).equals(undefined)
    expect(scoringReducer(three, { type: 'UNDO' }).phase).equals('ready')
  })
  it('calls the runner from 2nd out only once the runner headed home has answered', function () {
    const played = menuPlay(initial(7))
    expect(chainOutError(played, 3)).equals(
      'Decide the runner headed home first'
    )
    expect(chainOutError(played, 4)).equals(undefined)
    expect(decide(played, 3, 'out')).equals(completeMotions(played))
    const scored = decide(played, 4, 'safe')
    expect(chainOutError(scored, 3)).equals(undefined)
    let out = decide(scored, 3, 'out')
    expect(out.runnerAction).includes({ thrower: at(played, '1B'), to: 3 })
    out = completeMotions(
      scoringReducer(out, {
        type: 'DEFENDER',
        id: at(played, '3B'),
        point: { ...BASES[3] },
        generation: out.generation
      })
    )
    out = completeMotions(
      scoringReducer(out, { type: 'DEFENDER', generation: out.generation })
    )
    // That Out is the third: the half ends.
    expect(out.session.liveData.linescore.isTopInning).equals(false)
    expect(out.runnerChain).equals(undefined)
  })
})
