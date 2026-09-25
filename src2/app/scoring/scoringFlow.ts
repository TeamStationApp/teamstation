import {
  type Destination,
  DESTINATIONS,
  type Problem,
  type RunnerReason,
  type ScoringAction
} from '../../common/scoring/actions'
import {
  closesAutomatically,
  homeBackProposal,
  nextDecision,
  runnerDecisionError as gameRunnerError,
  runnerReasons as gameRunnerReasons
} from '../../common/scoring/rules'
import { type Applied, applyAction } from '../../common/scoring/session'
import { BASES } from '../field/fieldModel'
import { closePlay, copyState, snapshotOf } from './scoringMachine'
import { approachFirst, sequencesFor } from './scoringMotion'
import { throwPresentation, type ThrowSequence } from './scoringPresentation'
import { battingSide } from './scoringSelectors'
import type {
  ScoringEvent,
  ScoringSnapshot,
  ScoringState
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
export function act(next: ScoringSnapshot, action: ScoringAction): Applied {
  if (next.readOnly === true)
    throw new Refused([{ code: 'notNow', message: 'Scoring is read-only' }])
  const before = next.session
  const applied = applyAction(before, action)
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
  const pending = state.pendingPlay
  if (pending != null && !pending.trajectoryAccepted) {
    state.phase = 'trajectory'
    return
  }
  const game = state.session
  const decision = nextDecision(game)
  const moving = state.motions.some(motion => !motion.complete)
  if (decision === 'resolveBatter') {
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
  const lead = game.homeQueue[0]
  if (decision === 'homeDecision') {
    if (
      state.motions.some(motion => motion.playerId === lead && !motion.complete)
    ) {
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
      remainingMs: 10000,
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

/** A throw the screen drew has arrived: another hop, or the out. */
export function completeDefense(
  state: ScoringState,
  sequence: ThrowSequence
): void {
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
  const choice =
    action.returnPhase === 'resolveBatter' ||
    action.purpose === 'droppedThirdStrike'
  act(state, {
    type: 'runnerMovement',
    runner: action.playerId,
    to: destination(action.to),
    ...(choice || action.reason == null
      ? {}
      : { reason: action.reason as RunnerReason })
  })
  state.runnerAction = null
  state.phase = 'runnerMovement'
  settleRunners(state)
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
  const next: ScoringState = {
    ...snapshotOf(state),
    past: [...state.past, { label, snapshot: snapshotOf(state) }]
  }
  next.celebration = null
  try {
    edit(next)
  } catch (error) {
    if (error instanceof Refused) return state
    throw error
  }
  if (next.correctionWindow != null)
    next.correctionWindow = {
      remainingMs: 10000,
      revision: next.correctionWindow.revision + 1
    }
  return next
}

export function runnerReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState | undefined {
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
    const next = { ...snapshotOf(state), past: state.past }
    next.motions.find(motion => motion.id === event.id)!.complete = true
    if (command.purpose === 'approachFirst' && next.pendingPlay != null)
      next.pendingPlay.batterPoint = {
        ...command.waypoints[command.waypoints.length - 1]
      }
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
      ![
        'ready',
        'correctionWindow',
        'resolveBatter',
        'runnerDecision'
      ].includes(state.phase) ||
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
      else commitSafe(next)
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
