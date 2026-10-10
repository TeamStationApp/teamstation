import { expect } from 'chai'
import { describe, it } from 'mocha'

import type {
  BallInPlayAction,
  ResultAction,
  ScoringAction
} from '../../common/scoring/actions'
import { overrideOf } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  describeCompletedPlays,
  describeEntryPlays,
  describeLastPlay,
  describePlay,
  lastPlaySpan,
  type PlayDescription
} from './playDescription'
import type { Outcome } from './scoringContract'
import {
  initialScoringState,
  scoringReducer,
  sessionAt
} from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

describe('setup history descriptions', () => {
  it('identifies the runner and base, and distinguishes outs-only changes from other corrections', () => {
    const before = createDevelopmentSession(gameFixture, [], [])
    const placed = applyAction(before, {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 9,
      base: '2B'
    })
    expect(
      describePlay(
        before,
        [{ type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' }],
        placed.state
      )?.primary
    ).equals('Player 9. placed on 2B')
    for (const outs of [1, 2, 0]) {
      const original = outs === 0 ? placed.state : before
      const start =
        outs === 0
          ? applyAction(original, {
              type: 'gameFlow',
              kind: 'override',
              ...overrideOf(original),
              batter: overrideOf(original).batter ?? undefined,
              pitcher: overrideOf(original).pitcher ?? undefined,
              outs: 2
            }).state
          : original
      const action: ScoringAction = {
        type: 'gameFlow',
        kind: 'override',
        ...overrideOf(start),
        batter: overrideOf(start).batter ?? undefined,
        pitcher: overrideOf(start).pitcher ?? undefined,
        outs
      }
      const after = applyAction(start, action).state
      expect(describePlay(start, [action], after)?.primary).equals(
        `Set outs to ${outs}`
      )
    }
    const mixed: ScoringAction = {
      type: 'gameFlow',
      kind: 'override',
      ...overrideOf(before),
      batter: overrideOf(before).batter ?? undefined,
      pitcher: overrideOf(before).pitcher ?? undefined,
      outs: 2,
      balls: 1
    }
    expect(
      describePlay(before, [mixed], applyAction(before, mixed).state)?.primary
    ).equals('Game corrected')
  })
})

// Visitors 1-9 bat; the hosts field 10 P, 11 C, 12 1B, 13 2B, 14 SS, 15 3B,
// 16 LF, 17 CF, 18 RF.
const NAMES: Record<number, [string, string]> = {
  1: ['Chase', 'Lee'],
  2: ['Ann', 'Bell'],
  3: ['Cal', 'Diaz'],
  4: ['Eve', 'Fox'],
  12: ['Sam', 'Park'],
  13: ['Tia', 'Ross'],
  14: ['Noah', 'Dean'],
  15: ['Max', 'Holt'],
  16: ['Liv', 'Moss'],
  17: ['Ben', 'Cho'],
  11: ['Kai', 'Webb']
}

function game(
  bases: { first?: number; second?: number; third?: number } = {},
  count?: [number, number],
  animate = false
): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    animate
  )
  for (const [id, [first, last]] of Object.entries(NAMES)) {
    const player = state.session.gameData.players[Number(id)]
    player.firstName = first
    player.lastName = last
    player.fullName = `${first} ${last}`
  }
  const offense = state.session.liveData.linescore.offense
  for (const key of ['first', 'second', 'third'] as const) {
    const id = bases[key]
    if (id != null) offense[key] = playerRef(state.session, id)
  }
  if (count != null) {
    state.session.liveData.linescore.balls = count[0]
    state.session.liveData.linescore.strikes = count[1]
  }
  return state
}
/** Dictates the actions and describes what they did, as the Undo line would. */
function told(
  before: ScoringState,
  ...actions: ScoringAction[]
): PlayDescription | undefined {
  let after = scoringReducer(before, {
    type: 'DICTATED',
    transcript: 'said',
    actions
  })
  for (let step = 0; step < 40; step++) {
    const motion = after.motions.find(m => !m.complete && m.held !== true)
    if (motion == null) break
    after = scoringReducer(after, {
      type: 'MOTION_DONE',
      id: motion.id,
      generation: motion.generation
    })
  }
  expect(after.dictation?.problem, JSON.stringify(after.dictation)).equals(
    undefined
  )
  return describePlay(
    before.session,
    after.log.slice(before.log.length),
    after.session
  )
}
function inPlay(
  fielder: number,
  trajectory?: BallInPlayAction['trajectory'],
  contact: BallInPlayAction['contact'] = 'swing'
): BallInPlayAction {
  const action: BallInPlayAction = { type: 'ballInPlay', contact, fielder }
  if (trajectory != null) action.trajectory = trajectory
  return action
}
function result(
  eventType: ResultAction['eventType'],
  more: Partial<ResultAction> = {}
): ResultAction {
  return { type: 'result', eventType, ...more }
}

