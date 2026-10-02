import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BASES } from '../field/fieldModel'
import { foulPoint, sampleHit, samplePitch } from '../field/playAnimationModel'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import {
  PITCH_TIMING,
  pitchPresentation,
  presentationRuntime,
  stepPresentation
} from './scoringPresentation'
import type { ScoringState } from './scoringTypes'
function initial(): ScoringState {
  return initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    true
  )
}
describe('pitch presentation coordination', function () {
  for (const kind of ['ball', 'called', 'swing', 'foul'] as const)
    it(`presents ${kind} once and rejects duplicate or stale completion`, function () {
      const before = initial()
      const state = scoringReducer(before, { type: 'PITCH', kind })
      const sequence = state.presentation!
      if (sequence.kind !== 'pitch') throw new Error('Expected pitch')
      expect(sequence.pitch).equals(kind)
      expect(scoringReducer(state, { type: 'PITCH', kind })).equals(state)
      const runtime = presentationRuntime()
      expect(stepPresentation(runtime, sequence, 300, true).cues).has.length(0)
      expect(runtime.elapsedMs).equals(0)
      expect(stepPresentation(runtime, sequence, 0, false).done).equals(false)
      expect(
        stepPresentation(runtime, sequence, PITCH_TIMING.release, false).cues
      ).deep.equals(['swish'])
      const atRelease = samplePitch(sequence, PITCH_TIMING.release)
      expect(atRelease.visible).equals(true)
      expect(atRelease.ball).deep.equals(sequence.from)
      const atPlate = samplePitch(sequence, PITCH_TIMING.plate)
      expect(atPlate.ball).deep.equals(sequence.plate)
      expect(atPlate.swing > 0).equals(kind === 'swing' || kind === 'foul')
      const rest = stepPresentation(runtime, sequence, 2000, false)
      expect(rest.cues).deep.equals(kind === 'foul' ? ['pop', 'bat'] : ['pop'])
      expect(rest.done).equals(true)
      expect(stepPresentation(runtime, sequence, 1000, false).cues).has.length(
        0
      )
      expect(samplePitch(sequence, sequence.durationMs).visible).equals(false)
      const done = {
        type: 'PRESENTATION_DONE' as const,
        id: sequence.id,
        generation: sequence.generation,
        stage: sequence.stage
      }
      expect(scoringReducer(state, { ...done, id: 'old' })).equals(state)
      expect(scoringReducer(state, { ...done, generation: 10 })).equals(state)
      const settled = scoringReducer(state, done)
      expect(settled.presentation).equals(null)
      expect(settled.past).has.length(1)
      expect(scoringReducer(settled, done)).equals(settled)
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(undone.presentation).equals(null)
      expect(undone.session).deep.equals(before.session)
      expect(scoringReducer(undone, done)).equals(undone)
    })
  it('keeps the fourth-ball hitter and runners in their original places until delivery finishes', function () {
    const before = initial()
    before.session.liveData.linescore.balls = 3
    const state = scoringReducer(before, { type: 'PITCH', kind: 'ball' })
    expect(state.motions.some(m => !m.complete)).equals(true)
    const players = scoringFieldPlayers(state)
    expect(players.find(p => p.playerId === 1)?.batting).equals(true)
    expect(players.every(p => p.motion == null)).equals(true)
    const sequence = state.presentation!
    if (sequence.kind !== 'pitch') throw new Error('Expected pitch')
    const after = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: sequence.id,
      generation: sequence.generation,
      stage: sequence.stage
    })
    expect(scoringFieldPlayers(after).some(p => p.motion != null)).equals(true)
  })
  it('mirrors a behind-plate 45 degree foul using the actual batter and throwing sides', function () {
    const state = initial()
    state.session.gameData.players[10].throws = 'left'
    state.session.liveData.plays.currentPlay!.matchup.batSide.code = 'L'
    const sequence = pitchPresentation(state, 'foul')
    expect(sequence.throwSide).equals('L')
    expect(sequence.from.x).lessThan(0)
    const right = foulPoint(sequence.plate, 'R', 0.1)
    const left = foulPoint(sequence.plate, 'L', 0.1)
    expect(right.x).greaterThan(0)
    expect(left.x).equals(-right.x)
    expect(left.z).equals(right.z)
    expect(right.z).greaterThan(0)
    const angle =
      (Math.atan2(right.y - sequence.plate.y, Math.hypot(right.x, right.z)) *
        180) /
      Math.PI
    expect(angle).within(44, 46)
    expect(samplePitch(sequence, sequence.durationMs - 100).opacity).equals(0.5)
    expect(samplePitch(sequence, 0).visible).equals(true)
    const caught = samplePitch(
      pitchPresentation(state, 'called'),
      PITCH_TIMING.catch
    )
    expect(caught.catch).greaterThan(0)
  })
})

