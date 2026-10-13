import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { after, ball, close, F, game, single } from '../../test/scoringGames'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringState } from './scoringTypes'

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

const watching = (session = game()): ScoringState =>
  initialScoringState(session, true, { watching: true })

const inPlay: ScoringAction = {
  type: 'ballInPlay',
  contact: 'swing',
  launchAngle: 12,
  location: { x: -40, z: -70 },
  fielder: F.LF
}

describe('a replayed step', function () {
  it('applies a ball in play saved without its result, asking nothing', function () {
    const state = scoringReducer(watching(), {
      type: 'REPLAYED',
      actions: [inPlay]
    })
    expect(
      state.session.liveData.plays.currentPlay?.playEvents.at(-1)?.details
        .isInPlay
    ).equals(true)
    expect(state.dictationQuestion).equals(undefined)
    expect(state.log).deep.equals([inPlay])
    expect(state.presentation?.kind).equals('hit')
  })

  it('applies a steal exactly as stored', function () {
    const onFirst = single(game())
    const steal: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 1,
      to: '2B'
    }
    const state = scoringReducer(watching(onFirst), {
      type: 'REPLAYED',
      actions: [ball, steal]
    })
    expect(state.session.liveData.linescore.offense.second?.id).equals(1)
    expect(state.log).deep.equals([ball, steal])
  })

  it('applies a stored pitch the setup check would refuse, as replayPlays does', function () {
    const unset = watching()
    unset.session.liveData.boxscore.teams.home.defense.RF = null
    unset.session.liveData.linescore.defense.RF = null
    const dictated = scoringReducer(
      { ...unset, watching: false },
      { type: 'DICTATED', transcript: 'ball', actions: [ball] }
    )
    expect(dictated.session).equals(unset.session)
    const replayed = scoringReducer(unset, {
      type: 'REPLAYED',
      actions: [ball]
    })
    expect(replayed.session.liveData.linescore.balls).equals(1)
  })

  it('leaves the game as it was when the step will not apply', function () {
    const state = watching()
    expect(
      scoringReducer(state, { type: 'REPLAYED', actions: [close] })
    ).equals(state)
    expect(scoringReducer(state, { type: 'REPLAYED', actions: [] })).equals(
      state
    )
  })

  it('in watch mode closes nothing of its own: the stored close does', function () {
    const four = settle(
      scoringReducer(watching(after(game(), ball, ball, ball)), {
        type: 'REPLAYED',
        actions: [ball]
      })
    )
    expect(four.log).deep.equals([ball])
    expect(four.phase).equals('ready')
    expect(four.correctionWindow).equals(null)
    expect(four.runnerAction).equals(null)
    expect(four.session.pending).not.equals(null)
    const closed = scoringReducer(four, { type: 'REPLAYED', actions: [close] })
    expect(closed.session.pending).equals(null)
    expect(closed.log).deep.equals([ball, close])
  })

  it('in watch mode opens on a decided play and waits for the scorer', function () {
    const decided = after(game(), ball, ball, ball, ball)
    const watched = watching(decided)
    expect(watched.log).deep.equals([])
    expect(watched.phase).equals('ready')
    expect(watched.watching).equals(true)
    // The scoring screen, opened on the same game, closes it itself.
    expect(initialScoringState(decided, true).log).deep.equals([close])
  })

  it('keeps watching through the steps it plays', function () {
    const state = scoringReducer(watching(), {
      type: 'REPLAYED',
      actions: [ball]
    })
    expect(state.watching).equals(true)
  })
})
