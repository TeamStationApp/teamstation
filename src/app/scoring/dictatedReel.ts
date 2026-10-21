import type {
  BallInPlayAction,
  PitchAction,
  ResultAction,
  RunnerMovementAction,
  ScoringAction
} from '../../common/scoring/actions'
import { allowedAngle, closesFirst, inPlay } from '../../common/scoring/rules'
import { upcoming } from '../../common/scoring/session'
import { fieldingLocation } from '../field/fieldingLocation'
import {
  BASES,
  type GroundPoint,
  OUT_APPROACH_SPEED
} from '../field/fieldModel'
import { homeRunLanding } from '../field/stadiumBoundary'
import { foulFielder } from './dictatedGeometry'
import { fieldPlayersFor } from './fieldAdapter'
import type { Outcome } from './scoringContract'
import { basePath, homeQueuePoint, scoringFieldPlayers } from './scoringMotion'
import {
  hitPresentation,
  type HitSequence,
  outBatterPoint,
  type PitchKind,
  pitchPresentation,
  type PresentationSequence,
  tagMs,
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
  const queued = state.session.homeQueue.indexOf(runner)
  if (queued >= 0) return homeQueuePoint(queued)
  const offense = state.session.liveData.linescore.offense
  const base = [offense.first, offense.second, offense.third].findIndex(
    ref => ref?.id === runner
  )
  if (base >= 0) return { ...BASES[base + 1] }
  const side = state.session.liveData.plays.currentPlay?.matchup.batSide.code
  return { x: side === 'L' ? 4 : -4, z: 0 }
}

interface BatterRun {
  batter: number
  hit: HitSequence
  /** The hit's beat: nothing before it shows him anywhere but the plate. */
  beat: Beat
  point: GroundPoint
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
  /**
   * Where the hit's picture leaves a batter it runs out toward first. He
   * waits there through any picture before his own, is thrown out from there
   * and walks off from there, as after the same play tapped.
   */
  private batterRun: BatterRun | null = null
  private readonly batterRuns: BatterRun[] = []
  /** Where each defender finished the preceding throw in this sentence. */
  private readonly defenderPoints = new Map<number, GroundPoint>()
  private choice = false
  private choiceOut?: {
    runner: number
    from: number
    to: number
    point: GroundPoint
  }

  private safeRelays: RunnerMovementAction[] = []

  private finishSafeRelay(state: ScoringState): void {
    let actions = this.safeRelays
    this.safeRelays = []
    this.choiceOut = undefined
    // Settlement can defer a blocked advance until another runner scores.
    // The complete route retains the physical order of those relay segments.
    const route = actions[0]?.fieldingRoute
    if (route != null) {
      const waiting = [...actions]
      const ordered: RunnerMovementAction[] = []
      let end = route.length
      while (waiting.length > 0) {
        const index = waiting.findIndex(action =>
          action.fielders!.every((id, hop) => {
            const saved = route[end - action.fielders!.length + hop]
            const point = action.locations?.[hop]
            return (
              saved?.id === id &&
              (point == null ||
                (saved.point.x === point.x && saved.point.z === point.z))
            )
          })
        )
        if (index < 0) break
        const [action] = waiting.splice(index, 1)
        ordered.unshift(action)
        end -= action.fielders!.length
      }
      if (waiting.length === 0) actions = ordered
    }
    for (const action of actions)
      this.throws(
        state,
        action.runner,
        action.fielders!,
        action.to,
        action.locations,
        true
      )
  }

  /** Set when the sentence holds a home run, for the celebration. */
  homeRunKind: 'in-park' | 'out-of-park' | undefined

  constructor(private readonly animate: boolean) {}