describe('hit presentation coordination', function () {
  for (const [outcome, angle] of [
    ['Single', -5],
    ['Double', 25],
    ['Triple', 85],
    ['Home Run', -45],
    ['Ball Caught', 85]
  ] as const)
    it(`holds ${outcome} through trajectory, then releases runners at contact`, function () {
      let state = scoringReducer(initial(), { type: 'OUTCOME', outcome })
      const origin = scoringFieldPlayers(state).find(
        p => p.playerId === 10
      )!.position
      state = scoringReducer(state, {
        ...(outcome === 'Home Run'
          ? { type: 'LANDING' as const }
          : { type: 'FIELDER' as const, id: 10 }),
        point: { x: 25, z: -75 },
        generation: 0
      })
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === 10)!.position
      ).deep.equals(origin)
      expect(state.motions).has.length(0)
      expect(state.session.pending).equals(null)
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle,
        generation: 0
      })
      expect(
        state.session.liveData.plays.currentPlay!.hitData!.launchAngle
      ).equals(angle)
      const seq = state.presentation!
      if (seq.kind !== 'hit') throw new Error('Expected hit')
      expect(seq.fielderStart).deep.equals(
        outcome === 'Home Run'
          ? seq.players.find(p => p.playerId === seq.fielder)!.position
          : origin
      )
      expect(scoringFieldPlayers(state).every(p => p.motion == null)).equals(
        true
      )
      expect(sampleHit(seq, seq.contactMs).fielder).deep.equals(
        seq.fielderStart
      )
      expect(sampleHit(seq, seq.fielderEndMs).fielder).deep.equals(
        seq.fielderTarget
      )
      const clock = presentationRuntime()
      expect(stepPresentation(clock, seq, 449, false).contact).equals(false)
      expect(stepPresentation(clock, seq, 1, false).contact).equals(true)
      const contact = {
        type: 'PRESENTATION_CONTACT' as const,
        id: seq.id,
        generation: seq.generation
      }
      expect(scoringReducer(state, { ...contact, id: 'stale' })).equals(state)
      state = scoringReducer(state, contact)
      expect(scoringReducer(state, contact)).equals(state)
      expect(scoringFieldPlayers(state).some(p => p.motion != null)).equals(
        outcome !== 'Ball Caught'
      )
      const flight = state.presentation!
      const frame = stepPresentation(clock, flight, seq.durationMs, false)
      expect(frame.done).equals(true)
      expect(frame.cues).deep.equals(['pop'])
      const done = {
        type: 'PRESENTATION_DONE' as const,
        id: seq.id,
        generation: seq.generation,
        stage: flight.stage
      }
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(scoringReducer(undone, done)).equals(undone)
      expect(scoringReducer(state, done).presentation).equals(null)
    })
})

