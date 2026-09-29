import type {
  BallInPlayAction,
  PitchAction,
  ResultAction,
  ScoringAction
} from '../../common/scoring/actions'
import { allowedAngle } from '../../common/scoring/rules'
import { fieldingLocation } from '../field/fieldingLocation'
import { BASES, type GroundPoint } from '../field/fieldModel'
import { homeRunLanding } from '../field/stadiumBoundary'
import { foulFielder } from './dictatedGeometry'
import { fieldPlayersFor } from './fieldAdapter'
import type { Outcome } from './scoringContract'
import { scoringFieldPlayers } from './scoringMotion'
import {
  hitPresentation,
  type PitchKind,
  pitchPresentation,
  type PresentationSequence,
  throwSequence
} from './scoringPresentation'
import type {
  Beat,
  MotionCommand,
  PendingPlay,
  ScoringSnapshot,
  ScoringState
} from './scoringTypes'

/**
 * A dictated sentence, shown the way its taps would have shown it.
 *
 * The sentence is applied to the game at once; what this builds is only the
 * picture of it, played afterwards as a reel of beats. Each beat is at most
 * one picture — a pitch, a hit, a throw — and the runner motions that go with
 * it. Things that happen together share a beat: on a hit, the batter and every
 * runner run while the ball is in the air. Things that happen after get their
 * own: a tag-up leaves when the catch ends. The geometry a finger would have
 * drawn is made up here from what the LLM said, and never stored.
 */

const TRAJECTORY_ANGLES = {
  ground_ball: -8,
  chopper: -3,
  line_drive: 12,
  fly_ball: 35,
  popup: 65
} as const
const BUNT_ANGLE = -15
const PITCH_KINDS: Record<PitchAction['call'], PitchKind> = {
  B: 'ball',
  C: 'called',
  S: 'swing',
  T: 'swing',
  F: 'foul',
  L: 'foul'
}
const HIT_OUTCOMES: Partial<Record<ResultAction['eventType'], Outcome>> = {
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home Run',
  field_error: 'Error',
  fielders_choice: "Fielder's Choice"
}
const BASE_INDEX = { batter: 0, '1B': 1, '2B': 2, '3B': 3, home: 0 } as const

/** What a ball in play came to, in the screen's words for it. */
export function outcomeOf(result: ResultAction | undefined): Outcome {
  if (result == null) return 'Single'
  if (result.eventType === 'field_out')
    return result.outBy === 'catch' || result.foulCaught === true
      ? 'Ball Caught'
      : result.outBy === 'interference'
        ? 'Batter Interference'
        : 'Throw Out'
  return HIT_OUTCOMES[result.eventType] ?? 'Single'
}

/**
 * The hit a finger would have drawn: the ball goes where the named fielder
 * stands, at the angle of the trajectory the LLM gave.
 */
export function hitGeometry(
  state: Pick<ScoringState, 'session'>,
  action: BallInPlayAction,
  result: ResultAction | undefined
): { pending: PendingPlay; angle: number } {
  const outcome = outcomeOf(result)
  // A caught foul nobody was named for is shown caught by the corner
  // infielder on its side; the play credits nobody for it.
  const fielder =
    action.fielder ??
    (result?.foulCaught === true ? foulFielder(state.session) : undefined)
  const standing =
    fielder == null
      ? undefined
      : fieldPlayersFor(state.session).find(
          player => player.team === 'defense' && player.playerId === fielder
        )?.position
  const middle =
    outcome === 'Throw Out' || outcome === "Fielder's Choice"
      ? { x: 0, z: -40 }
      : { x: 0, z: -80 }
  const aim = action.location ?? standing ?? middle
  const homeRunKind =
    outcome === 'Home Run' ? (action.homeRunKind ?? 'out-of-park') : undefined
  let location: GroundPoint
  if (homeRunKind === 'out-of-park') {
    const length = Math.max(1, Math.hypot(aim.x, aim.z))
    location = homeRunLanding({
      x: (aim.x / length) * 140,
      z: (aim.z / length) * 140
    })
  } else location = fieldingLocation(outcome, aim)
  const raw =
    action.launchAngle ??
    (action.contact === 'bunt'
      ? BUNT_ANGLE
      : action.trajectory != null
        ? TRAJECTORY_ANGLES[action.trajectory]
        : outcome === 'Ball Caught'
          ? TRAJECTORY_ANGLES.fly_ball
          : outcome === 'Throw Out'
            ? TRAJECTORY_ANGLES.ground_ball
            : TRAJECTORY_ANGLES.line_drive)
  return {
    pending: {
      outcome,
      contactKind: action.contact === 'bunt' ? 'bunt' : 'swing',
      fielder,
      location,
      homeRunKind,
      trajectoryAccepted: true
    },
    angle: allowedAngle(raw, outcome, homeRunKind)
  }
}

