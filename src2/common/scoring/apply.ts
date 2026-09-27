import {
  type BallInPlayAction,
  type BaseRunningAction,
  type BatteryEventAction,
  cleanAction,
  destinationBase,
  DESTINATIONS,
  type FieldingPlayAction,
  type GameFlowAction,
  type LineupAction,
  PITCH_CALL_NAMES,
  type PitchAction,
  type Problem,
  type ResultAction,
  type RunnerMovementAction,
  type ScoringAction
} from './actions'
import { errorCredit, fieldedCredit, outCredits, positionOf } from './credits'
import {
  addErrorlessOut,
  type ChargeBook,
  chargeBook,
  chargeOf,
  countRbi,
  earnsRbi,
  errorlessOuts,
  halfPitcher,
  keepCharges,
  outsCorrected,
  REACHED_ON_ERROR_REASONS,
  runDecision,
  scoredOnError
} from './earnedRuns'
import {
  addPlayer,
  applyOverride,
  applyRoster,
  baseIds,
  battingSide,
  canSwitchBatter,
  fieldingSide,
  lineupChanges,
  ordinal,
  playerRef,
  startAppearance
} from './lineup'
import { homeRunKind, isFair } from './park'
import {
  choiceOpen,
  forcedFrom,
  hasEligiblePitch,
  HIT_BASES,
  homeBackProposal,
  inPlay,
  moreEligibility,
  nextDecision,
  runnerDecisionError,
  trajectoryLabel,
  trajectoryOf
} from './rules'
import {
  BASE_KEYS,
  copyState,
  type GamePlay,
  type GameState,
  lineupsOf,
  type Movement,
  type PlayerRef,
  type PlayEvent,
  type Point,
  type Resolution,
  type ResolutionOutcome,
  type RunnerCredit,
  setupOf,
  withoutUndefined
} from './state'
import type { Transition } from './transitions'

/**
 * `applyAction(state, action)` is the only way anything changes a game. It is
 * pure, synchronous and total: an action the game cannot take returns the
 * game unchanged with a problem, and never throws.
 *
 * A decided play stays open, so a scorer can still correct it, until
 * `closePlay` or the next action at the plate closes it.
 */
export interface Applied {
  state: GameState
  /** What the screen animates, in order. No coordinates, no durations. */
  transitions: Transition[]
  /** The play the action touched: the current one, or the one it completed. */
  play: GamePlay | null
  /** Anything the action asserted that the game forbids. */
  problems: Problem[]
}

class Refused extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message)
  }
}
function refuse(code: Problem['code'], message: string): never {
  throw new Refused({ code, message })
}

interface Ctx {
  state: GameState
  out: Transition[]
  /** What each runner is charged with, while the action lands. */
  charges: ChargeBook
}

const line = (ctx: Ctx): GameState['liveData']['linescore'] =>
  ctx.state.liveData.linescore
const current = (ctx: Ctx): GamePlay => {
  const play = ctx.state.liveData.plays.currentPlay
  if (play == null) refuse('notNow', 'Choose the next batter first')
  return play
}
const count = (ctx: Ctx): { balls: number; strikes: number; outs: number } => ({
  balls: line(ctx).balls,
  strikes: line(ctx).strikes,
  outs: line(ctx).outs
})

function setBase(ctx: Ctx, id: number, to: number): void {
  const offense = line(ctx).offense
  for (const key of BASE_KEYS) if (offense[key]?.id === id) offense[key] = null
  if (to >= 1 && to <= 3) offense[BASE_KEYS[to - 1]] = playerRef(ctx.state, id)
}
function rebuildQueue(ctx: Ctx): void {
  ctx.state.homeQueue = (ctx.state.pending?.movements ?? [])
    .filter(move => move.to === 4 && move.decision === 'pending')
    .sort((a, b) => b.from - a.from)
    .map(move => move.playerId)
}
function moved(ctx: Ctx, move: Movement): void {
  ctx.out.push({
    type: 'runnerMoved',
    runner: move.playerId,
    from: move.from,
    to: move.to,
    pendingHome: move.to === 4 && move.decision === 'pending',
    automaticHome: move.automaticHome === true
  })
}

interface Recorded {
  reason: string
  /** A run this movement scores is batted in. */
  rbi?: boolean
  /** The play event that made it, when that event is already written. */
  playIndex?: number
  credits?: RunnerCredit[]
  route?: Array<{ id: number; point: Point }>
  thrower?: Point
  defender?: Point
}
/** Writes one runner's movement onto the current play. */
function recordRunner(ctx: Ctx, movement: Movement, record: Recorded): void {
  const state = ctx.state
  const play = current(ctx)
  const out = movement.decision === 'out'
  const credits = record.credits ?? []
  const scored = !out && movement.to === 4
  const charge = chargeOf(state, ctx.charges, movement.playerId)
  // A movement made on a play points at the event the play came with. One an
  // action made between pitches points at that action's event, written next.
  const pending = state.pending
  const byAction = pending == null
  const playIndex =
    record.playIndex ??
    (pending == null
      ? play.playEvents.length
      : (pending.eventIndex ?? play.playEvents.length - 1))
  const run = scored
    ? runDecision(
        state,
        charge,
        scoredOnError(state.pending?.outcome, record.reason)
      )
    : { earned: false, teamUnearned: false }
  play.runners.push({
    movement: {
      originBase: movement.from,
      start: movement.from,
      end: movement.to,
      isOut: out,
      forceOut: out && movement.force,
      forced: !out && movement.force,
      runScored: !out && movement.to === 4,
      outNumber: out ? line(ctx).outs : undefined
    },
    details: {
      runner: playerRef(state, movement.playerId),
      movementReason: record.reason,
      responsiblePitcher: charge.pitcher,
      ...run,
      rbi: scored && record.rbi === true,
      playIndex,
      byAction
    },
    credits
  })
  countRbi(play)
  const runner = play.runners[play.runners.length - 1]
  play.source.gamestation.runnerActions ??= []
  play.source.gamestation.runnerActions.push({
    runner: runner.details.runner,
    origin: movement.from,
    destination: movement.to,
    reason: record.reason,
    pitchReference:
      ['Wild Pitch', 'Passed Ball'].includes(record.reason) &&
      hasEligiblePitch(state)
        ? (state.recentPitch ?? undefined)
        : undefined,
    isOut: out,
    forceOut: out && movement.force,
    runScored: !out && movement.to === 4,
    credits,
    throwerLocation: record.thrower,
    defenderLocation: record.defender,
    defensiveRoute: record.route?.map(hop => ({
      player: playerRef(state, hop.id),
      location: hop.point
    }))
  })
  play.count = count(ctx)
}
/** A runner's movement as an event of its own, after its runner entry. */
function actionEvent(ctx: Ctx, id: number, reason: string): void {
  const play = current(ctx)
  const event: PlayEvent = {
    index: play.playEvents.length,
    isPitch: false,
    type: 'action',
    details: {
      description: reason,
      code:
        reason === 'Wild Pitch'
          ? 'wild_pitch'
          : reason === 'Passed Ball'
            ? 'passed_ball'
            : 'runner_action',
      runnerEntry: play.runners.length - 1
    },
    count: count(ctx),
    player: playerRef(ctx.state, id),
    pitcher: play.matchup.pitcher
  }
  play.playEvents.push(event)
}
function countPitch(ctx: Ctx): void {
  const play = current(ctx)
  const counts =
    ctx.state.liveData.boxscore.teams[fieldingSide(ctx.state)].pitchCounts
  counts[play.matchup.pitcher.id] = (counts[play.matchup.pitcher.id] ?? 0) + 1
}
/**
 * A pitch, and the count it left. The in-play pitch keeps the count it was
 * thrown in, and a pitch's own out is not counted until the play is.
 */
