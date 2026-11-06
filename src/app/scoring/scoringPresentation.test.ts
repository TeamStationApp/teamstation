import { expect } from 'chai'
import { describe, it } from 'mocha'

import { scoringSession } from '../../test/scoringSession'
import { BASES, createPlayers, OUT_APPROACH_SPEED } from '../field/fieldModel'
import {
  FOUL_FADE_MS,
  foulPoint,
  sampleHit,
  samplePitch
} from '../field/playAnimationModel'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import {
  CAROM_MS,
  FOUL_FLIGHT_MAX_MS,
  foulFlightMs,
  HIT_UNPITCHED_CONTACT_MS,
  type HitSequence,
  PITCH_TIMING,
  pitchPresentation,
  presentationRuntime,
  SCORING_SPEED,
  stepPresentation,
  tagMs,
  THROW_MS,
  THROW_RELEASE_MS,
  throwSequence
} from './scoringPresentation'
import type { ScoringState } from './scoringTypes'
function initial(): ScoringState {
  return initialScoringState(scoringSession(gameFixture), true)
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
      // The ball leaves the hand as the picture starts: no windup.
      expect(stepPresentation(runtime, sequence, 1, false).cues).deep.equals([
        'swish'
      ])
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
    expect(
      samplePitch(sequence, sequence.durationMs - FOUL_FADE_MS / 2).opacity
    ).equals(0.5)
    expect(samplePitch(sequence, 0).visible).equals(true)
    const caught = samplePitch(
      pitchPresentation(state, 'called'),
      PITCH_TIMING.catch
    )
    expect(caught.catch).greaterThan(0)
  })
})

describe('scoring at speed (U45)', function () {
  it('ends every pitch but a foul within 400 ms, with no windup', function () {
    expect(PITCH_TIMING).deep.equals({
      release: 0,
      plate: 240,
      catch: 260,
      finish: 280,
      foulFinish: 540
    })
    for (const kind of ['ball', 'called', 'swing'] as const)
      expect(pitchPresentation(initial(), kind).durationMs).at.most(280)
    expect(pitchPresentation(initial(), 'foul').durationMs).equals(540)
  })
  it('plays every other scoring picture in half its natural time', function () {
    expect(SCORING_SPEED).equals(2)
    // The natural durations, halved.
    expect(HIT_UNPITCHED_CONTACT_MS).equals(450 / 2)
    expect(CAROM_MS).equals(600 / 2)
    expect(FOUL_FLIGHT_MAX_MS).equals(2000 / 2)
    expect(THROW_MS).equals(900 / 2)
    expect(THROW_RELEASE_MS).equals(150 / 2)
    expect(OUT_APPROACH_SPEED).equals(1.4 * 17 * 2)
    // A short foul's floor and a deeper one's pace.
    expect(foulFlightMs({ x: 3, z: 3 })).equals(900 / 2)
    expect(foulFlightMs({ x: 18, z: 24 })).equals(((30 / 20) * 1000) / 2)
    // A tag's floor; a long one at twice the runner's pace.
    const at = { x: 0, z: 0 }
    expect(tagMs(at, at, at, 650)).equals(650 / 2)
    expect(tagMs(at, { x: 0, z: -100 }, at, 650)).closeTo(
      (100 / (1.4 * 17) / 2) * 1000,
      1e-9
    )
    // A ball in play: its flight's floor and its pace.
    const hit = (point: { x: number; z: number }): HitSequence => {
      let state = scoringReducer(initial(), {
        type: 'OUTCOME',
        outcome: 'Single'
      })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point,
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 10,
        generation: 0
      })
      return state.presentation as HitSequence
    }
    const long = hit({ x: 25, z: -75 })
    const short = hit({
      x: long.fielderStart.x + 2,
      z: long.fielderStart.z - 2
    })
    expect(short.flightEndMs - short.contactMs).equals(1100 / 2)
    const travel = Math.hypot(
      long.arc.target.x - long.fielderStart.x,
      long.arc.target.z - long.fielderStart.z
    )
    expect(long.flightEndMs - long.contactMs).closeTo(
      Math.max(1100, (travel / 20) * 1000) / 2,
      1e-9
    )
    // A throw between fielders, and its release.
    const state = initial()
    const players = scoringFieldPlayers(state)
    const sequence = throwSequence(state, {
      players,
      thrower: 13,
      receiver: 11,
      runner: players.find(p => p.playerId === 1)!.playerId!,
      from: { x: -20, z: -60 },
      to: { x: 20, z: -40 },
      runnerPoint: { x: 0, z: 0 },
      final: false
    })
    expect(sequence.durationMs).equals(900 / 2)
    const runtime = presentationRuntime()
    expect(stepPresentation(runtime, sequence, 74, false).cues).deep.equals([])
    expect(stepPresentation(runtime, sequence, 1, false).cues).deep.equals([
      'swish'
    ])
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
      // The bat meets the pitch as it reaches the plate.
      expect(seq.contactMs).equals(PITCH_TIMING.plate)
      const clock = presentationRuntime()
      expect(
        stepPresentation(clock, seq, seq.contactMs - 1, false).contact
      ).equals(false)
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
          outcome: caught ? 'Ball Caught' : 'Ground Out'
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
      state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Ground Out' })
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
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Ground Out' })
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

describe('the pitch before a ball in play', function () {
  function single(start = initial()): HitSequence {
    let state = scoringReducer(start, {
      type: 'OUTCOME',
      outcome: 'Single'
    })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 25, z: -75 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 10,
      generation: 0
    })
    const seq = state.presentation!
    if (seq.kind !== 'hit') throw new Error('Expected hit')
    return seq
  }

  it('throws the ball to the plate with no windup, where the bat meets it', function () {
    const seq = single()
    expect(seq.pitcher).equals(10)
    expect(seq.from).not.equals(undefined)
    expect(seq.plate).deep.equals({ x: 0, y: seq.plate!.y, z: 0 })
    // The ball is out of the pitcher's hand at once, and shown.
    expect(sampleHit(seq, 0).ball).deep.equals(seq.from)
    const early = sampleHit(seq, 100)
    expect(early.visible).equals(true)
    expect(early.windup).equals(0)
    // Between the release and the plate it is on the pitch's line.
    const halfway = (PITCH_TIMING.release + seq.contactMs) / 2
    const flying = sampleHit(seq, halfway).ball
    // The mound is out toward center, at negative z; the plate is at 0.
    expect(flying.z).greaterThan(seq.from!.z)
    expect(flying.z).lessThan(seq.plate!.z)
    // At contact it is at the plate.
    const met = sampleHit(seq, seq.contactMs - 1).ball
    expect(Math.hypot(met.x, met.z)).lessThan(1.5)
    // The swing is at its height as the pitch arrives.
    expect(sampleHit(seq, seq.contactMs).swing).closeTo(1, 1e-9)
    expect(sampleHit(seq, seq.contactMs - 400).swing).equals(0)
  })

  it('meets the ball at once when no pitcher stands on the field to pitch it', function () {
    const start = initial()
    // A pitcher the field does not hold: no pitch to draw.
    start.session.liveData.plays.currentPlay!.matchup.pitcher.id = 999
    const seq = single(start)
    expect(seq.pitcher).equals(undefined)
    expect(seq.contactMs).equals(HIT_UNPITCHED_CONTACT_MS)
    expect(seq.fielderStartMs).equals(HIT_UNPITCHED_CONTACT_MS)
    expect(seq.flightEndMs).lessThan(single().flightEndMs)
  })

  it('keeps every timing after contact where it was, 600 ms later', function () {
    const seq = single()
    expect(seq.fielderStartMs).equals(seq.contactMs)
    expect(seq.flightEndMs).greaterThan(seq.contactMs + 1000)
    expect(sampleHit(seq, seq.contactMs).fielder).deep.equals(seq.fielderStart)
  })
})

