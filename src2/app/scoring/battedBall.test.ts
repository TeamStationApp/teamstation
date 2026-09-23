import { expect } from 'chai'
import { describe, it } from 'mocha'

import { allowedAngle, trajectoryLabel } from './battedBall'
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
})
