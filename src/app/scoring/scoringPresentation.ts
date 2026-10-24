import { pitchingHand } from '../field/athletePose'
import { BALL_CONTACT, type BallArcState } from '../field/ballArcModel'
import {
  BASES,
  clampToField,
  type FieldPlayer,
  type GroundPoint,
  OUT_APPROACH_SPEED
} from '../field/fieldModel'
import { fieldPlayersFor } from './fieldAdapter'
import type { ContactKind } from './scoringContract'
import { scoringFieldPlayers } from './scoringMotion'
import type { ScoringState } from './scoringTypes'
export type PitchKind = 'ball' | 'called' | 'swing' | 'foul'
export interface Point3 extends GroundPoint {
  y: number
}
export interface PitchSequence {
  /** Played for a dictated sentence: it shows what was already recorded. */
  dictated?: boolean
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
  /** Where a foul the scorer placed came down; the ball flies there. */
  foul?: GroundPoint
}
export const PITCH_TIMING = {
  release: 650,
  plate: 1050,
  catch: 1220,
  finish: 1500,
  foulFinish: 1750
} as const
/** When a ball in play meets the bat: as its pitch reaches the plate. */
export const HIT_CONTACT_MS = PITCH_TIMING.plate
/** When it meets the bat with no pitcher on the field to draw a pitch. */
export const HIT_UNPITCHED_CONTACT_MS = 450
/** The longest a placed foul is in the air: a deep one, into the seats. */
export const FOUL_FLIGHT_MAX_MS = 2000
/** How long a placed foul is in the air, by how far it went. */
export function foulFlightMs(foul: GroundPoint): number {
  // Its distance at a fly ball's pace, up to a deep fly's time in the air.
  return Math.min(
    FOUL_FLIGHT_MAX_MS,
    Math.max(900, (Math.hypot(foul.x, foul.z) / 20) * 1000)
  )
}
export function pitchPresentation(
  state: ScoringState,
  kind: PitchKind,
  foul?: GroundPoint
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
    durationMs:
      kind !== 'foul'
        ? PITCH_TIMING.finish
        : foul == null
          ? PITCH_TIMING.foulFinish
          : PITCH_TIMING.plate + foulFlightMs(foul) + 400,
    ...(kind === 'foul' && foul != null ? { foul: { ...foul } } : {}),
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
  dictated?: boolean
  contactKind?: ContactKind
  outOfPark?: boolean
  fielderTarget?: GroundPoint
  /**
   * A ball off the wall: after its flight it drops from the wall to here,
   * where the fielder plays it.
   */
  carom?: GroundPoint
  id: string
  generation: number
  stage: 'swing' | 'flight'
  kind: 'hit'
  durationMs: number
  contactMs: number
  flightEndMs: number
  fielderStartMs: number
  fielderEndMs: number
  players: FieldPlayer[]
  batter: number
  fielder?: number
  fielderStart: GroundPoint
  arc: BallArcState
  batSide: 'R' | 'L'
  slowRunner: boolean
  out: boolean
  /**
   * Where a dictated play stops the batter's run to first, reached as the
   * picture ends, so the throw that retires him can carry him the rest of the
   * way with the ball. Without it he runs toward first until he is all but
   * there.
   */
  outRunEnd?: GroundPoint
  /**
   * The pitch it was hit off: the pitcher winds up and the ball goes from his
   * hand to the plate, where the bat meets it at `contactMs`.
   */
  pitcher?: number
  throwSide?: 'R' | 'L'
  from?: Point3
  plate?: Point3
}
export interface ThrowSequence {
  dictated?: boolean
  /** A failed pickoff already recorded; completion must not retire the runner. */
  safe?: boolean
  /** A throw charged as an error: it goes past its receiver, uncaught. */
  wild?: boolean
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
  if (sequence.outRunEnd != null) {
    const t = Math.max(
      0,
      Math.min(
        1,
        (elapsedMs - sequence.contactMs) /
          (sequence.durationMs - sequence.contactMs)
      )
    )
    return {
      x: start.x + (sequence.outRunEnd.x - start.x) * t,
      z: start.z + (sequence.outRunEnd.z - start.z) * t
    }
  }
  const end = BASES[1]
  const distance = Math.hypot(end.x - start.x, end.z - start.z)
  const t = Math.max(
    0,
    Math.min(
      0.96,
      (((elapsedMs - sequence.contactMs) / 1000) *
        OUT_APPROACH_SPEED *
        (sequence.slowRunner ? 1 : 2)) /
        distance
    )
  )
  return {
    x: start.x + (end.x - start.x) * t,
    z: start.z + (end.z - start.z) * t
  }
}
/**
 * How long a tag takes: the ball's way or the runner's, whichever is longer,
 * at the pace they share, and never under `floorMs`.
 */