describe('a stand-in at an empty position (U48)', function () {
  it('plays the ball from the empty position’s spot, nameless, and throws right-handed', function () {
    let state = initial()
    state.session.liveData.linescore.defense.SS = null
    state.session.liveData.boxscore.teams.home.defense.SS = null
    const spot = createPlayers().find(player => player.id === 'SS')!.position
    expect(
      scoringFieldPlayers(state).some(player => player.standIn === 'SS')
    ).equals(false)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Ground Out' })
    // Nobody is there to take a ball to an occupied position by position.
    expect(
      scoringReducer(state, {
        type: 'FIELDER',
        id: '3B',
        point: { x: -10, z: -30 },
        generation: 0
      })
    ).equals(state)
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 'SS',
      point: { x: -10, z: -30 },
      generation: 0
    })
    expect(state.pendingPlay?.fielder).equals('SS')
    const drawn = scoringFieldPlayers(state).find(
      player => player.standIn === 'SS'
    )!
    expect(drawn.id).equals('empty-SS')
    expect(drawn.displayName).equals('')
    expect(drawn.playerId).equals(undefined)
    expect(drawn.emptyPosition).equals(undefined)
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -10,
      generation: 0
    })
    const seq = state.presentation!
    if (seq.kind !== 'hit') throw new Error('Expected hit')
    expect(seq.fielder).equals('SS')
    expect(seq.fielderStart).deep.equals(spot)
    expect(
      seq.players.filter(player => player.standIn === 'SS').map(p => p.id)
    ).deep.equals(['empty-SS'])
    expect(state.session.liveData.plays.currentPlay!.hitData).includes({
      position: 'SS'
    })
    expect(state.session.liveData.plays.currentPlay!.hitData!.fielder).equals(
      undefined
    )
    const players = scoringFieldPlayers(state)
    const thrown = throwSequence(state, {
      players,
      thrower: 'SS',
      receiver: state.session.liveData.linescore.defense['1B']!.id,
      runner: state.session.liveData.plays.currentPlay!.matchup.batter.id,
      from: { x: -10, z: -30 },
      to: BASES[1],
      runnerPoint: BASES[0],
      final: false
    })
    expect(thrown.throwSide).equals('R')
    expect(
      thrown.players.find(player => player.standIn === 'SS')!.position
    ).deep.equals({ x: -10, z: -30 })
  })
})
