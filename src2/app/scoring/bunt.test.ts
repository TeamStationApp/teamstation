import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGamePlay as asEstimatedGumboPlay } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { type Outcome, outcomeEvents } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'

const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))

describe('bunt contact identity', () => {
  for (const outcome of Object.keys(outcomeEvents) as Outcome[])
    it(`preserves bunt identity for ${outcome} and rejects a bunt home run`, () => {
      const start = initial()
      start.session.liveData.linescore.offense.first = playerRef(
        start.session,
        2
      )
      const chosen = scoringReducer(start, {
        type: 'OUTCOME',
        outcome,
        contactKind: 'bunt'
      })
      if (outcome === 'Home Run') {
        expect(chosen).equals(start)
        return
      }
      expect(chosen.pendingPlay!.contactKind).equals('bunt')
      expect(chosen.past.at(-1)!.label).equals(`Bunt: ${outcome}`)
      const play = chosen.session.liveData.plays.currentPlay!
      expect(play.playEvents.at(-1)!.details.description).equals('Bunt in Play')
      // The result reaches the game when the trajectory is accepted.
      expect(chosen.pendingPlay!.outcome).equals(outcome)
      expect(
        asEstimatedGumboPlay(JSON.parse(JSON.stringify(play))).source
          .gamestation.contactKind
      ).equals('bunt')
      expect(
        scoringReducer(chosen, {
          type: 'OUTCOME',
          outcome: 'Home Run',
          contactKind: 'bunt'
        })
      ).equals(chosen)
      expect(scoringReducer(chosen, { type: 'UNDO' }).session).deep.equals(
        start.session
      )
    })
  it('retains contact mode after completion and Undo, and keeps swing compatibility', () => {
    const start = initial()
    expect(
      scoringReducer(start, {
        type: 'OUTCOME',
        outcome: "Fielder's Choice",
        contactKind: 'bunt'
      })
    ).equals(start)
    let state = scoringReducer(start, {
      type: 'OUTCOME',
      outcome: 'Single',
      contactKind: 'bunt'
    })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 10, z: -40 },
      generation: state.generation
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -5,
      generation: state.generation
    })
    state = completeMotions(state)
    state = scoringReducer(state, {
      type: 'CLOSE_PLAY',
      generation: state.generation,
      revision: state.correctionWindow?.revision
    })
    expect(
      state.session.liveData.plays.allPlays[0].source.gamestation.contactKind
    ).equals('bunt')
    while (state.past.length > 0)
      state = scoringReducer(state, { type: 'UNDO' })
    expect(state.session).deep.equals(start.session)
    const swing = scoringReducer(start, {
      type: 'OUTCOME',
      outcome: 'Home Run'
    })
    expect(swing.pendingPlay!.contactKind).equals('swing')
    expect(
      swing.session.liveData.plays.currentPlay!.playEvents.at(-1)!.details
        .description
    ).equals('Ball in Play')
  })
})
