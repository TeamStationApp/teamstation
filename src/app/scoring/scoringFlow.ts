import {
  type Destination,
  DESTINATIONS,
  type Problem,
  type RunnerMovementAction,
  type RunnerReason,
  type ScoringAction
} from '../../common/scoring/actions'
import { revealedSides } from '../../common/scoring/lineupHistory'
import {
  closesAutomatically,
  completesHitOffer,
  forcedFrom,
  hasEligiblePitch,
  homeBackProposal,
  nextDecision,
  previousRunnerError,
  runnerDecisionError as gameRunnerError,
  runnerReasons as gameRunnerReasons
} from '../../common/scoring/rules'
import { type Applied, applyAction } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { BASES } from '../field/fieldModel'
import { advanceReel, holdForLaterBeat } from './dictatedReel'
import {
  closePlay,
  copyGame,
  copyState,
  snapshotOf,
  withStep
} from './scoringMachine'
import { approachFirst, basePath, enqueue, sequencesFor } from './scoringMotion'
import { throwPresentation, type ThrowSequence } from './scoringPresentation'
import { baseIds, battingSide } from './scoringSelectors'
import {
  CORRECTION_WINDOW_MS,
  type ScoringEvent,
  type ScoringSnapshot,
  type ScoringState
} from './scoringTypes'

/**
 * The screen's side of a play: which step the scorer is on, the throws being
 * drawn, the runner being dragged, and the animations. Every change to the
 * game is an action applied by the scoring library through `act`; nothing
 * here decides baseball.
 */

/** An action the game refused. The screen keeps the state it had. */
export class Refused extends Error {
  constructor(readonly problems: Problem[]) {
    super(problems[0]?.message ?? 'Refused')
  }
}

/**
 * Applies one action to the screen's copy of the game, records it in the log,
 * and turns what it did into motions. A play the game closed leaves the
 * screen's drawing of it behind; its runners finish moving on their own.
 */
/**
 * Logs the lineup on the screen when a side still unseen in the log is no
 * longer that roster order. The first play then scores that lineup, and so
 * does the game the play is saved into. Opening the screen logs nothing.
 * `shown` marks the snapshot as the screen's. A rebase lets it replace
 * only a side that is still the unseen roster order.
 */
function recordSeenLineup(next: ScoringSnapshot): void {
  const setup = setupOf(next.session)
  const confirmed = revealedSides(next.log, setup)
  if (confirmed.length === 0) return
  applyLogged(next, {
    type: 'lineup',
    kind: 'roster',
    setup,
    confirmed,
    shown: true
  })
}

function applyLogged(
  next: ScoringSnapshot,
  action: ScoringAction,
  options: { requireCurrentSetup?: boolean; replay?: boolean } = {}
): Applied {
  const before = next.session
  // On a copy that shares the finished plays (`copyGame`): `applyAction`'s
  // own copy is of the whole game, a stall that grew with it.
  const applied = applyAction(copyGame(before), action, {
    inPlace: true,
    requireCurrentSetup: options.requireCurrentSetup ?? true,
    replay: options.replay === true
  })
  if (applied.problems.length > 0) throw new Refused(applied.problems)
  next.session = applied.state
  next.log = [...next.log, action]
  sequencesFor(next, applied.transitions, {
    homeQueue: before.homeQueue,
    batSide: before.liveData.plays.currentPlay?.matchup.batSide.code ?? 'R',
    battingSide: battingSide(before)
  })
  if (applied.transitions.some(t => t.type === 'playClosed')) {
    next.pendingPlay = null
    next.runnerAction = null
    next.correctionWindow = null
  }
  if (applied.transitions.some(t => t.type === 'halfEnded'))
    next.celebration = null
  if (next.session.pending != null && next.pendingPlay == null)
    next.pendingPlay = {
      outcome: next.session.pending.outcome,
      trajectoryAccepted: true
    }
  return applied
}

export function act(
  next: ScoringSnapshot,
  action: ScoringAction,
  options: { requireCurrentSetup?: boolean; replay?: boolean } = {}
): Applied {
  if (next.readOnly === true)
    throw new Refused([{ code: 'notNow', message: 'Scoring is read-only' }])
  // A roster save names its own confirmation. Any other play first records
  // a lineup the screen is already showing in place of an unseen roster order.
  // Stored actions replayed without the current setup (a replay) already
  // hold every lineup their scorer recorded.
  if (
    options.requireCurrentSetup !== false &&
    (action.type !== 'lineup' || action.kind !== 'roster')
  )
    recordSeenLineup(next)
  return applyLogged(next, action, options)
}

export function destination(base: number): Destination {
  return DESTINATIONS[Math.max(0, Math.min(4, base))]
}

const DRAFTING = [
  'chooseThrower',
  'chooseDefender',
  'runnerDecision',
  'runnerReason',
  'errorCredit'
]