/** Where a runner stands in this game: his base, or the plate for the batter. */
function standingPoint(state: ScoringState, runner: number): GroundPoint {
  const offense = state.session.liveData.linescore.offense
  const base = [offense.first, offense.second, offense.third].findIndex(
    ref => ref?.id === runner
  )
  if (base >= 0) return { ...BASES[base + 1] }
  const side = state.session.liveData.plays.currentPlay?.matchup.batSide.code
  return { x: side === 'L' ? 4 : -4, z: 0 }
}

type Group = 'pitch' | 'hit' | 'throw' | 'tagUp' | 'steal' | 'battery' | 'other'

/**
 * Builds a sentence's reel while `dictated()` applies it. `before` runs ahead
 * of each action with the game as it stands then; `after` takes the motions
 * that action made.
 */
export class ReelBuilder {
  private readonly beats: Beat[] = []
  private current: Beat | null = null
  private group: Group | null = null
  private hitOpen = false
  /** The ball in play's beat, while its throws are still the same play. */
  private hitBeat: Beat | null = null
  private hitCaught = false
  private hitResultSeen = false
  private landing: { fielder?: number; point: GroundPoint } | null = null
  private throwBeat: Beat | null = null
  /** Set when the sentence holds a home run, for the celebration. */
  homeRunKind: 'in-park' | 'out-of-park' | undefined

  constructor(private readonly animate: boolean) {}

  before(
    state: ScoringState,
    action: ScoringAction,
    rest: readonly ScoringAction[]
  ): void {
    this.throwBeat = null
    switch (action.type) {
      case 'pitch':
        this.hitOpen = false
        this.open('pitch', pitchPresentation(state, PITCH_KINDS[action.call]))
        return
      case 'ballInPlay': {
        const result = rest.find(
          (next): next is ResultAction => next.type === 'result'
        )
        const { pending, angle } = hitGeometry(state, action, result)
        this.open(
          'hit',
          hitPresentation({ ...state, pendingPlay: pending }, angle)
        )
        this.hitOpen = true
        this.hitBeat = this.current
        this.hitResultSeen = false
        this.hitCaught = pending.outcome === 'Ball Caught'
        this.landing = { fielder: pending.fielder, point: pending.location! }
        if (pending.outcome === 'Home Run')
          this.homeRunKind = pending.homeRunKind ?? 'in-park'
        return
      }
      case 'result':
        if (this.group === 'hit' && this.hitOpen && !this.hitResultSeen) {
          this.hitResultSeen = true
          return
        }
        this.hitOpen = false
        this.open('other')
        return
      case 'runnerMovement':
      case 'baseRunning': {
        const out =
          action.type === 'runnerMovement'
            ? action.out === true
            : action.kind === 'caught_stealing' || action.kind === 'pickoff'
        const fielders = action.fielders ?? []
        if (out && fielders.length > 0) {
          if (this.throws(state, action.runner, fielders, action.to)) {
            this.hitOpen = false
            return
          }
        }
        if (
          action.type === 'runnerMovement' &&
          this.hitOpen &&
          !this.hitCaught &&
          this.group === 'hit'
        )
          return
        // A runner safe on a ball on the ground ran from the crack of the bat,
        // not from the end of the throw.
        if (
          action.type === 'runnerMovement' &&
          !out &&
          !this.hitCaught &&
          this.group === 'throw' &&
          this.hitBeat != null
        ) {
          this.throwBeat = this.hitBeat
          return
        }
        const group: Group =
          action.type === 'baseRunning'
            ? 'steal'
            : this.hitCaught && (this.group === 'hit' || this.group === 'tagUp')
              ? 'tagUp'
              : 'other'
        this.hitOpen = false
        if (this.group !== group || this.group === 'other') this.open(group)
        return
      }
      case 'batteryEvent':
        this.hitOpen = false
        if (this.group !== 'battery') this.open('battery')
        return
      default:
        // A lineup change or a game-flow step moves nobody on its own.
        if (this.current == null) this.open('other')
    }
  }

  /** The motions the action just made join the beat it belongs to. */
  after(made: readonly MotionCommand[]): void {
    const beat = this.throwBeat ?? this.current
    if (beat == null) return
    for (const motion of made) {
      const existing = beat.motions.find(m => m.playerId === motion.playerId)
      if (existing == null) {
        beat.motions.push({ ...motion, waypoints: [...motion.waypoints] })
        continue
      }
      // A second leg in the same beat is one run: second, third, home.
      const last = existing.waypoints.at(-1)!
      const [first, ...rest] = motion.waypoints
      const joins =
        first != null && Math.hypot(first.x - last.x, first.z - last.z) < 0.5
      existing.waypoints.push(...(joins ? rest : motion.waypoints))
      existing.complete = existing.waypoints.length < 2
    }
  }

