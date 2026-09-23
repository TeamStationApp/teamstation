import { expect } from 'chai'
import { describe, it } from 'mocha'

import { allowedAngle, trajectoryLabel } from './battedBall'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { type Outcome, outcomeEvents } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
describe('batted-ball draft', function () {
  for (const outcome of Object.keys(outcomeEvents) as Outcome[])
    it(`records ${outcome} once and stores the fielder and accepted trajectory`, function () {
      const start = initial()
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
        type: 'FIELDER',
        id: pitcher,
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
        accepted.session.liveData.plays.currentPlay!.playEvents.length
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
    expect(allowedAngle(100, 'Single')).equals(70)
    expect(trajectoryLabel(47.5)).equals('Pop Fly')
  })
})