function pitchEvent(
  ctx: Ctx,
  code: string,
  description: string,
  left = count(ctx)
): void {
  const play = current(ctx)
  const event: PlayEvent = {
    index: play.playEvents.length,
    isPitch: true,
    type: 'pitch',
    details: {
      call: { code, description },
      code,
      description,
      isInPlay: code === 'X'
    },
    count: left,
    player: play.matchup.pitcher
  }
  play.playEvents.push(event)
}
/**
 * What the play came to without a pitch: an award, a balk, a placed runner.
 * It names the pitcher, or the runner it is about (`player`).
 */
function playAction(
  ctx: Ctx,
  code: string,
  description: string,
  player?: PlayerRef
): void {
  const play = current(ctx)
  const event: PlayEvent = {
    index: play.playEvents.length,
    isPitch: false,
    type: 'action',
    details: { code, description },
    count: count(ctx),
    player: player ?? play.matchup.pitcher
  }
  play.playEvents.push(event)
}

/** The batter reached where the defence would have put him out. */
function batterReachedOnError(ctx: Ctx): void {
  const pending = ctx.state.pending
  if (pending == null || pending.batterReachedOnError === true) return
  pending.batterReachedOnError = true
  addErrorlessOut(ctx.state)
}

function newResolution(
  ctx: Ctx,
  outcome: ResolutionOutcome,
  extra: Partial<Resolution> = {}
): Resolution {
  const play = current(ctx)
  return {
    outcome,
    eventIndex: play.playEvents.length - 1,
    originalRunnerRecordCount: play.runners.length,
    originalBases: baseIds(ctx.state),
    originalRuns: line(ctx).teams[battingSide(ctx.state)].runs,
    originalOuts: line(ctx).outs,
    movements: [],
    ...extra
  }
}

function nextHalf(ctx: Ctx): void {
  const state = ctx.state
  const l = line(ctx)
  ctx.out.push({
    type: 'halfEnded',
    inning: l.currentInning,
    half: l.isTopInning ? 'top' : 'bottom'
  })
  if (!l.isTopInning) l.currentInning++
  l.isTopInning = !l.isTopInning
  l.inningState = l.isTopInning ? 'Top' : 'Bottom'
  l.currentInningOrdinal = ordinal(l.currentInning)
  l.balls = 0
  l.strikes = 0
  l.outs = 0
  l.offense = { batter: null, first: null, second: null, third: null }
  delete l.errorlessOuts
  ctx.charges.clear()
  state.pending = null
  state.homeQueue = []
  state.recentPitch = null
  state.awaitingBatter = startAppearance(state)
  ctx.out.push({
    type: 'batterChanged',
    batter: l.offense.batter?.id ?? null
  })
}

/** Ends the play: stamps the score, moves the order on, and brings up the next batter. */
function closePlay(ctx: Ctx): void {
  const state = ctx.state
  const play = current(ctx)
  play.about.isComplete = true
  play.result.awayScore = line(ctx).teams.away.runs
  play.result.homeScore = line(ctx).teams.home.runs
  refineEventType(play, state.pending)
  countRbi(play)
  state.liveData.plays.allPlays.push(copyState(play))
  ctx.out.push({
    type: 'playClosed',
    atBatIndex: play.about.atBatIndex,
    eventType: play.result.eventType
  })
  const lineup = state.liveData.boxscore.teams[battingSide(state)]
  lineup.battingIndex = (lineup.battingIndex + 1) % lineup.battingOrder.length
  state.pending = null
  state.homeQueue = []
  if (line(ctx).outs >= 3) nextHalf(ctx)
  else {
    line(ctx).balls = 0
    line(ctx).strikes = 0
    state.awaitingBatter = startAppearance(state)
    ctx.out.push({
      type: 'batterChanged',
      batter: line(ctx).offense.batter?.id ?? null
    })
  }
}

/**
 * The event type a closed play carries, from what the play came to, as MLB
 * types it. Only the outs and runs the play itself made count: a runner
 * caught stealing earlier in the plate appearance does not make its ground
 * ball a double play.
 *
 * - A strikeout that also retired a runner is a strikeout double play.
 * - With the batter safe and one runner put out, the play is a `force_out`
 *   when that runner was forced, and a `fielders_choice_out` when he was
 *   not. A fielder's choice that put nobody out stays `fielders_choice`.
 * - A fly ball caught with fewer than two out that scored a run is a
 *   sacrifice fly.
 * - A bunt that put the batter out and moved a runner up, with fewer than two
 *   out, is a sacrifice bunt.
 * - Two or three outs on a ground ball are a ground-ball double or triple
 *   play; on anything else, a double or triple play.
 */
function refineEventType(play: GamePlay, pending: Resolution | null): void {
  const made = play.runners.filter(runner => runner.details.byAction !== true)
  const outs = made.filter(runner => runner.movement.isOut).length
  const type = play.result.eventType
  if (type === 'strikeout' && outs >= 2)
    play.result.eventType =
      outs >= 3 ? 'strikeout_triple_play' : 'strikeout_double_play'
  if ((type !== 'field_out' && type !== 'fielders_choice') || pending == null)
    return
  const batter = play.matchup.batter.id
  const batterOut = made.some(
    runner => runner.movement.isOut && runner.details.runner.id === batter
  )
  const scored = made.some(
    runner => runner.movement.runScored === true && !runner.movement.isOut
  )
  const advanced = made.some(
    runner =>
      runner.details.runner.id !== batter &&
      !runner.movement.isOut &&
      runner.movement.end > runner.movement.start
  )
  const grounder =
    pending.outcome === 'Throw Out' || pending.outcome === "Fielder's Choice"
  const forced = made.some(
    runner => runner.movement.isOut && runner.movement.forceOut
  )
  if (outs === 0) return
  if (!batterOut && outs === 1 && grounder)
    play.result.eventType = forced ? 'force_out' : 'fielders_choice_out'
  else if (
    pending.outcome === 'Ball Caught' &&
    pending.originalOuts < 2 &&
    scored
  )
    play.result.eventType = outs >= 2 ? 'sac_fly_double_play' : 'sac_fly'
  else if (
    pending.contactKind === 'bunt' &&
    pending.outcome === 'Throw Out' &&
    batterOut &&
    advanced &&
    pending.originalOuts < 2
  )
    play.result.eventType = outs >= 2 ? 'sac_bunt_double_play' : 'sac_bunt'
  else if (outs >= 3)
    play.result.eventType = grounder
      ? 'grounded_into_triple_play'
      : 'triple_play'
  else if (outs === 2)
    play.result.eventType = grounder
      ? 'grounded_into_double_play'
      : 'double_play'
}

/**
 * The event type of a play a runner's third out ended between pitches: a
 * caught stealing or a pickoff names the base, anything else is a runner out.
 */
function betweenEventType(reason: string, from: number, to: number): string {
  if (reason === 'Caught Stealing') return `caught_stealing_${stealTarget(to)}`
  if (reason === 'Picked Off' && from >= 1 && from <= 3)
    return to > from
      ? `pickoff_caught_stealing_${stealTarget(to)}`
      : `pickoff_${from}b`
  return 'other_out'
}
/** The base a steal was headed for, as MLB's event types name it. */
function stealTarget(base: number): string {
  return base >= 4 ? 'home' : `${Math.max(2, base)}b`
}