/** The step the screen is on once everything has moved. */
export function settleRunners(state: ScoringState): void {
  if (DRAFTING.includes(state.phase)) return
  // A replay watches the game: it asks nothing and decides nothing, so the
  // scorer's own saved actions are all that move it.
  if (state.watching === true) {
    const moving =
      (state.reel?.length ?? 0) > 0 ||
      state.presentation != null ||
      state.motions.some(motion => !motion.complete)
    state.phase = moving ? 'runnerMovement' : 'ready'
    state.runnerAction = null
    state.correctionWindow = null
    return
  }
  // A dictated sentence is still being shown.
  if ((state.reel?.length ?? 0) > 0) {
    state.phase = 'runnerMovement'
    return
  }
  const pending = state.pendingPlay
  if (pending != null && !pending.trajectoryAccepted) {
    state.phase = 'trajectory'
    return
  }
  const game = state.session
  const decision = nextDecision(game)
  const moving = state.motions.some(motion => !motion.complete)
  if (decision === 'resolveBatter') {
    if (game.pending?.outcome === "Fielder's Choice") {
      if (pending?.fieldersChoice != null) {
        state.phase = moving ? 'runnerMovement' : 'fieldersChoice'
        return
      }
      const batter = game.pending.movements.find(move => move.from === 0)
      const subject =
        batter?.decision === 'out'
          ? game.pending.movements.find(
              move => move.decision === 'pending' && move.to < 4
            )!
          : batter!
      state.runnerAction = {
        purpose: 'fieldersChoice',
        playerId: subject.playerId,
        from: subject.from,
        to: Math.min(4, subject.from + 1),
        origin: 'current',
        returnPhase: 'fieldersChoice'
      }
      beginDefense(state)
      return
    }
    // A dropped third strike asks only whether the batter made first.
    if (game.pending?.outcome === 'Dropped Third Strike') {
      if (moving) {
        state.phase = 'runnerMovement'
        return
      }
      state.runnerAction = {
        purpose: 'droppedThirdStrike',
        playerId: game.liveData.plays.currentPlay!.matchup.batter.id,
        from: 0,
        to: 1,
        origin: 'current',
        returnPhase: 'correctionWindow',
        reason: 'Dropped Third Strike',
        runnerPoint: { ...BASES[1] }
      }
      state.phase = 'runnerDecision'
      return
    }
    state.phase = 'resolveBatter'
    return
  }
  if (decision === 'errorAttribution') {
    if (state.presentation != null || moving) {
      state.phase = 'runnerMovement'
      return
    }
    state.runnerAction = {
      purpose: 'errorAttribution',
      playerId: game.liveData.plays.currentPlay!.matchup.batter.id,
      from: 0,
      to: 1,
      origin: 'current',
      returnPhase: 'runnerMovement'
    }
    beginDefense(state)
    return
  }
  if (decision === 'batterOut') {
    const outcome = game.pending!.outcome
    state.runnerAction = {
      purpose:
        outcome === 'Batter Out — Other' ? undefined : 'batterRetirement',
      playerId: game.liveData.plays.currentPlay!.matchup.batter.id,
      from: 0,
      to: outcome === 'Batter Out — Other' ? 0 : 1,
      origin: 'current',
      returnPhase: 'correctionWindow',
      decision: 'out',
      reason: outcome,
      thrower: outcome === 'Batter Out — Other' ? undefined : pending?.fielder
    }
    if (outcome === 'Batter Out — Other') state.phase = 'chooseThrower'
    else beginDefense(state)
    return
  }
  if (decision === 'homeDecision') {
    // Wait for every unfinished motion (lead to home and trailer retreat /
    // re-advance), not only the lead — home Safe/Out must not fire mid-drag.
    if (moving) {
      state.phase = 'runnerMovement'
      return
    }
    state.runnerAction = null
    state.phase = 'homeDecision'
    return
  }
  if (moving) {
    state.phase = 'runnerMovement'
    return
  }
  if (game.pending?.automaticAward === true && state.presentation != null) {
    state.phase = 'runnerMovement'
    return
  }
  state.runnerAction = null
  if (decision === 'close') {
    state.phase = 'correctionWindow'
    state.correctionWindow ??= {
      remainingMs: CORRECTION_WINDOW_MS,
      revision: game.meta.sequence
    }
    // Nothing a scorer would correct: an award, empty bases, the third out.
    if (state.presentation == null && closesAutomatically(game))
      Object.assign(state, closePlay(state))
    return
  }
  state.pendingPlay = null
  state.correctionWindow = null
  state.phase = decision === 'awaitingBatter' ? 'awaitingBatter' : 'ready'
  // The runners (including a dictated reel) have finished; show the next at-bat.
  state.celebration = null
}