  /** The reel, with every picture flagged and named for its place in it. */
  finish(state: ScoringState): Beat[] {
    const beats = this.beats.filter(
      beat => beat.presentation != null || beat.motions.length > 0
    )
    beats.forEach((beat, index) => {
      if (beat.presentation != null)
        beat.presentation = {
          ...beat.presentation,
          dictated: true,
          id: `${state.generation}:${state.session.meta.sequence}:reel:${index}`
        }
      beat.motions = beat.motions.filter(motion => !motion.complete)
    })
    return beats
  }

  private open(group: Group, presentation?: PresentationSequence): void {
    const previous = this.current
    const beat: Beat = {
      ...(this.animate && presentation != null ? { presentation } : {}),
      motions: [],
      after:
        this.animate && presentation == null && previous?.presentation != null
          ? 'presentation'
          : 'motions'
    }
    this.beats.push(beat)
    this.current = beat
    this.group = group
    if (group !== 'throw') this.hitBeat = null
  }

  /**
   * One throw beat per throw of the chain: `[6, 4, 3]` is 6 to 4, then 4 to 3
   * at the base; a single fielder takes the ball to the base himself.
   */
  private throws(
    state: ScoringState,
    runner: number,
    fielders: readonly number[],
    to: keyof typeof BASE_INDEX | undefined
  ): boolean {
    const players = scoringFieldPlayers(state).map(player => ({
      ...player,
      motion: undefined,
      suppressed: false,
      hasBall: false
    }))
    const standing = (id: number): GroundPoint | undefined =>
      players.find(p => p.team === 'defense' && p.playerId === id)?.position
    if (
      !players.some(p => p.playerId === runner) ||
      fielders.some(id => standing(id) == null)
    )
      return false
    const base = { ...BASES[BASE_INDEX[to ?? '1B']] }
    const runnerPoint = standingPoint(state, runner)
    let from =
      this.landing?.fielder === fielders[0]
        ? { ...this.landing.point }
        : standing(fielders[0])!
    const chain =
      fielders.length === 1
        ? [{ thrower: fielders[0], receiver: fielders[0], final: true }]
        : fielders.slice(1).map((receiver, index) => ({
            thrower: fielders[index],
            receiver,
            final: false
          }))
    chain.forEach((step, index) => {
      const last = index === chain.length - 1
      const target = last ? base : standing(step.receiver)!
      this.open(
        'throw',
        throwSequence(state, {
          players: players.map(player => ({
            ...player,
            position: { ...player.position },
            target: { ...player.target }
          })),
          thrower: step.thrower,
          receiver: step.receiver,
          runner,
          from,
          to: target,
          runnerPoint,
          final: step.final
        })
      )
      from = target
    })
    this.throwBeat = this.current
    return true
  }
}

/** Puts a beat on the field: its picture, and its motions in place of any. */
function startBeat(state: ScoringSnapshot, beat: Beat): void {
  if (beat.presentation != null) state.presentation = beat.presentation
  for (const motion of beat.motions) {
    state.motions = state.motions.filter(m => m.playerId !== motion.playerId)
    state.motions.push({ ...motion, waypoints: [...motion.waypoints] })
  }
}

/**
 * Starts the reel: the first beat now, and every runner whose first motion is
 * in a later beat held where he starts.
 */
export function beginReel(state: ScoringSnapshot, beats: Beat[]): void {
  if (beats.length === 0) return
  const firstFor = new Map<number, MotionCommand>()
  for (const beat of beats.slice(1))
    for (const motion of beat.motions)
      if (!firstFor.has(motion.playerId)) firstFor.set(motion.playerId, motion)
  for (const motion of beats[0].motions) firstFor.delete(motion.playerId)
  for (const [playerId, motion] of firstFor) {
    state.motions = state.motions.filter(m => m.playerId !== playerId)
    state.motions.push({
      id: `${motion.id}:held`,
      generation: state.generation,
      playerId,
      waypoints: [{ ...motion.waypoints[0] }],
      complete: false,
      held: true
    })
  }
  state.reel = beats
  advanceReel(state)
}

/**
 * Starts whatever beats may start now. A beat with a picture waits until
 * nothing moves, so its picture starts from where everyone stands; a beat of
 * motions only may start as soon as the picture before it ends, which is how
 * a tag-up leaves at the catch. The reel is gone once its last beat has
 * started and nothing of it is still playing.
 */
export function advanceReel(state: ScoringSnapshot): void {
  const reel = state.reel
  if (reel == null) return
  while (reel.length > 0) {
    if (state.presentation != null) return
    const beat = reel[0]
    const moving = state.motions.some(m => !m.complete && m.held !== true)
    if (moving && (beat.presentation != null || beat.after === 'motions'))
      return
    reel.shift()
    startBeat(state, beat)
  }
  if (state.presentation == null && !state.motions.some(m => !m.complete))
    delete state.reel
}