/** Three outs between pitches: the play ends as the runner's out, and so does the half. */
function finishBetween(
  ctx: Ctx,
  reason: string,
  from: number,
  to: number
): void {
  if (line(ctx).outs < 3) return
  const play = current(ctx)
  play.about.isComplete = true
  play.result.description = reason
  play.result.event = 'Runner out'
  play.result.eventType = betweenEventType(reason, from, to)
  play.result.awayScore = line(ctx).teams.away.runs
  play.result.homeScore = line(ctx).teams.home.runs
  ctx.state.liveData.plays.allPlays.push(copyState(play))
  ctx.out.push({
    type: 'playClosed',
    atBatIndex: play.about.atBatIndex,
    eventType: play.result.eventType
  })
  nextHalf(ctx)
}

/** A run counts for the side; whether it was batted in is the runner's `rbi`. */
function scoreRun(ctx: Ctx, runner: number, rbi: boolean): void {
  line(ctx).teams[battingSide(ctx.state)].runs++
  ctx.out.push({ type: 'runScored', runner, rbi })
}

/** Runners who score by right score once nobody ahead of them is still to be decided. */
function resolveAutomaticHomes(ctx: Ctx): void {
  const pending = ctx.state.pending
  if (pending == null) return
  for (const move of pending.movements) {
    if (move.automaticHome !== true || move.resolved === true) continue
    if (line(ctx).outs >= 3) {
      move.resolved = true
      continue
    }
    if (ctx.state.homeQueue.length > 0) continue
    move.homeReleased = true
    move.resolved = true
    const reason =
      pending.automaticAward === true && pending.outcome !== 'Balk'
        ? current(ctx).result.event
        : pending.outcome
    const rbi = earnsRbi(pending.outcome, reason)
    scoreRun(ctx, move.playerId, rbi)
    recordRunner(ctx, move, { reason, rbi })
  }
}

/** The batter's choice is decided: everyone takes the base he was given. */
function commitChoiceIfResolved(ctx: Ctx): void {
  const pending = ctx.state.pending
  if (
    pending == null ||
    pending.choiceApplied === true ||
    !["Fielder's Choice", 'Error', 'Dropped Third Strike'].includes(
      pending.outcome
    ) ||
    line(ctx).outs >= 3 ||
    pending.movements.some(move => move.to < 4 && move.decision === 'pending')
  )
    return
  pending.choiceApplied = true
  for (const key of BASE_KEYS) line(ctx).offense[key] = null
  for (const move of pending.movements) {
    if (move.decision === 'out') continue
    if (move.to === 4) move.decision = 'pending'
    else setBase(ctx, move.playerId, move.to)
  }
  rebuildQueue(ctx)
  for (const move of pending.movements)
    if (move.decision !== 'out' && move.from !== move.to) {
      if (move.to < 4)
        recordRunner(ctx, move, {
          reason: pending.outcome,
          credits: fielded(ctx, move)
        })
      moved(ctx, move)
    }
}

/** A fielded-ball credit on the batter's own record, when the play has a fielder. */
function fielded(ctx: Ctx, move: Movement): RunnerCredit[] {
  const pending = ctx.state.pending
  return move.from === 0 && pending?.fielder != null
    ? [fieldedCredit(ctx.state, pending.fielder)]
    : []
}

/** Everything that follows by rule once an action has landed. */
function settle(ctx: Ctx): void {
  const pending = ctx.state.pending
  if (pending == null || choiceOpen(ctx.state)) return
  commitChoiceIfResolved(ctx)
  resolveAutomaticHomes(ctx)
  if (pending.sameAppearance === true && nextDecision(ctx.state) === 'close') {
    ctx.state.pending = null
    finishBetween(ctx, pending.outcome, 0, 0)
  }
}

function prepareHit(ctx: Ctx): void {
  const pending = ctx.state.pending!
  const bases = HIT_BASES[pending.outcome]
  if (bases == null) return
  const batter = current(ctx).matchup.batter.id
  const runners = pending.originalBases
    .map((id, index) => ({ id, from: index + 1 }))
    .filter((row): row is { id: number; from: number } => row.id != null)
    .reverse()
  pending.movements = [...runners, { id: batter, from: 0 }].map(row => {
    const to = Math.min(4, row.from + bases)
    const forced =
      row.from === 0 ||
      pending.originalBases.slice(0, row.from).every(id => id != null)
    const automaticHome = pending.outcome === 'Home Run'
    return {
      playerId: row.id,
      from: row.from,
      to,
      automaticHome,
      force: forced && to === row.from + 1,
      decision: to === 4 && !automaticHome ? 'pending' : 'safe',
      resolved: false
    }
  })
  rebuildQueue(ctx)
  for (const key of BASE_KEYS) line(ctx).offense[key] = null
  for (const movement of pending.movements) {
    if (movement.to < 4) {
      setBase(ctx, movement.playerId, movement.to)
      recordRunner(ctx, movement, {
        reason: pending.outcome,
        credits: fielded(ctx, movement)
      })
    }
    moved(ctx, movement)
  }
  if (pending.outcome !== 'Error')
    line(ctx).teams[battingSide(ctx.state)].hits++
}

/**
 * Puts each runner of an award where it sends him. Only the batter and the
 * runners he forced move; a runner the award did not force stays on his base
 * and, as in the feed, has no entry on the play.
 */
function applyAwardMovements(ctx: Ctx, reason: string): void {
  const pending = ctx.state.pending!
  rebuildQueue(ctx)
  for (const key of BASE_KEYS) line(ctx).offense[key] = null
  for (const movement of pending.movements) {
    if (movement.to < 4) {
      setBase(ctx, movement.playerId, movement.to)
      if (movement.to !== movement.from) recordRunner(ctx, movement, { reason })
    }
    moved(ctx, movement)
  }
}

/** The batter's side of a play: an out made at once, a choice to resolve, or nothing more. */
function prepareBatterResult(ctx: Ctx): void {
  const pending = ctx.state.pending!
  const batter = current(ctx).matchup.batter.id
  if (pending.outcome === 'Error') {
    pending.errorPending = true
    pending.choiceApplied = true
  } else if (pending.outcome === 'Dropped Third Strike') {
    // Forced runners take their base at once and a runner forced home waits
    // for the home call. The batter heads for first and waits for his own
    // call, except with the bases loaded, when he is taken to be safe.
    const loaded = pending.originalBases.every(id => id != null)
    pending.choiceApplied = true
    pending.movements = [
      {
        playerId: batter,
        from: 0,
        to: 1,
        force: true,
        decision: loaded ? 'safe' : 'pending',
        resolved: loaded
      }
    ]
    let forced = true
    pending.originalBases.forEach((id, index) => {
      if (id == null) {
        forced = false
        return
      }
      const to = index + 1 + (forced ? 1 : 0)
      pending.movements.push({
        playerId: id,
        from: index + 1,
        to,
        force: forced,
        decision: to === 4 ? 'pending' : 'safe',
        resolved: to !== 4
      })
    })
    for (const key of BASE_KEYS) line(ctx).offense[key] = null
    rebuildQueue(ctx)
    for (const move of pending.movements) {
      if (move.to < 4) setBase(ctx, move.playerId, move.to)
      if (move.from !== move.to) {
        if (move.decision === 'safe')
          recordRunner(ctx, move, { reason: pending.outcome })
        moved(ctx, move)
      }
    }
  } else if (pending.outcome === "Fielder's Choice") {
    pending.movements = pending.originalBases
      .map((id, index) => ({ id, from: index + 1 }))
      .filter((row): row is { id: number; from: number } => row.id != null)
      .map(row => ({
        playerId: row.id,
        from: row.from,
        to: row.from,
        force: false,
        decision: 'safe' as const,
        resolved: true
      }))
    pending.movements.push({
      playerId: batter,
      from: 0,
      to: 0,
      force: true,
      decision: 'pending'
    })
  } else if (pending.outcome === 'Ball Caught' && pending.fielder != null) {
    finishOut(ctx, {
      runner: batter,
      from: 0,
      to: 0,
      reason: 'Ball Caught',
      fielders: [pending.fielder]
    })
  }
}

