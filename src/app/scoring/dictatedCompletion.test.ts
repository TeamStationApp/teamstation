import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { nextDecision } from '../../common/scoring/rules'
import { scoringSession } from '../../test/scoringSession'
import {
  answerOf,
  baseOutsSaid,
  completeSentence,
  leadRunnersFirst,
  playDefaults,
  sentenceDefaults,
  sentenceQuestion,
  settleBetween,
  stealsByBase
} from './dictatedCompletion'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { DictationQuestion, ScoringState } from './scoringTypes'

const SS = 14
const FIRST_BASEMAN = 12
const SECOND_BASEMAN = 13
const THIRD_BASEMAN = 15
const LF = 16
const BATTER = 1

function game(
  bases: { first?: number; second?: number; third?: number } = {}
): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture), false)
  const offense = state.session.liveData.linescore.offense
  for (const key of ['first', 'second', 'third'] as const) {
    const id = bases[key]
    if (id != null) offense[key] = playerRef(state.session, id)
  }
  return state
}
function sayAs(
  transcript: string,
  state: ScoringState,
  ...actions: ScoringAction[]
): ScoringState {
  return scoringReducer(state, { type: 'DICTATED', transcript, actions })
}
function say(state: ScoringState, ...actions: ScoringAction[]): ScoringState {
  return sayAs('said', state, ...actions)
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
  it('puts the batter out at first on a throw-out, thrown by the fielder the ball went to', function () {
    const thrown: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'throw'
    }
    const done = completeSentence(game().session, [grounder, thrown])
    expect('actions' in done && done.actions.at(-1)).deep.equals({
      type: 'runnerMovement',
      runner: BATTER,
      to: '1B',
      out: true,
      reason: 'Throw Out',
      fielders: [SS, FIRST_BASEMAN]
    })
    const state = settle(say(game(), grounder, thrown))
    expect(state.session.liveData.linescore.outs).equals(1)
    const play = state.session.liveData.plays.allPlays.at(-1)
    expect(
      play?.runners.flatMap(runner =>
        (runner.credits ?? []).map(c => `${c.credit} ${c.player.id}`)
      )
    ).deep.equals([`f_assist ${SS}`, `f_putout ${FIRST_BASEMAN}`])
    nothingToTap(state)
  })

  it('credits the first baseman alone when the ball went to him, and nobody when it went to no one', function () {
    const thrown: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'throw'
    }
    const toFirst = completeSentence(game().session, [
      { ...grounder, fielder: FIRST_BASEMAN },
      thrown
    ])
    expect('actions' in toFirst && toFirst.actions.at(-1)).deep.include({
      fielders: [FIRST_BASEMAN]
    })
    const nobody = completeSentence(game().session, [
      { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
      thrown
    ])
    expect('actions' in nobody && nobody.actions.at(-1)).deep.equals({
      type: 'runnerMovement',
      runner: BATTER,
      to: '1B',
      out: true,
      reason: 'Throw Out'
    })
    // An out not said to be thrown is not given a throw.
    const unsaid = completeSentence(game().session, [
      grounder,
      { type: 'result', eventType: 'field_out' }
    ])
    expect('actions' in unsaid && unsaid.actions.at(-1)).not.to.have.property(
      'fielders'
    )
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
    const state = settle(sayAs('And he steals third.', before, third(5)))
    expect(bases(state)).deep.equals([5, null, 6])
    // A steal its runner can take, a runner already moving, and an empty
    // base before it are left as they are.
    expect(stealsByBase(before.session, [third(6)])).deep.equals([third(6)])
    expect(
      stealsByBase(before.session, [third(6), third(5)], 'He steals third.')
    ).deep.equals([third(6), third(5)])
    expect(
      stealsByBase(game({ first: 5 }).session, [third(5)], 'He steals third.')
    ).deep.equals([third(5)])
  })

  describe('fills in what a sentence leaves to be assumed', function () {
    it('makes a hit with no trajectory a line drive, landing where it was sent', function () {
      const [inPlay] = playDefaults(game().session, [
        { type: 'ballInPlay', contact: 'swing', direction: 'left_center' },
        { type: 'result', eventType: 'single' }
      ])
      expect(inPlay).deep.include({
        trajectory: 'line_drive',
        direction: 'left_center'
      })
      const { location } = inPlay as { location: { x: number; z: number } }
      expect(
        Math.round((Math.atan2(location.x, -location.z) * 180) / Math.PI)
      ).equals(-15)
      // A trajectory, an angle and a location said are kept.
      const said: ScoringAction[] = [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'fly_ball',
          direction: 'left',
          location: { x: 1, z: -2 }
        },
        { type: 'result', eventType: 'double' }
      ]
      expect(playDefaults(game().session, said)).deep.equals(said)
    })

    it('makes a caught foul a caught pop-up in foul territory', function () {
      const [inPlay, result] = playDefaults(game().session, [
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'field_out', foulCaught: true }
      ])
      expect(result).deep.include({ outBy: 'catch', foulCaught: true })
      expect(inPlay).deep.include({ trajectory: 'popup' })
      const { location } = inPlay as { location: { x: number; z: number } }
      expect(Math.abs(location.x)).greaterThan(-location.z)
      const state = settle(
        say(
          game(),
          { type: 'ballInPlay', contact: 'swing', fielder: 12 },
          { type: 'result', eventType: 'field_out', foulCaught: true }
        )
      )
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(
        state.session.liveData.plays.allPlays.at(-1)?.result.description
      ).equals('Foul ball caught')
    })

    it('throws a runner out at home to the catcher, from the fielder who caught the fly', function () {
      const fly: ScoringAction[] = [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'popup',
          fielder: 17
        },
        { type: 'result', eventType: 'field_out', outBy: 'catch' },
        { type: 'runnerMovement', runner: 7, to: 'home', out: true }
      ]
      expect(playDefaults(game({ third: 7 }).session, fly)[2]).deep.equals({
        type: 'runnerMovement',
        runner: 7,
        to: 'home',
        out: true,
        fielders: [17, 11]
      })
      const state = settle(say(game({ third: 7 }), ...fly))
      expect(state.session.liveData.linescore.outs).equals(2)
      // A chain that ends at the base, a base with two who cover it, and no
      // thrower are left alone.
      const out = (
        to: '1B' | '2B' | 'home',
        fielders?: number[]
      ): ScoringAction => ({
        type: 'runnerMovement',
        runner: BATTER,
        to,
        out: true,
        ...(fielders == null ? {} : { fielders })
      })
      // A chain the model sent is kept as sent: one fielder, whatever the
      // words, made the out himself.
      expect(
        playDefaults(game().session, [out('1B', [SS])], 'Thrown out at first.')
      ).deep.equals([out('1B', [SS])])
      expect(
        playDefaults(
          game().session,
          [out('1B', [10])],
          'He runs over and steps on first himself.'
        )
      ).deep.equals([out('1B', [10])])
      expect(playDefaults(game().session, [out('1B', [SS, 12])])).deep.equals([
        out('1B', [SS, 12])
      ])
      // A chain of two, like a 3-1 play, is left as it was said.
      expect(playDefaults(game().session, [out('1B', [12, 10])])).deep.equals([
        out('1B', [12, 10])
      ])
      expect(playDefaults(game().session, [out('2B', [SS])])).deep.equals([
        out('2B', [SS])
      ])
      expect(playDefaults(game().session, [out('home')])).deep.equals([
        out('home')
      ])
    })
  })

  describe('credits a catch nobody was named for, by the rules the scorer gave', function () {
    const catchOut: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    it('gives a caught foul to the corner infielder away from the batter, ball in play or not', function () {
      const [inPlay, result] = playDefaults(game().session, [
        { type: 'result', eventType: 'field_out', foulCaught: true }
      ])
      expect(inPlay).deep.include({
        type: 'ballInPlay',
        fielder: 12,
        trajectory: 'popup'
      })
      expect(result).deep.include({ outBy: 'catch' })
      const state = settle(
        say(game(), {
          type: 'result',
          eventType: 'field_out',
          foulCaught: true
        })
      )
      expect(state.session.liveData.linescore.outs).equals(1)
    })

    it('gives a fly sent a direction to that outfielder, the gaps to center', function () {
      const fielderFor = (
        direction: 'left' | 'left_center' | 'right'
      ): number | undefined => {
        const [inPlay] = playDefaults(game().session, [
          { type: 'ballInPlay', contact: 'swing', direction },
          catchOut
        ])
        return inPlay.type === 'ballInPlay' ? inPlay.fielder : undefined
      }
      expect([
        fielderFor('left'),
        fielderFor('left_center'),
        fielderFor('right')
      ]).deep.equals([16, 17, 18])
      const state = settle(
        say(
          game(),
          { type: 'ballInPlay', contact: 'swing', direction: 'left_center' },
          catchOut
        )
      )
      expect(state.session.liveData.linescore.outs).equals(1)
    })

    it('asks who caught it when nothing says, with the whole sentence in each answer', function () {
      const sentence: ScoringAction[] = [
        { type: 'ballInPlay', contact: 'swing' },
        catchOut
      ]
      const question = sentenceQuestion(game().session, 'Fly out.', sentence)!
      expect(question.question).equals('Who caught it?')
      expect(question.options).to.have.length(9)
      expect(question.options![6].actions).deep.equals([
        { type: 'ballInPlay', contact: 'swing', fielder: 16 },
        catchOut
      ])
      // With no ball in play, the answer brings one.
      expect(
        sentenceQuestion(game().session, 'Fly out.', [catchOut])!.options![7]
          .actions
      ).deep.equals([
        { type: 'ballInPlay', contact: 'swing', fielder: 17 },
        catchOut
      ])
      const asked = say(game(), ...sentence)
      expect(asked.dictationQuestion?.question).equals('Who caught it?')
      const answered = settle(
        scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 7 })
      )
      expect(answered.session.liveData.linescore.outs).equals(1)
    })

    it('does not send the batter out as well as the catch', function () {
      expect(
        playDefaults(game().session, [
          { type: 'ballInPlay', contact: 'swing', fielder: 12 },
          { type: 'result', eventType: 'field_out', foulCaught: true },
          { type: 'runnerMovement', runner: BATTER, to: '1B', out: true }
        ]).map(action => action.type)
      ).deep.equals(['ballInPlay', 'result'])
    })
  })

  it('reorders only a result followed at once by its own ball in play', function () {
    const hbp: ScoringAction = { type: 'result', eventType: 'hit_by_pitch' }
    const bip: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      fielder: 17
    }
    const fly: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    expect(
      playDefaults(game().session, [hbp, bip, fly]).map(action => action.type)
    ).deep.equals(['result', 'ballInPlay', 'result'])
    // The second batter's catch, result first, is put right.
    expect(
      playDefaults(game().session, [hbp, fly, bip]).map(action => action.type)
    ).deep.equals(['result', 'ballInPlay', 'result'])
  })

  it('asks who caught a ball the words name a fielder for but the actions do not', function () {
    const foul: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      foulCaught: true
    }
    const named = playDefaults(
      game().session,
      [foul],
      'He fouled out to the catcher.'
    )
    expect(named[0]).deep.include({ type: 'ballInPlay' })
    expect(named[0]).not.to.have.property('fielder')
    expect(
      sentenceQuestion(game().session, 'He fouled out to the catcher.', named)
        ?.question
    ).equals('Who caught it?')
    const asked = sayAs('He fouled out to the catcher.', game(), foul)
    expect(asked.dictationQuestion?.question).equals('Who caught it?')
    // Nobody named: the corner infielder away from the batter.
    expect(
      playDefaults(game().session, [foul], 'Foul ball caught.')[0]
    ).deep.include({
      fielder: 12
    })
    // A direction with no fielder named in the words is its outfielder's;
    // with one named that the model left out, the screen asks.
    const fly = (words: string): ScoringAction =>
      playDefaults(
        game().session,
        [
          { type: 'ballInPlay', contact: 'swing', direction: 'left' },
          { type: 'result', eventType: 'field_out', outBy: 'catch' }
        ],
        words
      )[0]
    expect(fly('Fly out to left.')).deep.include({ fielder: 16 })
    expect(
      fly('Pop up to shallow left, the shortstop makes the catch.')
    ).not.to.have.property('fielder')
    // A foul's side in the words: "to first" is the first baseman's.
    expect(
      playDefaults(game().session, [foul], 'He fouled out to first.')[0]
    ).deep.include({ fielder: 12 })
  })

  it('puts a ball in play ahead of its result, past runners moving, and leaves an earlier batter alone', function () {
    const hbp: ScoringAction = { type: 'result', eventType: 'hit_by_pitch' }
    const bip: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      fielder: 17
    }
    const fly: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const move: ScoringAction = {
      type: 'runnerMovement',
      runner: 7,
      to: 'home'
    }
    const types = (actions: ScoringAction[]): string[] =>
      actions.map(action => action.type)
    expect(types(playDefaults(game().session, [hbp, bip, fly]))).deep.equals([
      'result',
      'ballInPlay',
      'result'
    ])
    expect(types(playDefaults(game().session, [hbp, fly, bip]))).deep.equals([
      'result',
      'ballInPlay',
      'result'
    ])
    expect(
      types(playDefaults(game({ third: 7 }).session, [fly, move, bip]))
    ).deep.equals(['ballInPlay', 'result', 'runnerMovement'])
    const state = settle(say(game({ third: 7 }), fly, move, bip))
    expect(state.session.liveData.linescore.outs).equals(1)
    // Two batters' catches: the second one's own fielder is asked for.
    const second = sentenceQuestion(game().session, 'said', [
      { type: 'ballInPlay', contact: 'swing', fielder: 17 },
      fly,
      { type: 'ballInPlay', contact: 'swing' },
      fly
    ])!
    expect(second.options![7].actions[2]).deep.equals({
      type: 'ballInPlay',
      contact: 'swing',
      fielder: 17
    })
  })

  it('establishes a late fielder choice result without changing relay geometry or crossing play boundaries', function () {
    const bip: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'ground_ball',
      fielder: 15
    }
    const choice: ScoringAction = {
      type: 'result',
      eventType: 'fielders_choice'
    }
    const move: ScoringAction = {
      type: 'runnerMovement',
      runner: 6,
      to: '2B',
      out: true,
      fielders: [15, 13],
      locations: [
        { x: -10, z: 20 },
        { x: 0, z: 30 }
      ]
    }
    const before = game({ first: 6 }).session
    const expected = playDefaults(before, [bip, choice, move])
    expect(playDefaults(before, [bip, move, choice])).deep.equals(expected)
    // A second ball in play or another result ends the first play's block.
    const single: ScoringAction = { type: 'result', eventType: 'single' }
    for (const boundary of [bip, single]) {
      const normalized = playDefaults(before, [bip, move, boundary, choice])
      expect(normalized.slice(0, 2)).deep.equals([expected[0], expected[2]])
      expect(normalized[2]).deep.equals(boundary)
    }
  })

  it('gives a steal or a caught stealing to the runner who could have tried it', function () {
    const caught = (
      runner: number,
      to: '2B' | '3B',
      fielders?: number[]
    ): ScoringAction => ({
      type: 'baseRunning',
      kind: 'caught_stealing',
      runner,
      to,
      ...(fielders == null ? {} : { fielders })
    })
    const both = game({ first: 5, second: 6 })
    // Sent for the runner on first, into an occupied second: the runner on
    // second's, at third. The fielders guessed for second are dropped, and
    // the catcher's throw to the third baseman is credited.
    expect(stealsByBase(both.session, [caught(5, '2B', [11, 14])])).deep.equals(
      [caught(6, '3B', [11, 15])]
    )
    // Only he could have tried: nothing to ask.
    expect(
      sentenceQuestion(both.session, "Ball, and he's caught stealing.", [
        { type: 'pitch', call: 'B' },
        caught(6, '3B')
      ])
    ).equals(undefined)
    // A pickoff can be of either runner.
    const pickoff = sentenceQuestion(both.session, 'Picked off.', [
      { type: 'baseRunning', kind: 'pickoff', runner: 5, to: '2B' }
    ])!
    expect(pickoff.question).equals('Who was picked off?')
    expect(pickoff.options!.map(option => option.label)).deep.equals([
      `${both.session.gameData.players[6].fullName} picked off second`,
      `${both.session.gameData.players[5].fullName} picked off first`
    ])
  })

  it('lets a second batter’s named catcher leave the first batter’s default alone', function () {
    const sentence = playDefaults(
      game().session,
      [
        { type: 'ballInPlay', contact: 'swing', direction: 'left' },
        { type: 'result', eventType: 'field_out', outBy: 'catch' },
        { type: 'ballInPlay', contact: 'swing', fielder: 13 },
        { type: 'result', eventType: 'field_out', outBy: 'catch' }
      ],
      'Fly out to left. Next batter pops out to the second baseman.'
    )
    expect(sentence[0]).deep.include({ fielder: 16 })
    // A runner who tags up to third names no catcher.
    expect(
      playDefaults(
        game({ second: 6 }).session,
        [
          { type: 'ballInPlay', contact: 'swing', direction: 'right' },
          { type: 'result', eventType: 'field_out', outBy: 'catch' },
          { type: 'runnerMovement', runner: 6, to: '3B' }
        ],
        'Fly out to right, the runner tags up to third.'
      )[0]
    ).deep.include({ fielder: 18 })
  })

  it('settles the first batter’s ground out before the next batter’s play', function () {
    const sentence: ScoringAction[] = [
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      { type: 'ballInPlay', contact: 'swing', fielder: 17 },
      { type: 'result', eventType: 'field_out', outBy: 'catch' }
    ]
    const settled = settleBetween(game().session, sentence).actions
    expect(settled[2]).deep.include({
      type: 'runnerMovement',
      runner: BATTER,
      out: true
    })
    const state = settle(
      sayAs(
        'Grounds out to short. Next batter flies out to center.',
        game(),
        ...sentence
      )
    )
    expect(state.session.liveData.linescore.outs).equals(2)
  })

  it('says whose ball it was when a two-batter sentence asks who caught it', function () {
    const fly: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const question = sentenceQuestion(game().session, 'said', [
      { type: 'ballInPlay', contact: 'swing' },
      fly,
      { type: 'ballInPlay', contact: 'swing', fielder: 17 },
      fly
    ])!
    expect(question.question).equals(
      `Who caught ${game().session.gameData.players[BATTER].fullName}'s ball?`
    )
  })

  it('leaves a ball in play with its own result to the next batter', function () {
    const double: ScoringAction = { type: 'result', eventType: 'double' }
    const bip: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      fielder: 17
    }
    const fly: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    expect(
      playDefaults(game().session, [double, bip, fly]).map(
        action => action.type
      )
    ).deep.equals(['result', 'ballInPlay', 'result'])
  })

  it('steals one base at a time unless the words say, and picks off the runner on the base named', function () {
    const both = game({ first: 5, second: 6 })
    const home: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 5,
      to: 'home'
    }
    // "Double steal" sent as the runner on first going home: one base.
    expect(
      stealsByBase(
        both.session,
        [home, { type: 'baseRunning', kind: 'steal', runner: 6, to: '3B' }],
        "It's a double steal."
      )[0]
    ).deep.equals({ type: 'baseRunning', kind: 'steal', runner: 5, to: '2B' })
    // Said, it stands.
    expect(
      stealsByBase(
        game({ first: 5 }).session,
        [{ type: 'baseRunning', kind: 'steal', runner: 5, to: '3B' }],
        'He steals third.'
      )
    ).deep.equals([{ type: 'baseRunning', kind: 'steal', runner: 5, to: '3B' }])
    expect(
      stealsByBase(
        both.session,
        [{ type: 'baseRunning', kind: 'pickoff', runner: 5, to: '2B' }],
        'Picked off at second.'
      )
    ).deep.equals([
      {
        type: 'baseRunning',
        kind: 'pickoff',
        runner: 6,
        to: '2B',
        fielders: [10, 14]
      }
    ])
  })

  it('moves nobody up when the words name the runner or the base', function () {
    const steal: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 5,
      to: '2B'
    }
    const both = game({ first: 5, second: 6 })
    expect(
      stealsByBase(
        both.session,
        [steal],
        'Ball, the runner on first steals second.'
      )
    ).deep.equals([steal])
    expect(
      stealsByBase(both.session, [steal], 'Ball, and he steals.')
    ).deep.equals([{ type: 'baseRunning', kind: 'steal', runner: 6, to: '3B' }])
  })

  it('keeps a pickoff’s fielders with the runner at the base they were sent for', function () {
    const both = game({ first: 5, second: 6 })
    const question = sentenceQuestion(
      both.session,
      'Picked off, pitcher to shortstop.',
      [
        {
          type: 'baseRunning',
          kind: 'pickoff',
          runner: 5,
          to: '2B',
          fielders: [10, 14]
        }
      ]
    )!
    const [second, first] = question.options!.map(option => option.actions[0])
    expect(second).deep.include({ runner: 6, fielders: [10, 14] })
    expect(first).not.to.have.property('fielders')
  })

  it('asks how a ball in play ended when nothing says', function () {
    const bip: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      fielder: SS
    }
    const home: ScoringAction = {
      type: 'runnerMovement',
      runner: 7,
      to: 'home',
      out: true
    }
    const question = sentenceQuestion(
      game({ third: 7 }).session,
      'Ground ball.',
      [bip, home]
    )!
    expect(question.question).equals('What happened on the play?')
    expect(question.options!.map(option => option.label)).deep.equals([
      'Caught for an out',
      'Thrown out',
      "Fielder's choice",
      'Single',
      'Double',
      'Triple',
      'Home run',
      'Reached on an error'
    ])
    expect(question.options![1].actions).deep.equals([
      bip,
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      home
    ])
  })

  it('asks who stole when the words name no base and no runner, and two could have', function () {
    const first: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 5,
      to: '2B'
    }
    const on = game({ first: 5, third: 7 })
    const question = sentenceQuestion(on.session, 'He steals.', [first])!
    expect(question.question).equals('Who stole?')
    expect(question.options!.map(option => option.actions)).deep.equals([
      [{ type: 'baseRunning', kind: 'steal', runner: 7, to: 'home' }],
      [first],
      [{ type: 'baseRunning', kind: 'steal', runner: 7, to: 'home' }, first]
    ])
    // With its pitch too, the answer keeps the pitch; "the first pitch"
    // names no base.
    const ball: ScoringAction = { type: 'pitch', call: 'B' }
    const withPitch = sentenceQuestion(
      on.session,
      'Ball, and he steals on the first pitch.',
      [ball, first]
    )!
    expect(withPitch.options![1].actions).deep.equals([ball, first])
    // A runner named by number or as the lead runner is named.
    on.session.gameData.players[5].jersey = '2'
    expect(sentenceQuestion(on.session, 'Number two steals.', [first])).equals(
      undefined
    )
    expect(sentenceQuestion(on.session, '#2 steals.', [first])).equals(
      undefined
    )
    expect(
      sentenceQuestion(on.session, 'The lead runner steals.', [first])
    ).equals(undefined)
    // A base or a runner said, a double steal, an answer, or one runner on:
    // nothing to ask.
    expect(sentenceQuestion(on.session, 'He steals second.', [first])).equals(
      undefined
    )
    const name = on.session.gameData.players[5].fullName.split(' ')[0]
    expect(sentenceQuestion(on.session, `${name} steals.`, [first])).equals(
      undefined
    )
    expect(
      sentenceQuestion(on.session, 'Double steal.', [
        first,
        { type: 'baseRunning', kind: 'steal', runner: 7, to: 'home' }
      ])
    ).equals(undefined)
    expect(sentenceQuestion(on.session, 'He steals.', [first], true)).equals(
      undefined
    )
    expect(
      sentenceQuestion(game({ first: 5 }).session, 'He steals.', [first])
    ).equals(undefined)
    // With first and second on, only the lead runner can steal alone.
    const both = sentenceQuestion(
      game({ first: 5, second: 6 }).session,
      'He steals.',
      [first]
    )!
    expect(
      both.options!.map(option => option.label.split(' steals')[0].length > 0)
    ).to.have.length(2)
  })

  it('puts out the runner an answer names, on the base he was picked off', function () {
    const both = game({ first: 5, second: 6 })
    const asked = sayAs(
      'Ball, and he is picked off.',
      both,
      {
        type: 'pitch',
        call: 'B'
      },
      { type: 'baseRunning', kind: 'pickoff', runner: 5 }
    )
    const question = asked.dictationQuestion!
    expect(question.options!.map(option => option.label)).deep.equals([
      'Player 6 picked off second',
      'Player 5 picked off first'
    ])
    const first = settle(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 1 })
    )
    expect(bases(first)).deep.equals([null, 6, null])
    expect(first.session.liveData.linescore.outs).equals(1)
    // The base is the one the fielder who took the throw plays, over the
    // base sent.
    expect(
      stealsByBase(
        both.session,
        [
          {
            type: 'baseRunning',
            kind: 'pickoff',
            runner: 6,
            to: '2B',
            fielders: [10, 12]
          }
        ],
        'The runner on first is picked off, pitcher to first.'
      )
    ).deep.equals([
      {
        type: 'baseRunning',
        kind: 'pickoff',
        runner: 5,
        to: '1B',
        fielders: [10, 12]
      }
    ])
  })

  it('keeps a steal to one base unless the words say the farther one alone', function () {
    const steal = (
      runner: number,
      to: 'home' | '3B' | '2B'
    ): ScoringAction => ({
      type: 'baseRunning',
      kind: 'steal',
      runner,
      to
    })
    expect(
      stealsByBase(
        game({ first: 5 }).session,
        [steal(5, '3B')],
        'He steals second.'
      )
    ).deep.equals([steal(5, '2B')])
    expect(
      stealsByBase(
        game({ first: 5, second: 6 }).session,
        [steal(6, 'home'), steal(5, '3B')],
        'Double steal, runners to second and third.'
      )
    ).deep.equals([steal(6, '3B'), steal(5, '2B')])
    expect(
      stealsByBase(
        game({ first: 5, second: 6 }).session,
        [
          {
            type: 'baseRunning',
            kind: 'caught_stealing',
            runner: 5,
            to: '2B',
            fielders: [11, 14]
          },
          steal(6, 'home')
        ],
        'Double steal, the runner on first is thrown out at second, catcher to short.'
      )[1]
    ).deep.equals(steal(6, '3B'))
    // Home said, from third.
    expect(
      stealsByBase(
        game({ third: 7 }).session,
        [steal(7, 'home')],
        'He steals home.'
      )
    ).deep.equals([steal(7, 'home')])
  })

  it('asks who caught a ball the words give an infielder, and credits the one they give a foul', function () {
    const caught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const sent = (direction: 'right' | 'center'): ScoringAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'popup',
      direction
    })
    for (const [words, direction] of [
      ['Pops out to second.', 'right'],
      ['Lines out to third.', 'center'],
      ['Line drive to short, caught.', 'center'],
      [
        'Fly out to shallow center, the second baseman makes a nice catch.',
        'center'
      ],
      ['Fly out to shallow right, the second baseman grabs it.', 'right']
    ] as const)
      expect(
        playDefaults(game().session, [sent(direction), caught], words)[0],
        words
      ).not.to.have.property('fielder')
    const foul: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'field_out', foulCaught: true }
    ]
    expect(
      playDefaults(game().session, foul, 'Foul pop to first.')[0]
    ).deep.include({ fielder: 12 })
    expect(
      playDefaults(
        game().session,
        foul,
        'Foul pop to first, the runner tags up and goes to third.'
      )[0]
    ).deep.include({ fielder: 12 })
    // A runner's "to third" is not the foul's side.
    const away = (
      playDefaults(game().session, foul, 'Foul pop out.')[0] as {
        fielder: number
      }
    ).fielder
    expect(
      playDefaults(
        game({ second: 6 }).session,
        foul,
        'Foul pop out, the runner on second tags up to third.'
      )[0]
    ).deep.include({ fielder: away })
  })

  it('keeps each result-first batted ball with its own result', function () {
    const bip = (direction: 'left' | 'center'): ScoringAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      direction,
      ...(direction === 'left' ? { fielder: LF } : {})
    })
    const said: ScoringAction[] = [
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      bip('left'),
      { type: 'result', eventType: 'single' },
      bip('center')
    ]
    expect(
      playDefaults(game().session, said).map(action =>
        action.type === 'result' ? action.eventType : action.type
      )
    ).deep.equals(['ballInPlay', 'field_out', 'ballInPlay', 'single'])
    const state = settle(
      sayAs('Fly out to left. Next batter singles to center.', game(), ...said)
    )
    expect(state.dictationQuestion).equals(undefined)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('puts the batter out on a ground out that moved a runner up, whenever his out is said', function () {
    const toSecond: ScoringAction = {
      type: 'runnerMovement',
      runner: 5,
      to: '2B'
    }
    const thrown: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'throw'
    }
    for (const said of [
      [grounder, thrown, toSecond],
      [
        grounder,
        thrown,
        toSecond,
        { type: 'runnerMovement', runner: BATTER, to: '1B', out: true }
      ]
    ] as ScoringAction[][]) {
      const state = settle(
        sayAs(
          'Ground out to short, the runner moves up to second.',
          game({ first: 5 }),
          ...said
        )
      )
      expect(state.dictation?.problem).equals(undefined)
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(bases(state)).deep.equals([null, 5, null])
      nothingToTap(state)
    }
  })

  it('takes a runner said to reach the base the hit already gave him', function () {
    const state = settle(
      sayAs(
        'Single to left, the runner goes to third. Next batter singles to left, runner scores.',
        game({ second: 7 }),
        { type: 'ballInPlay', contact: 'swing', fielder: LF },
        { type: 'result', eventType: 'single' },
        { type: 'runnerMovement', runner: 7, to: '3B' },
        { type: 'ballInPlay', contact: 'swing', fielder: LF },
        { type: 'result', eventType: 'single' },
        { type: 'runnerMovement', runner: 7, to: 'home' }
      )
    )
    expect(state.dictation?.problem).equals(undefined)
    expect(bases(state)).deep.equals([2, BATTER, null])
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
  })

  it('asks what a first batter’s play needs before the next batter’s, answered as the whole sentence', function () {
    const single: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: LF },
      { type: 'result', eventType: 'single' }
    ]
    const asked = sayAs(
      "Ground ball to short, he reaches on a fielder's choice. Next batter singles to left.",
      game({ first: 5, second: 6 }),
      grounder,
      choice,
      ...single
    )
    expect(asked.dictation?.problem).equals(undefined)
    expect(asked.dictationQuestion?.question).equals(
      "Which runners were out on the fielder's choice?"
    )
    const answered = settle(
      scoringReducer(asked, { type: 'DICTATION_ANSWER', picks: [0] })
    )
    expect(answered.dictation?.problem).equals(undefined)
    expect(answered.session.liveData.linescore.outs).equals(1)
    expect(answered.past).to.have.length(1)
    const error = sayAs(
      'He reaches on an error. Next batter singles to left.',
      game(),
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'field_error' },
      ...single
    )
    expect(error.dictationQuestion?.question).equals('Who made the error?')
    const charged = settle(
      scoringReducer(error, { type: 'DICTATION_ANSWER', option: 5 })
    )
    expect(charged.dictation?.problem).equals(undefined)
    expect(bases(charged)[0]).not.equals(null)
    expect(bases(charged)[1]).not.equals(null)
  })

  it('splits a steal of home into a steal of the next base and the run the words say scored', function () {
    const steal = (
      runner: number,
      to: '2B' | '3B' | 'home'
    ): ScoringAction => ({
      type: 'baseRunning',
      kind: 'steal',
      runner,
      to
    })
    const home: ScoringAction = {
      type: 'runnerMovement',
      runner: 6,
      to: 'home'
    }
    const scores = 'He steals, and scores when the throw gets away.'
    const second = game({ second: 6 })
    expect(
      stealsByBase(second.session, [steal(6, 'home')], scores)
    ).deep.equals([steal(6, '3B'), home])
    const state = settle(sayAs(scores, second, steal(6, 'home')))
    expect(state.dictation?.problem).equals(undefined)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(state.log[0]).deep.equals(steal(6, '3B'))
    // Sent right, it is left as it is: no second run.
    expect(
      stealsByBase(second.session, [steal(6, '3B'), home], scores)
    ).deep.equals([steal(6, '3B'), home])
    // Only the runner's own words: another runner's score, one said not to
    // have scored, and one out trying are no run.
    const pair = game({ second: 6, third: 7 })
    expect(
      stealsByBase(
        pair.session,
        [steal(7, 'home'), steal(6, 'home')],
        'Double steal, the runner on third scores.'
      )
    ).deep.equals([steal(7, 'home'), steal(6, '3B')])
    for (const words of [
      'He steals, but does not score.',
      'He steals third, but is thrown out trying to score on the overthrow.'
    ])
      expect(
        stealsByBase(second.session, [steal(6, 'home')], words),
        words
      ).deep.equals([steal(6, '3B')])
    expect(
      stealsByBase(
        second.session,
        [steal(6, 'home')],
        'He steals, and races home when the throw gets away.'
      )
    ).deep.equals([steal(6, '3B'), home])
    // Another runner's part between commas is his, not the whole sentence.
    const named = game({ first: 5, second: 6 })
    named.session.gameData.players[5].firstName = 'Sub'
    named.session.gameData.players[6].firstName = 'Bench'
    expect(
      stealsByBase(
        named.session,
        [steal(6, 'home'), steal(5, '2B')],
        'Double steal, Sub takes second, Bench scores on the throw.'
      )
    ).deep.equals([steal(6, '3B'), home, steal(5, '2B')])
    // A part is about the runner it names first.
    expect(
      stealsByBase(
        pair.session,
        [steal(7, 'home'), steal(6, 'home')],
        'Double steal, the runner on second scores right behind the runner on third.'
      )
    ).deep.equals([
      steal(7, 'home'),
      steal(6, '3B'),
      { type: 'runnerMovement', runner: 6, to: 'home' }
    ])
    // Words before any runner is named are the stealing runner's; another
    // runner's piece is his.
    const firstAndSecond = game({ first: 5, second: 6 })
    for (const words of [
      'He steals third and scores on the throw while the runner on first holds.',
      'Double steal, the runner on first takes second as the runner on second scores on the throw.'
    ])
      expect(
        stealsByBase(
          firstAndSecond.session,
          [steal(6, 'home'), steal(5, '2B')],
          words
        ),
        words
      ).deep.equals([steal(6, '3B'), home, steal(5, '2B')])
    expect(
      stealsByBase(
        pair.session,
        [steal(7, 'home'), steal(6, 'home')],
        'Double steal, the runner on second stops at third as the runner on third scores.'
      )
    ).deep.equals([steal(7, 'home'), steal(6, '3B')])
    // Only a "not" or "trying to" about scoring takes the run away.
    for (const words of [
      "He steals third and scores when the third baseman can't handle the throw.",
      "He steals third and scores when the throw isn't caught.",
      'He tries to steal third, the throw gets away, he scores.',
      'He steals third, the throw gets away, he scores.'
    ])
      expect(
        stealsByBase(second.session, [steal(6, 'home')], words),
        words
      ).deep.equals([steal(6, '3B'), home])
    // Nothing said of a run: the steal of third alone.
    expect(
      stealsByBase(second.session, [steal(6, 'home')], 'He steals.')
    ).deep.equals([steal(6, '3B')])
    // From third, a steal of home.
    expect(
      stealsByBase(
        game({ third: 7 }).session,
        [steal(7, 'home')],
        'He steals home.'
      )
    ).deep.equals([steal(7, 'home')])
  })

  it('reads a steal’s bases from its own words, not another runner’s or the throw’s', function () {
    const steal = (
      runner: number,
      to: '2B' | '3B' | 'home'
    ): ScoringAction => ({
      type: 'baseRunning',
      kind: 'steal',
      runner,
      to
    })
    expect(
      stealsByBase(
        game({ first: 5, third: 7 }).session,
        [steal(7, 'home'), steal(5, '3B')],
        'Double steal, the runner on third steals home.'
      )
    ).deep.equals([steal(7, 'home'), steal(5, '2B')])
    const both = game({ first: 5, second: 6 })
    const late = 'Double steal, and the throw to third is late.'
    expect(
      stealsByBase(both.session, [steal(6, 'home'), steal(5, '3B')], late)
    ).deep.equals([steal(6, '3B'), steal(5, '2B')])
    const state = settle(sayAs(late, both, steal(6, 'home'), steal(5, '3B')))
    expect(state.dictation?.problem).equals(undefined)
    expect(bases(state)).deep.equals([null, 5, 6])
    // Another runner's "steals third" does not stretch this runner's steal.
    expect(
      stealsByBase(
        game({ first: 5, second: 6 }).session,
        [steal(6, 'home'), steal(5, '3B')],
        'Double steal, the runner on first takes off as the runner on second steals third.'
      )
    ).deep.equals([steal(6, '3B'), steal(5, '2B')])
    // Another runner by his base in other words is still another runner's.
    for (const words of [
      'Double steal, the runner from third steals home.',
      'Double steal, the runner at 3rd steals home.'
    ])
      expect(
        stealsByBase(
          game({ first: 5, third: 7 }).session,
          [steal(7, 'home'), steal(5, '3B')],
          words
        ),
        words
      ).deep.equals([steal(7, 'home'), steal(5, '2B')])
    // The base a throw went to is not the steal's; other steal words count;
    // never three bases.
    for (const words of [
      'He steals third without a throw.',
      'He swipes third.',
      'Stolen base, third.'
    ])
      expect(
        stealsByBase(game({ first: 5 }).session, [steal(5, '3B')], words),
        words
      ).deep.equals([steal(5, '3B')])
    expect(
      stealsByBase(
        game({ first: 5 }).session,
        [steal(5, 'home')],
        'He steals home.'
      )
    ).deep.equals([steal(5, '2B')])
    // Only the throw's own base is taken out, up to a comma.
    expect(
      stealsByBase(
        game({ first: 5 }).session,
        [steal(5, '3B')],
        'The throw is late, he slides in safe at third, stolen base.'
      )
    ).deep.equals([steal(5, '3B')])
    for (const words of [
      'Double steal, the kid on third steals home.',
      'Double steal, the runner over at third steals home.'
    ])
      expect(
        stealsByBase(
          game({ first: 5, third: 7 }).session,
          [steal(7, 'home'), steal(5, '3B')],
          words
        ),
        words
      ).deep.equals([steal(7, 'home'), steal(5, '2B')])
    // A runner's own words still say how far he went.
    expect(
      stealsByBase(
        game({ first: 5 }).session,
        [steal(5, '3B')],
        'The runner on first steals third.'
      )
    ).deep.equals([steal(5, '3B')])
  })

  it('reads a caught foul’s side only from words said of the foul', function () {
    const righty = (bases: { second?: number } = {}): ScoringState => {
      const state = game(bases)
      state.session.liveData.plays.currentPlay!.matchup.batSide = { code: 'R' }
      return state
    }
    const foul: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'field_out', foulCaught: true }
    ]
    const caughtBy = (words: string, bases = {}): unknown =>
      (
        playDefaults(righty(bases).session, foul, words)[0] as {
          fielder?: number
        }
      ).fielder
    expect(
      caughtBy('The runner on second tags up to third on the foul pop out.', {
        second: 6
      })
    ).equals(12)
    expect(
      caughtBy('Foul out and the runner goes to third.', { second: 6 })
    ).equals(12)
    expect(caughtBy('Foul pop to third.')).equals(15)
    expect(caughtBy('Foul ball down the third base line, caught.')).equals(15)
    expect(caughtBy('Fouled out near third.')).equals(15)
    expect(caughtBy('Foul pop-up to first.')).equals(12)
    // A runner's "to third" after "he", a name or a runner's verb is not the
    // foul's, with or without a comma.
    const runnerOn = righty({ second: 6 })
    runnerOn.session.gameData.players[6].firstName = 'Bench'
    for (const words of [
      'On the foul out he tags up to third.',
      'Foul out then Bench goes to third.',
      'Foul pop out, tagging up to third.',
      'Foul out, the throw to third is late.',
      'Foul out, sliding in safe at third.',
      'Foul out, over to third he goes.'
    ])
      expect(
        (playDefaults(runnerOn.session, foul, words)[0] as { fielder?: number })
          .fielder,
        words
      ).equals(12)
    for (const words of [
      'Foul pop, near third, caught.',
      'Foul pop, over by third, caught.',
      'He fouled out, caught near third.',
      'He fouls out to third.',
      'Foul pop fly to third.',
      'Foul popout to third.',
      'He pops out in foul territory near third.',
      'Foul ball caught by the third baseman.'
    ])
      expect(caughtBy(words), words).equals(15)
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

