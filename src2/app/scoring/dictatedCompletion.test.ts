import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { nextDecision } from '../../common/scoring/rules'
import { createDevelopmentSession } from './developmentSession'
import {
  answerOf,
  completeSentence,
  leadRunnersFirst,
  stealsByBase
} from './dictatedCompletion'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { DictationQuestion, ScoringState } from './scoringTypes'

const SS = 14
const LF = 16
const BATTER = 1

function game(
  bases: { first?: number; second?: number; third?: number } = {}
): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    false
  )
  const offense = state.session.liveData.linescore.offense
  for (const key of ['first', 'second', 'third'] as const) {
    const id = bases[key]
    if (id != null) offense[key] = playerRef(state.session, id)
  }
  return state
}
function say(state: ScoringState, ...actions: ScoringAction[]): ScoringState {
  return scoringReducer(state, {
    type: 'DICTATED',
    transcript: 'said',
    actions
  })
}
/** Plays out whatever the screen is animating. */
function settle(state: ScoringState): ScoringState {
  for (let step = 0; step < 40; step++) {
    const motion = state.motions.find(m => !m.complete && m.held !== true)
    if (motion == null) return state
    state = scoringReducer(state, {
      type: 'MOTION_DONE',
      id: motion.id,
      generation: motion.generation
    })
  }
  return state
}
const grounder: ScoringAction = {
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'ground_ball',
  fielder: SS
}
const choice: ScoringAction = { type: 'result', eventType: 'fielders_choice' }
const bases = (state: ScoringState): Array<number | null> => {
  const offense = state.session.liveData.linescore.offense
  return [offense.first, offense.second, offense.third].map(
    ref => ref?.id ?? null
  )
}
/** The screen is waiting on nothing a scorer would have to tap. */
function nothingToTap(state: ScoringState): void {
  expect(['close', 'ready', 'awaitingBatter']).includes(
    nextDecision(state.session)
  )
  expect(atRest(state), state.phase).equals(true)
}

