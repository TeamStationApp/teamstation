import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { BallInPlayAction } from '../../common/scoring/actions'
import type { Position } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { BASES } from '../field/fieldModel'
import { allowedAngle, startingAngle, trajectoryLabel } from './battedBall'
import { gameFixture } from './isUnscoredGame.test'
import { type Outcome, outcomeEvents } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { FielderRef, ScoringState } from './scoringTypes'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(scoringSession(gameFixture))
describe('batted-ball draft', function () {
  for (const outcome of Object.keys(outcomeEvents) as Outcome[])
    it(`records ${outcome} once and stores the fielder and accepted trajectory`, function () {
      const start = initial()
      if (outcome === "Fielder's Choice")
        start.session.liveData.linescore.offense.first = playerRef(
          start.session,
          2
        )
      const chosen = scoringReducer(start, { type: 'OUTCOME', outcome })
      const pitcher =
        chosen.session.liveData.plays.currentPlay!.matchup.pitcher.id
      expect(
        chosen.session.liveData.boxscore.teams.home.pitchCounts[pitcher]
      ).equals(1)
      expect(scoringReducer(chosen, { type: 'OUTCOME', outcome })).equals(
        chosen
      )
      const located = scoringReducer(chosen, {
        ...(outcome === 'Home Run'
          ? { type: 'LANDING' as const }
          : { type: 'FIELDER' as const, id: pitcher }),
        point: { x: 22, z: -30 },
        generation: 0
      })
      expect(located.phase).equals('trajectory')
      expect(located.session.liveData.linescore.defense).deep.equals(
        start.session.liveData.linescore.defense
      )
      const accepted = scoringReducer(located, {
        type: 'TRAJECTORY',
        angle: -45,
        generation: 0
      })
      expect(
        accepted.session.liveData.plays.currentPlay!.hitData?.launchAngle
      ).equals(outcome === 'Ball Caught' ? 10 : -45)
      expect(
        accepted.session.liveData.plays.currentPlay!.hitData?.coordinates
      ).deep.equals({ x: 22, z: -30 })
      expect(accepted.past.length).equals(3)
      expect(
        accepted.session.liveData.plays.currentPlay!.playEvents.filter(
          event => event.isPitch
        ).length
      ).equals(1)
      const undone = scoringReducer(accepted, { type: 'UNDO' })
      expect(undone.phase).equals('trajectory')
      expect(
        scoringReducer(undone, { type: 'TRAJECTORY', angle: 30, generation: 0 })
      ).equals(undone)
      expect(
        scoringReducer(scoringReducer(undone, { type: 'UNDO' }), {
          type: 'UNDO'
        }).session
      ).deep.equals(start.session)
    })
  it('ignores stale, foreign and non-finite placements and classifies the rounded angle boundaries', function () {
    const chosen = scoringReducer(initial(), {
      type: 'OUTCOME',
      outcome: 'Single'
    })
    for (const event of [
      { type: 'FIELDER' as const, id: 1, point: { x: 1, z: 1 }, generation: 0 },
      {
        type: 'FIELDER' as const,
        id: 10,
        point: { x: NaN, z: 1 },
        generation: 0
      },
      {
        type: 'FIELDER' as const,
        id: 10,
        point: { x: 1, z: 1 },
        generation: 1
      },
      { type: 'TRAJECTORY' as const, angle: 45, generation: 0 }
    ])
      expect(scoringReducer(chosen, event)).equals(chosen)
    expect(
      [-45, -26, -25, 9, 10, 34, 35, 47, 48, 70].map(trajectoryLabel)
    ).deep.equals([
      'Chopper',
      'Chopper',
      'Ground Ball',
      'Ground Ball',
      'Line Drive',
      'Line Drive',
      'Fly Ball',
      'Fly Ball',
      'Pop Fly',
      'Pop Fly'
    ])
    expect(allowedAngle(100, 'Single')).equals(85)
    expect(trajectoryLabel(47.5)).equals('Pop Fly')
  })
})

