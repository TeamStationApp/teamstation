import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { BallInPlayAction } from '../../common/scoring/actions'
import { allowedAngle, startingAngle, trajectoryLabel } from './battedBall'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { type Outcome, outcomeEvents } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
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
      const detail = play.source.gamestation
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
