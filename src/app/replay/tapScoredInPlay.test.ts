import { expect } from 'chai'
import { describe, it } from 'mocha'

import { narrateTimeline } from '../../common/replay/narration'
import { stepsOf } from '../../common/replay/replayTimeline'
import type { ScoringAction } from '../../common/scoring/actions'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import type { PresentationSequence } from '../scoring/scoringPresentation'
import type { ScoringState } from '../scoring/scoringTypes'

/** Plays every presentation and motion out, as a field would. */
function settle(state: ScoringState): ScoringState {
  let next = state
  for (let i = 0; i < 50; i++) {
    const shown = next.presentation
    if (shown != null) {
      next =
        shown.kind === 'hit' && shown.stage === 'swing'
          ? scoringReducer(next, {
              type: 'PRESENTATION_CONTACT',
              id: shown.id,
              generation: shown.generation
            })
          : scoringReducer(next, {
              type: 'PRESENTATION_DONE',
              id: shown.id,
              generation: shown.generation,
              stage: shown.stage
            })
      continue
    }
    const moving = next.motions.find(motion => !motion.complete)
    if (moving == null) return next
    next = scoringReducer(next, {
      type: 'MOTION_DONE',
      id: moving.id,
      generation: moving.generation
    })
  }
  return next
}

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

    // Replayed, the field draws that one hit, where the trajectory put it.
    const hits = (actions: ScoringAction[]): PresentationSequence[] => {
      const replayed = scoringReducer(
        initialScoringState(start.session, true, { watching: true }),
        { type: 'REPLAYED', actions }
      )
      return [
        replayed.presentation,
        ...(replayed.reel ?? []).map(beat => beat.presentation)
      ].filter((shown): shown is PresentationSequence => shown?.kind === 'hit')
    }
    const drawn = hits(log)
    expect(drawn).length(1)

    // Live, the bare ball arrives first and the rest after it was drawn:
    // the rest moves on from that hit and draws no second one.
    const first = log.findIndex(action => action.type === 'ballInPlay')
    let live = scoringReducer(
      initialScoringState(start.session, true, { watching: true }),
      { type: 'REPLAYED', actions: log.slice(0, first + 1) }
    )
    const shownLive = (state: typeof live): PresentationSequence[] =>
      [
        state.presentation,
        ...(state.reel ?? []).map(beat => beat.presentation)
      ].filter((shown): shown is PresentationSequence => shown?.kind === 'hit')
    expect(shownLive(live)).length(1)
    live = settle(live)
    live = scoringReducer(live, {
      type: 'REPLAYED',
      actions: log.slice(first + 1)
    })
    expect(shownLive(live)).length(0)
    expect(
      settle(live).session.liveData.plays.currentPlay?.result.eventType
    ).equals('single')
    const bare = log.findIndex(action => action.type === 'ballInPlay')
    const detailed = hits(log.filter((_, index) => index !== bare))
    expect(drawn[0]).deep.includes({
      fielderTarget: (detailed[0] as { fielderTarget: unknown }).fielderTarget
    })
  })
})