describe('contextual batted-ball choices', function () {
  it('rejects empty-base fielder choice without a pitch or history and allows every occupied base', function () {
    const empty = initial()
    expect(
      scoringReducer(empty, { type: 'OUTCOME', outcome: "Fielder's Choice" })
    ).equals(empty)
    for (const base of ['first', 'second', 'third'] as const) {
      const state = initial()
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        2
      )
      expect(
        scoringReducer(state, { type: 'OUTCOME', outcome: "Fielder's Choice" })
          .phase
      ).equals('locateFielder')
    }
  })
  it('clamps only stands home runs to a line drive in both preview and committed trajectories', function () {
    for (const outside of [false, true]) {
      let state = scoringReducer(initial(), {
        type: 'OUTCOME',
        outcome: 'Home Run'
      })
      state = scoringReducer(state, {
        type: 'LANDING',
        point: { x: 0, z: outside ? -129 : -118 },
        generation: 0
      })
      const kind = state.pendingPlay!.homeRunKind
      for (const requested of [-45, -5, 9, 10, 25, 70, 85, 90]) {
        const expected = Math.max(outside ? 10 : -45, Math.min(85, requested))
        expect(allowedAngle(requested, 'Home Run', kind)).equals(expected)
        const result = scoringReducer(state, {
          type: 'TRAJECTORY',
          angle: requested,
          generation: 0
        })
        expect(
          result.session.liveData.plays.currentPlay!.hitData!.launchAngle
        ).equals(expected)
      }
    }
  })

  it("writes the launch angle as the scorer's own only when he dragged it", function () {
    /** The launch angle the stored play gives, only when the scorer set it. */
    const inPlayHit = (
      state: ReturnType<typeof initialScoringState>
    ): Record<string, unknown> => {
      const play = state.session.liveData.plays.currentPlay!
      const detail = play.source.teamstation
      return {
        trajectory: detail.trajectory,
        ...(detail.launchAngleSet === true
          ? { launchAngle: play.hitData?.launchAngle }
          : {})
      }
    }
    /** Whether the ball in play the screen sent says the scorer set it. */
    const sentDragged = (
      state: ReturnType<typeof initialScoringState>
    ): unknown =>
      state.log.findLast(
        (action): action is BallInPlayAction => action.type === 'ballInPlay'
      )?.launchAngleDragged
    const fielded = scoringReducer(
      scoringReducer(initial(), { type: 'OUTCOME', outcome: 'Single' }),
      { type: 'FIELDER', id: 17, point: { x: 5, z: -80 }, generation: 0 }
    )
    expect(startingAngle(fielded)).equals(45)
    // Accepted where the control starts, untouched: no launch angle.
    const untouched = scoringReducer(fielded, {
      type: 'TRAJECTORY',
      angle: 45,
      generation: 0
    })
    expect(sentDragged(untouched)).equals(undefined)
    expect(inPlayHit(untouched)).not.have.property('launchAngle')
    expect(inPlayHit(untouched)).includes({ trajectory: 'fly_ball' })
    // Dragged there, even to the same 45°: the scorer's own.
    for (const angle of [45, 12]) {
      const dragged = scoringReducer(fielded, {
        type: 'TRAJECTORY',
        angle,
        generation: 0,
        dragged: true
      })
      expect(sentDragged(dragged)).equals(true)
      expect(inPlayHit(dragged)).includes({ launchAngle: angle })
    }
    // A home run's landing sets 45° too, and that is no drag either.
    const landed = scoringReducer(
      scoringReducer(initial(), { type: 'OUTCOME', outcome: 'Home Run' }),
      { type: 'LANDING', point: { x: 0, z: -129 }, generation: 0 }
    )
    expect(startingAngle(landed)).equals(45)
    const homeRun = scoringReducer(landed, {
      type: 'TRAJECTORY',
      angle: 45,
      generation: 0,
      dragged: false
    })
    expect(inPlayHit(homeRun)).not.have.property('launchAngle')
    // Before any play the control would start at 45° as well.
    expect(startingAngle(initial())).equals(45)
  })
})

