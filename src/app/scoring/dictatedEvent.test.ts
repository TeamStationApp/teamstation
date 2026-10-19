import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { nextDecision } from '../../common/scoring/rules'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer, screenOf } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringPhase, ScoringState } from './scoringTypes'

const FINISH = 'Finish what is on screen, then say it again'

function fresh(): ScoringState {
  return initialScoringState(scoringSession(gameFixture))
}
function say(
  state: ScoringState,
  actions: ScoringAction[],
  transcript = 'said'
): ScoringState {
  return scoringReducer(state, { type: 'DICTATED', transcript, actions })
}
const single: ScoringAction[] = [
  {
    type: 'ballInPlay',
    contact: 'swing',
    launchAngle: 15,
    location: { x: 5, z: -80 },
    fielder: 17
  },
  { type: 'result', eventType: 'single' }
]

describe('a dictated sentence', function () {
  it('applies every action in order as one undo step, labelled with what was said', function () {
    const before = fresh()
    const actions: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' },
      ...single
    ]
    const after = say(before, actions, 'ball, strike, single to center')
    expect(after.log).deep.equals(actions)
    expect(after.past).to.have.length(1)
    expect(after.past[0].label).equals('ball, strike, single to center')
    expect(after.dictation).deep.equals({
      transcript: 'ball, strike, single to center'
    })
    expect(after.motions.length).greaterThan(0)
    const settled = completeMotions(after)
    expect(nextDecision(settled.session)).equals('close')
    expect(settled.phase).equals('correctionWindow')

    const undone = scoringReducer(after, { type: 'UNDO' })
    expect(undone.log).deep.equals([])
    expect(undone.past).to.have.length(0)
    expect(undone.dictation).equals(undefined)
  })

  it('is refused whole when the rules engine refuses any action, with its reason', function () {
    const before = say(fresh(), [{ type: 'pitch', call: 'B' }])
    const after = say(before, [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      // Nobody is on second to steal third.
      { type: 'baseRunning', runner: 3, kind: 'steal', to: '3B' }
    ])
    expect(after.log).equals(before.log)
    expect(after.session).equals(before.session)
    expect(after.past).equals(before.past)
    expect(after.dictation?.transcript).equals('said')
    expect(after.dictation?.problem?.code).oneOf([
      'illegal',
      'notNow',
      'unknownPlayer'
    ])
    expect(after.dictation?.problem?.message).is.a('string').and.not.equal('')
  })

  it('returns the very same state for an empty sentence', function () {
    const state = fresh()
    state.phase = 'correctionWindow'
    expect(say(state, [])).equals(state)
  })

  it('is refused on a read-only screen with the read-only reason', function () {
    const state = { ...fresh(), readOnly: true }
    const after = say(state, [{ type: 'pitch', call: 'B' }])
    expect(after.log).deep.equals([])
    expect(after.dictation?.problem).deep.equals({
      code: 'notNow',
      message: 'Scoring is read-only'
    })
  })

  describe('applies only with the screen at rest', function () {
    const drawing: ScoringPhase[] = [
      'locateFielder',
      'locateLanding',
      'trajectory',
      'runnerDecision'
    ]
    for (const phase of drawing)
      it(`is refused in ${phase}`, function () {
        const state = { ...fresh(), phase }
        const after = say(state, [{ type: 'pitch', call: 'B' }])
        expect(after.log).deep.equals([])
        expect(after.session).equals(state.session)
        expect(after.dictation?.problem?.message).equals(FINISH)
      })

    it('is refused while a runner is being dragged', function () {
      const base = fresh()
      const state = {
        ...base,
        runnerDraft: {
          historyLength: 0,
          logLength: base.log.length,
          screen: screenOf(base)
        }
      }
      expect(
        say(state, [{ type: 'pitch', call: 'B' }]).dictation?.problem?.message
      ).equals(FINISH)
    })

    it('is refused under a wild-pitch draft, which sits in ready', function () {
      let walked = fresh()
      for (let n = 0; n < 4; n++)
        walked = scoringReducer(walked, { type: 'PITCH', kind: 'ball' })
      walked = scoringReducer(completeMotions(walked), { type: 'CLOSE_PLAY' })
      const drafting = scoringReducer(walked, {
        type: 'MORE',
        input: { action: 'Wild Pitch' }
      })
      expect(drafting.moreDraft).not.equal(undefined)
      expect(drafting.phase).equals('ready')
      const after = say(drafting, [{ type: 'pitch', call: 'B' }])
      expect(after.log).equals(drafting.log)
      expect(after.dictation?.problem?.message).equals(FINISH)
    })

    it('is refused while a pitch animates, and the animation still finishes', function () {
      const base = { ...fresh(), presentationEnabled: true }
      const pitching = scoringReducer(base, { type: 'PITCH', kind: 'ball' })
      const sequence = pitching.presentation
      expect(sequence).not.equal(null)
      const after = say(pitching, [{ type: 'pitch', call: 'B' }])
      expect(after.log).equals(pitching.log)
      expect(after.dictation?.problem?.message).equals(FINISH)
      const done = scoringReducer(after, {
        type: 'PRESENTATION_DONE',
        id: sequence!.id,
        generation: sequence!.generation,
        stage: sequence!.stage
      })
      expect(done.presentation).equals(null)
      expect(done.log).to.have.length(1)
    })

    it('applies in ready and in the correction window', function () {
      expect(say(fresh(), [{ type: 'pitch', call: 'B' }]).log).to.have.length(1)
      const decided = completeMotions(say(fresh(), single))
      expect(decided.phase).equals('correctionWindow')
      expect(say(decided, [{ type: 'pitch', call: 'B' }]).log).to.have.length(3)
    })

    it('lets the rules engine decide in awaitingBatter', function () {
      const state = fresh()
      const session = state.session
      session.liveData.boxscore.teams.away.battingOrder = [1]
      session.liveData.linescore.offense.first = playerRef(session, 1)
      session.liveData.plays.currentPlay = null
      session.liveData.linescore.offense.batter = null
      session.awaitingBatter = {
        teamId: session.gameData.teams.away.id,
        dueIndex: 0,
        duePlayerId: 1
      }
      state.phase = 'awaitingBatter'
      const after = say(state, [{ type: 'pitch', call: 'B' }])
      expect(after.dictation?.problem?.message).equals(
        'The batter due is on base: change the lineup first'
      )
    })
  })

  it('clears the last reason at the next sentence, and on reset', function () {
    const refused = say({ ...fresh(), phase: 'trajectory' }, [
      { type: 'pitch', call: 'B' }
    ])
    expect(refused.dictation?.problem).not.equal(undefined)
    const next = say(
      { ...refused, phase: 'ready' },
      [{ type: 'pitch', call: 'B' }],
      'ball'
    )
    expect(next.dictation).deep.equals({ transcript: 'ball' })
    expect(next.past[0].screen.dictation).equals(undefined)
    const reset = scoringReducer(refused, {
      type: 'RESET',
      session: refused.session,
      log: refused.log
    })
    expect(reset.dictation).equals(undefined)
  })

  it('closes the decided play itself when the next sentence begins', function () {
    const decided = completeMotions(say(fresh(), single, 'single to center'))
    expect(nextDecision(decided.session)).equals('close')
    const plays = decided.session.liveData.plays.allPlays.length
    const next = say(decided, [{ type: 'pitch', call: 'B' }], 'ball')
    expect(next.session.liveData.plays.allPlays.length).equals(plays + 1)
    expect(next.log.at(-1)).deep.equals({ type: 'pitch', call: 'B' })
    const settled = completeMotions(next)
    expect(settled.phase).oneOf(['ready', 'awaitingBatter'])
    expect(settled.session.liveData.linescore.balls).equals(1)
  })

  it('refuses an explicit close of an undecided play, whole', function () {
    const after = say(fresh(), [
      { type: 'pitch', call: 'B' },
      { type: 'gameFlow', kind: 'closePlay' }
    ])
    expect(after.log).deep.equals([])
    expect(after.dictation?.problem?.message).equals(
      'The play is not decided yet'
    )
  })
})