describe('a play in two lines', function () {
  it('names pitches, and the walk or strikeout they come to', function () {
    expect(told(game(), { type: 'pitch', call: 'B' })).deep.equals({
      primary: 'Ball'
    })
    expect(
      told(game(), { type: 'pitch', call: 'B' }, { type: 'pitch', call: 'C' })
    ).deep.equals({
      primary: 'Ball, called strike'
    })
    expect(told(game({}, [3, 1]), { type: 'pitch', call: 'B' })).deep.equals({
      primary: 'Chase L. walks'
    })
    expect(
      told(game({}, [1, 2]), { type: 'pitch', call: 'S' })?.primary
    ).equals('Chase L. strikes out swinging')
    expect(
      told(
        game({}, [0, 1]),
        { type: 'pitch', call: 'F' },
        { type: 'pitch', call: 'C' }
      )
    ).deep.equals({
      primary: 'Chase L. strikes out looking',
      secondary: 'On foul, called strike'
    })
    expect(
      told(game({}, [0, 2]), { type: 'pitch', call: 'L' })?.primary
    ).equals('Chase L. strikes out swinging')
    expect(
      told(game({ first: 2 }, [3, 0]), { type: 'pitch', call: 'B' })
    ).deep.equals({
      primary: 'Chase L. walks',
      secondary: 'Ann B. to second'
    })
  })

  it('names a hit by trajectory, kind and direction, and the runners it moved', function () {
    expect(
      told(game(), inPlay(16, 'line_drive'), result('double'))
    ).deep.equals({
      primary: 'Chase L. line drive double to left'
    })
    expect(told(game({ second: 2 }), inPlay(17), result('single'))).deep.equals(
      {
        // Said with no trajectory, a hit is a line drive.
        primary: 'Chase L. line drive single to center',
        secondary: 'Ann B. to third'
      }
    )
    expect(
      told(
        game({ first: 2, third: 3 }),
        { type: 'pitch', call: 'B' },
        inPlay(16, 'fly_ball'),
        result('home_run')
      )
    ).deep.equals({
      primary: 'Chase L. fly ball home run to left',
      secondary: 'After ball; Cal D. scores; Ann B. scores'
    })
  })

  it('names the direction a ball was sent, and a caught foul as a foul out', function () {
    expect(
      told(
        game(),
        { type: 'ballInPlay', contact: 'swing', direction: 'left_center' },
        result('single')
      )?.primary
    ).equals('Chase L. line drive single to left center')
    expect(
      told(
        game(),
        { type: 'ballInPlay', contact: 'swing', fielder: 12 },
        result('field_out', { foulCaught: true })
      )
    ).deep.equals({
      primary: 'Chase L. fouls out to first',
      secondary: 'Caught by Sam P. (1B)'
    })
  })

  it('names a batter thrown out stretching a hit', function () {
    expect(
      told(game(), inPlay(17), result('single'), {
        type: 'runnerMovement',
        runner: 1,
        to: '2B',
        out: true,
        fielders: [17, 13]
      })
    ).deep.equals({
      primary: 'Chase L. line drive single to center',
      secondary: 'Out at second, Ben C. (CF) to Tia R. (2B)'
    })
  })

  it('names a ground out and the fielders who made it', function () {
    expect(
      told(
        game(),
        inPlay(14, 'ground_ball'),
        result('field_out', { outBy: 'throw' }),
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          out: true,
          fielders: [14, 12]
        }
      )
    ).deep.equals({
      primary: 'Chase L. ground out',
      secondary: 'Noah D. (SS) to Sam P. (1B)'
    })
    // Thrown out with no throw said: the fielder the ball went to threw to
    // first.
    expect(
      told(
        game(),
        inPlay(14, 'ground_ball'),
        result('field_out', { outBy: 'throw' })
      )
    ).deep.equals({
      primary: 'Chase L. ground out',
      secondary: 'Noah D. (SS) to Sam P. (1B)'
    })
    // Nobody said who made it: no credit, no second line.
    expect(
      told(
        game(),
        { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
        result('field_out', { outBy: 'throw' })
      )
    ).deep.equals({
      primary: 'Chase L. ground out'
    })
    expect(
      told(
        game(),
        inPlay(15, undefined, 'bunt'),
        result('field_out', { outBy: 'throw' })
      )?.primary
    ).equals('Chase L. bunt out')
  })

  it('names a caught ball by its flight, and who caught it', function () {
    expect(
      told(
        game(),
        inPlay(17, 'fly_ball'),
        result('field_out', { outBy: 'catch' })
      )
    ).deep.equals({
      primary: 'Chase L. flies out to center',
      secondary: 'Caught by Ben C. (CF)'
    })
    expect(
      told(game(), inPlay(14, 'popup'), result('field_out', { outBy: 'catch' }))
        ?.primary
    ).equals('Chase L. pops out to short')
    expect(
      told(
        game(),
        inPlay(15, 'line_drive'),
        result('field_out', { outBy: 'catch' })
      )?.primary
    ).equals('Chase L. lines out to third')
    expect(
      told(
        game(),
        inPlay(12),
        result('field_out', { outBy: 'catch', foulCaught: true })
      )?.primary
    ).equals('Chase L. fouls out to first')
  })

  it('names an error and the fielder charged, and a fielder’s choice and its out', function () {
    expect(
      told(game(), inPlay(15, 'ground_ball'), result('field_error'))
    ).deep.equals({
      primary: 'Chase L. reaches on an error',
      secondary: 'Error by Max H. (3B)'
    })
    expect(
      told(
        game({ first: 2 }),
        inPlay(14, 'ground_ball'),
        result('fielders_choice')
      )
    ).deep.equals({
      primary: "Chase L. reaches on a fielder's choice",
      secondary: 'Ann B. out at second'
    })
  })

  it('names a steal, a caught stealing and its throw, and a wild pitch', function () {
    expect(
      told(game({ first: 2 }), {
        type: 'baseRunning',
        kind: 'steal',
        runner: 2,
        to: '2B'
      })
    ).deep.equals({
      primary: 'Ann B. steals second'
    })
    expect(
      told(game({ first: 2 }), {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 2,
        to: '2B',
        fielders: [11, 13]
      })
    ).deep.equals({
      primary: 'Ann B. caught stealing second',
      secondary: 'Kai W. (C) to Tia R. (2B)'
    })
    expect(
      told(
        game({ first: 2 }),
        { type: 'pitch', call: 'B' },
        {
          type: 'batteryEvent',
          kind: 'wild_pitch',
          advances: [{ runner: 2, to: '2B' }]
        }
      )
    ).deep.equals({
      primary: 'Wild pitch',
      secondary: 'On ball; Ann B. to second'
    })
  })

  it('names what reaches the batter without a ball in play', function () {
    expect(told(game(), result('hit_by_pitch'))?.primary).equals(
      'Chase L. hit by pitch'
    )
    expect(told(game(), result('intent_walk'))?.primary).equals(
      'Chase L. intentionally walked'
    )
    expect(told(game(), result('catcher_interference'))?.primary).equals(
      "Chase L. reaches on catcher's interference"
    )
    const dropped = game({}, [0, 2])
    expect(
      told(dropped, result('strikeout'), {
        type: 'runnerMovement',
        runner: 1,
        to: '1B'
      })
    ).deep.equals({
      primary: 'Chase L. strikes out, dropped third strike',
      secondary: 'Safe at first'
    })
    expect(
      told(dropped, result('strikeout'), {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true
      })?.secondary
    ).equals('Out at first')
  })

  it('names lineup changes and a lone runner move', function () {
    const state = game()
    expect(
      describePlay(
        state.session,
        [{ type: 'lineup', kind: 'batterSide', batSide: 'L' }],
        state.session
      )?.primary
    ).equals('Chase L. bats left')
    expect(
      describePlay(
        state.session,
        [
          {
            type: 'lineup',
            kind: 'substitute',
            player: 4,
            replaces: 2,
            position: 'SS'
          }
        ],
        state.session
      )?.primary
    ).equals('Eve F. in for Ann B. at SS')
    expect(
      describePlay(
        state.session,
        [{ type: 'lineup', kind: 'pinchRunner', player: 4, replaces: 2 }],
        state.session
      )?.primary
    ).equals('Eve F. runs for Ann B.')
    expect(
      describePlay(
        state.session,
        [{ type: 'lineup', kind: 'battingOrder', order: [1] }],
        state.session
      )?.primary
    ).equals('Batting order changed')
    expect(
      describePlay(
        state.session,
        [{ type: 'runnerMovement', runner: 2, to: '3B' }],
        state.session
      )?.primary
    ).equals('Ann B. to third')
    expect(
      describePlay(
        state.session,
        [{ type: 'runnerMovement', runner: 2, to: 'home' }],
        state.session
      )?.primary
    ).equals('Ann B. scores')
    expect(
      describePlay(
        state.session,
        [{ type: 'runnerMovement', runner: 2, to: '2B', out: true }],
        state.session
      )
    ).deep.equals({ primary: 'Ann B. out at second' })
    expect(
      describePlay(
        state.session,
        [{ type: 'gameFlow', kind: 'endHalf' }],
        state.session
      )?.primary
    ).equals('End of the half')
    expect(
      describePlay(
        state.session,
        [{ type: 'fieldingPlay', fielders: [14], error: 14 }],
        state.session
      )?.primary
    ).equals('Error charged to Noah D. (SS)')
    expect(describePlay(state.session, [], state.session)).equals(undefined)
  })
})