describe('a dictated sentence finishes the play', function () {
  it('puts the batter out at first on a throw-out, crediting nobody', function () {
    const done = completeSentence(game().session, [
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    ])
    expect('actions' in done && done.actions.at(-1)).deep.equals({
      type: 'runnerMovement',
      runner: BATTER,
      to: '1B',
      out: true,
      reason: 'Throw Out'
    })
    const state = settle(
      say(game(), grounder, {
        type: 'result',
        eventType: 'field_out',
        outBy: 'throw'
      })
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    nothingToTap(state)
  })

  it('puts the lone runner out on a fielder’s choice and the batter on first', function () {
    const state = settle(say(game({ first: 5 }), grounder, choice))
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(bases(state)).deep.equals([BATTER, null, null])
    expect(state.log.slice(2)).deep.equals([
      { type: 'runnerMovement', runner: 5, to: '2B', out: true },
      { type: 'runnerMovement', runner: BATTER, to: '1B' }
    ])
    expect(state.past).to.have.length(1)
    nothingToTap(state)
  })

  it('only puts the batter on first when the sentence said who was out', function () {
    const state = settle(
      say(game({ first: 5, second: 6 }), grounder, choice, {
        type: 'runnerMovement',
        runner: 6,
        to: '3B',
        out: true
      })
    )
    expect(state.log.at(-1)).deep.equals({
      type: 'runnerMovement',
      runner: BATTER,
      to: '1B'
    })
    expect(state.session.liveData.linescore.outs).equals(1)
    nothingToTap(state)
  })

  it('moves up a forced runner the play did not put out', function () {
    const state = settle(
      say(game({ first: 5, second: 6 }), grounder, choice, {
        type: 'runnerMovement',
        runner: 6,
        to: '3B',
        out: true
      })
    )
    expect(bases(state)).deep.equals([BATTER, 5, null])
    expect(state.log.slice(-2)).deep.equals([
      { type: 'runnerMovement', runner: 5, to: '2B' },
      { type: 'runnerMovement', runner: BATTER, to: '1B' }
    ])
  })

  describe('with two runners on a fielder’s choice', function () {
    const asked = (): ScoringState =>
      say(game({ first: 5, second: 6 }), grounder, choice)

    it('asks which were out, and applies nothing yet', function () {
      const state = asked()
      expect(state.log).deep.equals([])
      const question = state.dictationQuestion!
      expect(question.question).match(/fielder's choice/)
      expect(question.pick!.choices.map(c => c.label)).deep.equals([
        `${state.session.gameData.players[5].fullName} out at second`,
        `${state.session.gameData.players[6].fullName} out at third`
      ])
    })

    it('applies the answer as the sentence, in one Undo step', function () {
      let state = scoringReducer(asked(), {
        type: 'DICTATION_ANSWER',
        picks: [1]
      })
      expect(state.dictationQuestion).equals(undefined)
      state = settle(state)
      expect(bases(state)).deep.equals([BATTER, 5, null])
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(state.past).to.have.length(1)
      nothingToTap(state)
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(undone.log).deep.equals([])
    })

    it('can put both out, or nobody', function () {
      const both = settle(
        scoringReducer(asked(), {
          type: 'DICTATION_ANSWER',
          picks: [1, 0, 0, 9]
        })
      )
      expect(both.session.liveData.linescore.outs).equals(2)
      const none = settle(
        scoringReducer(asked(), { type: 'DICTATION_ANSWER', picks: [] })
      )
      expect(none.session.liveData.linescore.outs).equals(0)
      nothingToTap(none)
    })

    it('is dropped by a dismissal, the next sentence, a tap, Undo or reset', function () {
      const state = asked()
      expect(
        scoringReducer(state, { type: 'DICTATION_DISMISS' }).dictationQuestion
      ).equals(undefined)
      // A scorer who scores something else has moved on from it.
      const tapped = scoringReducer(state, { type: 'PITCH', kind: 'ball' })
      expect(tapped.session.liveData.linescore.balls).equals(1)
      expect(tapped.dictationQuestion).equals(undefined)
      expect(say(state, { type: 'pitch', call: 'B' }).dictationQuestion).equals(
        undefined
      )
      const after = say(game(), { type: 'pitch', call: 'B' })
      const reasked = say(after, grounder, choice)
      expect(
        scoringReducer(reasked, { type: 'UNDO' }).dictationQuestion
      ).equals(undefined)
      expect(
        scoringReducer(state, {
          type: 'RESET',
          session: state.session,
          log: []
        }).dictationQuestion
      ).equals(undefined)
      // With nothing asked, an answer or a dismissal changes nothing.
      const plain = game()
      expect(scoringReducer(plain, { type: 'DICTATION_DISMISS' })).equals(plain)
      expect(
        scoringReducer(plain, { type: 'DICTATION_ANSWER', option: 0 })
      ).equals(plain)
    })
  })

  it('asks whether the batter made first on a dropped third strike', function () {
    let state = game()
    state = say(
      state,
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' }
    )
    state = settle(state)
    const asked = say(state, { type: 'result', eventType: 'strikeout' })
    const question = asked.dictationQuestion!
    expect(question.options!.map(o => o.label)).deep.equals([
      'Safe at first',
      'Out at first'
    ])
    const safe = settle(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 0 })
    )
    expect(bases(safe)[0]).equals(BATTER)
    const out = settle(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 1 })
    )
    expect(out.session.liveData.linescore.outs).equals(1)
    nothingToTap(out)
    // An answer the question does not have changes nothing.
    expect(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 5 })
    ).equals(asked)
    expect(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', picks: [0] })
    ).equals(asked)
  })

  it('charges an error to the fielder named, or asks who', function () {
    const error: ScoringAction = { type: 'result', eventType: 'field_error' }
    const named = settle(say(game(), grounder, error))
    expect(named.log.at(-1)).deep.equals({
      type: 'fieldingPlay',
      fielders: [SS],
      error: SS
    })
    nothingToTap(named)
    const asked = say(game(), { type: 'ballInPlay', contact: 'swing' }, error)
    const question = asked.dictationQuestion!
    expect(question.question).equals('Who made the error?')
    expect(question.options).to.have.length(9)
    expect(question.options![5].label).match(/^3B /)
    const answered = settle(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 5 })
    )
    expect(answered.log.at(-1)).deep.equals({
      type: 'fieldingPlay',
      fielders: [15],
      error: 15
    })
    nothingToTap(answered)
  })

  it('scores a runner the hit sent home', function () {
    const state = settle(
      say(
        game({ third: 5 }),
        { type: 'ballInPlay', contact: 'swing', fielder: LF },
        { type: 'result', eventType: 'single' }
      )
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    nothingToTap(state)
  })

  it('takes a double steal lead runner first, in whatever order it was said', function () {
    const trail: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 5,
      to: '2B'
    }
    const lead: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 6,
      to: '3B'
    }
    const ball: ScoringAction = { type: 'pitch', call: 'B' }
    const before = game({ first: 5, second: 6 })
    expect(leadRunnersFirst(before.session, [ball, trail, lead])).deep.equals([
      ball,
      lead,
      trail
    ])
    const state = settle(say(before, trail, lead))
    expect(state.dictation?.problem).equals(undefined)
    expect(bases(state)).deep.equals([null, 5, 6])
    // Runners moved up between pitches, said trailing runner first.
    const moved = settle(
      say(
        game({ first: 5, second: 6 }),
        { type: 'runnerMovement', runner: 5, to: '2B' },
        { type: 'runnerMovement', runner: 6, to: '3B' }
      )
    )
    expect(bases(moved)).deep.equals([null, 5, 6])
  })

  it('gives a steal to the runner on the base before the one taken', function () {
    const third = (runner: number): ScoringAction => ({
      type: 'baseRunning',
      kind: 'steal',
      runner,
      to: '3B'
    })
    const before = game({ first: 5, second: 6 })
    // Sent for the runner on first, who cannot pass second: the runner on
    // second's.
    expect(stealsByBase(before.session, [third(5)])).deep.equals([third(6)])
    const state = settle(say(before, third(5)))
    expect(bases(state)).deep.equals([5, null, 6])
    // A steal its runner can take, a runner already moving, and an empty
    // base before it are left as they are.
    expect(stealsByBase(before.session, [third(6)])).deep.equals([third(6)])
    expect(stealsByBase(before.session, [third(6), third(5)])).deep.equals([
      third(6),
      third(5)
    ])
    expect(stealsByBase(game({ first: 5 }).session, [third(5)])).deep.equals([
      third(5)
    ])
  })

  it('leaves a play that needs nothing as it is', function () {
    const sentence: ScoringAction[] = [{ type: 'pitch', call: 'B' }]
    expect(completeSentence(game().session, sentence)).deep.equals({
      actions: sentence
    })
  })

  it('reads an answer into the whole sentence it comes to', function () {
    const pick: DictationQuestion = {
      transcript: 't',
      question: 'q',
      pick: {
        choices: [
          { label: 'a', actions: [{ type: 'pitch', call: 'B' }] },
          { label: 'b', actions: [{ type: 'pitch', call: 'C' }] }
        ],
        before: [{ type: 'pitch', call: 'S' }],
        none: [{ type: 'pitch', call: 'F' }]
      }
    }
    expect(
      answerOf(pick, { picks: [1, 0, 1, -1] })!.map(a =>
        a.type === 'pitch' ? a.call : ''
      )
    ).deep.equals(['S', 'B', 'C'])
    expect(answerOf(pick, { picks: [] })!.length).equals(2)
    expect(answerOf(pick, { option: 0 })).equals(undefined)
    expect(answerOf({ transcript: 't', question: 'q' }, { picks: [] })).equals(
      undefined
    )
  })
})
