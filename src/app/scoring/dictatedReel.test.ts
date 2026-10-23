import { expect } from 'chai'
import { describe, it } from 'mocha'

import type {
  BallInPlayAction,
  ResultAction,
  ScoringAction,
  Trajectory
} from '../../common/scoring/actions'
import { scoringSession } from '../../test/scoringSession'
import { BASES } from '../field/fieldModel'
import { sampleThrow } from '../field/playAnimationModel'
import { hitGeometry, outcomeOf } from './dictatedReel'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import {
  type HitSequence,
  outBatterPoint,
  presentationRuntime,
  stepPresentation,
  type ThrowSequence
} from './scoringPresentation'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

// The development game: the home team fields 10 P, 11 C, 12 1B, 13 2B,
// 14 SS, 15 3B, 16 LF, 17 CF, 18 RF; the visitors bat 1 to 9.
const F = {
  P: 10,
  C: 11,
  B1: 12,
  B2: 13,
  SS: 14,
  B3: 15,
  LF: 16,
  CF: 17,
  RF: 18
}

/** A fresh game, animations on, with runners put straight on the bases. */
function game(
  bases: { first?: number; second?: number; third?: number } = {}
): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture), true)
  const offense = state.session.liveData.linescore.offense
  // The leadoff batter is 1; runners come from further down the order.
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
/** What the field does with a picture: swing, contact, and done. */
function finishPicture(state: ScoringState): ScoringState {
  const sequence = state.presentation
  if (sequence == null) return state
  let next = state
  if (sequence.kind === 'hit' && sequence.stage === 'swing')
    next = scoringReducer(next, {
      type: 'PRESENTATION_CONTACT',
      id: sequence.id,
      generation: sequence.generation
    })
  const now = next.presentation!
  return scoringReducer(next, {
    type: 'PRESENTATION_DONE',
    id: now.id,
    generation: now.generation,
    stage: now.stage
  })
}
function finishMotion(state: ScoringState, playerId: number): ScoringState {
  const motion = state.motions.find(
    m => m.playerId === playerId && !m.complete && m.held !== true
  )!
  return scoringReducer(state, {
    type: 'MOTION_DONE',
    id: motion.id,
    generation: motion.generation
  })
}
function moving(state: ScoringState): number[] {
  return state.motions
    .filter(m => !m.complete && m.held !== true)
    .map(m => m.playerId)
    .sort((a, b) => a - b)
}
function held(state: ScoringState): number[] {
  return state.motions.filter(m => m.held === true).map(m => m.playerId)
}
/**
 * While a tag throw is up, the field draws the runner from the picture, on
 * his way from where he stood; his walk off, already queued, leaves from the
 * base he is tagged at for the dugout.
 */
function drawnByPicture(
  state: ScoringState,
  runner: number,
  base: { x: number; z: number }
): void {
  const thrown = state.presentation as ThrowSequence
  expect(thrown).deep.include({ kind: 'throw', stage: 'tag', runner })
  const drawn = scoringFieldPlayers(state).find(p => p.playerId === runner)!
  expect(drawn.position).deep.equals({
    x: thrown.runnerFrom.x,
    z: thrown.runnerFrom.z
  })
  expect(drawn.motion).equals(undefined)
  const walks = state.motions.filter(
    m => m.playerId === runner && m.held !== true && !m.complete
  )
  expect(walks).length(1)
  expect(walks[0].waypoints[0]).deep.equals(base)
  const dugout = walks[0].waypoints.at(-1)!
  expect([Math.abs(dugout.x), dugout.z]).deep.equals([32, 6])
}
function spoken(
  state: ScoringState,
  transcript: string,
  ...actions: ScoringAction[]
): ScoringState {
  return scoringReducer(state, { type: 'DICTATED', transcript, actions })
}
/** Plays the reel, naming each throw `thrower>receiver:stage:unassisted`. */
function throwsOf(state: ScoringState): {
  state: ScoringState
  order: string[]
} {
  const order: string[] = []
  for (
    let step = 0;
    step < 30 && (state.presentation != null || state.reel != null);
    step++
  ) {
    const sequence = state.presentation
    if (sequence != null) {
      order.push(
        sequence.kind === 'throw'
          ? `${sequence.thrower}>${sequence.receiver}:${sequence.stage}:${sequence.unassisted}${sequence.safe === true ? ':safe' : ''}`
          : sequence.kind
      )
      if (sequence.kind === 'throw' && sequence.stage === 'tag')
        drawnByPicture(state, sequence.runner, {
          x: sequence.to.x,
          z: sequence.to.z
        })
      state = finishPicture(state)
    } else
      state = finishMotion(
        state,
        state.motions.find(m => !m.complete && m.held !== true)!.playerId
      )
  }
  return { state, order }
}
/** Plays the whole reel as the field would. */
function playOut(state: ScoringState): ScoringState {
  for (let step = 0; step < 50; step++) {
    if (state.presentation != null) {
      state = finishPicture(state)
      continue
    }
    const motion = state.motions.find(m => !m.complete && m.held !== true)
    if (motion == null) return state
    state = finishMotion(state, motion.playerId)
  }
  throw new Error('The reel did not end')
}
const grounder: ScoringAction = {
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'ground_ball',
  fielder: F.SS
}
const single: ScoringAction[] = [
  {
    type: 'ballInPlay',
    contact: 'swing',
    trajectory: 'line_drive',
    fielder: F.LF
  },
  { type: 'result', eventType: 'single' }
]