/** The Undo control's lines, as the scoring screen reads them. */
function shown(
  state: ScoringState,
  opening: ScoringState
): PlayDescription | undefined {
  return describeLastPlay(state.log, state.past, state.session, logLength =>
    sessionAt(state, logLength, () => opening.session)
  )
}
function finish(state: ScoringState): ScoringState {
  const p = state.presentation!
  return scoringReducer(state, {
    type: 'PRESENTATION_DONE',
    id: p.id,
    generation: state.generation,
    stage: p.stage
  })
}
/** A ball in play tapped: the outcome, the fielder, the angle, the flight. */
function tapHit(
  state: ScoringState,
  outcome: Outcome,
  fielder: number,
  angle: number
): ScoringState {
  state = scoringReducer(state, { type: 'OUTCOME', outcome })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: fielder,
    point: { x: 0, z: -40 },
    generation: state.generation
  })
  state = scoringReducer(state, {
    type: 'TRAJECTORY',
    angle,
    generation: state.generation
  })
  state = scoringReducer(state, {
    type: 'PRESENTATION_CONTACT',
    id: state.presentation!.id,
    generation: state.generation
  })
  return finish(state)
}

describe('the last play, however it was tapped', function () {
  it('keeps the full description for an older completed play after another pitch', () => {
    const opening = game().session
    const batter = opening.gameData.players[1]
    batter.firstName = 'Mookie'
    batter.lastName = 'Betts'
    batter.fullName = 'Mookie Betts'
    const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
    const log: ScoringAction[] = [
      { type: 'pitch', call: 'S' },
      { type: 'pitch', call: 'S' },
      { type: 'pitch', call: 'S' },
      close,
      { type: 'pitch', call: 'B' }
    ]
    const states = [opening]
    for (const action of log)
      states.push(applyAction(states.at(-1)!, action).state)
    const at = (length: number): typeof opening => states[length]
    const description = describeCompletedPlays(log, new Set([0]), at).get(0)
    expect(description?.primary).matches(/Mookie.*strikes out swinging/)
    expect(describeCompletedPlays(log, new Set(), at).size).equals(0)
    expect(describeCompletedPlays(log, new Set([99]), at).size).equals(0)
    expect(
      describeCompletedPlays([close], new Set([0]), () => states[4]).size
    ).equals(0)
  })
  it('reads a tapped ground out, over its entries, as a ground out', function () {
    const opening = game({}, undefined, true)
    let state = tapHit(opening, 'Throw Out', 14, -8)
    state = scoringReducer(state, {
      type: 'DEFENDER',
      id: 12,
      point: { x: 19, z: -19 },
      generation: state.generation
    })
    state = finish(state)
    state = scoringReducer(state, {
      type: 'DEFENDER',
      generation: state.generation
    })
    if (state.presentation != null) state = finish(state)
    state = completeMotions(state)
    expect(state.log.at(-1)).deep.equals({
      type: 'gameFlow',
      kind: 'closePlay'
    })
    expect(state.past.length).greaterThan(1)
    expect(shown(state, opening)).deep.equals({
      primary: 'Chase L. ground out',
      secondary: 'Noah D. (SS) to Sam P. (1B)'
    })
  })

  it('reads a tapped hit and pop-up by the angle, as a sentence would', function () {
    const opening = game({}, undefined, true)
    const single = completeMotions(tapHit(opening, 'Single', 16, 15))
    expect(shown(single, opening)?.primary).equals(
      'Chase L. line drive single to left'
    )
    const popped = completeMotions(tapHit(opening, 'Ball Caught', 14, 65))
    expect(shown(popped, opening)).deep.equals({
      primary: 'Chase L. pops out to short',
      secondary: 'Caught by Noah D. (SS)'
    })
  })

  it('reads the saved play after a reload, not the step that closed it', function () {
    const opening = game()
    let state = scoringReducer(opening, {
      type: 'DICTATED',
      transcript: 'said',
      actions: [inPlay(17, 'fly_ball'), result('field_out', { outBy: 'catch' })]
    })
    state = completeMotions(state)
    // The screen as a reload opens it: the same game, no Undo entries.
    const reloaded = { ...state, past: [] }
    expect(reloaded.log.at(-1)).deep.equals({
      type: 'gameFlow',
      kind: 'closePlay'
    })
    expect(shown(reloaded, opening)).deep.equals({
      primary: 'Chase L. flies out to center',
      secondary: 'Caught by Ben C. (CF)'
    })
    expect(shown({ ...opening, past: [] }, opening)).equals(undefined)
  })

  it('names each batter of a sentence that scored two', function () {
    const opening = game({}, undefined, true)
    const state = completeMotions(
      scoringReducer(opening, {
        type: 'DICTATED',
        transcript: 'Hit by pitch. Next batter flies out to center.',
        actions: [
          result('hit_by_pitch'),
          inPlay(17, 'fly_ball'),
          result('field_out', { outBy: 'catch' })
        ]
      })
    )
    expect(shown(state, opening)?.primary).equals('Ann B. flies out to center')
    expect(
      describeEntryPlays(state.log, state.past, logLength =>
        sessionAt(state, logLength, () => opening.session)
      ).map(play => play.primary)
    ).deep.equals(['Chase L. hit by pitch', 'Ann B. flies out to center'])
    expect(
      describeEntryPlays(state.log, [], logLength =>
        sessionAt(state, logLength, () => opening.session)
      )
    ).deep.equals([])
  })

  it('names both runners of a double steal, and the one caught', function () {
    expect(
      told(
        game({ first: 2, second: 3 }),
        { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' },
        {
          type: 'baseRunning',
          kind: 'caught_stealing',
          runner: 2,
          to: '2B',
          fielders: [11, 13]
        }
      )
    ).deep.equals({
      primary: 'Cal D. steals third',
      secondary: 'Ann B. caught stealing second, Kai W. (C) to Tia R. (2B)'
    })
  })

  it('tells a walk from the next batter’s play in one sentence', function () {
    const opening = game({}, [3, 0], true)
    const state = completeMotions(
      scoringReducer(opening, {
        type: 'DICTATED',
        transcript: 'Ball four. Next batter flies out to left.',
        actions: [
          { type: 'pitch', call: 'B' },
          inPlay(16, 'fly_ball'),
          result('field_out', { outBy: 'catch' })
        ]
      })
    )
    expect(shown(state, opening)?.primary).equals('Ann B. flies out to left')
    expect(
      describeEntryPlays(state.log, state.past, logLength =>
        sessionAt(state, logLength, () => opening.session)
      ).map(play => play.primary)
    ).deep.equals(['Chase L. walks', 'Ann B. flies out to left'])
  })

  it('leads with the strikeout or walk a steal or wild pitch was said with', function () {
    expect(
      told(
        game({ first: 2 }, [0, 2]),
        { type: 'baseRunning', kind: 'steal', runner: 2, to: '2B' },
        { type: 'pitch', call: 'S' }
      )
    ).deep.equals({
      primary: 'Chase L. strikes out swinging',
      secondary: 'Ann B. steals second'
    })
    const ball: ScoringAction = { type: 'pitch', call: 'B' }
    const counted = completeMotions(
      scoringReducer(game({ second: 2 }), {
        type: 'DICTATED',
        transcript: 'Ball, ball, ball, strike.',
        actions: [ball, ball, ball, { type: 'pitch', call: 'S' }]
      })
    )
    expect(
      told(
        counted,
        {
          type: 'batteryEvent',
          kind: 'wild_pitch',
          advances: [{ runner: 2, to: '3B' }]
        },
        { type: 'pitch', call: 'B' }
      )
    ).deep.equals({
      primary: 'Chase L. walks',
      secondary: 'Wild pitch; Ann B. to third'
    })
  })

  it('reads a reload’s last play by its last batter', function () {
    const opening = game({}, undefined, true)
    const state = completeMotions(
      scoringReducer(opening, {
        type: 'DICTATED',
        transcript: 'Single to left. Next batter is hit by a pitch.',
        actions: [inPlay(16), result('single'), result('hit_by_pitch')]
      })
    )
    expect(shown({ ...state, past: [] }, opening)?.primary).equals(
      'Ann B. hit by pitch'
    )
  })

  it('spans a play from its start to before its close', function () {
    const ball: ScoringAction = { type: 'pitch', call: 'B' }
    const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
    const hit = inPlay(16)
    const single = result('single')
    const move: ScoringAction = { type: 'runnerMovement', runner: 2, to: '3B' }
    const steal: ScoringAction = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 2,
      to: '2B'
    }
    // A ball in play and what followed it, not the pitch before.
    expect(lastPlaySpan([ball, hit, single, move, close], 3)).deep.equals({
      start: 1,
      end: 4
    })
    // A result with no ball in play stops at the pitch before it.
    expect(lastPlaySpan([ball, result('hit_by_pitch'), move], 2)).deep.equals({
      start: 1,
      end: 3
    })
    // A runner's move after a pitch is the pitch's.
    expect(lastPlaySpan([ball, ball, move], 2)).deep.equals({
      start: 1,
      end: 3
    })
    expect(lastPlaySpan([close, steal], 1)).deep.equals({ start: 1, end: 2 })
    // Nothing before the play ahead closed; all of the last entry.
    expect(lastPlaySpan([single, close, move], 2)).deep.equals({
      start: 2,
      end: 3
    })
    expect(lastPlaySpan([ball, ball], 0)).deep.equals({ start: 0, end: 2 })
    // One entry that scored two batters: the second batter's play.
    expect(
      lastPlaySpan([result('hit_by_pitch'), hit, result('field_out')], 0)
    ).deep.equals({ start: 1, end: 3 })
    expect(lastPlaySpan([], 0)).deep.equals({ start: 0, end: 0 })
  })
})