/** The throw starts from whoever holds the ball, or the scorer picks him. */
export function beginDefense(state: ScoringState): void {
  const action = state.runnerAction!
  const pending = state.pendingPlay
  const holder = pending?.ballHolder ?? pending?.fielder
  const point = pending?.ballLocation ?? pending?.location
  if (action.origin === 'current' && holder != null && point != null) {
    action.thrower = holder
    action.throwerPoint = { ...point }
    action.defensiveRoute = [{ id: holder, point: { ...point } }]
    state.phase = 'chooseDefender'
  } else state.phase = 'chooseThrower'
}

/**
 * During the relay that retires the batter, a forced runner the throw beat to
 * the next base is out there: the fielder holding the ball puts him out, with
 * the relay so far behind him. The relay then goes on for the batter from that
 * fielder, so a 6-4-3 records the lead runner first and the batter second.
 */
export function forceOutInRelay(
  state: ScoringState,
  runner: number,
  to: number,
  decision: 'safe' | 'out',
  generation: number
): ScoringState {
  const action = state.runnerAction
  const route = action?.defensiveRoute ?? []
  const game = state.session
  const offense = game.liveData.linescore.offense
  const from =
    [offense.first?.id, offense.second?.id, offense.third?.id].indexOf(runner) +
    1
  if (
    state.phase !== 'chooseDefender' ||
    action?.purpose !== 'batterRetirement' ||
    state.presentation != null ||
    decision !== 'out' ||
    generation !== state.generation ||
    route.length === 0 ||
    from === 0 ||
    to !== from + 1 ||
    !forcedFrom(game, from)
  )
    return state
  return accepted(
    state,
    `Force out ${game.gameData.players[runner].fullName}`,
    next => {
      act(next, {
        type: 'runnerMovement',
        runner,
        to: destination(to),
        out: true,
        reason: 'Force Out',
        fielders: route.map(hop => hop.id),
        locations: route.map(hop => ({ ...hop.point })),
        runnerLocation: { ...BASES[to % 4] }
      })
      const holder = route[route.length - 1]
      const relay = next.runnerAction!
      relay.thrower = holder.id
      relay.throwerPoint = { ...holder.point }
      relay.defensiveRoute = [{ id: holder.id, point: { ...holder.point } }]
      if (next.session.liveData.linescore.outs >= 3) {
        next.runnerAction = null
        next.phase = 'runnerMovement'
        settleRunners(next)
      }
    }
  )
}

/** A throw the screen drew has arrived: another hop, or the out. */
export function completeDefense(
  state: ScoringState,
  sequence: ThrowSequence
): void {
  if (sequence.safe === true) {
    settleRunners(state)
    return
  }
  const action = state.runnerAction!
  const point = { x: sequence.to.x, z: sequence.to.z }
  if (sequence.stage === 'transfer') {
    action.defensiveRoute ??= [
      { id: sequence.thrower, point: { ...sequence.holderOrigin } }
    ]
    action.defensiveRoute.push({ id: sequence.receiver, point })
    if (state.pendingPlay != null) {
      state.pendingPlay.ballHolder = sequence.receiver
      state.pendingPlay.ballLocation = { ...point }
      if (action.purpose === 'batterRetirement') {
        state.pendingPlay.batterPoint = { ...sequence.runnerFrom }
        approachFirst(state, action.playerId, sequence.runnerFrom, {
          x: BASES[1].x * 0.96,
          z: BASES[1].z * 0.96
        })
      }
    }
    state.phase = 'chooseDefender'
    return
  }
  action.defender = sequence.receiver
  action.defenderPoint = point
  action.runnerPoint = point
  const last = action.defensiveRoute?.at(-1)
  if (last != null) last.point = { ...point }
  if (state.pendingPlay != null) {
    state.pendingPlay.ballHolder = sequence.receiver
    state.pendingPlay.ballLocation = { ...point }
    if (action.purpose === 'batterRetirement')
      state.pendingPlay.batterPoint = { ...point }
  }
  finishOut(state, sequence.receiver)
}

/** The runner the scorer called out is out, by the fielders who handled it. */
export function finishOut(state: ScoringState, defender: number): void {
  const action = state.runnerAction!
  const route = action.defensiveRoute
  const fielders =
    route != null
      ? route.map(hop => hop.id)
      : action.thrower != null && action.thrower !== defender
        ? [action.thrower, defender]
        : [defender]
  act(state, {
    type: 'runnerMovement',
    runner: action.playerId,
    to: destination(action.to),
    out: true,
    // The batter of a dropped third strike is out for the outcome itself.
    ...(action.reason == null || action.purpose === 'droppedThirdStrike'
      ? {}
      : { reason: action.reason as RunnerReason }),
    fielders,
    ...(route == null
      ? {}
      : { locations: route.map(hop => ({ ...hop.point })) }),
    ...(action.runnerPoint == null
      ? {}
      : { runnerLocation: { ...action.runnerPoint } })
  })
  state.runnerAction = null
  state.phase = 'runnerMovement'
  settleRunners(state)
}