describe('a dictated throw credits the fielder who covered the base', function () {
  const PITCHER = 10
  const CATCHER = 11
  const CF = 17
  const RF = 18
  const RUNNER = 5
  function credits(state: ScoringState): string[] {
    const { allPlays, currentPlay } = state.session.liveData.plays
    const play =
      (currentPlay?.runners.length ?? 0) > 0 ? currentPlay : allPlays.at(-1)
    return (play?.runners ?? [])
      .flatMap(runner =>
        (runner.credits ?? []).map(c => `${c.credit} ${c.player.id}`)
      )
      .sort()
  }
  const outAt = (
    runner: number,
    to: '1B' | '2B' | '3B' | 'home',
    fielders?: number[]
  ): ScoringAction => ({
    type: 'runnerMovement',
    runner,
    to,
    out: true,
    ...(fielders == null ? {} : { fielders })
  })

  it('credits the second baseman when the third baseman fields, and the shortstop when the first baseman does', function () {
    const fromThird = settle(
      sayAs(
        'Ground ball to third. The runner is out at second, safe at first.',
        game({ first: RUNNER }),
        { ...grounder, fielder: THIRD_BASEMAN },
        choice,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(fromThird)).deep.equals(
      [
        `f_assist ${THIRD_BASEMAN}`,
        `f_putout ${SECOND_BASEMAN}`,
        `f_fielded_ball ${THIRD_BASEMAN}`
      ].sort()
    )
    const fromFirst = settle(
      sayAs(
        'Ground ball to first. The runner is out at second, safe at first.',
        game({ first: RUNNER }),
        { ...grounder, fielder: FIRST_BASEMAN },
        choice,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(fromFirst)).deep.equals(
      [
        `f_assist ${FIRST_BASEMAN}`,
        `f_putout ${SS}`,
        `f_fielded_ball ${FIRST_BASEMAN}`
      ].sort()
    )
    // A chain the model sent is kept, including one the cover rule would not choose.
    const sent = playDefaults(
      game({ first: RUNNER }).session,
      [
        { ...grounder, fielder: THIRD_BASEMAN },
        choice,
        outAt(RUNNER, '2B', [THIRD_BASEMAN, SS])
      ],
      'Ground ball to third, out at second to the shortstop.'
    )
    expect(sent.find(action => action.type === 'runnerMovement')).deep.include({
      fielders: [THIRD_BASEMAN, SS]
    })
  })

  it('credits a player the scorer named at second ahead of the cover', function () {
    const named = game({ first: RUNNER })
    named.session.gameData.players[SECOND_BASEMAN].fullName = 'Fari Cole'
    const toFari = settle(
      sayAs(
        'Ground ball to first, throw to second to Fari, safe at first.',
        named,
        { ...grounder, fielder: FIRST_BASEMAN },
        choice,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(toFari)).to.include(`f_putout ${SECOND_BASEMAN}`)
    expect(credits(toFari)).to.not.include(`f_putout ${SS}`)
    const john = game({ first: RUNNER })
    john.session.gameData.players[SS].fullName = 'John Hale'
    const threwOn = settle(
      sayAs(
        "Ground ball to third, out at second, but John's throw to first is late.",
        john,
        { ...grounder, fielder: THIRD_BASEMAN },
        choice,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(threwOn)).to.include(`f_putout ${SS}`)
    expect(credits(threwOn)).to.not.include(`f_putout ${SECOND_BASEMAN}`)
  })

  it('credits the infielder a ground ball was hit to when the play left him off', function () {
    const third = settle(
      sayAs(
        'Grounder to third, thrown out at first.',
        game(),
        { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
        { type: 'result', eventType: 'field_out', outBy: 'throw' }
      )
    )
    expect(credits(third)).deep.equals(
      [`f_assist ${THIRD_BASEMAN}`, `f_putout ${FIRST_BASEMAN}`].sort()
    )
    const short = settle(
      sayAs(
        'Sacrifice bunt to the shortstop, thrown out at first.',
        game(),
        { type: 'ballInPlay', contact: 'bunt', trajectory: 'ground_ball' },
        { type: 'result', eventType: 'field_out', outBy: 'throw' }
      )
    )
    expect(credits(short)).deep.equals(
      [`f_assist ${SS}`, `f_putout ${FIRST_BASEMAN}`].sort()
    )
  })

  it('credits the center fielder for a gap unless the scorer named someone', function () {
    const caught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const gap = (fielder: number): ScoringAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'popup',
      direction: 'right_center',
      fielder
    })
    expect(
      playDefaults(
        game().session,
        [gap(RF), caught],
        'Pop fly to right center, caught.'
      )[0]
    ).deep.include({ fielder: CF })
    const william = game()
    william.session.gameData.players[RF].fullName = 'William Park'
    expect(
      playDefaults(
        william.session,
        [gap(RF), caught],
        'Pop fly to right center, William catches it.'
      )[0]
    ).deep.include({ fielder: RF })
  })

  it('credits the fielder who caught the fly and the one who took the throw, second included', function () {
    const fly = (fielder: number): ScoringAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'popup',
      fielder
    })
    const caught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const fromLeft = settle(
      sayAs(
        'Pop fly to left, the runner tags and is thrown out at second.',
        game({ first: RUNNER }),
        fly(LF),
        caught,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(fromLeft)).deep.equals(
      [`f_putout ${LF}`, `f_assist ${LF}`, `f_putout ${SS}`].sort()
    )
    const fromThird = settle(
      sayAs(
        'Pop up to third, the runner tags and is thrown out at second.',
        game({ first: RUNNER }),
        fly(THIRD_BASEMAN),
        caught,
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(fromThird)).deep.equals(
      [
        `f_putout ${THIRD_BASEMAN}`,
        `f_assist ${THIRD_BASEMAN}`,
        `f_putout ${SECOND_BASEMAN}`
      ].sort()
    )
  })

  it('credits the outfielder for the direction on a hit, and the infielder at the base', function () {
    const state = settle(
      sayAs(
        'Single to right center, the runner is thrown out at second.',
        game({ first: RUNNER }),
        {
          type: 'ballInPlay',
          contact: 'swing',
          direction: 'right_center',
          fielder: RF
        },
        { type: 'result', eventType: 'single' },
        outAt(RUNNER, '2B')
      )
    )
    expect(credits(state)).to.include(`f_assist ${CF}`)
    expect(credits(state)).to.include(`f_putout ${SS}`)
    expect(credits(state)).to.not.include(`f_putout ${CF}`)
    expect(credits(state)).to.not.include(`f_assist ${RF}`)
  })

  it('credits a caught stealing to the catcher and the fielder at the base', function () {
    const third = settle(
      sayAs('He is thrown out at third.', game({ second: 6 }), {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 6,
        to: '3B'
      })
    )
    expect(credits(third)).deep.equals(
      [`f_assist ${CATCHER}`, `f_putout ${THIRD_BASEMAN}`].sort()
    )
    const second = settle(
      sayAs('Caught stealing at second.', game({ first: RUNNER }), {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: RUNNER,
        to: '2B'
      })
    )
    expect(credits(second)).deep.equals(
      [`f_assist ${CATCHER}`, `f_putout ${SS}`].sort()
    )
  })

  it('credits a pickoff that gets the runner to the pitcher, and a safe one to nobody', function () {
    const out = settle(
      sayAs('Picked him off at first.', game({ first: RUNNER }), {
        type: 'baseRunning',
        kind: 'pickoff',
        runner: RUNNER,
        to: '1B'
      })
    )
    expect(credits(out)).deep.equals(
      [`f_assist ${PITCHER}`, `f_putout ${FIRST_BASEMAN}`].sort()
    )
    const snap = settle(
      sayAs('The catcher picks him off at first.', game({ first: RUNNER }), {
        type: 'baseRunning',
        kind: 'pickoff',
        runner: RUNNER,
        to: '1B'
      })
    )
    expect(credits(snap)).deep.equals(
      [`f_assist ${CATCHER}`, `f_putout ${FIRST_BASEMAN}`].sort()
    )
    const safe = settle(
      sayAs('Pickoff attempt at first, safe.', game({ first: RUNNER }), {
        type: 'baseRunning',
        kind: 'pickoff_safe',
        runner: RUNNER,
        to: '1B'
      })
    )
    expect(
      credits(safe).filter(
        line => line.startsWith('f_assist') || line.startsWith('f_putout')
      )
    ).deep.equals([])
  })
})

describe('a dictated double play', function () {
  const RUNNER = 5
  const thrown: ScoringAction = {
    type: 'result',
    eventType: 'field_out',
    outBy: 'throw'
  }
  const to = (fielder: number): ScoringAction => ({ ...grounder, fielder })
  function credits(state: ScoringState): string[] {
    // The play just dictated: still open while a runner stays on, or else
    // the last one closed.
    const { allPlays, currentPlay } = state.session.liveData.plays
    const play =
      (currentPlay?.runners.length ?? 0) > 0 ? currentPlay : allPlays.at(-1)
    return (play?.runners ?? [])
      .flatMap(runner =>
        (runner.credits ?? []).map(c => `${c.credit} ${c.player.id}`)
      )
      .sort()
  }
  function turned(
    transcript: string,
    bases: { first?: number; second?: number; third?: number },
    ...actions: ScoringAction[]
  ): ScoringState {
    return settle(sayAs(transcript, game(bases), ...actions))
  }
  /** A double play's credits, in the order `credits` lists them. */
  const dp = (lead: number, pivot: number, end = FIRST_BASEMAN): string[] =>
    (lead === pivot
      ? [`f_putout ${pivot}`, `f_assist ${pivot}`, `f_putout ${end}`]
      : [
          `f_assist ${lead}`,
          `f_putout ${pivot}`,
          `f_assist ${pivot}`,
          `f_putout ${end}`
        ]
    ).sort()

  it('reads the position numbers said, over the fielders the model sent', function () {
    for (const words of [
      'Six four three double play.',
      '6-4-3 double play.',
      '643 double play.',
      'Six to four to three, double play.'
    ]) {
      // Grok 4.3's shape: the runner's out, and the batter's left out.
      const state = turned(
        words,
        { first: RUNNER },
        to(SECOND_BASEMAN),
        thrown,
        {
          type: 'runnerMovement',
          runner: RUNNER,
          to: '2B',
          out: true,
          fielders: [SS]
        }
      )
      expect(state.session.liveData.linescore.outs, words).equals(2)
      expect(bases(state), words).deep.equals([null, null, null])
      expect(credits(state), words).deep.equals(dp(SS, SECOND_BASEMAN))
      nothingToTap(state)
    }
  })

  it('reads two numbers right before the double play: the shortstop unassisted, then to first', function () {
    const state = turned(
      'Six-three double play.',
      { first: RUNNER },
      to(SS),
      thrown
    )
    expect(state.session.liveData.linescore.outs).equals(2)
    expect(credits(state)).deep.equals(dp(SS, SS))
  })

  it('credits the fielders said by where the ball went, the cover at second by rule', function () {
    for (const [fielder, pivot] of [
      [SS, SECOND_BASEMAN],
      [THIRD_BASEMAN, SECOND_BASEMAN],
      [SECOND_BASEMAN, SS],
      [10, SS]
    ]) {
      const state = turned(
        'Ground ball, double play.',
        { first: RUNNER },
        to(fielder),
        thrown
      )
      expect(state.session.liveData.linescore.outs, String(fielder)).equals(2)
      expect(credits(state), String(fielder)).deep.equals(dp(fielder, pivot))
    }
    // 3-6-3: the first baseman starts it and takes the throw back.
    const first = turned(
      'He fields it and they turn two.',
      { first: RUNNER },
      to(FIRST_BASEMAN),
      thrown
    )
    expect(credits(first)).deep.equals(dp(FIRST_BASEMAN, SS))
  })

  it('puts the forced runner out however Claude sent him, and keeps its chain', function () {
    const chain = [SECOND_BASEMAN, SS, FIRST_BASEMAN]
    for (const shape of [
      [{ type: 'runnerMovement', runner: RUNNER, to: 'home', fielders: chain }],
      [
        { type: 'runnerMovement', runner: RUNNER, to: 'home', fielders: chain },
        {
          type: 'runnerMovement',
          runner: BATTER,
          to: '1B',
          out: true,
          fielders: chain
        }
      ],
      [
        {
          type: 'runnerMovement',
          runner: RUNNER,
          to: 'home',
          fielders: [SECOND_BASEMAN, SS]
        },
        {
          type: 'runnerMovement',
          runner: BATTER,
          to: '1B',
          fielders: [SECOND_BASEMAN, FIRST_BASEMAN]
        }
      ]
    ] as ScoringAction[][]) {
      const state = turned(
        'Ground ball to second, they turn two.',
        { first: RUNNER },
        to(SECOND_BASEMAN),
        thrown,
        ...shape
      )
      expect(state.session.liveData.linescore.outs).equals(2)
      expect(state.session.liveData.linescore.teams.away.runs).equals(0)
      expect(credits(state)).deep.equals(dp(SECOND_BASEMAN, SS))
    }
  })

  it('replaces chains that could not be one double play', function () {
    const out = (
      runner: number,
      to: '1B' | '2B',
      fielders: number[]
    ): ScoringAction => ({
      type: 'runnerMovement',
      runner,
      to,
      out: true,
      fielders
    })
    for (const [fielder, shape, lead, pivot] of [
      // Claude: the first baseman taking the throw at second.
      [
        SECOND_BASEMAN,
        [
          out(RUNNER, '2B', [SECOND_BASEMAN, FIRST_BASEMAN]),
          out(BATTER, '1B', [FIRST_BASEMAN])
        ],
        SECOND_BASEMAN,
        SS
      ],
      // Claude: the throw to first not from the pivot.
      [
        SECOND_BASEMAN,
        [
          out(RUNNER, '2B', [SECOND_BASEMAN, SS]),
          out(BATTER, '1B', [SECOND_BASEMAN, FIRST_BASEMAN])
        ],
        SECOND_BASEMAN,
        SS
      ],
      [
        SS,
        [
          out(RUNNER, '2B', [SS, SECOND_BASEMAN]),
          out(BATTER, '1B', [SS, FIRST_BASEMAN])
        ],
        SS,
        SECOND_BASEMAN
      ],
      // Grok 4.3: the shortstop named on both outs.
      [
        SS,
        [out(RUNNER, '2B', [SS]), out(BATTER, '1B', [SS])],
        SS,
        SECOND_BASEMAN
      ],
      // Sol: the second baseman named alone, then to first.
      [
        SECOND_BASEMAN,
        [
          out(RUNNER, '2B', [SECOND_BASEMAN]),
          out(BATTER, '1B', [SECOND_BASEMAN, FIRST_BASEMAN])
        ],
        SECOND_BASEMAN,
        SS
      ]
    ] as Array<[number, ScoringAction[], number, number]>) {
      const state = turned(
        'They turn two.',
        { first: RUNNER },
        to(fielder),
        thrown,
        ...shape
      )
      expect(state.session.liveData.linescore.outs).equals(2)
      expect(credits(state), JSON.stringify(shape)).deep.equals(dp(lead, pivot))
    }
  })

  it('reads the fielder who fielded it, sent alone on the runner’s out, as the usual double play, unless he took the base himself', function () {
    const sent: ScoringAction = {
      type: 'runnerMovement',
      runner: RUNNER,
      to: '2B',
      out: true,
      fielders: [SS]
    }
    const usual = turned(
      'The shortstop fields it, double play.',
      { first: RUNNER },
      to(SS),
      thrown,
      sent
    )
    expect(credits(usual)).deep.equals(dp(SS, SECOND_BASEMAN))
    const himself = turned(
      'The shortstop steps on second and throws to first, double play.',
      { first: RUNNER },
      to(SS),
      thrown,
      sent
    )
    expect(credits(himself)).deep.equals(dp(SS, SS))
  })

  it('keeps two outs the model chained as one double play, and a run that scored', function () {
    const chained = turned(
      'The third baseman throws to the shortstop, who turns two.',
      { first: RUNNER },
      to(THIRD_BASEMAN),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [THIRD_BASEMAN, SS]
      },
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        out: true,
        fielders: [SS, FIRST_BASEMAN]
      }
    )
    expect(credits(chained)).deep.equals(dp(THIRD_BASEMAN, SS))
    const scored = turned(
      'Ground ball to second, they turn two, the run scores.',
      { first: RUNNER, third: 7 },
      to(SECOND_BASEMAN),
      thrown,
      { type: 'runnerMovement', runner: 7, to: 'home' }
    )
    expect(scored.session.liveData.linescore.outs).equals(2)
    expect(scored.session.liveData.linescore.teams.away.runs).equals(1)
    expect(credits(scored)).deep.equals(dp(SECOND_BASEMAN, SS))
  })

  it('takes the throw home to the catcher when the runner put out was at home', function () {
    const state = turned(
      'Ground ball to short, home to first, double play.',
      { third: 7 },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: 7, to: 'home', out: true }
    )
    expect(state.session.liveData.linescore.outs).equals(2)
    expect(state.session.liveData.linescore.teams.away.runs).equals(0)
    expect(credits(state)).deep.equals(dp(SS, 11))
  })

  it('leaves a double play the words say did not happen a fielder’s choice', function () {
    const choiceOut: ScoringAction = {
      type: 'runnerMovement',
      runner: RUNNER,
      to: '2B',
      out: true,
      fielders: [SS, SECOND_BASEMAN]
    }
    for (const words of [
      'Ground ball to short, they couldn’t turn two, the runner is out at second and the batter is safe at first.',
      'Force out at second, no double play.',
      'Six four, they try to turn two but the batter beats the throw.'
    ]) {
      const state = turned(words, { first: RUNNER }, to(SS), choice, choiceOut)
      expect(state.session.liveData.linescore.outs, words).equals(1)
      expect(bases(state), words).deep.equals([BATTER, null, null])
    }
  })

  it('makes a runner out and the batter safe, as the words say, a fielder’s choice', function () {
    const state = turned(
      'Force out at second, no double play.',
      { first: RUNNER },
      to(SS),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [SECOND_BASEMAN]
      }
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(bases(state)).deep.equals([BATTER, null, null])
  })

  it('makes up no fielders the words do not name, however the model chains them', function () {
    const state = turned(
      'Ground ball to the first baseman, he throws to second and gets the return throw, double play.',
      { first: RUNNER },
      to(FIRST_BASEMAN),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [FIRST_BASEMAN, SECOND_BASEMAN]
      },
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        out: true,
        fielders: [SECOND_BASEMAN, FIRST_BASEMAN]
      }
    )
    expect(credits(state)).deep.equals(dp(FIRST_BASEMAN, SS))
  })

  it('is a double play said with "go for", "try to" or "almost beat the throw"', function () {
    const both: ScoringAction[] = [
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [SS, SECOND_BASEMAN]
      },
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        out: true,
        fielders: [SECOND_BASEMAN, FIRST_BASEMAN]
      }
    ]
    for (const words of [
      'Ground ball to short, they go for the double play and get it.',
      'Ground ball to short, they try to turn two and they get both.',
      'Six four three double play, the batter almost beat the throw.',
      'Ground ball to short not even close double play'
    ]) {
      const state = turned(words, { first: RUNNER }, to(SS), thrown, ...both)
      expect(state.session.liveData.linescore.outs, words).equals(2)
      expect(credits(state), words).deep.equals(dp(SS, SECOND_BASEMAN))
    }
  })

  it('does not read a runner beating the throw home as the batter safe', function () {
    const home = turned(
      'Fly out to center, the runner on third tags and beats the throw home, and the runner on second is thrown out at third.',
      { second: 6, third: 7 },
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: 17
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 7, to: 'home' },
      {
        type: 'runnerMovement',
        runner: 6,
        to: '3B',
        out: true,
        fielders: [17, THIRD_BASEMAN]
      }
    )
    expect(home.session.liveData.linescore.outs).equals(2)
    expect(home.session.liveData.linescore.teams.away.runs).equals(1)
  })

  it('reads the chain on a chopper and a ball down the line', function () {
    for (const [words, fielder, trajectory, lead] of [
      ['Chopper to short, six four three double play.', SS, 'chopper', SS],
      [
        'Hard ground ball down the third base line, five four three double play.',
        THIRD_BASEMAN,
        'ground_ball',
        THIRD_BASEMAN
      ]
    ] as const) {
      const state = turned(
        words,
        { first: RUNNER },
        { type: 'ballInPlay', contact: 'swing', trajectory, fielder },
        thrown,
        {
          type: 'runnerMovement',
          runner: RUNNER,
          to: '2B',
          out: true,
          fielders: [FIRST_BASEMAN]
        }
      )
      expect(state.session.liveData.linescore.outs, words).equals(2)
      expect(credits(state), words).deep.equals(dp(lead, SECOND_BASEMAN))
    }
  })

  it('credits the fielders the words name taking the throws, over the chains Claude sent', function () {
    const out = (
      runner: number,
      to: '1B' | '2B',
      fielders: number[]
    ): ScoringAction => ({
      type: 'runnerMovement',
      runner,
      to,
      out: true,
      fielders
    })
    for (const [words, fielder, shape, expected] of [
      [
        'Ground ball to third, he throws to the shortstop covering second, on to first, double play.',
        THIRD_BASEMAN,
        [
          out(RUNNER, '2B', [SS, FIRST_BASEMAN]),
          out(BATTER, '1B', [FIRST_BASEMAN])
        ],
        dp(THIRD_BASEMAN, SS)
      ],
      [
        'Comebacker, he throws to the second baseman, on to first, double play.',
        10,
        [
          out(RUNNER, '2B', [SECOND_BASEMAN, FIRST_BASEMAN]),
          out(BATTER, '1B', [FIRST_BASEMAN])
        ],
        dp(10, SECOND_BASEMAN)
      ],
      [
        'Ground ball to first, he throws to second, the pitcher covers first, double play.',
        FIRST_BASEMAN,
        [
          out(RUNNER, '2B', [FIRST_BASEMAN, SECOND_BASEMAN]),
          out(BATTER, '1B', [SECOND_BASEMAN, 10])
        ],
        dp(FIRST_BASEMAN, SS, 10)
      ],
      [
        'Ground ball to the first baseman, he throws to the shortstop, back to the first baseman, double play.',
        FIRST_BASEMAN,
        [],
        dp(FIRST_BASEMAN, SS)
      ]
    ] as Array<[string, number, ScoringAction[], string[]]>) {
      const state = turned(
        words,
        { first: RUNNER },
        to(fielder),
        thrown,
        ...shape
      )
      expect(state.session.liveData.linescore.outs, words).equals(2)
      expect(credits(state), words).deep.equals(expected)
    }
  })

  it('keeps the chain the model sent when the words account for every fielder in it', function () {
    const out = (
      runner: number,
      to: '1B' | '2B',
      fielders: number[]
    ): ScoringAction => ({
      type: 'runnerMovement',
      runner,
      to,
      out: true,
      fielders
    })
    const covering = turned(
      'Ground ball to third, he throws to the shortstop covering second, on to first, double play.',
      { first: RUNNER },
      to(THIRD_BASEMAN),
      thrown,
      out(RUNNER, '2B', [THIRD_BASEMAN, SS]),
      out(BATTER, '1B', [SS, FIRST_BASEMAN])
    )
    expect(credits(covering)).deep.equals(dp(THIRD_BASEMAN, SS))
    const pitcher = turned(
      'Ground ball to first, he throws to second, the pitcher covers first, double play.',
      { first: RUNNER },
      to(FIRST_BASEMAN),
      thrown,
      out(RUNNER, '2B', [FIRST_BASEMAN, SS]),
      out(BATTER, '1B', [SS, 10])
    )
    expect(credits(pitcher)).deep.equals(dp(FIRST_BASEMAN, SS, 10))
  })

  it('leaves a runner who holds where he is, unless another runner was sent to his base', function () {
    const held = turned(
      'Ground ball to short, they turn two, the runner on second holds.',
      { first: RUNNER, second: 6 },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: 6, to: '2B' }
    )
    expect(bases(held)).deep.equals([null, 6, null])
    const taken = turned(
      'Six four three double play.',
      { first: RUNNER, second: 6, third: 7 },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: 7, to: '3B' },
      { type: 'runnerMovement', runner: 6, to: '3B' }
    )
    expect(taken.dictation?.problem).equals(undefined)
    expect(bases(taken)).deep.equals([null, null, 6])
  })

  it('puts the runner from first out at second, not at home where the model sent him', function () {
    const state = turned(
      'Ground ball to second, they turn two.',
      { first: RUNNER },
      to(SECOND_BASEMAN),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: 'home',
        out: true,
        fielders: [SECOND_BASEMAN, SS, FIRST_BASEMAN]
      }
    )
    expect(credits(state)).deep.equals(dp(SECOND_BASEMAN, SS))
  })

  it('leaves a double play the words say failed a fielder’s choice, however it is put', function () {
    const choiceOut: ScoringAction = {
      type: 'runnerMovement',
      runner: RUNNER,
      to: '2B',
      out: true,
      fielders: [SS, SECOND_BASEMAN]
    }
    for (const words of [
      'Ground ball to short, they try to turn two but the relay is late.',
      'Ground ball to second, they almost turned two, the runner is out at second.',
      'Slow roller to short, no chance for a double play, they get the force at second.',
      'Force out at second, the relay is too late for the double play.',
      'Ground ball to short, they go for the double play but only get the lead runner.',
      'Ground ball to short, they try to turn two but the batter is safe.',
      'Ground ball to short, nearly a double play, but the batter beats it out.',
      'Ground ball to short, they get the runner at second, not in time for the double play.'
    ]) {
      const state = turned(words, { first: RUNNER }, to(SS), thrown, choiceOut)
      expect(state.session.liveData.linescore.outs, words).equals(1)
      expect(bases(state), words).deep.equals([BATTER, null, null])
    }
    // The runner's out sent before the result: still the lead runner out
    // and the batter safe.
    for (const shape of [
      [choiceOut, choice],
      [choiceOut, thrown]
    ] as ScoringAction[][]) {
      const state = turned(
        'Ground ball to short, they try to turn two but the relay is late.',
        { first: RUNNER },
        to(SS),
        ...shape
      )
      expect(state.dictation?.problem, JSON.stringify(shape)).equals(undefined)
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(bases(state)).deep.equals([BATTER, null, null])
    }
    // The batter put out, though the words say the relay to him was late:
    // the lead runner was the out.
    const late = turned(
      'Ground ball to short, they try to turn two but the relay is late.',
      { first: RUNNER },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: RUNNER, to: '2B' }
    )
    expect(late.session.liveData.linescore.outs).equals(1)
    expect(bases(late)).deep.equals([BATTER, null, null])
    // A late relay said without "but", or after a period, is the same.
    for (const words of [
      'Ground ball to short, they try to turn two, the relay is late.',
      'Ground ball to short, they try to turn two. But the relay is late.',
      'Ground ball to second, they go for the double play, too late at first.'
    ]) {
      for (const shape of [
        [thrown, { type: 'runnerMovement', runner: RUNNER, to: '2B' }],
        [thrown, choiceOut]
      ] as ScoringAction[][]) {
        const state = turned(words, { first: RUNNER }, to(SS), ...shape)
        expect(state.session.liveData.linescore.outs, words).equals(1)
        expect(bases(state), words).deep.equals([BATTER, null, null])
      }
    }
    // With no runner put out, the model's one out stands: the words may say
    // it was the batter's.
    const batterOnly = turned(
      'Ground ball to short, no double play, they only get the batter at first.',
      { first: RUNNER },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: RUNNER, to: '2B' }
    )
    expect(batterOnly.session.liveData.linescore.outs).equals(1)
    expect(bases(batterOnly)).deep.equals([null, RUNNER, null])
    // A real double play said with a try, and "but" for something else.
    const real = turned(
      'Ground ball to short, they go for the double play and get it, but the run scores.',
      { first: RUNNER, third: 7 },
      to(SS),
      thrown,
      { type: 'runnerMovement', runner: 7, to: 'home' },
      choiceOut,
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        out: true,
        fielders: [SECOND_BASEMAN, FIRST_BASEMAN]
      }
    )
    expect(real.session.liveData.linescore.outs).equals(2)
    expect(real.session.liveData.linescore.teams.away.runs).equals(1)
    // The model's own fielder's choice stands, unless numbers were said.
    const sent = turned(
      'Ground ball to short, double play.',
      { first: RUNNER },
      to(SS),
      choice,
      choiceOut
    )
    expect(sent.session.liveData.linescore.outs).equals(1)
    const numbers = turned(
      'Six four three double play.',
      { first: RUNNER },
      to(SS),
      choice,
      choiceOut
    )
    expect(numbers.session.liveData.linescore.outs).equals(2)
  })

  it('reads the pivot only from a fielder named taking or making a throw who could cover a base', function () {
    for (const [words, fielder, lead, pivot] of [
      [
        'Ground ball to third, he throws to second, and the relay to the first baseman gets him, double play.',
        THIRD_BASEMAN,
        THIRD_BASEMAN,
        SECOND_BASEMAN
      ],
      [
        'Ground ball to short, he flips to second, and the second baseman throws to the first baseman, double play.',
        SS,
        SS,
        SECOND_BASEMAN
      ],
      [
        'Shortstop to second, over to the first baseman, double play.',
        SS,
        SS,
        SECOND_BASEMAN
      ],
      [
        'Ground ball close to the third baseman, the shortstop cuts in front and throws to second, on to first, double play.',
        SS,
        SS,
        SECOND_BASEMAN
      ]
    ] as const) {
      const state = turned(words, { first: RUNNER }, to(fielder), thrown)
      expect(state.session.liveData.linescore.outs, words).equals(2)
      expect(credits(state), words).deep.equals(dp(lead, pivot))
    }
  })

  it('keeps the runner from second thrown out at home when the words say home', function () {
    const state = turned(
      'Ground ball to short, he throws home to get the runner from second, catcher to first, double play.',
      { first: RUNNER, second: 6 },
      to(SS),
      thrown,
      {
        type: 'runnerMovement',
        runner: 6,
        to: 'home',
        out: true,
        fielders: [SS, 11]
      },
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        out: true,
        fielders: [11, FIRST_BASEMAN]
      }
    )
    expect(state.session.liveData.linescore.outs).equals(2)
    expect(bases(state)).deep.equals([null, RUNNER, null])
    expect(credits(state)).deep.equals(dp(SS, 11))
  })

  it('moves every other runner the batter forced up a base', function () {
    const second = turned(
      'Six four three double play.',
      { first: RUNNER, second: 6 },
      to(SS),
      thrown
    )
    expect(second.session.liveData.linescore.outs).equals(2)
    expect(bases(second)).deep.equals([null, null, 6])
    const loaded = turned(
      'Six four three double play.',
      { first: RUNNER, second: 6, third: 7 },
      to(SS),
      thrown
    )
    expect(loaded.session.liveData.linescore.teams.away.runs).equals(1)
    expect(bases(loaded)).deep.equals([null, null, 6])
    // "One two three": the force at home, then first.
    const home = turned(
      'One two three double play.',
      { first: RUNNER, second: 6, third: 7 },
      to(10),
      thrown
    )
    expect(home.session.liveData.linescore.outs).equals(2)
    expect(home.session.liveData.linescore.teams.away.runs).equals(0)
    expect(bases(home)).deep.equals([null, RUNNER, 6])
    expect(credits(home)).deep.equals(dp(10, 11))
  })

  it('puts the runner out at a base ahead of him, whatever base the model sent', function () {
    const state = turned(
      '6-4-3 double play.',
      { first: RUNNER },
      to(SS),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '1B',
        out: true,
        fielders: [SS, SECOND_BASEMAN]
      }
    )
    const play = state.session.liveData.plays.allPlays.at(-1)
    expect(
      play?.runners.find(r => r.details.runner.id === RUNNER)?.movement.end
    ).equals(2)
    expect(credits(state)).deep.equals(dp(SS, SECOND_BASEMAN))
  })

  it('trusts a model chain only when it starts with the fielder who fielded it', function () {
    const state = turned(
      'Comebacker to the pitcher, double play.',
      { first: RUNNER },
      to(10),
      thrown,
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [SECOND_BASEMAN]
      }
    )
    expect(credits(state)).deep.equals(dp(10, SS))
  })

  it('reads the chain past a count said before it, and a chain alone', function () {
    const counted = turned(
      'On the two-one pitch, six three double play.',
      { first: RUNNER },
      to(SECOND_BASEMAN),
      thrown
    )
    expect(credits(counted)).deep.equals(dp(SS, SS))
    const alone = turned(
      'Ground ball, six-four-three.',
      { first: RUNNER },
      to(SS),
      thrown
    )
    expect(alone.session.liveData.linescore.outs).equals(2)
    expect(credits(alone)).deep.equals(dp(SS, SECOND_BASEMAN))
  })

  it('leaves a ball in the air, and two outs already made, to the rules', function () {
    const liner: ScoringAction[] = [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        fielder: SS
      },
      { type: 'result', eventType: 'field_out' },
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '1B',
        out: true,
        fielders: [SS, FIRST_BASEMAN]
      }
    ]
    expect(
      playDefaults(
        game({ first: RUNNER }).session,
        liner,
        'Line drive to short, doubled off first, double play.'
      )
    ).deep.equals(liner)
    const twoOut = game({ first: RUNNER })
    twoOut.session.liveData.linescore.outs = 2
    expect(
      playDefaults(
        twoOut.session,
        [to(SS), thrown],
        'Six four three double play.'
      )
    ).deep.equals([to(SS), thrown])
  })

  it('leaves the sentence alone with nobody on first and no runner put out', function () {
    const state = turned(
      'Ground ball to short, double play.',
      { second: RUNNER },
      to(SS),
      thrown
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(credits(state)).deep.equals([
      `f_assist ${SS}`,
      `f_putout ${FIRST_BASEMAN}`
    ])
  })

  it('takes the throw to first only from an out on the same ball in play', function () {
    const state = turned(
      'Runner caught stealing, catcher to short. Then ground out to second.',
      { first: RUNNER },
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [11, SS]
      },
      to(SECOND_BASEMAN),
      thrown
    )
    expect(credits(state)).to.include.members([
      `f_assist ${SECOND_BASEMAN}`,
      `f_putout ${FIRST_BASEMAN}`
    ])
    expect(credits(state)).not.to.include(`f_assist ${SS}`)
  })

  it('throws the batter out from the fielder who made the runner’s out, assuming the cover when nobody was named', function () {
    const pivot = turned('said', { first: RUNNER }, to(SS), thrown, {
      type: 'runnerMovement',
      runner: RUNNER,
      to: '2B',
      out: true,
      fielders: [SS, SECOND_BASEMAN]
    })
    expect(credits(pivot)).deep.equals(dp(SS, SECOND_BASEMAN))
    // The shortstop fielded it and the out was at second, so the second
    // baseman took the throw and threw on to first.
    const unsaid = turned('said', { first: RUNNER }, to(SS), thrown, {
      type: 'runnerMovement',
      runner: RUNNER,
      to: '2B',
      out: true
    })
    expect(unsaid.session.liveData.linescore.outs).equals(2)
    expect(credits(unsaid)).deep.equals(dp(SS, SECOND_BASEMAN))
  })
})

