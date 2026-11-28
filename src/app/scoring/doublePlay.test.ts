import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { Position } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { fieldingLocation } from '../field/fieldingLocation'
import { createPlayers } from '../field/fieldModel'
import {
  DOUBLE_PLAYS,
  doublePlayChoices,
  doublePlayPositions,
  doublePlayRows,
  startDoublePlay
} from './doublePlay'
import { gameFixture } from './isUnscoredGame.test'
import { moreEligibility } from './moreActions'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

const GROUND = DOUBLE_PLAYS.filter(kind => kind !== 'caught')

/** A fresh game with runners on the bases `mask` names (1st = 1) and `outs`. */
function initial(mask = 0, outs = 0): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture))
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
    expect(viaMenu.log.slice(before.log.length)).deep.equals(
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
