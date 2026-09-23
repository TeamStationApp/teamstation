import { pitchingHand } from '../field/athletePose'
import { BALL_CONTACT, type BallArcState } from '../field/ballArcModel'
import {
  BASES,
  clampToField,
  type FieldPlayer,
  type GroundPoint
} from '../field/fieldModel'
import { fieldPlayersFor } from './fieldAdapter'
import { scoringFieldPlayers } from './scoringMotion'
import type { ScoringState } from './scoringTypes'
export type PitchKind = 'ball' | 'called' | 'swing' | 'foul'
export interface Point3 extends GroundPoint {
  y: number
}
export interface PitchSequence {
  id: string
  generation: number
  stage: 'delivery'
  kind: 'pitch'
  pitch: PitchKind
  durationMs: number
  players: FieldPlayer[]
  pitcher: number
  catcher: number
  batter: number
  batSide: 'R' | 'L'
  throwSide: 'R' | 'L'
  from: Point3
  plate: Point3
  glove: Point3
}
export const PITCH_TIMING = {
  release: 650,
  plate: 1050,
  catch: 1220,
  finish: 1500,
  foulFinish: 1750
} as const
export function pitchPresentation(
  state: ScoringState,
  kind: PitchKind
): PitchSequence {
  const session = state.session
  const play = session.liveData.plays.currentPlay!
  const players = fieldPlayersFor(session)
  const pitcher = play.matchup.pitcher.id
  const catcher = session.liveData.linescore.defense.C?.id ?? pitcher
  const throwSide =
    session.gameData.players[pitcher].throws === 'left' ? 'L' : 'R'
  const location = (id: number): GroundPoint =>
    players.find(player => player.playerId === id)!.position
  return {
    id: `${state.generation}:${session.meta.sequence + 1}:pitch`,
    generation: state.generation,
    stage: 'delivery',
    kind: 'pitch',
    pitch: kind,
    durationMs: kind === 'foul' ? PITCH_TIMING.foulFinish : PITCH_TIMING.finish,
    players,
    pitcher,
    catcher,
    batter: play.matchup.batter.id,
    batSide: play.matchup.batSide.code,
    throwSide,
    from: pitchingHand(
      location(pitcher),
      PITCH_TIMING.release,
      PITCH_TIMING.release,
      throwSide
    ),
    plate: { x: 0, y: BALL_CONTACT, z: 0 },
    glove: { ...location(catcher), y: 5.2 }
  }
}
export interface HitSequence {
  outOfPark?: boolean
  fielderTarget?: GroundPoint
  id: string
  generation: number
  stage: 'swing' | 'flight'
  kind: 'hit'
  durationMs: number
  contactMs: number
  players: FieldPlayer[]
  batter: number
  fielder: number
  fielderStart: GroundPoint
  arc: BallArcState
  batSide: 'R' | 'L'
  out: boolean
}
export interface ThrowSequence {
  id: string
  generation: number
  kind: 'throw'
  stage: 'transfer' | 'tag'
  durationMs: number
  players: FieldPlayer[]
  thrower: number
  receiver: number
  runner: number
  from: Point3
  to: Point3
  unassisted: boolean
  holderOrigin: GroundPoint
  runnerFrom: GroundPoint
  throwSide: 'R' | 'L'
  heading: number
}
export type PresentationSequence = PitchSequence | HitSequence | ThrowSequence
export function outBatterPoint(
  sequence: HitSequence,
  elapsedMs = sequence.durationMs
): GroundPoint {
  const start = sequence.players.find(
    p => p.playerId === sequence.batter
  )!.position
  const end = BASES[1]
  const distance = Math.hypot(end.x - start.x, end.z - start.z)
  const t = Math.max(
    0,
    Math.min(0.96, (((elapsedMs - sequence.contactMs) / 1000) * 8) / distance)
  )
  return {
    x: start.x + (end.x - start.x) * t,
    z: start.z + (end.z - start.z) * t
  }
}
export function throwPresentation(
  state: ScoringState,
  receiver: number,
  point?: GroundPoint,
  final = false
): ThrowSequence {
  const action = state.runnerAction!
  const players = scoringFieldPlayers(state).map(player => ({
    ...player,
    motion: undefined,
    suppressed: false,
    hasBall: false
  }))
  const holder = action.defensiveRoute?.at(-1)
  const thrower = holder?.id ?? action.thrower!
  const from =
    holder?.point ??
    action.throwerPoint ??
    state.pendingPlay?.location ??
    players.find(p => p.playerId === thrower)!.position
  const to = final
    ? BASES[action.to % 4]
    : (point ?? players.find(p => p.playerId === receiver)!.position)
  const runner = players.find(p => p.playerId === action.playerId)!
  const runnerPoint =
    action.runnerPoint ??
    (action.purpose === 'batterRetirement' &&
    state.pendingPlay?.batterPoint != null
      ? state.pendingPlay.batterPoint
      : runner.position)
  runner.position = { ...runnerPoint }
  runner.target = { ...runnerPoint }
  runner.batting = false
  for (const player of players) {
    if (player.playerId === thrower) {
      player.position = { ...from }
      player.target = { ...from }
    } else if (player.playerId === receiver) {
      player.position = { ...to }
      player.target = { ...to }
    }
  }
  const unassisted = final
  const throwSide =
    state.session.gameData.players[thrower].throws === 'left' ? 'L' : 'R'
  const heading = Math.atan2(to.x - from.x, to.z - from.z)
  return {
    id: `${state.generation}:${state.session.meta.sequence + 1}:throw`,
    generation: state.generation,
    kind: 'throw',
    stage: final ? 'tag' : 'transfer',
    players,
    thrower,
    receiver,
    runner: action.playerId,
    holderOrigin: { ...from },
    runnerFrom: { ...runnerPoint },
    throwSide,
    heading,
    from: final
      ? { ...from, y: 6 }
      : pitchingHand(from, 150, 150, throwSide, heading),
    to: { ...to, y: 5.2 },
    unassisted,
    durationMs: unassisted
      ? Math.max(
          650,
          (Math.max(
            Math.hypot(to.x - from.x, to.z - from.z),
            Math.hypot(to.x - runnerPoint.x, to.z - runnerPoint.z)
          ) /
            10) *
            1000
        )
      : 900
  }
}
export function hitPresentation(
  state: ScoringState,
  angle: number
): HitSequence {
  const pending = state.pendingPlay!
  const players = fieldPlayersFor(state.session)
  const start = players.find(
    player => player.playerId === pending.fielder
  )!.position
  const target = pending.location!
  const flight = Math.max(
    1100,
    (Math.hypot(target.x - start.x, target.z - start.z) / 20) * 1000
  )
  return {
    id: `${state.generation}:${state.session.meta.sequence + 1}:hit`,
    generation: state.generation,
    stage: 'swing',
    kind: 'hit',
    outOfPark: pending.homeRunKind === 'out-of-park',
    fielderTarget:
      pending.homeRunKind === 'out-of-park'
        ? clampToField(target)
        : { ...target },
    durationMs: 450 + flight,
    contactMs: 450,
    players,
    batter: state.session.liveData.plays.currentPlay!.matchup.batter.id,
    fielder: pending.fielder!,
    fielderStart: { ...start },
    arc: {
      target: { ...target },
      angle,
      landingHeight:
        pending.landingHeight ??
        (pending.outcome === 'Ball Caught' ? 5.2 : undefined)
    },
    batSide: state.session.liveData.plays.currentPlay!.matchup.batSide.code,
    out: ['Ball Caught', 'Throw Out', 'Batter Interference'].includes(
      pending.outcome
    )
  }
}
export interface PresentationRuntime {
  elapsedMs: number
  fired: Set<string>
  complete: boolean
}
export function presentationRuntime(): PresentationRuntime {
  return { elapsedMs: 0, fired: new Set(), complete: false }
}
/** A single clock supplies visual sampling and exactly-once cue boundaries. */
export function stepPresentation(
  runtime: PresentationRuntime,
  sequence: PresentationSequence,
  deltaMs: number,
  paused: boolean
): { cues: Array<'swish' | 'pop' | 'bat'>; done: boolean; contact?: boolean } {
  if (paused || runtime.complete || !Number.isFinite(deltaMs) || deltaMs <= 0)
    return { cues: [], done: false }
  runtime.elapsedMs = Math.min(sequence.durationMs, runtime.elapsedMs + deltaMs)
  const cues: Array<'swish' | 'pop' | 'bat'> = []
  const schedule: ReadonlyArray<
    readonly [string, number, 'swish' | 'pop' | 'bat']
  > =
    sequence.kind === 'pitch'
      ? [
          ['release', PITCH_TIMING.release, 'swish'],
          [
            'impact',
            sequence.pitch === 'foul' ? PITCH_TIMING.plate : PITCH_TIMING.catch,
            'pop'
          ],
          [
            'contact',
            sequence.pitch === 'foul' ? PITCH_TIMING.plate : Infinity,
            'bat'
          ]
        ]
      : sequence.kind === 'throw'
        ? [
            ['release', sequence.unassisted ? Infinity : 150, 'swish'],
            ['catch', sequence.durationMs, 'pop']
          ]
        : [
            ['swing', sequence.contactMs - 120, 'swish'],
            ['contact', sequence.contactMs, 'bat'],
            [
              'fielded',
              sequence.outOfPark === true ? Infinity : sequence.durationMs,
              'pop'
            ]
          ]
  for (const [id, at, cue] of schedule) {
    if (runtime.elapsedMs >= at && !runtime.fired.has(id)) {
      runtime.fired.add(id)
      cues.push(cue)
    }
  }
  const contact =
    sequence.kind === 'hit' &&
    sequence.stage === 'swing' &&
    runtime.elapsedMs >= sequence.contactMs &&
    !runtime.fired.has('stage-contact')
  if (contact) runtime.fired.add('stage-contact')
  const done =
    runtime.elapsedMs >= sequence.durationMs &&
    (sequence.kind !== 'hit' || sequence.stage === 'flight')
  runtime.complete = done
  return { cues, done, contact }
}