describe('Out at First', function () {
  const SS = 14
  const FIRST = 12
  const PITCHER = 10
  /** Lets the presentation on screen finish, the next one included. */
  function presented(state: ScoringState): ScoringState {
    for (let count = 0; count < 10 && state.presentation != null; count++) {
      const shown = state.presentation
      if (shown.kind === 'hit' && shown.stage === 'swing')
        state = scoringReducer(state, {
          type: 'PRESENTATION_CONTACT',
          id: shown.id,
          generation: state.generation
        })
      const sequence = state.presentation!
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: sequence.id,
        generation: state.generation,
        stage: sequence.stage
      })
      state = completeMotions(state)
    }
    return completeMotions(state)
  }
  /** A ground ball to `fielder` called Out at First. */
  function outAtFirst(
    fielder: FielderRef,
    options: {
      outcome?: 'Out at First' | 'Ground Out'
      presentation?: boolean
      empty?: Position
      contactKind?: 'swing' | 'bunt'
    } = {}
  ): ScoringState {
    let state = initialScoringState(
      scoringSession(gameFixture),
      options.presentation ?? false
    )
    if (options.empty != null)
      state.session.liveData.linescore.defense[options.empty] = null
    state = scoringReducer(state, {
      type: 'OUTCOME',
      outcome: options.outcome ?? 'Out at First',
      contactKind: options.contactKind
    })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: fielder,
      point: { x: -20, z: -40 },
      generation: state.generation
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -10,
      generation: state.generation
    })
    return presented(state)
  }
  /** The batter's out as the closed play stores it. */
  function batterOut(state: ScoringState): {
    reason: string | undefined
    credits: string[]
    outSubtype: string | undefined
    outBy: string | undefined
  } {
    const closed = scoringReducer(state, {
      type: 'CLOSE_PLAY',
      generation: state.generation
    })
    const play = closed.session.liveData.plays.allPlays.at(-1)!
    const batter = play.matchup.batter.id
    const runner = play.runners.find(
      row => row.details.runner.id === batter && row.movement.isOut
    )!
    const result = closed.log.findLast(action => action.type === 'result')
    return {
      reason: runner.details.movementReason,
      credits: runner.credits.map(
        credit => `${credit.credit} ${credit.player?.id ?? credit.position}`
      ),
      outSubtype: play.source.teamstation.outSubtype,
      outBy: result?.type === 'result' ? result.outBy : undefined
    }
  }

  for (const presentation of [false, true])
    it(`throws the shortstop's ball to the first baseman with no prompt${presentation ? ', drawn' : ''}`, function () {
      const state = outAtFirst(SS, { presentation })
      expect(state.phase).not.equals('chooseDefender')
      expect(state.session.liveData.linescore.outs).equals(1)
      const out = state.log.findLast(action => action.type === 'runnerMovement')
      expect(out).deep.includes({
        to: '1B',
        out: true,
        reason: 'Out at First',
        fielders: [SS, FIRST]
      })
      const stored = batterOut(state)
      expect(stored).deep.includes({
        reason: 'Out at First',
        outSubtype: 'Out at First',
        outBy: 'first'
      })
      expect(stored.credits).deep.equals([
        `f_assist ${SS}`,
        `f_putout ${FIRST}`
      ])
    })

  it('records a bunt Out at First the same way', function () {
    const state = outAtFirst(SS, { contactKind: 'bunt' })
    expect(batterOut(state).credits).deep.equals([
      `f_assist ${SS}`,
      `f_putout ${FIRST}`
    ])
  })

  it("asks who took the first baseman's own ball, and the last receiver gets the putout", function () {
    let state = outAtFirst(FIRST)
    expect(state.phase).equals('chooseDefender')
    expect(state.runnerAction).includes({
      purpose: 'batterRetirement',
      thrower: FIRST
    })
    expect(state.session.liveData.linescore.outs).equals(0)
    // The pitcher covers first.
    state = completeMotions(
      scoringReducer(state, {
        type: 'DEFENDER',
        id: PITCHER,
        point: { ...BASES[1] },
        generation: state.generation
      })
    )
    expect(state.phase).equals('chooseDefender')
    state = completeMotions(
      scoringReducer(state, { type: 'DEFENDER', generation: state.generation })
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(batterOut(state).credits).deep.equals([
      `f_assist ${FIRST}`,
      `f_putout ${PITCHER}`
    ])
  })

  for (const presentation of [false, true])
    it(`throws to a nameless stand-in at an empty first, credited to nobody${presentation ? ', drawn' : ''}`, function () {
      const state = outAtFirst(SS, { empty: '1B', presentation })
      expect(state.session.liveData.linescore.outs).equals(1)
      const out = state.log.findLast(action => action.type === 'runnerMovement')
      expect(out).deep.includes({
        fielders: [SS, '1B'],
        reason: 'Out at First'
      })
      const closed = scoringReducer(state, {
        type: 'CLOSE_PLAY',
        generation: state.generation
      })
      const play = closed.session.liveData.plays.allPlays.at(-1)!
      const runner = play.runners.find(row => row.movement.isOut)!
      expect(runner.credits).deep.equals([
        {
          player: runner.credits[0].player,
          credit: 'f_assist',
          position: 'SS'
        },
        { credit: 'f_putout', position: '1B' }
      ])
      expect(runner.credits[0].player?.id).equals(SS)
    })

  it('asks for a receiver when a stand-in at an empty first fields it himself', function () {
    const state = outAtFirst('1B', { empty: '1B' })
    expect(state.phase).equals('chooseDefender')
    expect(state.session.liveData.linescore.outs).equals(0)
  })

  it('still lets the scorer choose the first baseman on a Ground Out', function () {
    let state = outAtFirst(SS, { outcome: 'Ground Out' })
    expect(state.phase).equals('chooseDefender')
    expect(state.session.liveData.linescore.outs).equals(0)
    state = completeMotions(
      scoringReducer(state, {
        type: 'DEFENDER',
        id: FIRST,
        point: { ...BASES[1] },
        generation: state.generation
      })
    )
    state = completeMotions(
      scoringReducer(state, { type: 'DEFENDER', generation: state.generation })
    )
    const stored = batterOut(state)
    expect(stored).deep.includes({
      reason: 'Ground Out',
      outSubtype: 'Ground Out',
      outBy: 'throw'
    })
    expect(stored.credits).deep.equals([`f_assist ${SS}`, `f_putout ${FIRST}`])
  })

  it('still asks for the fielder of a Ball Caught', function () {
    const chosen = scoringReducer(
      initialScoringState(scoringSession(gameFixture)),
      { type: 'OUTCOME', outcome: 'Ball Caught' }
    )
    expect(chosen.phase).equals('locateFielder')
    const caught = presented(
      scoringReducer(
        scoringReducer(chosen, {
          type: 'FIELDER',
          id: SS,
          point: { x: -20, z: -60 },
          generation: 0
        }),
        { type: 'TRAJECTORY', angle: 40, generation: 0 }
      )
    )
    expect(caught.session.liveData.linescore.outs).equals(1)
    expect(
      caught.log.some(
        action => action.type === 'runnerMovement' && action.fielders != null
      )
    ).equals(false)
  })
})
