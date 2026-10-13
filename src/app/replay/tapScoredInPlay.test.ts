import { expect } from 'chai'
import { describe, it } from 'mocha'

import { narrateTimeline } from '../../common/replay/narration'
import { stepsOf } from '../../common/replay/replayTimeline'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'

describe('a ball in play scored by taps, replayed', function () {
  it('is one step with one sentence, though the screen saves the ball twice', function () {
    const start = initialScoringState(scoringSession(gameFixture))
    const chosen = scoringReducer(start, { type: 'OUTCOME', outcome: 'Single' })
    const pitcher =
      chosen.session.liveData.plays.currentPlay!.matchup.pitcher.id
    const located = scoringReducer(chosen, {
      type: 'FIELDER',
      id: pitcher,
      point: { x: 60, z: -150 },
      generation: 0
    })
    const accepted = scoringReducer(located, {
      type: 'TRAJECTORY',
      angle: 15,
      generation: 0
    })
    const log = accepted.log
    // The outcome's bare ball in play, then the one that says where it went.
    expect(log.filter(action => action.type === 'ballInPlay')).length(2)
    const steps = stepsOf(0, log)
    expect(steps.map(step => step.kind)).deep.equals(['inPlay'])
    expect(steps[0].actions).deep.equals(log)
    const narration = narrateTimeline({
      start: start.session,
      steps,
      end: accepted.session,
      derived: 0
    }).get(steps[0].key)!
    expect(narration.text).not.includes('puts it in play')
    expect(narration.text).includes('right')
  })
})