interface OutCall {
  runner: number
  from: number
  to: number
  reason: string
  fielders: number[]
  locations?: Point[]
  runnerLocation?: Point
}

/**
 * A runner is out. A third out that was a force takes back every run the play
 * scored, and ends the half for everyone still headed home.
 */
function finishOut(ctx: Ctx, call: OutCall): void {
  const pending = ctx.state.pending
  const l = line(ctx)
  if (l.outs >= 3) return
  const old = pending?.movements.find(move => move.playerId === call.runner)
  // Put out at the next base while the batter is still running, and with
  // every base behind him taken, a runner is forced: the lead runner of a
  // double play, retired before the batter.
  const force =
    (call.to === call.from + 1 && forcedFrom(ctx.state, call.from)) ||
    (old?.force === true && old.decision === 'pending') ||
    (call.from === 0 && call.to <= 1)
  l.outs++
  // A batter who reached on an error and is then put out on the same play
  // makes the one out his error already counted.
  if (
    pending?.batterReachedOnError !== true ||
    call.runner !== current(ctx).matchup.batter.id
  )
    addErrorlessOut(ctx.state)
  const movement: Movement = {
    playerId: call.runner,
    from: call.from,
    to: call.to,
    force,
    decision: 'out',
    resolved: true
  }
  if (old != null) Object.assign(old, movement)
  else pending?.movements.push(movement)
  setBase(ctx, call.runner, 0)
  for (let i = 1; i < call.fielders.length; i++)
    ctx.out.push({
      type: 'throwMade',
      from: call.fielders[i - 1],
      to: call.fielders[i]
    })
  const route =
    call.locations == null
      ? undefined
      : call.fielders.map((id, i) => ({
          id,
          point: call.locations?.[i] ?? call.locations?.at(-1) ?? { x: 0, z: 0 }
        }))
  recordRunner(ctx, movement, {
    reason: call.reason,
    credits: outCredits(ctx.state, call.fielders),
    route,
    thrower: call.locations?.[0],
    defender: call.runnerLocation ?? call.locations?.at(-1)
  })
  actionEvent(ctx, call.runner, call.reason)
  ctx.out.push({
    type: 'outRecorded',
    runner: call.runner,
    from: call.from,
    at: call.to,
    outs: l.outs
  })
  ctx.state.homeQueue = ctx.state.homeQueue.filter(id => id !== call.runner)
  if (l.outs >= 3) {
    if (pending != null && force) {
      const taken = l.teams[battingSide(ctx.state)].runs - pending.originalRuns
      l.teams[battingSide(ctx.state)].runs = pending.originalRuns
      const play = current(ctx)
      for (const record of play.runners.slice(
        pending.originalRunnerRecordCount
      )) {
        record.movement.runScored = false
        record.details.rbi = false
        record.details.earned = false
        record.details.teamUnearned = false
      }
      countRbi(play)
      for (const record of (play.source.gamestation.runnerActions ?? []).slice(
        pending.originalRunnerRecordCount
      ))
        record.runScored = false
      if (taken > 0) ctx.out.push({ type: 'runsTakenBack', runs: taken })
    }
    ctx.state.homeQueue = []
  }
}

// ---- The actions ----

function pitch(ctx: Ctx, action: PitchAction): void {
  if (ctx.state.pending != null)
    refuse('notNow', 'Finish the current play first')
  const play = current(ctx)
  if (inPlay(play)) refuse('notNow', 'A ball in play needs its result')
  const l = line(ctx)
  const outs = l.outs
  countPitch(ctx)
  if (action.call === 'B') l.balls++
  else if (action.call !== 'F' || l.strikes < 2) l.strikes++
  pitchEvent(ctx, action.call, PITCH_CALL_NAMES[action.call], {
    balls: l.balls,
    strikes: l.strikes,
    outs
  })
  ctx.out.push({
    type: 'pitchThrown',
    call: action.call,
    pitcher: play.matchup.pitcher.id
  })
  ctx.state.recentPitch =
    action.call === 'F'
      ? null
      : { atBatIndex: play.about.atBatIndex, index: play.playEvents.length - 1 }
  if (l.balls >= 4 || l.strikes >= 3) {
    const walk = l.balls >= 4
    const originalBases = baseIds(ctx.state)
    const pending = newResolution(ctx, walk ? 'Walk' : 'Strikeout', {
      automaticAward: walk
    })
    ctx.state.pending = pending
    play.result.event = walk ? 'Walk' : 'Strikeout'
    play.result.eventType = walk ? 'walk' : 'strikeout'
    play.result.description = play.result.event
    play.source.gamestation.outcome = play.result.event
    if (walk) {
      let carry: number | null = play.matchup.batter.id
      for (let base = 1; base <= 3 && carry != null; base++) {
        const id: number = carry
        carry = originalBases[base - 1]
        setBase(ctx, id, base)
        pending.movements.push({
          playerId: id,
          from: base - 1,
          to: base,
          force: true,
          decision: 'safe'
        })
      }
      if (carry != null)
        pending.movements.push({
          playerId: carry,
          from: 3,
          to: 4,
          force: true,
          decision: 'safe',
          automaticHome: true
        })
      for (const movement of pending.movements) {
        if (movement.to < 4) recordRunner(ctx, movement, { reason: 'Walk' })
        moved(ctx, movement)
      }
    } else {
      l.outs++
      addErrorlessOut(ctx.state)
      const batter = play.matchup.batter.id
      const movement: Movement = {
        playerId: batter,
        from: 0,
        to: 0,
        force: false,
        decision: 'out',
        resolved: true
      }
      pending.movements.push(movement)
      recordRunner(ctx, movement, { reason: 'Strikeout' })
      ctx.out.push({
        type: 'outRecorded',
        runner: batter,
        from: 0,
        at: 0,
        outs: l.outs
      })
    }
  }
  play.count = count(ctx)
}

const TRAJECTORY_ANGLES = {
  ground_ball: -10,
  line_drive: 20,
  fly_ball: 40,
  popup: 60,
  chopper: -35
} as const