export function tagMs(
  from: GroundPoint,
  to: GroundPoint,
  runnerFrom: GroundPoint,
  floorMs: number
): number {
  return Math.max(
    floorMs,
    (Math.max(
      Math.hypot(to.x - from.x, to.z - from.z),
      Math.hypot(to.x - runnerFrom.x, to.z - runnerFrom.z)
    ) /
      OUT_APPROACH_SPEED) *
      1000
  )
}
/** What a throw is made of, however it came about: a drag or a sentence. */
export interface ThrowParts {
  /** The field as the throw starts; the three below are placed on it. */
  players: FieldPlayer[]
  thrower: number
  receiver: number
  runner: number
  from: GroundPoint
  to: GroundPoint
  runnerPoint: GroundPoint
  /** The last fielder runs the ball to the base himself. */
  final: boolean
  /** A late defensive relay may continue after its carrier has scored. */
  safe?: boolean
}
export function throwSequence(
  state: ScoringState,
  parts: ThrowParts
): ThrowSequence {
  const { players, thrower, receiver, from, to, runnerPoint, final } = parts
  const runner = players.find(p => p.playerId === parts.runner)!
  if (parts.safe !== true || runner != null) {
    runner.position = { ...runnerPoint }
    runner.target = { ...runnerPoint }
    runner.batting = false
  }
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
    runner: parts.runner,
    ...(parts.safe === true ? { safe: true } : {}),
    holderOrigin: { ...from },
    runnerFrom: { ...runnerPoint },
    throwSide,
    heading,
    from: final
      ? { ...from, y: 6 }
      : pitchingHand(from, 150, 150, throwSide, heading),
    to: { ...to, y: 5.2 },
    unassisted,
    durationMs: unassisted ? tagMs(from, to, runnerPoint, 650) : 900
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
  return throwSequence(state, {
    players,
    thrower,
    receiver,
    runner: action.playerId,
    from,
    to,
    runnerPoint,
    final
  })
}
/** How long a ball off the wall takes to drop and come back. */
export const CAROM_MS = 600

export function hitPresentation(
  state: ScoringState,
  angle: number
): HitSequence {
  const pending = state.pendingPlay!
  const players = fieldPlayersFor(state.session)
  const start =
    players.find(player => player.playerId === pending.fielder)?.position ??
    pending.location!
  const target = pending.location!
  const flight = Math.max(
    1100,
    (Math.hypot(target.x - start.x, target.z - start.z) / 20) * 1000
  )
  const pitcher = state.session.liveData.plays.currentPlay!.matchup.pitcher.id
  const mound = players.find(player => player.playerId === pitcher)?.position
  // With no pitcher to draw a pitch, the swing comes as soon as it did
  // before a pitch was drawn.
  const contactMs = mound == null ? HIT_UNPITCHED_CONTACT_MS : HIT_CONTACT_MS
  const flightEndMs = contactMs + flight
  const caught = pending.outcome === 'Ball Caught' || pending.fielder == null
  const carom = pending.carom
  const fielderEndMs =
    contactMs + flight / (caught ? 1 : 0.8) + (carom == null ? 0 : CAROM_MS)
  const throwSide =
    state.session.gameData.players[pitcher]?.throws === 'left' ? 'L' : 'R'
  return {
    id: `${state.generation}:${state.session.meta.sequence + 1}:hit`,
    generation: state.generation,
    stage: 'swing',
    kind: 'hit',
    contactKind: pending.contactKind ?? 'swing',
    outOfPark: pending.homeRunKind === 'out-of-park',
    fielderTarget:
      carom != null
        ? { ...carom }
        : pending.homeRunKind === 'out-of-park'
          ? clampToField(target)
          : { ...target },
    ...(carom == null ? {} : { carom: { ...carom } }),
    durationMs:
      pending.fielder == null
        ? flightEndMs + (carom == null ? 0 : CAROM_MS)
        : Math.max(flightEndMs + (carom == null ? 0 : CAROM_MS), fielderEndMs),
    flightEndMs,
    fielderStartMs: contactMs,
    fielderEndMs,
    contactMs,
    ...(mound == null
      ? {}
      : {
          pitcher,
          throwSide,
          from: pitchingHand(
            mound,
            PITCH_TIMING.release,
            PITCH_TIMING.release,
            throwSide
          ),
          plate: { x: 0, y: BALL_CONTACT, z: 0 }
        }),
    players,
    batter: state.session.liveData.plays.currentPlay!.matchup.batter.id,
    fielder: pending.fielder,
    fielderStart: { ...start },
    arc: {
      target: { ...target },
      angle,
      landingHeight:
        pending.landingHeight ??
        (pending.outcome === 'Ball Caught' ? 5.2 : undefined)
    },
    batSide: state.session.liveData.plays.currentPlay!.matchup.batSide.code,
    slowRunner: pending.outcome !== 'Ball Caught',
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
            // A wild throw is never caught.
            [
              'catch',
              sequence.wild === true ? Infinity : sequence.durationMs,
              'pop'
            ]
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