  before(
    given: ScoringState,
    action: ScoringAction,
    rest: readonly ScoringAction[]
  ): void {
    // An action that closes a finished play first finds the closed game:
    // the next at-bat's batter, count and runners.
    const state = closesFirst(action)
      ? { ...given, session: upcoming(given.session).state }
      : given
    this.throwBeat = null
    this.choiceOut = undefined
    if (this.current == null) {
      this.choice = state.session.pending?.outcome === "Fielder's Choice"
      for (const player of scoringFieldPlayers(state))
        if (player.team === 'defense' && player.playerId != null)
          this.defenderPoints.set(player.playerId, { ...player.position })
    }
    switch (action.type) {
      case 'pitch':
        this.finishSafeRelay(state)
        this.choice = false
        this.defenderPoints.clear()
        this.hitOpen = false
        this.batterRun = null
        this.open('pitch', pitchPresentation(state, PITCH_KINDS[action.call]))
        return
      case 'ballInPlay': {
        this.finishSafeRelay(state)
        const result = rest.find(
          (next): next is ResultAction => next.type === 'result'
        )
        const { pending, angle } = hitGeometry(state, action, result)
        this.defenderPoints.clear()
        this.choice = pending.outcome === "Fielder's Choice"
        const hit = hitPresentation({ ...state, pendingPlay: pending }, angle)
        // A second ball in play says more of the one already drawn, as the
        // engine takes it: the scoring screen saves the outcome's bare ball,
        // then the one with where it went. That hit is drawn once, there.
        const again =
          this.group === 'hit' &&
          this.current != null &&
          this.current === this.hitBeat
        if (again && this.current != null) {
          if (this.animate) this.current.presentation = hit
        } else if (inPlay(state.session.liveData.plays.currentPlay))
          // An earlier sentence drew the ball, as a live view gets the bare
          // ball before the rest: the play goes on from there, unpitched.
          this.open('hit')
        else this.open('hit', hit)
        // The batter it puts out runs with it; said again, it is the same run.
        if (again && this.batterRun != null)
          this.batterRuns.splice(this.batterRuns.indexOf(this.batterRun), 1)
        this.batterRun =
          this.animate && hit.out
            ? {
                batter: hit.batter,
                hit,
                beat: this.current!,
                point: outBatterPoint(hit)
              }
            : null
        if (this.batterRun != null) this.batterRuns.push(this.batterRun)
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
        const safeRelay = this.choice && !out && fielders.length > 1
        if (safeRelay && action.type === 'runnerMovement') {
          this.safeRelays.push(action)
        }
        if (this.choice && out && action.type === 'runnerMovement') {
          if (this.hitBeat == null) {
            this.open('other')
            this.hitBeat = this.current
          }
          const offense = state.session.liveData.linescore.offense
          const from =
            [offense.first, offense.second, offense.third].findIndex(
              ref => ref?.id === action.runner
            ) + 1
          this.choiceOut = {
            runner: action.runner,
            from: state.session.homeQueue.includes(action.runner) ? 4 : from,
            point: standingPoint(state, action.runner),
            to: action.to === 'home' ? 4 : BASE_INDEX[action.to]
          }
        }
        if (out && fielders.length > 0) {
          if (
            this.throws(
              state,
              action.runner,
              fielders,
              action.to,
              action.type === 'runnerMovement' ? action.locations : undefined,
              safeRelay
            )
          ) {
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
      if (
        this.choiceOut?.runner === motion.playerId &&
        this.hitBeat != null &&
        beat.presentation?.kind === 'throw'
      ) {
        const { from, to, point } = this.choiceOut
        const tagPoint = {
          x: beat.presentation.to.x,
          z: beat.presentation.to.z
        }
        const path = basePath(from, to)
        path[0] = { ...point }
        if (path.length > 1) path[path.length - 1] = { ...tagPoint }
        else if (Math.hypot(point.x - tagPoint.x, point.z - tagPoint.z) > 0.001)
          path.push({ ...tagPoint })
        const existing = this.hitBeat.motions.find(
          m => m.playerId === motion.playerId
        )
        if (existing == null)
          this.hitBeat.motions.push({
            ...motion,
            id: `${motion.id}:approach`,
            waypoints: path,
            complete: path.length < 2
          })
        else {
          existing.waypoints.push(...path.slice(1))
          existing.complete = existing.waypoints.length < 2
        }
        this.beats.push({
          after: 'presentation',
          motions: [
            {
              ...motion,
              waypoints: [tagPoint, ...motion.waypoints.slice(1)]
            }
          ]
        })
        continue
      }
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

  /**
   * Puts each batter the hit ran out where it left him, from his hit on: in
   * the throw pictures after it, and, through the hit beat's `runFrom`, in
   * his motions once the hit starts.
   */
  private placeBatterRuns(): void {
    for (const run of this.batterRuns) {
      // Held where the hit left him only while this reel goes on with him:
      // a ground out whose out comes in a later save leaves him there, done.
      const later = this.beats.slice(this.beats.indexOf(run.beat) + 1)
      const held = later.some(
        beat =>
          beat.motions.some(motion => motion.playerId === run.batter) ||
          (beat.presentation?.kind === 'throw' &&
            beat.presentation.runner === run.batter)
      )
      run.beat.runFrom = {
        playerId: run.batter,
        point: { ...run.point },
        held
      }
      for (const beat of this.beats.slice(this.beats.indexOf(run.beat) + 1)) {
        const picture = beat.presentation
        if (picture?.kind === 'throw' && picture.runner !== run.batter)
          for (const player of picture.players)
            if (player.playerId === run.batter) {
              player.position = { ...run.point }
              player.target = { ...run.point }
              player.batting = false
            }
      }
    }
  }

  /** The reel, with every picture flagged and named for its place in it. */
  finish(state: ScoringState): Beat[] {
    this.finishSafeRelay(state)
    this.placeBatterRuns()
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
   * Stops the hit's run of a batter put out so that he keeps one pace
   * through the hit and the picture that retires him, thrown or carried: it
   * takes him the rest of the way to its base, arriving with the ball. The
   * share assumes the picture lasts as long as the ball does, which holds
   * while he runs no faster than the ball.
   */
  private shareBatterRun(
    run: BatterRun,
    out: {
      thrower: number
      receiver: number
      from: GroundPoint
      target: GroundPoint
    }
  ): void {
    const { hit } = run
    const start = hit.players.find(p => p.playerId === hit.batter)!.position
    const { from, target } = out
    const floorMs = out.thrower === out.receiver ? 650 : 900
    const hitSeconds = (hit.durationMs - hit.contactMs) / 1000
    const distance = Math.hypot(target.x - start.x, target.z - start.z)
    // The tag lasts as long as the ball's way, so his share of the run is
    // the hit's share of the time; unless that leaves him farther to run
    // than the ball, when the tag lasts his run and he runs at its pace.
    const ballSeconds = tagMs(from, target, target, floorMs) / 1000
    let share = hitSeconds / (hitSeconds + ballSeconds)
    if ((1 - share) * distance > ballSeconds * OUT_APPROACH_SPEED)
      share = (hitSeconds * OUT_APPROACH_SPEED) / distance
    share = Math.min(0.96, share)
    hit.outRunEnd = {
      x: start.x + (target.x - start.x) * share,
      z: start.z + (target.z - start.z) * share
    }
    run.point = outBatterPoint(hit)
  }

  /**
   * One throw beat per throw of the chain: `[6, 4, 3]` is 6 to 4, then 4 to 3
   * at the base; a single fielder takes the ball to the base himself.
   *
   * The throw that retires the runner is a tag, whether or not the ball is
   * thrown: he runs to the base while the ball is in the air, and they arrive
   * together. A relay hop before that stays a transfer. A fielder who keeps
   * the ball runs it in, and the ball is not drawn as a second throw.
   */
  private throws(
    state: ScoringState,
    runner: number,
    fielders: readonly number[],
    to: keyof typeof BASE_INDEX | undefined,
    locations?: readonly GroundPoint[],
    safe = false
  ): boolean {
    const players = scoringFieldPlayers(state).map(player => ({
      ...player,
      motion: undefined,
      suppressed: false,
      hasBall: false
    }))
    for (const player of players) {
      const point =
        player.playerId == null
          ? undefined
          : this.defenderPoints.get(player.playerId)
      if (player.team === 'defense' && point != null) {
        player.position = { ...point }
        player.target = { ...point }
      }
    }
    const standing = (id: number): GroundPoint | undefined =>
      players.find(p => p.team === 'defense' && p.playerId === id)?.position
    if (
      (!safe && !players.some(p => p.playerId === runner)) ||
      fielders.some(id => standing(id) == null)
    )
      return false
    const base = { ...BASES[BASE_INDEX[to ?? '1B']] }
    let from =
      this.defenderPoints.get(fielders[0]) ??
      (this.landing?.fielder === fielders[0]
        ? { ...this.landing.point }
        : (locations?.[0] ?? standing(fielders[0])!))
    const chain =
      fielders.length === 1
        ? [{ thrower: fielders[0], receiver: fielders[0] }]
        : fielders.slice(1).map((receiver, index) => ({
            thrower: fielders[index],
            receiver
          }))
    const hops = chain.map((step, index) => {
      const target =
        (fielders.length === 1 ? locations?.[0] : locations?.[index + 1]) ??
        (index === chain.length - 1 ? base : standing(step.receiver)!)
      const hop = { ...step, from, target }
      from = target
      return hop
    })
    if (this.batterRun?.batter === runner && !safe)
      this.shareBatterRun(this.batterRun, hops.at(-1)!)
    const runnerPoint =
      this.choiceOut != null
        ? (locations?.at(-1) ?? base)
        : this.batterRun?.batter === runner
          ? { ...this.batterRun.point }
          : standingPoint(state, runner)
    hops.forEach(({ from, target, ...step }, index) => {
      const last = index === hops.length - 1
      const carried = step.thrower === step.receiver
      const sequence = throwSequence(state, {
        players: players.map(player => {
          const point =
            player.team === 'defense' && player.playerId != null
              ? this.defenderPoints.get(player.playerId)
              : undefined
          return {
            ...player,
            position: { ...(point ?? player.position) },
            target: { ...(point ?? player.target) }
          }
        }),
        thrower: step.thrower,
        receiver: step.receiver,
        runner,
        from,
        to: target,
        runnerPoint,
        final: carried,
        safe
      })
      const playAtBase = last && !safe
      if (playAtBase && !carried) {
        sequence.stage = 'tag'
        sequence.durationMs = tagMs(from, target, runnerPoint, 900)
      }
      this.open('throw', sequence)
      this.defenderPoints.set(step.thrower, { ...from })
      this.defenderPoints.set(step.receiver, { ...target })
    })
    this.throwBeat = this.current
    return true
  }
}

/** Puts a beat on the field: its picture, and its motions in place of any. */
function startBeat(state: ScoringSnapshot, beat: Beat): void {
  if (beat.presentation != null) state.presentation = beat.presentation
  // The hit runs its batter out toward first: from now on he waits there,
  // and whatever he does next leaves from there.
  const run = beat.runFrom
  if (run != null) {
    state.motions = state.motions.filter(m => m.playerId !== run.playerId)
    if (!beat.motions.some(m => m.playerId === run.playerId))
      state.motions.push({
        id: `${beat.presentation?.id ?? 'run'}:${run.playerId}:run`,
        generation: state.generation,
        playerId: run.playerId,
        waypoints: [{ ...run.point }],
        complete: !run.held,
        held: run.held
      })
  }
  const tag =
    beat.presentation?.kind === 'throw' &&
    beat.presentation.stage === 'tag' &&
    beat.presentation.safe !== true
      ? beat.presentation
      : undefined
  for (const motion of beat.motions) {
    state.motions = state.motions.filter(m => m.playerId !== motion.playerId)
    // The throw picture runs him to the base with the ball, so his walk off
    // leaves from that base, not from where he started.
    const [first, ...rest] = motion.waypoints
    const waypoints =
      motion.playerId === tag?.runner
        ? [{ x: tag.to.x, z: tag.to.z }, { ...motion.waypoints.at(-1)! }]
        : motion.playerId === run?.playerId &&
            first != null &&
            Math.hypot(first.x - BASES[0].x, first.z - BASES[0].z) < 5
          ? [{ ...run.point }, ...rest]
          : [...motion.waypoints]
    state.motions.push({ ...motion, waypoints })
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