function ballInPlay(ctx: Ctx, action: BallInPlayAction): void {
  if (ctx.state.pending != null)
    refuse('notNow', 'Finish the current play first')
  const play = current(ctx)
  // The ball already in play: this says more about it, and throws no pitch.
  const again = inPlay(play)
  if (!again) {
    ctx.state.recentPitch = null
    countPitch(ctx)
    pitchEvent(
      ctx,
      'X',
      action.contact === 'bunt' ? 'Bunt in Play' : 'Ball in Play'
    )
    ctx.out.push({
      type: 'pitchThrown',
      call: 'X',
      pitcher: play.matchup.pitcher.id
    })
  } else if (play.source.gamestation.contactKind !== action.contact)
    refuse('illegal', 'The ball is already in play as a different contact')
  play.source.gamestation.contactKind = action.contact
  const angle =
    action.launchAngle ??
    (action.trajectory == null
      ? undefined
      : TRAJECTORY_ANGLES[action.trajectory])
  if (action.fielder != null) {
    if (!isFielder(ctx, action.fielder))
      refuse('unknownPlayer', 'That player is not in the field')
    ctx.out.push({ type: 'ballFielded', fielder: action.fielder })
  }
  if (angle != null || action.location != null || action.fielder != null) {
    play.hitData = withoutUndefined({
      launchAngle: angle,
      trajectory: angle == null ? undefined : trajectoryLabel(angle),
      coordinates: action.location == null ? undefined : { ...action.location },
      fielder:
        action.fielder == null
          ? undefined
          : playerRef(ctx.state, action.fielder),
      position:
        action.fielder == null
          ? undefined
          : positionOf(ctx.state, action.fielder)
    })
    // The scorer's own pick, which the label and MLB's list both lose.
    const detail = play.source.gamestation
    if (angle == null) {
      delete detail.trajectory
      delete detail.launchAngle
    } else {
      detail.trajectory = action.trajectory ?? trajectoryOf(angle)
      detail.launchAngle = angle
    }
  }
  const kind =
    action.homeRunKind ??
    (action.location == null ? undefined : homeRunKind(action.location))
  if (kind != null) play.source.gamestation.homeRunKind = kind
  if (action.landingHeight != null)
    play.source.gamestation.landingHeight = action.landingHeight
}

function isFielder(ctx: Ctx, id: number): boolean {
  return Object.values(line(ctx).defense).some(player => player?.id === id)
}

const BATTED: Partial<Record<ResultAction['eventType'], ResolutionOutcome>> = {
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home Run',
  field_error: 'Error',
  fielders_choice: "Fielder's Choice"
}
const OUT_OUTCOMES = {
  throw: 'Throw Out',
  catch: 'Ball Caught',
  interference: 'Batter Interference'
} as const
const AWARDS = {
  hit_by_pitch: 'Hit by Pitch',
  intent_walk: 'Intentional Walk',
  catcher_interference: "Catcher's Interference"
} as const

function result(ctx: Ctx, action: ResultAction): void {
  if (ctx.state.pending != null)
    refuse('notNow', 'Finish the current play first')
  const play = current(ctx)
  const type = action.eventType
  const batted =
    BATTED[type] ??
    (type === 'field_out' ? OUT_OUTCOMES[action.outBy ?? 'throw'] : undefined)
  if (batted != null) {
    battedResult(ctx, action, batted)
    return
  }
  if (inPlay(play))
    refuse('notNow', 'A ball in play needs a batted-ball result')
  ctx.state.recentPitch = null
  if (type === 'strikeout') {
    if (moreEligibility(ctx.state, 'Dropped Third Strike') != null)
      refuse('illegal', 'Requires two strikes and first empty or two outs')
    countPitch(ctx)
    // Strike three the catcher did not hold: a strike, not a ball in play.
    pitchEvent(ctx, 'S', 'Dropped Third Strike', { ...count(ctx), strikes: 3 })
    play.result.event = 'Strikeout'
    play.result.eventType = 'strikeout'
    play.result.description = 'Dropped Third Strike'
    play.source.gamestation.outcome = 'Dropped Third Strike'
    line(ctx).strikes = 3
    play.count.strikes = 3
    ctx.state.pending = newResolution(ctx, 'Dropped Third Strike')
    prepareBatterResult(ctx)
    return
  }
  if (type === 'other_out') {
    playAction(ctx, 'other_out', 'Batter Out — Other')
    play.result.event = 'Batter Out — Other'
    play.result.eventType = 'other_out'
    play.result.description = 'Batter Out — Other'
    play.source.gamestation.outcome = 'Batter Out — Other'
    ctx.state.pending = newResolution(ctx, 'Batter Out — Other')
    return
  }
  const occupied = baseIds(ctx.state)
  const batter = play.matchup.batter.id
  const movements: Movement[] = []
  let label: string
  if (type === 'manual_placement') {
    if (occupied.some(id => id != null))
      refuse('illegal', 'Requires empty bases')
    const base = destinationBase(action.base ?? '1B')
    label = 'Put Batter on Base'
    playAction(ctx, 'manual_placement', label)
    movements.push({
      playerId: batter,
      from: 0,
      to: base,
      force: false,
      decision: 'safe'
    })
    ctx.state.pending = newResolution(ctx, 'Manual placement', {
      automaticAward: true
    })
  } else {
    label = AWARDS[type as keyof typeof AWARDS]
    if (type === 'hit_by_pitch') {
      countPitch(ctx)
      pitchEvent(ctx, 'H', label)
    } else playAction(ctx, type, label)
    ctx.state.pending = newResolution(ctx, 'Walk', { automaticAward: true })
    // Catcher's interference is an error: the batter might have been out.
    if (type === 'catcher_interference') batterReachedOnError(ctx)
    movements.push({
      playerId: batter,
      from: 0,
      to: 1,
      force: true,
      decision: 'safe'
    })
    let forced = true
    occupied.forEach((id, index) => {
      if (id == null) {
        forced = false
        return
      }
      const to = forced ? index + 2 : index + 1
      movements.push({
        playerId: id,
        from: index + 1,
        to,
        force: forced,
        decision: 'safe'
      })
    })
  }
  for (const movement of movements) movement.automaticHome = movement.to === 4
  play.result.event = label
  play.result.eventType = type
  play.result.description = label
  play.source.gamestation.outcome = label
  ctx.state.pending.movements = movements
  applyAwardMovements(ctx, label)
}

function battedResult(
  ctx: Ctx,
  action: ResultAction,
  outcome: ResolutionOutcome
): void {
  const play = current(ctx)
  if (!inPlay(play)) ballInPlay(ctx, { type: 'ballInPlay', contact: 'swing' })
  const contact = play.source.gamestation.contactKind ?? 'swing'
  if (contact === 'bunt' && outcome === 'Home Run')
    refuse('illegal', 'A bunt cannot be a home run')
  if (
    outcome === "Fielder's Choice" &&
    !baseIds(ctx.state).some(id => id != null)
  )
    refuse('illegal', "A fielder's choice needs a runner on base")
  const fielder = play.hitData?.fielder?.id
  const kind = play.source.gamestation.homeRunKind
  ctx.state.pending = newResolution(ctx, outcome, {
    contactKind: contact,
    fielder,
    ...(outcome === 'Home Run' ? { homeRunKind: kind ?? 'in-park' } : {})
  })
  if (outcome === 'Error') batterReachedOnError(ctx)
  play.result.event = outcome
  play.result.eventType = action.eventType
  play.result.description = outcome
  play.source.gamestation.outcome = outcome
  if (outcome === 'Throw Out' || outcome === 'Ball Caught')
    play.source.gamestation.outSubtype = outcome
  if (outcome === 'Home Run')
    play.source.gamestation.homeRunKind = kind ?? 'in-park'
  else {
    delete play.source.gamestation.homeRunKind
    delete play.source.gamestation.landingHeight
  }
  const landed = play.hitData?.coordinates
  const foul =
    action.foulCaught ??
    (landed != null && play.hitData?.fielder != null && !isFair(landed))
  if (foul && outcome === 'Ball Caught') {
    play.source.gamestation.foulCaught = true
    play.result.description = 'Foul ball caught'
  }
  prepareHit(ctx)
  prepareBatterResult(ctx)
}