describe('a dictated sentence on the field', function () {
  for (const reversed of [false, true])
    it(`keeps each batter's receiver and animation within his words (${reversed})`, function () {
      const plays = [
        { words: 'Grounds out to short.', fielder: F.SS, receiver: F.B1 },
        {
          words:
            'Grounds out, fielded by the first baseman and thrown to the pitcher for the out.',
          fielder: F.B1,
          receiver: F.P
        }
      ]
      if (reversed) plays.reverse()
      let state = scoringReducer(game(), {
        type: 'DICTATED',
        transcript: plays.map(play => play.words).join(' Next batter '),
        actions: plays.flatMap(
          play =>
            [
              {
                type: 'ballInPlay',
                contact: 'swing',
                trajectory: 'ground_ball',
                fielder: play.fielder
              },
              { type: 'result', eventType: 'field_out', outBy: 'throw' }
            ] as ScoringAction[]
        )
      })
      expect(state.dictationQuestion).equals(undefined)
      const throws: string[] = []
      for (let i = 0; i < 50 && !atRest(state); i++) {
        if (state.presentation != null) {
          if (state.presentation.kind === 'throw')
            throws.push(
              `${state.presentation.thrower}>${state.presentation.receiver}`
            )
          state = finishPicture(state)
        } else {
          const motion = state.motions.find(m => !m.complete && m.held !== true)
          if (motion == null) break
          state = finishMotion(state, motion.playerId)
        }
      }
      expect(throws).deep.equals(
        plays.map(play => `${play.fielder}>${play.receiver}`)
      )
      expect(state.session.liveData.linescore.outs).equals(2)
      expect(
        state.session.liveData.plays.allPlays.map(play =>
          play.runners.flatMap(runner =>
            runner.credits.map(credit => [credit.player.id, credit.credit])
          )
        )
      ).deep.equals(
        plays.map(play => [
          [play.fielder, 'f_assist'],
          [play.receiver, 'f_putout']
        ])
      )
    })

  for (const example of [
    {
      transcript: '6-4-3 double play',
      bases: { first: 5 },
      fielder: F.SS,
      throws: [`${F.SS}>${F.B2}`, `${F.B2}>${F.B1}`],
      credits: [
        [5, F.SS, 'f_assist'],
        [5, F.B2, 'f_putout'],
        [1, F.B2, 'f_assist'],
        [1, F.B1, 'f_putout']
      ],
      outs: 2
    },
    {
      transcript:
        'Grounder fielded by the first baseman and thrown to the pitcher for the out',
      bases: {},
      fielder: F.B1,
      throws: [`${F.B1}>${F.P}`],
      credits: [
        [1, F.B1, 'f_assist'],
        [1, F.P, 'f_putout']
      ],
      outs: 1
    }
  ])
    it(`animates and credits the entire dictated route: ${example.transcript}`, function () {
      const before = game(example.bases)
      let state = scoringReducer(before, {
        type: 'DICTATED',
        transcript: example.transcript,
        actions: [
          {
            type: 'ballInPlay',
            contact: 'swing',
            trajectory: 'ground_ball',
            fielder: example.fielder
          },
          { type: 'result', eventType: 'field_out', outBy: 'throw' }
        ]
      })
      expect(state.dictationQuestion).equals(undefined)
      const throws: string[] = []
      for (let i = 0; i < 40 && !atRest(state); i++) {
        if (state.presentation != null) {
          if (state.presentation.kind === 'throw')
            throws.push(
              `${state.presentation.thrower}>${state.presentation.receiver}`
            )
          state = finishPicture(state)
        } else {
          const motion = state.motions.find(m => !m.complete && m.held !== true)
          if (motion == null) break
          state = finishMotion(state, motion.playerId)
        }
      }
      expect(throws).deep.equals(example.throws)
      expect(state.session.liveData.linescore.outs).equals(example.outs)
      const play = state.session.liveData.plays.allPlays.at(-1)!
      expect(
        play.runners.flatMap(r =>
          (r.credits ?? []).map(c => [
            r.details.runner.id,
            c.player.id,
            c.credit
          ])
        )
      ).deep.equals(example.credits)
      const undone = scoringReducer(playOut(state), { type: 'UNDO' })
      expect(undone.session.liveData.linescore.outs).equals(0)
    })

  it('plays each pitch in turn, with the game already holding both', function () {
    const before = game()
    let state = say(
      before,
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' }
    )
    expect(state.log).to.have.length(2)
    expect(state.past).to.have.length(1)
    expect(state.session.liveData.linescore.balls).equals(1)
    expect(state.presentation).deep.include({
      kind: 'pitch',
      pitch: 'ball',
      dictated: true
    })
    expect(state.reel).to.have.length(1)
    expect(atRest(state)).equals(false)
    state = finishPicture(state)
    expect(state.presentation).deep.include({ kind: 'pitch', pitch: 'called' })
    state = finishPicture(state)
    expect(state.presentation).equals(null)
    expect(state.reel).equals(undefined)
    expect(atRest(state)).equals(true)
  })

  it('runs the batter and every runner together while a hit is in the air', function () {
    let state = say(game({ second: 5 }), ...single)
    const hit = state.presentation as HitSequence
    expect(hit).deep.include({
      kind: 'hit',
      stage: 'swing',
      fielder: F.LF,
      dictated: true
    })
    const leftFielder = fieldPlayersFor(game().session).find(
      p => p.playerId === F.LF
    )!
    expect(hit.arc.target).deep.equals(leftFielder.position)
    expect(hit.arc.angle).equals(12)
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    expect(moving(state)).deep.equals([batter, 5].sort((a, b) => a - b))
    expect(held(state)).deep.equals([])
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: hit.id,
      generation: hit.generation
    })
    expect((state.presentation as HitSequence).stage).equals('flight')
    // Both finish during the flight, as they do for a tapped hit.
    state = finishMotion(state, 5)
    state = finishMotion(state, batter)
    expect(moving(state)).deep.equals([])
    state = finishPicture(state)
    expect(state.reel).equals(undefined)
    expect(state.phase).equals('correctionWindow')
  })

  it('runs second to third to home as one run when he scores on the hit', function () {
    const state = say(game({ second: 5 }), ...single, {
      type: 'runnerMovement',
      runner: 5,
      to: 'home'
    })
    const runner = state.motions.find(m => m.playerId === 5)!
    expect(runner.waypoints[0]).deep.equals(BASES[2])
    expect(runner.waypoints).to.deep.include(BASES[3])
    expect(runner.waypoints.at(-1)).not.deep.equal(BASES[3])
    expect(moving(state)).to.include(5)
  })

  it('holds a tag-up at third until the catch, then sends him', function () {
    let state = say(
      game({ third: 5 }),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 5, to: 'home', reason: 'Advance' }
    )
    expect((state.presentation as HitSequence).out).equals(true)
    expect(held(state)).deep.equals([5])
    // In the air, the field draws from the motions: he stands at third.
    const hit = state.presentation!
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: hit.id,
      generation: hit.generation
    })
    const standing = scoringFieldPlayers(state).find(p => p.playerId === 5)!
    expect(standing.position).deep.equals(BASES[3])
    expect(standing.target).deep.equals(BASES[3])
    expect(standing.motion).equals(undefined)
    state = finishPicture(state)
    // The catch is over: he leaves now, whatever else is still moving.
    expect(held(state)).deep.equals([])
    expect(moving(state)).to.include(5)
    state = playOut(state)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(state.reel).equals(undefined)
  })

  it('plays the throw of a ground out after the hit, and records nothing twice', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'ground_ball',
        fielder: F.SS
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [F.SS, F.B1]
      }
    )
    const log = state.log
    expect(state.presentation?.kind).equals('hit')
    const landing = (state.presentation as HitSequence).arc.target
    // The hit runs him toward first; the throw takes him on from there, at
    // the same pace, so he reaches the bag with the ball and not before it.
    const hit = state.presentation as HitSequence
    const ranTo = outBatterPoint(hit)
    const start = hit.players.find(p => p.playerId === batter)!.position
    state = finishPicture(state)
    const thrown = state.presentation as ThrowSequence
    expect({ x: thrown.runnerFrom.x, z: thrown.runnerFrom.z }).deep.equals(
      ranTo
    )
    const left = Math.hypot(BASES[1].x - ranTo.x, BASES[1].z - ranTo.z)
    expect(left).greaterThan(5)
    expect(ranTo.z).lessThan(-1)
    const hitPace =
      Math.hypot(ranTo.x - start.x, ranTo.z - start.z) /
      (hit.durationMs - hit.contactMs)
    expect(left / thrown.durationMs).closeTo(hitPace, hitPace * 0.01)
    // He leaves with the windup, not after it.
    expect(sampleThrow(thrown, 100).runnerProgress).greaterThan(0)
    expect(thrown).deep.include({
      kind: 'throw',
      stage: 'tag',
      unassisted: false,
      thrower: F.SS,
      receiver: F.B1,
      runner: batter,
      dictated: true
    })
    expect(sampleThrow(thrown, thrown.durationMs / 2).visible).equals(true)
    drawnByPicture(state, batter, BASES[1])
    expect(thrown.holderOrigin).deep.equals(landing)
    expect({ x: thrown.to.x, z: thrown.to.z }).deep.equals(BASES[1])
    state = playOut(state)
    // The throw recorded nothing again; the bases being empty, the screen
    // closed the play itself, as it does after the same play tapped.
    expect(state.log.slice(0, log.length)).deep.equals(log)
    expect(state.log.slice(log.length)).deep.equals([
      { type: 'gameFlow', kind: 'closePlay' }
    ])
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('runs a runner safe on a ground out with the hit, not after the throw', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(
      game({ first: 5, third: 7 }),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'ground_ball',
        fielder: F.SS
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [F.SS, F.B1]
      },
      { type: 'runnerMovement', runner: 5, to: '2B' },
      { type: 'runnerMovement', runner: 7, to: 'home' }
    )
    expect(state.presentation?.kind).equals('hit')
    // The batter runs with the throw that meets him at first.
    expect(moving(state)).deep.equals([5, 7])
    expect(held(state)).deep.equals([batter])
    const hit = state.presentation as HitSequence
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: hit.id,
      generation: hit.generation
    })
    state = finishMotion(finishMotion(state, 5), 7)
    expect(state.presentation).deep.include({ kind: 'hit', stage: 'flight' })
    state = finishPicture(state)
    expect(state.presentation).deep.include({ kind: 'throw', runner: batter })
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(state.session.liveData.linescore.offense.second?.id).equals(5)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
  })

  it('shows a caught foul caught in foul territory, by the corner infielder away from the batter', function () {
    const state = say(
      game(),
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'field_out', foulCaught: true }
    )
    const hit = state.presentation as HitSequence
    expect(hit).deep.include({ kind: 'hit', fielder: F.B1 })
    expect(Math.abs(hit.arc.target.x)).greaterThan(-hit.arc.target.z)
  })

  it('plays an unassisted out as the fielder taking the ball to the base', function () {
    let state = say(game({ second: 5 }), {
      type: 'baseRunning',
      kind: 'caught_stealing',
      runner: 5,
      to: '3B',
      fielders: [F.B3]
    })
    expect(state.presentation).deep.include({
      kind: 'throw',
      stage: 'tag',
      unassisted: true,
      thrower: F.B3
    })
    const carried = state.presentation as ThrowSequence
    expect(sampleThrow(carried, carried.durationMs / 2).visible).equals(false)
    drawnByPicture(state, 5, BASES[3])
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('throws a runner out caught stealing with him running to the base', function () {
    let state = say(game({ first: 5 }), {
      type: 'baseRunning',
      kind: 'caught_stealing',
      runner: 5,
      to: '2B',
      fielders: [F.C, F.SS]
    })
    const thrown = state.presentation as ThrowSequence
    expect(thrown).deep.include({
      kind: 'throw',
      stage: 'tag',
      unassisted: false,
      thrower: F.C,
      receiver: F.SS
    })
    expect({ x: thrown.runnerFrom.x, z: thrown.runnerFrom.z }).deep.equals(
      BASES[1]
    )
    expect(sampleThrow(thrown, thrown.durationMs / 2).visible).equals(true)
    drawnByPicture(state, 5, BASES[2])
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('throws a runner picked off back to the base he walks off from', function () {
    let state = say(game({ first: 5 }), {
      type: 'baseRunning',
      kind: 'pickoff',
      runner: 5,
      to: '1B',
      fielders: [F.P, F.B1]
    })
    expect(state.presentation).deep.include({
      kind: 'throw',
      stage: 'tag',
      unassisted: false,
      thrower: F.P,
      receiver: F.B1
    })
    drawnByPicture(state, 5, BASES[1])
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('tags the batter at first on the toss to the pitcher covering', function () {
    const { state, order } = throwsOf(
      spoken(
        game(),
        'Grounder to first, tosses it to the pitcher for the out at first.',
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'ground_ball',
          fielder: F.B1
        },
        { type: 'result', eventType: 'field_out', outBy: 'throw' }
      )
    )
    expect(order).deep.equals(['hit', `${F.B1}>${F.P}:tag:false`])
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(state.session.liveData.linescore.offense.first ?? null).equals(null)
  })

  it('keeps every hop of an all-Safe relay a transfer', function () {
    const route = [
      { id: F.B3, point: { x: -20, z: -35 } },
      { id: F.B2, point: { ...BASES[2] } },
      { id: F.B1, point: { ...BASES[1] } }
    ]
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    const { state, order } = throwsOf(
      spoken(
        game({ first: 6 }),
        "Fielder's choice. Ground ball to third.",
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'ground_ball',
          fielder: F.B3
        },
        { type: 'result', eventType: 'fielders_choice' },
        {
          type: 'runnerMovement',
          runner: batter,
          to: '1B',
          fielders: route.map(hop => hop.id),
          locations: route.map(hop => hop.point)
        },
        { type: 'runnerMovement', runner: 6, to: '2B' }
      )
    )
    expect(order).deep.equals([
      'hit',
      `${F.B3}>${F.B2}:transfer:false:safe`,
      `${F.B2}>${F.B1}:transfer:false:safe`
    ])
    expect(state.session.liveData.linescore.outs).equals(0)
  })

  it('plays a double play as its throws, in the order they were said', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    const state = say(
      game({ first: 5 }),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'ground_ball',
        fielder: F.SS
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: 5,
        to: '2B',
        out: true,
        fielders: [F.SS, F.B2]
      },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [F.B2, F.B1]
      }
    )
    expect(state.presentation?.kind).equals('hit')
    expect(held(state).sort((a, b) => a - b)).deep.equals(
      [batter, 5].sort((a, b) => a - b)
    )
    // Through the first throw he waits where the hit's run left him.
    const ranTo = outBatterPoint(state.presentation as HitSequence)
    expect(
      state.motions.find(m => m.playerId === batter && m.held === true)!
        .waypoints[0]
    ).deep.equals(ranTo)
    const played = throwsOf(state)
    expect(played.order).deep.equals([
      'hit',
      `${F.SS}>${F.B2}:tag:false`,
      `${F.B2}>${F.B1}:tag:false`
    ])
    expect(played.state.session.liveData.linescore.outs).equals(2)
  })

  it('runs the batter out unassisted at first at one pace with the carry', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'ground_ball',
        fielder: F.B1
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [F.B1]
      }
    )
    const hit = state.presentation as HitSequence
    const ranTo = outBatterPoint(hit)
    const start = hit.players.find(p => p.playerId === batter)!.position
    state = finishPicture(state)
    const carried = state.presentation as ThrowSequence
    expect(carried).deep.include({ stage: 'tag', unassisted: true })
    expect({ x: carried.runnerFrom.x, z: carried.runnerFrom.z }).deep.equals(
      ranTo
    )
    const left = Math.hypot(BASES[1].x - ranTo.x, BASES[1].z - ranTo.z)
    const hitPace =
      Math.hypot(ranTo.x - start.x, ranTo.z - start.z) /
      (hit.durationMs - hit.contactMs)
    expect(left / carried.durationMs).closeTo(hitPace, hitPace * 0.01)
  })

  it('shows the batter at the plate in a picture before his hit', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(
      game({ first: 5 }),
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 5,
        to: '2B',
        fielders: [F.C, F.SS]
      },
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [F.SS, F.B1]
      }
    )
    const atPlate = (point: { x: number; z: number }): boolean =>
      Math.hypot(point.x, point.z) < 5
    expect(state.presentation).deep.include({ kind: 'throw', runner: 5 })
    const drawn = scoringFieldPlayers(state).find(p => p.playerId === batter)!
    expect(atPlate(drawn.position)).equals(true)
    const hold = state.motions.find(
      m => m.playerId === batter && m.held === true
    )
    if (hold != null) expect(atPlate(hold.waypoints[0])).equals(true)
    // Once his hit starts, he waits where it leaves him.
    for (let i = 0; i < 20 && state.presentation?.kind !== 'hit'; i++)
      state =
        state.presentation != null
          ? finishPicture(state)
          : finishMotion(
              state,
              state.motions.find(m => !m.complete && m.held !== true)!.playerId
            )
    const ranTo = outBatterPoint(state.presentation as HitSequence)
    expect(
      state.motions.find(m => m.playerId === batter && m.held === true)!
        .waypoints[0]
    ).deep.equals(ranTo)
  })

  it('pictures the pitches of the second at-bat with the batter up', function () {
    let state = spoken(
      game(),
      'Single. Next batter: ball, ball, grounds out to short.',
      ...single,
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    const batters: string[] = []
    for (let i = 0; i < 60 && !atRest(state); i++) {
      const p = state.presentation
      if (p != null) {
        if (p.kind !== 'throw') batters.push(`${p.kind}:${p.batter}`)
        state = finishPicture(state)
      } else {
        const motion = state.motions.find(m => !m.complete && m.held !== true)
        if (motion == null) break
        state = finishMotion(state, motion.playerId)
      }
    }
    expect(batters).deep.equals(['hit:1', 'pitch:2', 'pitch:2', 'hit:2'])
  })

  it('runs the batter who is up in the second at-bat of a sentence', function () {
    let state = spoken(
      game(),
      'Grounds out to short. Next batter grounds out to second.',
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      { ...grounder, fielder: F.B2 },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    const hits: number[] = []
    const tagged: Array<{ runner: number; from: { x: number; z: number } }> = []
    for (let i = 0; i < 60 && !atRest(state); i++) {
      const p = state.presentation
      if (p != null) {
        if (p.kind === 'hit') hits.push(p.batter)
        if (p.kind === 'throw')
          tagged.push({ runner: p.runner, from: p.runnerFrom })
        state = finishPicture(state)
      } else {
        const motion = state.motions.find(m => !m.complete && m.held !== true)
        if (motion == null) break
        state = finishMotion(state, motion.playerId)
      }
    }
    expect(hits).deep.equals([1, 2])
    expect(tagged.map(t => t.runner)).deep.equals([1, 2])
    for (const { from } of tagged) expect(from.z).lessThan(-1)
  })

  it('keeps the batter where the hit left him through the first throw of a double play', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = spoken(
      game({ first: 5 }),
      'Six four three double play.',
      grounder,
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    const ranTo = outBatterPoint(state.presentation as HitSequence)
    state = finishPicture(state)
    const first = state.presentation as ThrowSequence
    expect(first).deep.include({ runner: 5, receiver: F.B2 })
    const drawn = scoringFieldPlayers(state).find(p => p.playerId === batter)!
    expect(drawn.position).deep.equals(ranTo)
    expect(drawn.batting).equals(false)
    const batterThrown = (): boolean =>
      state.presentation?.kind === 'throw' &&
      state.presentation.runner === batter
    while (!batterThrown()) {
      if (state.presentation != null) state = finishPicture(state)
      else
        state = finishMotion(
          state,
          state.motions.find(m => !m.complete && m.held !== true)!.playerId
        )
    }
    const second = state.presentation as unknown as ThrowSequence
    expect({ x: second.runnerFrom.x, z: second.runnerFrom.z }).deep.equals(
      ranTo
    )
  })

  it('plays a spoken six-four-three as the two throws it expands to', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    const { state, order } = throwsOf(
      spoken(
        game({ first: 5 }),
        'Six four three double play.',
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'ground_ball',
          fielder: F.SS
        },
        { type: 'result', eventType: 'field_out', outBy: 'throw' }
      )
    )
    expect(order).deep.equals([
      'hit',
      `${F.SS}>${F.B2}:tag:false`,
      `${F.B2}>${F.B1}:tag:false`
    ])
    expect(state.session.liveData.linescore.outs).equals(2)
    const play = state.session.liveData.plays.allPlays.at(-1)!
    const outs = play.runners
      .filter(r => r.movement.isOut)
      .map(r => [
        r.details.runner.id,
        r.credits
          .filter(c => c.credit === 'f_assist' || c.credit === 'f_putout')
          .map(c => c.player.id)
      ])
    expect(outs).deep.equals([
      [5, [F.SS, F.B2]],
      [batter, [F.B2, F.B1]]
    ])
  })

  it('throws a caught ball to the base the runner is out at, with him running', function () {
    let state = say(
      game({ first: 5 }),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      {
        type: 'runnerMovement',
        runner: 5,
        to: '2B',
        out: true,
        fielders: [F.LF, F.SS]
      }
    )
    expect(state.presentation?.kind).equals('hit')
    expect(held(state)).deep.equals([5])
    const landing = (state.presentation as HitSequence).arc.target
    const ranTo = outBatterPoint(state.presentation as HitSequence)
    state = finishPicture(state)
    // The batter's out trot is on the catch, from where the catch left him.
    // The throw starts once he is done.
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    expect(
      state.motions.find(m => m.playerId === batter && !m.complete)!
        .waypoints[0]
    ).deep.equals(ranTo)
    while (state.presentation == null) {
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      if (motion == null) break
      state = finishMotion(state, motion.playerId)
    }
    const thrown = state.presentation as ThrowSequence
    expect(thrown).deep.include({
      kind: 'throw',
      stage: 'tag',
      unassisted: false,
      thrower: F.LF,
      receiver: F.SS,
      runner: 5
    })
    expect(thrown.holderOrigin).deep.equals(landing)
    expect({ x: thrown.to.x, z: thrown.to.z }).deep.equals(BASES[2])
    expect({ x: thrown.runnerFrom.x, z: thrown.runnerFrom.z }).deep.equals(
      BASES[1]
    )
    const flight = sampleThrow(thrown, thrown.durationMs / 2)
    expect(flight.visible).equals(true)
    expect(flight.ball.y).greaterThan(thrown.from.y)
    drawnByPicture(state, 5, BASES[2])
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(2)
    expect(state.reel).equals(undefined)
  })

  it('plays a wild pitch after the pitch it came on', function () {
    let state = say(
      game({ first: 5 }),
      { type: 'pitch', call: 'B' },
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 5, to: '2B' }]
      }
    )
    expect(state.presentation?.kind).equals('pitch')
    expect(held(state)).deep.equals([5])
    state = finishPicture(state)
    expect(moving(state)).deep.equals([5])
  })

  it('walks a hit batsman to first after the sentence, with no picture', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(game(), { type: 'result', eventType: 'hit_by_pitch' })
    expect(state.presentation).equals(null)
    expect(moving(state)).deep.equals([batter])
    state = playOut(state)
    expect(state.reel).equals(undefined)
  })

  it('shows nothing for a sentence that moves nobody', function () {
    const state = say(game(), {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'L'
    })
    expect(state.log).to.have.length(1)
    expect(state.reel).equals(undefined)
    expect(state.presentation).equals(null)
    expect(atRest(state)).equals(true)
  })

  it('celebrates a home run only until its runners finish and the next batter is ready', function () {
    let state = say(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.CF
      },
      { type: 'result', eventType: 'home_run' }
    )
    expect((state.presentation as HitSequence).outOfPark).equals(true)
    expect(state.celebration?.kind).equals('out-of-park')
    state = playOut(state)
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.offense.batter?.id).equals(2)
    expect(state.celebration).equals(null)
  })

  it('stores what the LLM said, not the geometry made up for the picture', function () {
    const actions = [...single]
    const state = say(game({ second: 5 }), ...actions)
    expect(state.log).deep.equals(actions)
  })

  it('keeps the order without pictures when animations are off', function () {
    let state = say(
      { ...game({ third: 5 }), presentationEnabled: false },
      { type: 'pitch', call: 'B' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 5, to: 'home', reason: 'Advance' }
    )
    expect(state.presentation).equals(null)
    expect(held(state)).deep.equals([5])
    // The runner waits for what came before him to finish moving.
    state = playOut(state)
    expect(state.reel).equals(undefined)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
  })

  it('walks a batter caught out off from the plate when animations are off', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    const state = say(
      { ...game(), presentationEnabled: false },
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' }
    )
    expect(state.presentation).equals(null)
    const walk = state.motions.find(m => m.playerId === batter && !m.complete)!
    expect(Math.hypot(walk.waypoints[0].x, walk.waypoints[0].z)).lessThan(5)
  })

  it('keeps a sentence that arrives mid-reel and applies it after', function () {
    let state = say(game(), { type: 'pitch', call: 'B' })
    state = say(state, { type: 'pitch', call: 'C' })
    expect(state.queuedDictation).to.have.length(1)
    expect(state.log).to.have.length(1)
    expect(state.dictation?.problem).equals(undefined)
    state = finishPicture(state)
    // The first ended; the second is applied and playing.
    expect(state.queuedDictation).equals(undefined)
    expect(state.log).to.have.length(2)
    expect(state.presentation).deep.include({ kind: 'pitch', pitch: 'called' })
    expect(state.past).to.have.length(2)
  })

  it('drops the reel and the queue on Undo', function () {
    let state = say(game(), { type: 'pitch', call: 'B' })
    state = say(state, { type: 'pitch', call: 'C' })
    state = scoringReducer(state, { type: 'UNDO' })
    expect(state.reel).equals(undefined)
    expect(state.queuedDictation).equals(undefined)
    expect(state.log).deep.equals([])
    expect(atRest(state)).equals(true)
  })

  it('holds a batter it runs out only while the reel goes on with him', function () {
    // A ground out saved without the batter's out, as a tapped one is: the
    // reel ends with nobody held, waiting for the next save.
    const state = playOut(
      say(game(), grounder, {
        type: 'result',
        eventType: 'field_out',
        outBy: 'throw'
      })
    )
    expect(state.reel ?? null).equals(null)
    expect(
      state.motions.filter(motion => !motion.complete && motion.held === true)
    ).deep.equals([])
  })

  describe('the geometry it makes up', function () {
    it('throws a ball off the wall from its carom, where the fielder played it', function () {
      let state = spoken(
        game({ first: 5 }),
        'Off the wall in left, double, the left fielder throws home, out.',
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'line_drive',
          fielder: F.LF,
          direction: 'left'
        },
        { type: 'result', eventType: 'double' },
        {
          type: 'runnerMovement',
          runner: 5,
          to: 'home',
          out: true,
          fielders: [F.LF, F.C]
        }
      )
      let carom: { x: number; z: number } | undefined
      let from: { x: number; z: number } | undefined
      for (let step = 0; step < 40 && from == null; step++) {
        const sequence = state.presentation
        if (sequence?.kind === 'hit') carom ??= sequence.carom
        if (sequence?.kind === 'throw' && sequence.thrower === F.LF)
          from = sequence.from
        if (sequence != null) state = finishPicture(state)
        else {
          const motion = state.motions.find(m => !m.complete && m.held !== true)
          if (motion == null) break
          state = finishMotion(state, motion.playerId)
        }
      }
      // From the thrower's hand at the carom, 8 u short of the wall.
      expect(carom).not.equals(undefined)
      expect(from).not.equals(undefined)
      expect(Math.hypot(from!.x - carom!.x, from!.z - carom!.z)).lessThan(4)
    })

    const session = game().session
    const inPlay = (
      more: Partial<BallInPlayAction> = {}
    ): BallInPlayAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      ...more
    })
    const result = (
      eventType: ResultAction['eventType'],
      more: Partial<ResultAction> = {}
    ): ResultAction => ({ type: 'result', eventType, ...more })
    const at = (
      trajectory: Trajectory,
      ending: ResultAction = result('single')
    ): number =>
      hitGeometry({ session }, inPlay({ trajectory, fielder: F.CF }), ending)
        .angle

    it('takes the angle from the trajectory', function () {
      expect(
        (
          ['ground_ball', 'chopper', 'line_drive', 'fly_ball', 'popup'] as const
        ).map(trajectory => at(trajectory))
      ).deep.equals([-8, -3, 12, 35, 65])
    })

    it('falls back on the outcome, and keeps a caught ball in the air', function () {
      const plain = (
        ending: ResultAction,
        more: Partial<BallInPlayAction> = {}
      ): number => hitGeometry({ session }, inPlay(more), ending).angle
      expect(plain(result('field_out', { outBy: 'catch' }))).equals(35)
      expect(plain(result('field_out', { outBy: 'throw' }))).equals(-8)
      expect(plain(result('double'))).equals(12)
      expect(plain(result('single'), { contact: 'bunt' })).equals(-15)
      expect(plain(result('single'), { launchAngle: 22 })).equals(22)
      // A caught ball cannot be a grounder.
      expect(at('ground_ball', result('field_out', { outBy: 'catch' }))).equals(
        10
      )
    })

    it('uses a given location, and the middle of the field with no fielder', function () {
      const given = hitGeometry(
        { session },
        inPlay({ location: { x: 10, z: -60 } }),
        result('field_out', { outBy: 'catch' })
      )
      expect(given.pending.location).deep.equals({ x: 10, z: -60 })
      const none = hitGeometry({ session }, inPlay(), undefined)
      expect(none.pending.outcome).equals('Single')
      expect(none.pending.location!.x).equals(0)
      expect(none.pending.fielder).equals(undefined)
      const inPark = hitGeometry(
        { session },
        inPlay({ fielder: F.CF, homeRunKind: 'in-park' }),
        result('home_run')
      )
      expect(inPark.pending.homeRunKind).equals('in-park')
    })

    it('reads each result as the screen names it', function () {
      expect(outcomeOf(result('double'))).equals('Double')
      expect(outcomeOf(result('field_error'))).equals('Error')
      expect(outcomeOf(result('fielders_choice'))).equals("Fielder's Choice")
      expect(outcomeOf(result('field_out', { foulCaught: true }))).equals(
        'Ball Caught'
      )
      expect(outcomeOf(result('field_out', { outBy: 'interference' }))).equals(
        'Batter Interference'
      )
      expect(outcomeOf(result('field_out'))).equals('Throw Out')
      expect(outcomeOf(result('hit_by_pitch'))).equals('Single')
    })
  })
})