export function runnerReasons(state: ScoringState): readonly string[] {
  if (state.moreDraft != null) return [state.moreDraft.action]
  const action = state.runnerAction
  if (action == null) return gameRunnerReasons({ from: 0, to: 0 })
  return gameRunnerReasons(action)
}

export function runnerDecisionError(state: ScoringState): string | undefined {
  const action = state.runnerAction
  if (action == null) return
  return gameRunnerError(state.session, action)
}

function commitSafe(state: ScoringState): void {
  const action = state.runnerAction!
  let pickoff: ThrowSequence | undefined
  if (
    action.origin === 'between' &&
    action.from === action.to &&
    action.reason === 'Safe from Pickoff'
  ) {
    const defense = state.session.liveData.linescore.defense
    const pitcher = defense.P
    const receiver = defense[(['1B', '2B', '3B'] as const)[action.to - 1]]
    if (pitcher != null && receiver != null) {
      action.thrower = pitcher.id
      pickoff = {
        ...throwPresentation(state, receiver.id, BASES[action.to]),
        safe: true
      }
    }
  }
  const choice =
    action.returnPhase === 'resolveBatter' ||
    action.purpose === 'droppedThirdStrike'
  act(state, {
    type: 'runnerMovement',
    runner: action.playerId,
    to: destination(action.to),
    ...(pickoff == null
      ? {}
      : {
          fielders: [pickoff.thrower, pickoff.receiver],
          locations: [pickoff.holderOrigin, BASES[action.to]]
        }),
    ...(action.error == null ? {} : { error: action.error }),
    ...(action.errorEvent == null ? {} : { errorEvent: action.errorEvent }),
    ...(choice || action.reason == null
      ? {}
      : { reason: action.reason as RunnerReason })
  })
  state.runnerAction = null
  state.phase = 'runnerMovement'
  settleRunners(state)
  if (pickoff != null && state.presentationEnabled === true)
    state.presentation = pickoff
}

function validDefender(
  state: ScoringState,
  id: number | undefined
): id is number {
  return (
    id != null &&
    Object.values(state.session.liveData.linescore.defense).some(
      player => player?.id === id
    )
  )
}

/**
 * Accepts a step the scorer took, recording it for Undo. A step the game
 * refuses leaves everything as it was.
 */
export function accepted(
  state: ScoringState,
  label: string,
  edit: (next: ScoringState) => void
): ScoringState {
  const next: ScoringState = { ...snapshotOf(state), ...withStep(state, label) }
  next.celebration = null
  // A scorer who scores something else has moved on from a question.
  delete next.dictationQuestion
  try {
    edit(next)
  } catch (error) {
    if (error instanceof Refused) return state
    throw error
  }
  if (next.correctionWindow != null)
    next.correctionWindow = {
      remainingMs: CORRECTION_WINDOW_MS,
      revision: next.correctionWindow.revision + 1
    }
  return next
}

/** A saved Safe batter advance survives reopening the choice. */
function choiceBatterDestination(state: ScoringState): number | undefined {
  const batter = state.session.pending?.movements.find(move => move.from === 0)
  if (batter?.decision === 'out') return
  return Math.max(1, batter?.decision === 'safe' ? batter.to : 1)
}