describe('defensive presentation barriers', function () {
  for (const caught of [true, false])
    for (const home of [false, true])
      it(`keeps ${home ? 'home' : 'away'} batter out of dugout until ${caught ? 'catch' : 'throw'}`, function () {
        let state = initial()
        if (home) state.session.liveData.linescore.isTopInning = false
        state = scoringReducer(state, {
          type: 'OUTCOME',
          outcome: caught ? 'Ball Caught' : 'Throw Out'
        })
        state = scoringReducer(state, {
          type: 'FIELDER',
          id: 10,
          point: { x: 15, z: -40 },
          generation: 0
        })
        state = scoringReducer(state, {
          type: 'TRAJECTORY',
          angle: 45,
          generation: 0
        })
        const hit = state.presentation!
        if (hit.kind !== 'hit') throw new Error('Expected hit')
        state = scoringReducer(state, {
          type: 'PRESENTATION_CONTACT',
          id: hit.id,
          generation: 0
        })
        const batter = scoringFieldPlayers(state).find(
          p => p.playerId === hit.batter
        )!
        expect(batter.batting).equals(false)
        expect(batter.motion).equals(undefined)
        state = scoringReducer(state, {
          type: 'PRESENTATION_DONE',
          id: hit.id,
          generation: 0,
          stage: 'flight'
        })
        expect(state.pendingPlay!.batterPoint!.x).greaterThan(0)
        if (!caught) {
          expect(state.phase).equals('chooseDefender')
          state = scoringReducer(state, {
            type: 'DEFENDER',
            id: 12,
            point: { x: 19, z: -19 },
            generation: 0
          })
          const transfer = state.presentation!
          if (transfer.kind !== 'throw') throw new Error('Expected throw')
          expect(transfer.unassisted).equals(false)
          expect(
            scoringFieldPlayers(state).every(p => p.motion == null)
          ).equals(true)
          const clock = presentationRuntime()
          expect(
            stepPresentation(clock, transfer, 900, false).cues
          ).deep.equals(['swish', 'pop'])
          state = scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: transfer.id,
            generation: 0,
            stage: 'transfer'
          })
          expect(state.session.liveData.linescore.outs).equals(0)
          state = scoringReducer(state, { type: 'DEFENDER', generation: 0 })
          const tag = state.presentation!
          state = scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: tag.id,
            generation: 0,
            stage: tag.stage
          })
        }
        const motion = state.motions.find(m => m.playerId === hit.batter)!
        expect(motion.waypoints[0]).deep.equals(state.pendingPlay!.batterPoint)
        expect(motion.waypoints.at(-1)!.x > 0).equals(home)
        expect(state.session.liveData.linescore.outs).equals(1)
      })
  for (const completed of [false, true])
    it(`continues to first and captures the visible runner when receiver is chosen ${completed ? 'after' : 'during'} approach`, function () {
      let state = initial()
      state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Throw Out' })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 0, z: -20 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 45,
        generation: 0
      })
      const hit = state.presentation!
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: hit.id,
        generation: 0,
        stage: hit.stage
      })
      const approach = state.motions.find(m => m.purpose === 'approachFirst')!
      const end = approach.waypoints.at(-1)!
      expect(Math.hypot(end.x - BASES[1].x, end.z - BASES[1].z)).lessThan(1.5)
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === approach.playerId)!
          .motion
      ).not.equals(undefined)
      if (completed)
        state = scoringReducer(state, {
          type: 'MOTION_DONE',
          id: approach.id,
          generation: 0
        })
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === approach.playerId)!
          .slowApproach
      ).equals(!completed ? true : undefined)
      expect(state.phase).equals('chooseDefender')
      const visible = completed ? end : { x: 12, z: -12 }
      if (completed)
        expect(
          scoringFieldPlayers(state).find(
            p => p.playerId === approach.playerId
          )!.position
        ).deep.equals(end)
      state = scoringReducer(state, {
        type: 'DEFENDER',
        id: 12,
        runnerPoint: visible,
        generation: 0
      })
      expect(state.presentation!.kind).equals('throw')
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === approach.playerId)!
          .position
      ).deep.equals(visible)
      expect(
        state.presentation!.kind === 'throw' && state.presentation!.runnerFrom
      ).deep.equals(visible)
      expect(state.session.liveData.linescore.outs).equals(0)
    })
  it('uses an unassisted touch without a self-throw and invalidates it on undo', function () {
    let state = initial()
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Throw Out' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 15, z: -40 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 0,
      generation: 0
    })
    const hit = state.presentation!
    state = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: hit.id,
      generation: 0,
      stage: hit.stage
    })
    state = scoringReducer(state, { type: 'DEFENDER', generation: 0 })
    const seq = state.presentation!
    if (seq.kind !== 'throw') throw new Error('Expected throw')
    expect(seq.unassisted).equals(true)
    expect(
      state.session.liveData.plays.currentPlay!.source.teamstation.runnerActions
    ).equals(undefined)
    const clock = presentationRuntime()
    expect(
      stepPresentation(clock, seq, seq.durationMs, false).cues
    ).deep.equals(['pop'])
    const undone = scoringReducer(state, { type: 'UNDO' })
    expect(undone.presentation).equals(null)
    expect(undone.session.liveData.linescore.outs).equals(0)
    expect(
      scoringReducer(undone, {
        type: 'PRESENTATION_DONE',
        id: seq.id,
        generation: 0,
        stage: seq.stage
      })
    ).equals(undone)
  })
})