describe('a base an infielder took for the out, on the field', function () {
  /** The pictures the reel draws, a throw as `thrower>receiver:unassisted`. */
  function picturesOf(state: ScoringState): {
    state: ScoringState
    order: string[]
  } {
    const order: string[] = []
    for (let step = 0; step < 40 && !atRest(state); step++) {
      const sequence = state.presentation
      if (sequence != null) {
        order.push(
          sequence.kind === 'throw'
            ? `${sequence.thrower}>${sequence.receiver}:${sequence.unassisted}`
            : sequence.kind
        )
        state = finishPicture(state)
        continue
      }
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      if (motion == null) break
      state = finishMotion(state, motion.playerId)
    }
    return { state, order }
  }

  it('draws the shortstop carrying the ball to second for the force', function () {
    const { order } = picturesOf(
      spoken(
        game({ first: 7 }),
        "Grounder to the shortstop, who tags second for fielder's choice.",
        grounder,
        { type: 'result', eventType: 'fielders_choice' }
      )
    )
    expect(order).deep.equals(['hit', `${F.SS}>${F.SS}:true`])
  })

  it('draws the safe runners where they ran to, while the base is taken', function () {
    let state = spoken(
      game({ first: 7, second: 8 }),
      'Grounder to third, and the third baseman takes third base for the out.',
      { ...grounder, fielder: F.B3 },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    for (
      let step = 0;
      step < 40 && state.presentation?.kind !== 'throw';
      step++
    )
      state =
        state.presentation != null
          ? finishPicture(state)
          : finishMotion(
              state,
              state.motions.find(m => !m.complete && m.held !== true)!.playerId
            )
    const carry = state.presentation
    if (carry?.kind !== 'throw') throw new Error('Expected the carry')
    const at = (id: number): { x: number; z: number } =>
      carry.players.find(p => p.playerId === id)!.position
    const near = (
      a: { x: number; z: number },
      b: { x: number; z: number }
    ): boolean => Math.hypot(a.x - b.x, a.z - b.z) < 2
    expect(near(at(1), BASES[1])).equals(true)
    expect(near(at(7), BASES[2])).equals(true)
  })

  it("starts a fielder's choice's carry as soon as the hit's picture ends", function () {
    const state = spoken(
      game({ first: 7 }),
      "Grounder to the shortstop, who tags second for fielder's choice.",
      grounder,
      { type: 'result', eventType: 'fielders_choice' }
    )
    const carry = state.reel?.find(beat => beat.presentation?.kind === 'throw')
    expect(carry?.after).equals('presentation')
  })

  it('keeps the forced runner at the bag from his arrival to the carry', function () {
    let state = spoken(
      game({ first: 7 }),
      "Grounder to the shortstop, who tags second for fielder's choice.",
      grounder,
      { type: 'result', eventType: 'fielders_choice' }
    )
    const hit = state.presentation!
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: hit.id,
      generation: hit.generation
    })
    // He reaches the bag before the shortstop has the ball.
    state = finishMotion(state, 7)
    expect(state.presentation?.id).equals(hit.id)
    const drawn = scoringFieldPlayers(state).find(p => p.playerId === 7)
    expect(drawn).not.equals(undefined)
    expect(
      Math.hypot(drawn!.position.x - BASES[2].x, drawn!.position.z - BASES[2].z)
    ).lessThan(5)
  })

  it('draws the third baseman taking third, and no throw to first', function () {
    const { order, state } = picturesOf(
      spoken(
        game({ first: 7, second: 8 }),
        'Grounder to third, and the third baseman takes third base for the out.',
        { ...grounder, fielder: F.B3 },
        { type: 'result', eventType: 'field_out', outBy: 'throw' }
      )
    )
    expect(order).deep.equals(['hit', `${F.B3}>${F.B3}:true`])
    expect(state.session.liveData.linescore.outs).equals(1)
  })
})