function fieldingPlay(ctx: Ctx, action: FieldingPlayAction): void {
  const pending = ctx.state.pending
  if (pending?.errorPending !== true || action.error == null)
    refuse('notNow', 'No error is waiting to be charged')
  if (!action.fielders.includes(action.error))
    refuse('illegal', 'The fielder charged must have handled the ball')
  for (const id of action.fielders)
    if (!isFielder(ctx, id))
      refuse('unknownPlayer', 'That player is not in the field')
  const play = current(ctx)
  play.source.gamestation.errorCredit = {
    player: playerRef(ctx.state, action.error),
    defensiveRoute: action.fielders.map((id, i) => ({
      player: playerRef(ctx.state, id),
      location: action.locations?.[i] ?? { x: 0, z: 0 }
    }))
  }
  const batterRecord = play.runners.find(
    runner =>
      runner.details.runner.id === play.matchup.batter.id &&
      runner.movement.start === 0
  )
  batterRecord?.credits.push(
    errorCredit(ctx.state, action.error, action.errorKind)
  )
  line(ctx).teams[fieldingSide(ctx.state)].errors++
  pending.errorPending = false
  ctx.out.push({ type: 'errorCharged', fielder: action.error })
}

/** Where a runner is now: a base, the plate, or headed home. */
function locate(ctx: Ctx, runner: number): number {
  const base = baseIds(ctx.state).indexOf(runner) + 1
  if (base > 0) return base
  if (ctx.state.homeQueue.includes(runner)) return 4
  if (current(ctx).matchup.batter.id === runner) return 0
  return -1
}

/**
 * `joining` is the event of the action this movement is part of, when that
 * action has already written it: the second runner a wild pitch moved.
 */
function runnerMovement(
  ctx: Ctx,
  action: RunnerMovementAction,
  joining?: number
): void {
  const state = ctx.state
  const pending = state.pending
  const to = destinationBase(action.to)
  let where = locate(ctx, action.runner)
  if (where < 0) refuse('unknownPlayer', 'That runner is not on the play')
  const decision = nextDecision(state)
  if (decision === 'errorAttribution')
    refuse('notNow', 'Charge the error first')
  // The batter of a dropped third strike already stands on first, still
  // waiting for his call there: he runs from the plate.
  const droppedBatter =
    pending?.outcome === 'Dropped Third Strike' &&
    pending.movements.some(
      move =>
        move.playerId === action.runner &&
        move.from === 0 &&
        move.decision === 'pending'
    )
  if (droppedBatter) where = 0
  if (where === 4) {
    homeMovement(ctx, action, to)
    return
  }
  if (decision === 'homeDecision')
    refuse('notNow', 'Decide the runner headed home first')
  if (where === 0) {
    const batterTurn =
      decision === 'batterOut' ||
      (decision === 'resolveBatter' &&
        pending?.movements.some(move => move.playerId === action.runner) ===
          true)
    if (!batterTurn) refuse('notNow', 'The batter is not running')
  } else if (to < where) refuse('illegal', 'A runner cannot go back')
  if (decision === 'batterOut' && action.out !== true)
    refuse('notNow', 'Say who put the batter out')
  if (action.out === true) {
    finishOut(ctx, {
      runner: action.runner,
      from: where,
      to,
      reason:
        action.reason ??
        (decision === 'batterOut' || droppedBatter ? pending!.outcome : 'Out'),
      fielders: action.fielders ?? [],
      locations: action.locations,
      runnerLocation: action.runnerLocation
    })
    if (pending == null) finishBetween(ctx, action.reason ?? 'Out', where, to)
    settle(ctx)
    return
  }
  const error = runnerDecisionError(state, {
    playerId: action.runner,
    from: where,
    to
  })
  if (error != null) refuse('illegal', error)
  commitSafe(ctx, action, where, to, joining)
}

function commitSafe(
  ctx: Ctx,
  action: RunnerMovementAction,
  from: number,
  to: number,
  joining?: number
): void {
  const pending = ctx.state.pending
  const movement: Movement = {
    playerId: action.runner,
    from,
    to,
    force: false,
    decision: 'safe',
    resolved: true
  }
  if (pending != null && choiceOpen(ctx.state)) {
    const old = pending.movements.find(move => move.playerId === action.runner)
    if (old == null) refuse('notNow', 'That runner is not part of the choice')
    movement.force =
      to === from + 1 &&
      (from === 0 ||
        pending.originalBases.slice(0, from).every(id => id != null)) &&
      pending.movements.some(move => move.from === 0 && move.decision !== 'out')
    Object.assign(old, movement)
    if (pending.outcome === 'Dropped Third Strike') {
      // Strike three the catcher dropped, and the batter reached on a passed
      // ball or an error: he would have been out.
      if (
        from === 0 &&
        action.reason != null &&
        REACHED_ON_ERROR_REASONS.has(action.reason)
      )
        batterReachedOnError(ctx)
      recordRunner(ctx, movement, { reason: pending.outcome })
    }
    let required = 0
    for (const other of [...pending.movements]
      .filter(move => move.decision !== 'out')
      .sort((a, b) => a.from - b.from)) {
      if (other.to < required) other.decision = 'pending'
      required = Math.min(4, Math.max(required, other.to) + 1)
    }
    settle(ctx)
    return
  }
  if (pending != null && from === to)
    refuse('illegal', 'The runner is already there')
  // Between pitches, a runner who stays where he is was safe on a pickoff;
  // nothing else leaves him on his base.
  if (
    from === to &&
    (action.reason ?? 'Safe from Pickoff') !== 'Safe from Pickoff'
  )
    refuse('illegal', `That runner is already on ${DESTINATIONS[to]}`)
  const reason =
    action.reason ??
    (pending == null && from === to ? 'Safe from Pickoff' : 'Advance')
  setBase(ctx, action.runner, to)
  const rbi = to === 4 && earnsRbi(pending?.outcome, reason)
  if (to === 4 && from !== 4) scoreRun(ctx, action.runner, rbi)
  const old = pending?.movements.find(move => move.playerId === action.runner)
  if (old != null) Object.assign(old, movement)
  else pending?.movements.push(movement)
  recordRunner(ctx, movement, { reason, rbi, playIndex: joining })
  if (joining == null) actionEvent(ctx, action.runner, reason)
  moved(ctx, movement)
  settle(ctx)
}

/** The lead runner headed home: safe, out, or sent back to third. */
function homeMovement(
  ctx: Ctx,
  action: RunnerMovementAction,
  to: number
): void {
  const state = ctx.state
  const pending = state.pending!
  if (state.homeQueue[0] !== action.runner)
    refuse('notNow', 'Decide the lead runner headed home first')
  const movement = pending.movements.find(
    move => move.playerId === action.runner
  )!
  if (action.out === true) {
    finishOut(ctx, {
      runner: action.runner,
      from: movement.from,
      to: 4,
      reason: action.reason ?? 'Out at home',
      fielders: action.fielders ?? [],
      locations: action.locations,
      runnerLocation: action.runnerLocation
    })
    settle(ctx)
    return
  }
  if (to === 4) {
    movement.decision = 'safe'
    movement.resolved = true
    const reason = action.reason ?? 'Safe at home'
    const rbi = earnsRbi(pending.outcome, reason)
    scoreRun(ctx, action.runner, rbi)
    recordRunner(ctx, movement, { reason, rbi })
    state.homeQueue.shift()
    settle(ctx)
    return
  }
  const proposal = homeBackProposal(state)
  if (proposal == null || to !== 3)
    refuse('illegal', 'The runners behind him cannot give ground')
  const before = pending.movements
  pending.movements = proposal
  for (const key of BASE_KEYS) line(ctx).offense[key] = null
  rebuildQueue(ctx)
  for (const move of proposal)
    if (move.decision !== 'out' && move.to < 4) {
      setBase(ctx, move.playerId, move.to)
      const old = before.find(item => item.playerId === move.playerId)!
      if (old.to !== move.to) {
        recordRunner(ctx, move, { reason: 'Back' })
        ctx.out.push({
          type: 'runnerReturned',
          runner: move.playerId,
          from: old.to,
          to: move.to
        })
      }
    }
  settle(ctx)
}