/** Commit the collected calls in play order, keeping original-base force rules. */
function commitFieldersChoice(state: ScoringState): void {
  const choice = state.pendingPlay!.fieldersChoice!
  const batter = state.session.liveData.plays.currentPlay!.matchup.batter.id
  const batterTo = choiceBatterDestination(state)
  delete state.pendingPlay!.fieldersChoice
  state.motions = []
  const moveRunner = (action: RunnerMovementAction): void => {
    act(state, { ...action, fieldingRoute: copyState(choice.route) })
  }
  if (batterTo != null)
    moveRunner({
      type: 'runnerMovement',
      runner: batter,
      to: destination(batterTo),
      fielders: choice.route.map(hop => hop.id),
      locations: choice.route.map(hop => ({ ...hop.point }))
    })
  // A saved pending destination can block a leading Safe advance. Draft
  // legal calls first, then retry after another runner moves or retires.
  const draftSafes = (): void => {
    for (const move of [...choice.runners].sort((a, b) => b.from - a.from))
      if (
        move.decision === 'safe' &&
        state.session.pending?.choiceApplied !== true &&
        gameRunnerError(state.session, move) == null
      )
        moveRunner({
          type: 'runnerMovement',
          runner: move.playerId,
          to: destination(move.to)
        })
  }
  draftSafes()
  const homes = choice.runners
    .filter(move => move.to === 4 && move.decision === 'safe')
    .sort((a, b) => b.from - a.from)
  if (batterTo === 4)
    homes.push({ playerId: batter, from: 0, to: 4, decision: 'safe' })
  const scoreHome = (through = choice.calls.length): void => {
    for (const home of homes)
      if (
        choice.calls.indexOf(home.playerId) <= through &&
        (state.session.homeQueue.includes(home.playerId) ||
          (state.session.homeQueue.length === 0 &&
            baseIds(state.session).includes(home.playerId)))
      )
        moveRunner({
          type: 'runnerMovement',
          runner: home.playerId,
          to: 'home'
        })
  }
  let routeStart = 0
  for (const id of choice.calls) {
    if (state.session.liveData.linescore.outs >= 3) break
    const move = choice.runners.find(move => move.playerId === id)!
    // Settle legal interim positions before recording home crossings. A
    // runner still forced home must join the queue, even if his Out is later.
    if (homes.length > 0 && state.session.pending?.choiceApplied !== true)
      for (const waiting of state.session.pending!.movements) {
        const out = choice.runners.find(
          runner =>
            runner.playerId === waiting.playerId && runner.decision === 'out'
        )
        if (
          waiting.decision === 'pending' &&
          waiting.from > 0 &&
          out != null &&
          !(
            out.to < 4 &&
            out.to === waiting.from + 1 &&
            forcedFrom(state.session, waiting.from)
          )
        ) {
          let to =
            out.to === waiting.from + 1 &&
            forcedFrom(state.session, waiting.from)
              ? out.to
              : waiting.from
          while (
            to <= out.to &&
            gameRunnerError(state.session, {
              playerId: waiting.playerId,
              from: waiting.from,
              to
            }) != null
          )
            to++
          if (to > out.to) continue
          moveRunner({
            type: 'runnerMovement',
            runner: waiting.playerId,
            to: destination(to)
          })
        }
      }
    draftSafes()
    if (state.session.pending?.choiceApplied === true)
      scoreHome(choice.calls.indexOf(id))
    if (move.decision !== 'out') continue
    const point = BASES[move.to % 4]
    const routeEnd = move.putout!
    const route = choice.route.slice(routeStart, routeEnd + 1)
    routeStart = routeEnd
    moveRunner({
      type: 'runnerMovement',
      runner: id,
      to: destination(move.to),
      out: true,
      fielders: route.map(hop => hop.id),
      locations: route.map(hop => ({ ...hop.point })),
      runnerLocation: { ...point }
    })
  }
  if (state.session.liveData.linescore.outs < 3) {
    scoreHome()
    for (const move of [...choice.runners].sort((a, b) => b.from - a.from))
      if (
        move.decision === 'safe' &&
        move.to < 4 &&
        baseIds(state.session)[move.to - 1] !== move.playerId
      )
        moveRunner({
          type: 'runnerMovement',
          runner: move.playerId,
          to: destination(move.to)
        })
  }
  // Every offered advance already finished. Only scoring/out motions remain.
  for (const motion of state.motions) {
    const move = choice.runners.find(move => move.playerId === motion.playerId)
    if (move != null || (motion.playerId === batter && batterTo != null))
      motion.waypoints[0] = { ...BASES[(move?.to ?? batterTo!) % 4] }
  }
  state.phase = 'runnerMovement'
  settleRunners(state)
}

/** Passed-ball confirmation belongs to this batter, never the preceding one. */
export function hasCurrentRunnerPitch(state: ScoringState): boolean {
  return (
    hasEligiblePitch(state.session) &&
    state.session.recentPitch?.atBatIndex ===
      state.session.liveData.plays.currentPlay?.about.atBatIndex
  )
}