describe('a force and an overthrow at first, on the field', function () {
  const BATTER = 1
  const words =
    'Grounder to the shortstop, he tags second for the out, but overthrows first. For an error, and batter is safe.'
  const said: ScoringAction[] = [
    grounder,
    {
      type: 'runnerMovement',
      runner: 7,
      to: '2B',
      out: true,
      reason: 'Force Out'
    },
    { type: 'result', eventType: 'field_error' },
    {
      type: 'fieldingPlay',
      fielders: [F.SS],
      error: F.SS,
      errorKind: 'throwing'
    }
  ]

  it('draws a throw to the pitcher covering first sailing past first, not home', function () {
    let state = spoken(
      game({}),
      'The first baseman fields it and throws it away to the pitcher covering.',
      { ...grounder, fielder: F.B1 },
      { type: 'result', eventType: 'field_error' },
      {
        type: 'fieldingPlay',
        fielders: [F.B1, F.P],
        error: F.B1,
        errorKind: 'throwing'
      }
    )
    let wild: ThrowSequence | undefined
    for (let step = 0; step < 40 && !atRest(state); step++) {
      const sequence = state.presentation
      if (sequence != null) {
        if (sequence.kind === 'throw' && sequence.wild === true) wild = sequence
        state = finishPicture(state)
        continue
      }
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      if (motion == null) break
      state = finishMotion(state, motion.playerId)
    }
    expect(wild).not.equals(undefined)
    // Its line runs through first, the bag the pitcher covers, not the
    // plate he stood nearer.
    const { from, to } = wild!
    const line = { x: to.x - from.x, z: to.z - from.z }
    const offLine = (base: { x: number; z: number }): number =>
      Math.abs(line.x * (base.z - from.z) - line.z * (base.x - from.x)) /
      Math.hypot(line.x, line.z)
    expect(offLine(BASES[1])).lessThan(offLine(BASES[0]))
    expect(offLine(BASES[1])).lessThan(2)
  })

  it('draws the carry at second, then the throw sailing past the first baseman', function () {
    let state = spoken(game({ first: 7 }), words, ...said)
    const throws: ThrowSequence[] = []
    const order: string[] = []
    for (let step = 0; step < 40 && !atRest(state); step++) {
      const sequence = state.presentation
      if (sequence != null) {
        order.push(sequence.kind)
        if (sequence.kind === 'throw') throws.push(sequence)
        state = finishPicture(state)
        continue
      }
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      if (motion == null) break
      state = finishMotion(state, motion.playerId)
    }
    expect(order).deep.equals(['hit', 'throw', 'throw'])
    expect(throws[0]).includes({
      thrower: F.SS,
      receiver: F.SS,
      unassisted: true
    })
    const wild = throws[1]
    expect(wild).includes({
      thrower: F.SS,
      receiver: F.B1,
      wild: true,
      safe: true,
      runner: BATTER
    })
    const first = BASES[1]
    const end = sampleThrow(wild, wild.durationMs).ball
    // Past the bag, on the line of the throw, about 30 feet on.
    expect(Math.hypot(end.x - first.x, end.z - first.z)).greaterThan(5)
    expect(Math.hypot(end.x, end.z)).lessThan(
      Math.hypot(wild.from.x, wild.from.z) + 200
    )
    const line = state.session.liveData.linescore
    expect(line.outs).equals(1)
    expect(line.teams.home.errors).equals(1)
    expect(line.offense.first?.id).equals(BATTER)
    // The throw that was the error is never caught.
    const runtime = presentationRuntime()
    const { cues } = stepPresentation(runtime, wild, wild.durationMs, false)
    expect(cues).deep.equals(['swish'])
    expect(
      stepPresentation(
        presentationRuntime(),
        throws[0],
        throws[0].durationMs,
        false
      ).cues
    ).includes('pop')
  })

  it('draws the wild throw as soon as the force is drawn, past the batter at the bag', function () {
    const state = spoken(game({ first: 7 }), words, ...said)
    const wild = state.reel?.find(
      beat =>
        beat.presentation?.kind === 'throw' && beat.presentation.wild === true
    )
    expect(wild?.after).equals('presentation')
    // He ran from the crack of the bat, and the throw finds him on the bag.
    expect(wild?.motions.map(motion => motion.playerId)).not.includes(BATTER)
    const drawn = wild?.presentation?.players.find(p => p.playerId === BATTER)
    expect(drawn?.batting).equals(false)
    expect(
      Math.hypot(drawn!.position.x - BASES[1].x, drawn!.position.z - BASES[1].z)
    ).lessThan(2)
  })

  it('draws no wild throw when the force ends the half', function () {
    const two = game({ first: 7 })
    two.session.liveData.linescore.outs = 2
    let state = spoken(two, words, ...said)
    const kinds: string[] = []
    for (let step = 0; step < 40 && !atRest(state); step++) {
      const sequence = state.presentation
      if (sequence != null) {
        kinds.push(
          sequence.kind === 'throw' && sequence.wild === true
            ? 'wild'
            : sequence.kind
        )
        state = finishPicture(state)
        continue
      }
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      if (motion == null) break
      state = finishMotion(state, motion.playerId)
    }
    expect(kinds).not.includes('wild')
  })
})