function baseRunning(ctx: Ctx, action: BaseRunningAction): void {
  if (ctx.state.pending != null)
    refuse('notNow', 'Finish the current play first')
  const from = baseIds(ctx.state).indexOf(action.runner) + 1
  if (from === 0) refuse('unknownPlayer', 'That runner is not on base')
  const next = Math.min(4, from + 1)
  const target = action.to == null ? next : destinationBase(action.to)
  // A steal, or a runner let go, is to a base ahead of him.
  if (
    target === from &&
    action.kind !== 'pickoff' &&
    action.kind !== 'pickoff_safe'
  )
    refuse('illegal', `That runner is already on ${DESTINATIONS[from]}`)
  const move = (
    to: number,
    out: boolean,
    reason: RunnerMovementAction['reason']
  ): void => {
    runnerMovement(ctx, {
      type: 'runnerMovement',
      runner: action.runner,
      to: (['batter', '1B', '2B', '3B', 'home'] as const)[to],
      out,
      reason,
      fielders: action.fielders
    })
  }
  if (action.kind === 'steal') move(target, false, 'Steal')
  else if (action.kind === 'caught_stealing')
    move(target, true, 'Caught Stealing')
  else if (action.kind === 'pickoff') move(from, true, 'Picked Off')
  else if (action.kind === 'pickoff_safe')
    move(from, false, 'Safe from Pickoff')
  else move(target, false, 'Defensive Indifference')
}

function batteryEvent(ctx: Ctx, action: BatteryEventAction): void {
  if (ctx.state.pending != null)
    refuse('notNow', 'Finish the current play first')
  const label =
    action.kind === 'balk'
      ? 'Balk'
      : action.kind === 'wild_pitch'
        ? 'Wild Pitch'
        : 'Passed Ball'
  const why = moreEligibility(ctx.state, label)
  if (why != null) refuse('illegal', why)
  if (action.kind !== 'balk') {
    const advances = action.advances ?? []
    if (advances.length === 0) refuse('malformed', 'Say where each runner went')
    const lead = [...advances].sort(
      (a, b) =>
        baseIds(ctx.state).indexOf(b.runner) -
        baseIds(ctx.state).indexOf(a.runner)
    )
    // One pitch the catcher did not hold is one event, however many runners
    // it moved: the lead runner's movement writes it, and the rest join it.
    const event = current(ctx).playEvents.length
    lead.forEach((advance, i) => {
      runnerMovement(
        ctx,
        {
          type: 'runnerMovement',
          runner: advance.runner,
          to: advance.to,
          reason: action.kind === 'wild_pitch' ? 'Wild Pitch' : 'Passed Ball'
        },
        i === 0 ? undefined : event
      )
    })
    return
  }
  ctx.state.recentPitch = null
  playAction(ctx, 'balk', 'Balk')
  const pending = newResolution(ctx, 'Balk', {
    automaticAward: true,
    sameAppearance: true
  })
  ctx.state.pending = pending
  baseIds(ctx.state).forEach((id, index) => {
    if (id != null)
      pending.movements.push({
        playerId: id,
        from: index + 1,
        to: index + 2,
        force: true,
        decision: 'safe',
        automaticHome: index === 2
      })
  })
  applyAwardMovements(ctx, 'Balk')
}

/** The runner a pinch runner runs for: the side at bat's man on the base. */
function pinchedFor(ctx: Ctx, action: LineupAction): number {
  if (action.base == null || action.player == null)
    refuse('malformed', 'Say who runs, and for the runner on which base')
  const runner = baseIds(ctx.state)[destinationBase(action.base) - 1]
  if (runner == null) refuse('illegal', `Nobody is on ${action.base}`)
  if (action.side !== battingSide(ctx.state))
    refuse('illegal', 'A pinch runner runs for the side at bat')
  return runner
}

function lineup(ctx: Ctx, action: LineupAction): void {
  const state = ctx.state
  if (state.pending != null) refuse('notNow', 'Finish the current play first')
  if (action.kind === 'batterSide') {
    const side = action.batSide
    const play = state.liveData.plays.currentPlay
    if (side == null || play == null || !canSwitchBatter(state))
      refuse(
        'notNow',
        'The batter can change sides only before the first pitch'
      )
    play.matchup.batSide.code = side
    play.source.gamestation.lineupChanged = true
    return
  }
  const setup = action.setup ?? setupOf(state)
  // Who took whose place in the order: a substitute bats when his man was due.
  const replaced: Record<number, number> = {}
  if (action.setup == null) {
    const sideName = action.side
    if (sideName == null) refuse('malformed', 'Say which team')
    const team = setup.sides[sideName]
    if (action.kind === 'battingOrder') {
      if (action.order == null) refuse('malformed', 'Give the whole order')
      team.battingOrder = [...action.order]
    } else if (action.kind === 'addPlayer') {
      addPlayer(
        {
          gameData: { teams: state.gameData.teams, players: setup.players },
          liveData: { boxscore: { teams: setup.sides } },
          meta: { identities: setup.identities }
        },
        sideName,
        action.name ?? 'New Player',
        action.jersey ?? ''
      )
    } else if (action.kind === 'position') {
      if (action.position == null || action.player == null)
        refuse('malformed', 'Give a position and a player')
      for (const [position, id] of Object.entries(team.defense))
        if (id === action.player)
          team.defense[position as keyof typeof team.defense] = null
      team.defense[action.position] = action.player
    } else if (action.kind === 'substitute' || action.kind === 'pinchRunner') {
      const incoming = action.player
      const leaving =
        action.kind === 'substitute' ? action.replaces : pinchedFor(ctx, action)
      if (incoming == null || leaving == null)
        refuse('malformed', 'Say who comes in and who leaves')
      if (!team.players.includes(incoming)) team.players.push(incoming)
      team.battingOrder = team.battingOrder.map(id =>
        id === leaving ? incoming : id
      )
      for (const [position, id] of Object.entries(team.defense))
        if (id === leaving)
          team.defense[position as keyof typeof team.defense] = incoming
      replaced[leaving] = incoming
    } else refuse('malformed', 'A roster change carries its setup')
  }
  const applied = applyRoster(state, setup, action.nextBatter, replaced)
  if (applied.state == null)
    refuse('illegal', applied.error ?? 'Invalid lineup')
  ctx.state = applied.state
  // A pinch runner takes the charges of the man he runs for (9.16).
  const was = baseIds(state)
  baseIds(ctx.state).forEach((id, index) => {
    const runner = was[index]
    if (id == null || runner == null || id === runner) return
    ctx.charges.set(id, chargeOf(state, ctx.charges, runner))
    ctx.charges.delete(runner)
  })
  const play = ctx.state.liveData.plays.currentPlay
  if (play != null) {
    play.source.gamestation.lineupChanged = true
    for (const change of lineupChanges(state, ctx.state, applied.takers))
      play.playEvents.push(
        withoutUndefined({
          index: play.playEvents.length,
          isPitch: false,
          type: 'action',
          details: {
            description: change.description,
            code: change.eventType,
            fromPosition: change.fromPosition
          },
          isSubstitution: true,
          position: change.position,
          battingOrder: change.battingOrder,
          replacedPlayer: change.replacedPlayer,
          moved: change.moved,
          count: count(ctx),
          player: change.player
        })
      )
  }
  ctx.out.push({
    type: 'batterChanged',
    batter: ctx.state.liveData.linescore.offense.batter?.id ?? null
  })
}