describe('strike three in a sentence', function () {
  it('keeps a dropped third strike, said after the pitch, for the screen to ask about', function () {
    const state = settle(
      sayAs(
        'Strike three, but the catcher drops it and the batter beats the throw to first.',
        game(),
        { type: 'pitch', call: 'S' },
        { type: 'pitch', call: 'S' },
        { type: 'pitch', call: 'S' },
        { type: 'result', eventType: 'strikeout' }
      )
    )
    expect(state.dictation?.problem).equals(undefined)
    expect(state.dictationQuestion?.question).match(/dropped third strike/)
  })

  it('is the strikeout by itself: a strikeout sent after it is dropped too', function () {
    const state = settle(
      sayAs(
        'Foul ball. Swing and a miss. Called strike three.',
        game({ second: 6 }),
        { type: 'pitch', call: 'F' },
        { type: 'pitch', call: 'S' },
        { type: 'pitch', call: 'C' },
        { type: 'result', eventType: 'strikeout' }
      )
    )
    expect(state.dictation?.problem).equals(undefined)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('is the strikeout by itself: an out sent after it is dropped', function () {
    const state = settle(
      sayAs(
        'Foul ball. Swing and a miss. Called strike three.',
        game(),
        { type: 'pitch', call: 'F' },
        { type: 'pitch', call: 'S' },
        { type: 'pitch', call: 'C' },
        {
          type: 'result',
          eventType: 'field_out',
          outBy: 'catch',
          foulCaught: true
        }
      )
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(
      state.session.liveData.plays.allPlays.map(p => p.result.eventType)
    ).deep.equals(['strikeout'])
  })
})

describe('a runner who holds', function () {
  it('stays on third on a single, which would otherwise send him home', function () {
    const state = settle(
      sayAs(
        'Line drive single to left, the runner holds at third.',
        game({ third: 6 }),
        { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
        { type: 'result', eventType: 'single' },
        { type: 'runnerMovement', runner: 6, to: '3B' }
      )
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(0)
    expect(bases(state)).deep.equals([BATTER, null, 6])
    nothingToTap(state)
  })

  it('stays on third when the hold is said before the single', function () {
    const state = settle(
      sayAs(
        'Single to left, the runner holds at third.',
        game({ third: 6 }),
        { type: 'runnerMovement', runner: 6, to: '3B' },
        { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
        { type: 'result', eventType: 'single' }
      )
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(0)
    expect(bases(state)).deep.equals([BATTER, null, 6])
  })

  it('is not moved, and the rest of the sentence stands', function () {
    const state = settle(
      sayAs(
        'Ground out to short, the runner holds.',
        game({ second: 6 }),
        grounder,
        {
          type: 'result',
          eventType: 'field_out',
          outBy: 'throw'
        },
        { type: 'runnerMovement', runner: 6, to: '2B' }
      )
    )
    expect(state.dictation?.problem).equals(undefined)
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(bases(state)).deep.equals([null, 6, null])
    nothingToTap(state)
  })
})

describe('a base an infielder took for the out', function () {
  function at(
    outs: number,
    bases: { first?: number; second?: number; third?: number }
  ): ScoringState {
    const state = game(bases)
    state.session.liveData.linescore.outs = outs
    return state
  }
  const to = (fielder: number): ScoringAction => ({
    type: 'ballInPlay',
    contact: 'swing',
    trajectory: 'ground_ball',
    fielder
  })
  const thrownOut: ScoringAction = {
    type: 'result',
    eventType: 'field_out',
    outBy: 'throw'
  }
  const runs = (state: ScoringState): number =>
    state.session.liveData.linescore.teams.away.runs
  const outsOf = (state: ScoringState): number =>
    state.session.liveData.linescore.outs
  const half = (state: ScoringState): boolean =>
    state.session.liveData.linescore.isTopInning
  /** Each out, without the spots the field gives its throws. */
  const outsIn = (actions: readonly ScoringAction[]): ScoringAction[] =>
    actions.flatMap(action => {
      if (action.type !== 'runnerMovement' || action.out !== true) return []
      const { locations: _spots, ...out } = action
      return [out]
    })
  const shortstop = game().session.gameData.players[SS].fullName

  it("reads the base a fielder took, and never a runner's", function () {
    const bases = (words: string): string[] =>
      baseOutsSaid(words).map(out => out.base)
    expect(
      bases("Grounder to short, who tags second for fielder's choice.")
    ).deep.equals(['2B'])
    expect(bases('He steps on third.')).deep.equals(['3B'])
    expect(bases('Paul takes third base for the out.')).deep.equals(['3B'])
    expect(
      bases('Grounder to third, he tags. Third base for the out.')
    ).deep.equals(['3B'])
    expect(bases('Force at home.')).deep.equals(['home'])
    expect(bases('The runner is forced at second.')).deep.equals(['2B'])
    expect(bases('The third baseman takes third.')).deep.equals(['3B'])
    for (const words of [
      'The runner tags up and scores.',
      'He tagged first.',
      'Casey takes second on the throw.',
      'Single, and Remy gets to third.'
    ])
      expect(bases(words), words).deep.equals([])
    expect(baseOutsSaid('The shortstop steps on second.')[0].by).equals('SS')
    expect(baseOutsSaid('He throws to second for the out.')[0].thrown).equals(
      true
    )
  })

  it("puts the runner out at second, with the shortstop, on a fielder's choice the model left without him", function () {
    const words =
      "And it's a grounder to the shortstop. Who tags second for fielder's choice."
    const sentence = playDefaults(
      at(1, { first: 7 }).session,
      [to(SS), choice],
      words
    )
    expect(sentence.slice(0, 2)).deep.equals([to(SS), choice])
    expect(outsIn(sentence)).deep.equals([
      {
        type: 'runnerMovement',
        runner: 7,
        to: '2B',
        out: true,
        reason: 'Force Out',
        fielders: [SS]
      }
    ])
    const after = settle(sayAs(words, at(1, { first: 7 }), to(SS), choice))
    expect(outsOf(after)).equals(2)
    expect(bases(after)).deep.equals([BATTER, null, null])
    nothingToTap(after)
  })

  for (const outs of [0, 2])
    it(`makes "takes third base for the out" the runner forced at third, not the batter at first (${outs} out)`, function () {
      const words =
        'Grounder to third, and the third baseman takes third base for the out.'
      const sentence = playDefaults(
        at(outs, { first: 7, second: 8 }).session,
        [to(THIRD_BASEMAN), thrownOut],
        words
      )
      expect(sentence.filter(action => action.type === 'result')).deep.equals([
        choice
      ])
      expect(outsIn(sentence)).deep.equals([
        {
          type: 'runnerMovement',
          runner: 8,
          to: '3B',
          out: true,
          reason: 'Force Out',
          fielders: [THIRD_BASEMAN]
        }
      ])
      const after = settle(
        sayAs(
          words,
          at(outs, { first: 7, second: 8 }),
          to(THIRD_BASEMAN),
          thrownOut
        )
      )
      if (outs === 2) {
        expect(outsOf(after)).equals(0)
        expect(half(after)).equals(false)
      } else {
        expect(outsOf(after)).equals(1)
        expect(bases(after)).deep.equals([BATTER, 7, null])
      }
    })

  it('credits a throw to the base to its cover, a runner not forced as thrown out, and leaves a base nobody could be put out at', function () {
    const thrown = playDefaults(
      at(0, { first: 7 }).session,
      [to(THIRD_BASEMAN), choice],
      'Grounder to third, he throws to second for the out.'
    )
    expect(outsIn(thrown)).deep.equals([
      {
        type: 'runnerMovement',
        runner: 7,
        to: '2B',
        out: true,
        reason: 'Force Out',
        fielders: [THIRD_BASEMAN, SECOND_BASEMAN]
      }
    ])
    const tagged = playDefaults(
      at(0, { second: 8 }).session,
      [to(THIRD_BASEMAN), choice],
      'Grounder to third, and he tags third for the out.'
    )
    expect(outsIn(tagged)).deep.equals([
      {
        type: 'runnerMovement',
        runner: 8,
        to: '3B',
        out: true,
        reason: 'Throw Out',
        fielders: [THIRD_BASEMAN]
      }
    ])
    const empty = [to(THIRD_BASEMAN), thrownOut]
    expect(
      playDefaults(at(0, {}).session, empty, 'He steps on third for the out.')
    ).deep.equals(playDefaults(at(0, {}).session, empty, 'Grounder to third.'))
  })

  it('keeps the batter out at first when the words put him out there too, and a double play at second', function () {
    const both = playDefaults(
      at(0, { first: 7, second: 8 }).session,
      [to(THIRD_BASEMAN), thrownOut],
      'Grounder to third, he steps on third and throws to first, double play.'
    )
    expect(both.find(action => action.type === 'result')).deep.equals(thrownOut)
    expect(outsIn(both)[0]).deep.includes({
      runner: 8,
      to: '3B',
      fielders: [THIRD_BASEMAN]
    })
    const pivot = playDefaults(
      at(0, { first: 7, second: 8 }).session,
      [to(THIRD_BASEMAN), thrownOut],
      'Grounder to third, he tags. Third base for the out, and double play at second.'
    )
    expect(pivot.find(action => action.type === 'result')).deep.equals(choice)
    expect(
      outsIn(pivot).map(
        out => out.type === 'runnerMovement' && [out.runner, out.to]
      )
    ).deep.equals([
      [8, '3B'],
      [7, '2B']
    ])
  })

  describe('a force and an overthrow at first', function () {
    const words =
      "And it's a grounder to the shortstop, he tags second for the out, but overthrows first. For an error, and batter is safe."
    const force: ScoringAction = {
      type: 'runnerMovement',
      runner: 7,
      to: '2B',
      out: true,
      reason: 'Force Out'
    }
    const error: ScoringAction = {
      type: 'fieldingPlay',
      fielders: [SS],
      error: SS,
      errorKind: 'throwing'
    }
    const bare: ScoringAction = {
      type: 'fieldingPlay',
      fielders: [SS],
      error: SS
    }
    const errorResult: ScoringAction = {
      type: 'result',
      eventType: 'field_error'
    }
    const forms: Array<[string, ScoringAction[]]> = [
      ['the out before the error', [to(SS), force, errorResult, error]],
      ['the error before the out', [to(SS), errorResult, error, force]],
      ['no errorKind', [to(SS), force, errorResult, bare]],
      ['no fieldingPlay', [to(SS), force, errorResult]],
      ['no result', [to(SS), error, force]]
    ]
    for (const [form, said] of forms)
      it(`charges the throw to first after the force (${form})`, function () {
        expect(
          playDefaults(at(0, { first: 7 }).session, said, words)
        ).deep.equals([
          to(SS),
          errorResult,
          {
            type: 'fieldingPlay',
            fielders: [SS, FIRST_BASEMAN],
            error: SS,
            errorKind: 'throwing'
          },
          { ...force, fielders: [SS] }
        ])
        const after = settle(sayAs(words, at(0, { first: 7 }), ...said))
        expect(outsOf(after)).equals(1)
        expect(after.session.liveData.linescore.teams.home.errors).equals(1)
        expect(bases(after)).deep.equals([BATTER, null, null])
        expect(after.dictation?.problem).equals(undefined)
      })

    for (const [form, said] of forms)
      it(`ends the half on the force with two out, leaving the error out (${form})`, function () {
        const done = sentenceDefaults(at(2, { first: 7 }).session, said, words)
        expect(done.actions).deep.equals([
          to(SS),
          choice,
          { ...force, fielders: [SS] }
        ])
        expect(done.leftOut).deep.equals([`the error by ${shortstop}`])
        const after = settle(sayAs(words, at(2, { first: 7 }), ...said))
        expect(half(after)).equals(false)
        expect(after.session.liveData.linescore.teams.home.errors).equals(0)
        expect(after.dictation?.note).equals(
          `Left out after the third out: the error by ${shortstop}`
        )
      })
  })

  describe('a run after the third out', function () {
    const popup: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'popup',
      fielder: LF
    }
    const caught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const home: ScoringAction = {
      type: 'runnerMovement',
      runner: 8,
      to: 'home'
    }

    for (const [words, said] of [
      [
        "Pop fly to left field. And it's caught for the out, but the runner tags up and takes home.",
        [popup, caught, home]
      ],
      [
        'Pop fly to left, the runner tags and scores, and the left fielder makes the catch for the third out.',
        [popup, caught, home]
      ],
      [
        'Pop fly to left, the runner tags and scores, and the left fielder makes the catch for the third out.',
        [popup, home, caught]
      ],
      [
        'Pop fly to left, the runner tags and scores, and the left fielder makes the catch for the third out.',
        [home, popup, caught]
      ]
    ] as Array<[string, ScoringAction[]]>)
      it(`scores nothing after a catch makes it: ${said.map(action => action.type).join(', ')}`, function () {
        const after = settle(
          sayAs(words, at(2, { second: 7, third: 8 }), ...said)
        )
        expect(runs(after)).equals(0)
        expect(half(after)).equals(false)
        expect(after.dictation?.note).equals(
          'Left out after the third out: Player 8 scoring'
        )
      })

    it('scores nothing before a ground out at first makes it', function () {
      const after = settle(
        sayAs(
          'Grounder to short, the runner scores, and he throws him out at first.',
          at(2, { third: 8 }),
          to(SS),
          home,
          thrownOut
        )
      )
      expect(runs(after)).equals(0)
      expect(half(after)).equals(false)
    })

    it('keeps a run scored on a wild pitch before the catch', function () {
      const done = sentenceDefaults(
        at(2, { first: 7, third: 8 }).session,
        [
          { type: 'pitch', call: 'B' },
          {
            type: 'batteryEvent',
            kind: 'wild_pitch',
            advances: [{ runner: 8, to: 'home' }]
          },
          popup,
          caught
        ],
        'Wild pitch, the runner on third scores. Then a fly out to left for the third out.'
      )
      expect(done.leftOut).deep.equals([])
    })

    it('drops nothing when the third out ends the sentence, or the outs stay under three', function () {
      const words =
        "Pop fly to left. And it's caught for the out, but the runner tags up and takes home."
      for (const outs of [0, 1])
        expect(
          sentenceDefaults(
            at(outs, { third: 8 }).session,
            [popup, caught, home],
            words
          ).leftOut
        ).deep.equals([])
      expect(
        sentenceDefaults(
          at(2, { third: 8 }).session,
          [popup, caught],
          'Caught for the third out.'
        ).leftOut
      ).deep.equals([])
    })

    it("counts a run the words put before a runner's third out, sent after it", function () {
      const words =
        'Single to left, the runner scores, and the batter is thrown out going to second.'
      const single: ScoringAction[] = [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'line_drive',
          fielder: LF
        },
        { type: 'result', eventType: 'single' }
      ]
      const out: ScoringAction = {
        type: 'runnerMovement',
        runner: BATTER,
        to: '2B',
        out: true,
        reason: 'Throw Out',
        fielders: [LF, SECOND_BASEMAN]
      }
      const done = sentenceDefaults(
        at(2, { third: 8 }).session,
        [...single, out, home],
        words
      )
      expect(done.leftOut).deep.equals([])
      expect(done.actions.indexOf(home)).lessThan(done.actions.indexOf(out))
      const after = settle(
        sayAs(words, at(2, { third: 8 }), ...single, out, home)
      )
      expect(runs(after)).equals(1)
      expect(half(after)).equals(false)
    })
  })

  it("leaves a fielder's choice's calls after its third out to the rules", function () {
    const said: ScoringAction[] = [
      to(THIRD_BASEMAN),
      choice,
      {
        type: 'runnerMovement',
        runner: 8,
        to: 'home',
        out: true,
        fielders: [THIRD_BASEMAN]
      },
      { type: 'runnerMovement', runner: 7, to: '3B' }
    ]
    const done = sentenceDefaults(
      at(2, { second: 7, third: 8 }).session,
      said,
      "Ground ball to the third baseman for a fielder's choice. He tags the runner from third out himself at home. The runner from second is safe at third."
    )
    expect(done.leftOut).deep.equals([])
    expect(
      done.actions.some(
        action => action.type === 'runnerMovement' && action.runner === 7
      )
    ).equals(true)
  })

  it('puts the base out on the runner there, not on a player the model guessed who is on no base', function () {
    const pitcher = 10
    const sentence = playDefaults(
      at(0, { first: 7, second: 8 }).session,
      [
        to(THIRD_BASEMAN),
        choice,
        {
          type: 'runnerMovement',
          runner: pitcher,
          to: '3B',
          out: true,
          reason: 'Force Out'
        }
      ],
      'Grounder to third, and the third baseman takes third base for the out.'
    )
    expect(
      outsIn(sentence).map(out => out.type === 'runnerMovement' && out.runner)
    ).deep.equals([8])
  })

  it('keeps the note of a sentence queued behind a reel, and of one answered', function () {
    const words =
      "Pop fly to left field. And it's caught for the out, but the runner tags up and takes home."
    const popup: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'popup',
      fielder: LF
    }
    const caught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    }
    const home: ScoringAction = {
      type: 'runnerMovement',
      runner: 8,
      to: 'home'
    }
    const note = 'Left out after the third out: Player 8 scoring'
    const answered = sayAs(words, at(2, { third: 8 }), popup, caught, home)
    expect(answered.dictation?.note).equals(note)
    const plain = sayAs('Grounder to short.', at(0, {}), to(SS), thrownOut)
    expect(plain.dictation?.note).equals(undefined)
    const question: DictationQuestion = {
      transcript: words,
      note,
      question: 'Who caught it?',
      options: [{ label: 'Left fielder', actions: [popup, caught] }]
    }
    const asked: ScoringState = {
      ...at(2, { third: 8 }),
      dictationQuestion: question
    }
    const done = scoringReducer(asked, { type: 'DICTATION_ANSWER', option: 0 })
    expect(done.dictation?.note).equals(note)
    expect(runs(done)).equals(0)
  })
})
