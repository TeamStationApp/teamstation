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
import { hitGeometry, outcomeOf } from './dictatedReel'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import type { HitSequence, ThrowSequence } from './scoringPresentation'
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
    state = finishPicture(state)
    const thrown = state.presentation as ThrowSequence
    expect(thrown).deep.include({
      kind: 'throw',
      stage: 'transfer',
      thrower: F.SS,
      receiver: F.B1,
      runner: batter,
      dictated: true
    })
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
    state = playOut(state)
    expect(state.session.liveData.linescore.outs).equals(1)
  })

  it('plays a double play as its throws, in the order they were said', function () {
    const batter = game().session.liveData.plays.currentPlay!.matchup.batter.id
    let state = say(
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
    const order: string[] = []
    for (
      let step = 0;
      step < 20 && (state.presentation != null || state.reel != null);
      step++
    ) {
      const sequence = state.presentation
      if (sequence != null) {
        order.push(
          sequence.kind === 'throw'
            ? `${sequence.thrower}>${sequence.receiver}`
            : sequence.kind
        )
        state = finishPicture(state)
      } else
        state = finishMotion(
          state,
          state.motions.find(m => !m.complete && m.held !== true)!.playerId
        )
    }
    expect(order).deep.equals(['hit', `${F.SS}>${F.B2}`, `${F.B2}>${F.B1}`])
    expect(state.session.liveData.linescore.outs).equals(2)
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

  describe('the geometry it makes up', function () {
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