function gameFlow(ctx: Ctx, action: GameFlowAction): void {
  const state = ctx.state
  if (action.kind === 'closePlay') {
    if (nextDecision(state) !== 'close')
      refuse('notNow', 'The play is not decided yet')
    closePlay(ctx)
    return
  }
  if (state.pending != null) refuse('notNow', 'Finish the current play first')
  if (action.kind === 'endHalf') {
    nextHalf(ctx)
    return
  }
  if (action.kind === 'endGame') {
    // The play has begun with a pitch or any action but a substitution, and
    // a runner who moved or a lineup changed during it holds it open too.
    const play = state.liveData.plays.currentPlay
    if (
      play != null &&
      (play.playEvents.some(event => event.isSubstitution !== true) ||
        play.runners.length > 0 ||
        play.source.gamestation.lineupChanged === true)
    )
      refuse('notNow', 'Finish the at-bat first')
    state.final = true
    ctx.out.push({ type: 'gameEnded' })
    return
  }
  if (action.kind === 'placeRunner') {
    const play = current(ctx)
    const base = action.base == null ? 0 : destinationBase(action.base)
    const occupied = baseIds(state)
    const runner = action.runner
    if (
      base === 0 ||
      runner == null ||
      occupied[base - 1] != null ||
      runner === play.matchup.batter.id ||
      occupied.includes(runner) ||
      !state.liveData.boxscore.teams[battingSide(state)].players.includes(
        runner
      )
    )
      refuse(
        'illegal',
        'Place a batting-team player who is not batting on an empty base'
      )
    state.recentPitch = null
    // It names the runner placed, as a runner's own actions do.
    playAction(
      ctx,
      'placed_runner',
      'Place a Runner (Tiebreaker)',
      playerRef(state, runner)
    )
    line(ctx).offense[BASE_KEYS[base - 1]] = playerRef(state, runner)
    // The extra-innings runner is taken to have reached on an error, and is
    // charged to the pitcher who began the half.
    ctx.charges.set(runner, {
      pitcher: halfPitcher(state),
      reachedOnError: true
    })
    const movement: Movement = {
      playerId: runner,
      from: 0,
      to: base,
      force: false,
      decision: 'safe'
    }
    recordRunner(ctx, movement, {
      reason: 'Place a Runner (Tiebreaker)',
      playIndex: play.playEvents.length - 1
    })
    moved(ctx, movement)
    return
  }
  const bases = action.bases ?? []
  const applied = applyOverride(state, {
    inning: action.inning ?? line(ctx).currentInning,
    top: action.top ?? line(ctx).isTopInning,
    awayScore: action.awayScore ?? line(ctx).teams.away.runs,
    homeScore: action.homeScore ?? line(ctx).teams.home.runs,
    balls: action.balls ?? line(ctx).balls,
    strikes: action.strikes ?? line(ctx).strikes,
    outs: action.outs ?? line(ctx).outs,
    batter: action.batter ?? line(ctx).offense.batter?.id ?? null,
    pitcher: action.pitcher ?? line(ctx).defense.P?.id ?? null,
    bases: [bases[0] ?? null, bases[1] ?? null, bases[2] ?? null]
  })
  if (applied.state == null)
    refuse('illegal', applied.error ?? 'Invalid game state')
  ctx.state = applied.state
  const before = state.liveData.linescore
  outsCorrected(ctx.state, {
    inning: before.currentInning,
    top: before.isTopInning,
    outs: before.outs
  })
  // Runners put on base in a new half are charged to its pitcher.
  if (line(ctx).errorlessOuts == null) ctx.charges.clear()
  ctx.out.push({
    type: 'batterChanged',
    batter: ctx.state.liveData.linescore.offense.batter?.id ?? null
  })
}

const HANDLERS: {
  [K in ScoringAction['type']]: (
    ctx: Ctx,
    action: Extract<ScoringAction, { type: K }>
  ) => void
} = {
  pitch,
  ballInPlay,
  result,
  fieldingPlay,
  runnerMovement,
  baseRunning,
  batteryEvent,
  lineup,
  gameFlow
}

/** Actions a decided play closes itself for, rather than refusing. */
const CLOSES_FIRST = new Set<ScoringAction['type']>([
  'pitch',
  'ballInPlay',
  'result',
  'baseRunning',
  'batteryEvent',
  'lineup'
])

export function applyAction(state: GameState, raw: ScoringAction): Applied {
  const cleaned = cleanAction(raw)
  const unchanged = (problem: Problem): Applied => ({
    state,
    transitions: [],
    play: state.liveData.plays.currentPlay,
    problems: [problem]
  })
  if ('problem' in cleaned) return unchanged(cleaned.problem)
  const action = cleaned.action
  if (state.final)
    return unchanged({ code: 'gameOver', message: 'The game is over' })
  const copy = copyState(state)
  const ctx: Ctx = { state: copy, out: [], charges: chargeBook(copy) }
  const mound = copy.liveData.linescore.defense.P
  errorlessOuts(copy)
  const played = state.liveData.plays.allPlays.length
  try {
    if (
      (CLOSES_FIRST.has(action.type) ||
        (action.type === 'gameFlow' && action.kind !== 'closePlay')) &&
      nextDecision(ctx.state) === 'close'
    )
      closePlay(ctx)
    if (
      ctx.state.awaitingBatter != null &&
      action.type !== 'lineup' &&
      action.type !== 'gameFlow'
    )
      refuse('notNow', 'The batter due is on base: change the lineup first')
    ;(HANDLERS[action.type] as (ctx: Ctx, action: ScoringAction) => void)(
      ctx,
      action
    )
    settle(ctx)
    keepCharges(ctx.state, ctx.charges, mound)
    // Until its first pitch or action, a play begins with the lineups as
    // they stand.
    const open = ctx.state.liveData.plays.currentPlay
    if (
      open?.lineups != null &&
      open.playEvents.every(event => event.isSubstitution === true)
    )
      open.lineups.began = lineupsOf(ctx.state)
  } catch (error) {
    if (error instanceof Refused) return unchanged(error.problem)
    return unchanged({
      code: 'illegal',
      message: error instanceof Error ? error.message : String(error)
    })
  }
  ctx.state.meta.sequence++
  const plays = ctx.state.liveData.plays.allPlays
  return {
    state: ctx.state,
    transitions: ctx.out,
    play:
      plays.length > played
        ? plays[plays.length - 1]
        : ctx.state.liveData.plays.currentPlay,
    problems: []
  }
}

/** Applies each action in turn; the first refused one stops the rest. */
export function applyActions(
  state: GameState,
  actions: readonly ScoringAction[]
): Applied {
  let applied: Applied = {
    state,
    transitions: [],
    play: state.liveData.plays.currentPlay,
    problems: []
  }
  for (const action of actions) {
    const next = applyAction(applied.state, action)
    applied = {
      state: next.state,
      transitions: [...applied.transitions, ...next.transitions],
      play: next.play,
      problems: next.problems
    }
    if (next.problems.length > 0) break
  }
  return applied
}
