import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { nextDecision } from '../../common/scoring/rules'
import { createDevelopmentSession } from './developmentSession'
import {
  answerOf,
  completeSentence,
  leadRunnersFirst,
  playDefaults,
  sentenceQuestion,
  settleBetween,
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
    // second's, at third, without the fielders guessed for second.
    expect(stealsByBase(both.session, [caught(5, '2B', [11, 14])])).deep.equals(
      [caught(6, '3B')]
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
      { type: 'baseRunning', kind: 'pickoff', runner: 6, to: '2B' }
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