export function runnerReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState | undefined {
  if (event.type === 'CHOICE_CANCEL') {
    if (
      state.phase !== 'fieldersChoice' ||
      state.readOnly === true ||
      event.generation !== state.generation ||
      state.pendingPlay?.fieldersChoice?.choosingPutout == null
    )
      return state
    return accepted(state, 'Cancel putout choice', next => {
      delete next.pendingPlay!.fieldersChoice!.choosingPutout
    })
  }
  if (event.type === 'CHOICE_DECIDE') {
    const draft = state.pendingPlay?.fieldersChoice
    const runner = draft?.runners.find(move => move.playerId === event.id)
    if (
      state.phase !== 'fieldersChoice' ||
      state.readOnly === true ||
      state.presentation != null ||
      state.motions.some(motion => !motion.complete) ||
      event.generation !== state.generation ||
      runner == null ||
      runner.decision != null ||
      (draft!.choosingPutout != null && draft!.choosingPutout !== event.id) ||
      (event.decision === 'safe' && event.putout != null)
    )
      return state
    const previousPutout = Math.max(
      0,
      ...draft!.runners.map(move => move.putout ?? 0)
    )
    const putout = event.putout ?? (draft!.route.length === 1 ? 0 : undefined)
    if (event.decision === 'out') {
      if (putout == null) {
        if (draft!.choosingPutout === event.id) return state
        return accepted(state, 'Choose who made the out', next => {
          next.pendingPlay!.fieldersChoice!.choosingPutout = event.id
        })
      }
      if (
        !Number.isInteger(putout) ||
        putout < previousPutout ||
        putout >= draft!.route.length
      )
        return state
    }
    return accepted(
      state,
      `${event.decision === 'safe' ? 'Safe' : 'Out'} ${state.session.gameData.players[event.id].fullName}`,
      next => {
        const choice = next.pendingPlay!.fieldersChoice!
        const move = choice.runners.find(move => move.playerId === event.id)!
        move.decision = event.decision
        if (event.decision === 'out') move.putout = putout
        delete choice.choosingPutout
        choice.calls.push(event.id)
        if (choice.runners.some(move => move.decision == null)) return
        commitFieldersChoice(next)
      }
    )
  }
  if (event.type === 'ERROR_CANCEL')
    return state.phase === 'errorCredit'
      ? { ...state, phase: 'chooseDefender' }
      : state
  if (event.type === 'ERROR_CREDIT') {
    const route = state.runnerAction?.defensiveRoute ?? []
    if (
      state.phase !== 'errorCredit' ||
      state.session.pending?.errorPending !== true ||
      event.generation !== state.generation ||
      !route.some(hop => hop.id === event.id)
    )
      return state
    return accepted(
      state,
      `Error by ${state.session.gameData.players[event.id].fullName}`,
      next => {
        act(next, {
          type: 'fieldingPlay',
          fielders: route.map(hop => hop.id),
          error: event.id,
          locations: route.map(hop => ({ ...hop.point }))
        })
        next.runnerAction = null
        next.phase = 'runnerMovement'
        settleRunners(next)
      }
    )
  }
  if (event.type === 'MOTION_DONE') {
    const command = state.motions.find(
      motion => motion.id === event.id && motion.generation === event.generation
    )
    if (
      event.generation !== state.generation ||
      command == null ||
      command.complete
    )
      return state
    const next = {
      ...snapshotOf(state),
      past: state.past,
      checkpoints: state.checkpoints
    }
    const done = next.motions.find(motion => motion.id === event.id)!
    done.complete = true
    holdForLaterBeat(next, done)
    if (command.purpose === 'approachFirst' && next.pendingPlay != null)
      next.pendingPlay.batterPoint = {
        ...command.waypoints[command.waypoints.length - 1]
      }
    advanceReel(next)
    settleRunners(next)
    return next
  }
  if (event.type === 'CANCEL_RUNNER') {
    if (
      state.runnerAction == null ||
      state.runnerAction.purpose === 'droppedThirdStrike' ||
      !['runnerDecision', 'runnerReason'].includes(state.phase)
    )
      return state
    return {
      ...state,
      phase: state.runnerAction.returnPhase,
      runnerAction: null
    }
  }
  if (event.type === 'RUNNER_PROPOSE') {
    if (
      state.runnerAction?.purpose === 'droppedThirdStrike' ||
      state.motions.some(motion => !motion.complete) ||
      !Number.isInteger(event.to) ||
      event.to < 0 ||
      event.to > 4
    )
      return state
    const bases = [
      state.session.liveData.linescore.offense.first?.id ?? null,
      state.session.liveData.linescore.offense.second?.id ?? null,
      state.session.liveData.linescore.offense.third?.id ?? null
    ]
    const from = bases.indexOf(event.id) + 1
    const batter = state.session.liveData.plays.currentPlay?.matchup.batter.id
    // homeDecision may propose only a hit-offer re-take (Out after retreat).
    const homeRetake =
      state.phase === 'homeDecision' &&
      completesHitOffer(state.session, event.id, from, event.to)
    if (
      ![
        'ready',
        'correctionWindow',
        'resolveBatter',
        'runnerDecision'
      ].includes(state.phase) &&
      !homeRetake
    )
      return state
    if (
      from === 0 &&
      !(
        (state.phase === 'resolveBatter' ||
          state.runnerAction?.returnPhase === 'resolveBatter') &&
        event.id === batter
      )
    )
      return state
    if (event.to < from) return state
    const action = {
      playerId: event.id,
      from,
      to: event.to,
      origin:
        state.session.pending == null
          ? ('between' as const)
          : ('current' as const),
      returnPhase: state.runnerAction?.returnPhase ?? state.phase
    }
    return { ...state, phase: 'runnerDecision', runnerAction: action }
  }
  if (event.type === 'RUNNER_DECIDE') {
    const action = state.runnerAction
    if (
      state.phase !== 'runnerDecision' ||
      action == null ||
      (event.decision === 'safe' && action.to === 0)
    )
      return state
    if (event.decision === 'safe' && runnerDecisionError(state) != null)
      return state
    return accepted(
      state,
      `${event.decision === 'safe' ? 'Safe' : 'Out'} ${state.session.gameData.players[action.playerId].fullName}`,
      next => {
        next.runnerAction!.decision = event.decision
        if (
          action.origin === 'between' &&
          !(event.decision === 'safe' && action.from === action.to)
        )
          next.phase = 'runnerReason'
        else if (event.decision === 'out') beginDefense(next)
        else {
          next.runnerAction!.reason =
            action.from === action.to ? 'Safe from Pickoff' : 'Advance'
          commitSafe(next)
        }
      }
    )
  }
  if (event.type === 'RUNNER_REASON') {
    if (
      state.phase !== 'runnerReason' ||
      !runnerReasons(state).includes(event.reason)
    )
      return state
    return accepted(state, event.reason, next => {
      next.runnerAction!.reason = event.reason
      if (next.runnerAction!.decision === 'out') beginDefense(next)
      else if (['Throwing Error', 'Fielding Error'].includes(event.reason))
        next.phase = 'runnerError'
      else if (['Wild Pitch', 'Passed Ball'].includes(event.reason))
        next.phase =
          event.reason === 'Passed Ball' && !hasCurrentRunnerPitch(next)
            ? 'runnerPitchType'
            : 'runnerPitch'
      else commitSafe(next)
    })
  }
  if (event.type === 'RUNNER_ERROR') {
    if (
      state.phase !== 'runnerError' ||
      event.generation !== state.generation ||
      !validDefender(state, event.id)
    )
      return state
    return accepted(state, state.runnerAction!.reason!, next => {
      next.runnerAction!.error = event.id
      if (
        previousRunnerError(
          next.session,
          next.runnerAction!.reason,
          event.id
        ) != null
      )
        next.phase = 'runnerErrorReuse'
      else commitSafe(next)
    })
  }
  if (event.type === 'RUNNER_ERROR_REUSE') {
    if (state.phase !== 'runnerErrorReuse' || state.runnerAction == null)
      return state
    const prior = previousRunnerError(
      state.session,
      state.runnerAction.reason,
      state.runnerAction.error
    )
    if (event.reuse && prior == null) return state
    return accepted(state, state.runnerAction.reason!, next => {
      if (event.reuse) next.runnerAction!.errorEvent = prior
      commitSafe(next)
    })
  }
  if (event.type === 'RUNNER_PITCH_NEW') {
    if (
      state.phase !== 'runnerPitch' ||
      state.runnerAction?.reason !== 'Passed Ball' ||
      state.session.pending != null
    )
      return state
    return { ...state, phase: 'runnerPitchType' }
  }
  if (event.type === 'RUNNER_PITCH' || event.type === 'RUNNER_PITCH_KIND') {
    const selecting = event.type === 'RUNNER_PITCH_KIND'
    const add = selecting || event.addBall
    const passed = state.runnerAction?.reason === 'Passed Ball'
    if (
      state.phase !== (selecting ? 'runnerPitchType' : 'runnerPitch') ||
      (selecting && !passed) ||
      (!add &&
        !(passed
          ? hasCurrentRunnerPitch(state)
          : hasEligiblePitch(state.session))) ||
      (add && state.session.pending != null) ||
      (!selecting && passed && event.addBall)
    )
      return state
    return accepted(state, state.runnerAction!.reason!, next => {
      const action = next.runnerAction!
      if (add)
        act(next, {
          type: 'pitch',
          call: selecting
            ? ({ ball: 'B', called: 'C', swing: 'S' } as const)[event.kind]
            : 'B'
        })
      // Ball four already advances forced runners. Keep that walk movement,
      // and charge a wild pitch/passed ball only for an additional advance.
      const awarded =
        next.session.pending?.movements.some(
          move =>
            move.playerId === action.playerId &&
            move.force &&
            move.to === action.to
        ) === true
      // A third strike that ends the inning cannot score the drafted advance.
      // Settle the pitch first, retaining its out and the atomic Undo snapshot.
      if (awarded || next.session.liveData.linescore.outs >= 3) {
        next.runnerAction = null
        next.phase = 'runnerMovement'
        settleRunners(next)
      } else commitSafe(next)
    })
  }
  if (event.type === 'THROWER') {
    if (
      state.phase !== 'chooseThrower' ||
      event.generation !== state.generation ||
      !validDefender(state, event.id) ||
      !Number.isFinite(event.point.x) ||
      !Number.isFinite(event.point.z)
    )
      return state
    return accepted(
      state,
      `Thrower ${state.session.gameData.players[event.id].fullName}`,
      next => {
        next.runnerAction!.thrower = event.id
        next.runnerAction!.throwerPoint = { ...event.point }
        next.runnerAction!.defensiveRoute = [
          { id: event.id, point: { ...event.point } }
        ]
        next.phase = 'chooseDefender'
      }
    )
  }
  if (event.type === 'DEFENDER') {
    const action = state.runnerAction
    const holder = action?.defensiveRoute?.at(-1)?.id ?? action?.thrower
    const id = event.id ?? holder
    if (
      state.phase !== 'chooseDefender' ||
      state.presentation != null ||
      event.generation !== state.generation ||
      !validDefender(state, id) ||
      !validDefender(state, holder) ||
      (event.id != null && event.id === holder) ||
      (event.point != null &&
        (!Number.isFinite(event.point.x) || !Number.isFinite(event.point.z))) ||
      (event.runnerPoint != null &&
        (!Number.isFinite(event.runnerPoint.x) ||
          !Number.isFinite(event.runnerPoint.z)))
    )
      return state
    if (event.id == null && action?.purpose === 'errorAttribution')
      return accepted(state, 'Choose error fielder', next => {
        next.phase = 'errorCredit'
      })
    if (event.id == null && action?.purpose === 'fieldersChoice')
      return accepted(state, 'Finish fielder’s choice defense', next => {
        const pending = next.pendingPlay!
        const batterTo = choiceBatterDestination(next)
        let required = batterTo == null ? 1 : Math.min(4, batterTo + 1)
        const runners = next.session.pending!.originalBases.flatMap(
          (id, index) => {
            const previous = next.session.pending!.movements.find(
              move => move.playerId === id
            )
            if (id == null || previous?.decision === 'out') return []
            const safe =
              previous?.decision === 'safe' && previous.to > previous.from
            const to = Math.min(
              4,
              Math.max(index + 2, required, safe ? previous.to : 0)
            )
            required = Math.min(4, to + 1)
            return [
              {
                playerId: id,
                from: index + 1,
                to,
                decision: safe ? ('safe' as const) : undefined
              }
            ]
          }
        )
        pending.fieldersChoice = {
          route: copyState(next.runnerAction!.defensiveRoute!),
          runners,
          calls: runners
            .filter(move => move.decision != null)
            .map(move => move.playerId)
        }
        for (const move of runners)
          enqueue(next, move.playerId, basePath(move.from, move.to))
        if (batterTo != null)
          enqueue(
            next,
            next.session.liveData.plays.currentPlay!.matchup.batter.id,
            basePath(0, batterTo)
          )
        next.runnerAction = null
        next.phase = 'runnerMovement'
        if (runners.every(move => move.decision != null))
          commitFieldersChoice(next)
        else settleRunners(next)
      })
    return accepted(
      state,
      event.id == null
        ? `Out by ${state.session.gameData.players[id].fullName}`
        : `Throw to ${state.session.gameData.players[id].fullName}`,
      next => {
        next.runnerAction!.runnerPoint =
          event.runnerPoint ?? next.runnerAction!.runnerPoint
        const sequence = throwPresentation(
          next,
          id,
          event.point,
          event.id == null
        )
        if (next.presentationEnabled === true) next.presentation = sequence
        else completeDefense(next, sequence)
      }
    )
  }
  if (event.type === 'HOME') {
    const game = state.session
    if (
      state.phase !== 'homeDecision' ||
      game.homeQueue.length === 0 ||
      game.liveData.linescore.outs >= 3
    )
      return state
    const id = game.homeQueue[0]
    const movement = game.pending!.movements.find(move => move.playerId === id)!
    if (event.decision === 'back') {
      if (homeBackProposal(game) == null) return state
      return accepted(
        state,
        `Back ${game.gameData.players[id].fullName}`,
        next => {
          act(next, {
            type: 'runnerMovement',
            runner: id,
            to: '3B',
            reason: 'Back'
          })
          next.phase = 'runnerMovement'
          settleRunners(next)
        }
      )
    }
    return accepted(
      state,
      `${event.decision === 'safe' ? 'Safe' : 'Out'} at home ${game.gameData.players[id].fullName}`,
      next => {
        if (event.decision === 'out') {
          next.runnerAction = {
            playerId: id,
            from: movement.from,
            to: 4,
            origin: 'current',
            returnPhase: 'homeDecision',
            decision: 'out',
            reason: 'Out at home'
          }
          beginDefense(next)
          return
        }
        act(next, { type: 'runnerMovement', runner: id, to: 'home' })
        next.phase = 'runnerMovement'
        settleRunners(next)
      }
    )
  }
}

export { copyState }
