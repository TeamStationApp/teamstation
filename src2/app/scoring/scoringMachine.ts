import { setupOf } from '../../common/scoring/state'
import {
  acceptTrajectory,
  chooseOutcome,
  placeFielder,
  placeLanding
} from './battedBall'
import { moreReducer } from './moreActions'
import {
  accepted,
  act,
  completeDefense,
  Refused,
  runnerReducer,
  settleRunners
} from './scoringFlow'
import { approachFirst } from './scoringMotion'
import { outBatterPoint, pitchPresentation } from './scoringPresentation'
import { bottomActionsAllowed, canSwitchBatter } from './scoringSelectors'
import type {
  ScoringEvent,
  ScoringSessionState,
  ScoringSnapshot,
  ScoringState
} from './scoringTypes'

/**
 * The scoring screen's reducer. It turns what the scorer does — a tap, a drag,
 * a menu choice — into actions the scoring library applies, and keeps the
 * screen's own state: the step the scorer is on, what is being drawn, and the
 * history Undo walks back through.
 */

export { accepted }

export function copyState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
export function initialScoringState(
  session: ScoringSessionState,
  presentationEnabled = false
): ScoringState {
  const owned = copyState(session)
  const state: ScoringState = {
    session: owned,
    presentationEnabled,
    presentation: null,
    motions: [],
    runnerAction: null,
    correctionWindow: null,
    phase: owned.awaitingBatter == null ? 'ready' : 'awaitingBatter',
    pendingPlay: null,
    log: [],
    generation: 0,
    past: []
  }
  // A game picked up in the middle of a play resumes at that play's step.
  if (owned.pending != null) {
    state.pendingPlay = {
      outcome: owned.pending.outcome,
      trajectoryAccepted: true
    }
    state.phase = 'runnerMovement'
    settleRunners(state)
    // A decided play picked up here waits for the scorer: no countdown
    // closes it, and so nothing is saved until they finish it or pitch.
    state.correctionWindow = null
  }
  return state
}
export function snapshotOf(state: ScoringState): ScoringSnapshot {
  const { past: _past, ...snapshot } = state
  return copyState(snapshot)
}

/** Closes the decided play: the game moves on to the next batter. */
export function closePlay(state: ScoringState): ScoringState {
  if (state.phase !== 'correctionWindow') return state
  const next = { ...snapshotOf(state), past: state.past }
  try {
    act(next, { type: 'gameFlow', kind: 'closePlay' })
  } catch (error) {
    if (error instanceof Refused) return state
    throw error
  }
  next.motions = []
  next.runnerAction = null
  next.correctionWindow = null
  next.pendingPlay = null
  next.phase = next.session.awaitingBatter == null ? 'ready' : 'awaitingBatter'
  return next
}
function cancelRunnerDraft(state: ScoringState): ScoringState {
  const draft = state.runnerDraft ?? state.moreDraft
  if (draft == null) return state
  const restored: ScoringState = {
    ...copyState(draft.checkpoint),
    celebration: null,
    past: state.past.slice(0, draft.historyLength),
    generation: state.generation + 1
  }
  for (const motion of restored.motions) motion.generation = restored.generation
  if (restored.correctionWindow != null) restored.correctionWindow.revision++
  return restored
}
function runnerTransition(
  state: ScoringState,
  event: ScoringEvent
): ScoringState | undefined {
  const result = runnerReducer(state, event)
  if (result == null || result === state) return result
  if (event.type === 'RUNNER_PROPOSE')
    return {
      ...result,
      runnerDraft:
        state.runnerDraft ??
        (state.moreDraft != null
          ? {
              checkpoint: state.moreDraft.checkpoint,
              historyLength: state.moreDraft.historyLength
            }
          : {
              checkpoint: { ...snapshotOf(state), activeGesture: false },
              historyLength: state.past.length
            })
    }
  const draft = state.runnerDraft
  if (draft == null) return result
  if (event.type === 'DEFENDER' && result.phase === 'chooseDefender')
    return result
  if (
    [
      'runnerDecision',
      'runnerReason',
      'chooseThrower',
      'chooseDefender'
    ].includes(result.phase)
  )
    return {
      ...result,
      runnerDraft: draft,
      session: state.session,
      log: state.log,
      past: state.past,
      correctionWindow: state.correctionWindow
    }
  const label =
    state.runnerAction?.reason ?? result.past.at(-1)?.label ?? 'Runner movement'
  delete result.runnerDraft
  delete result.moreDraft
  result.past = [
    ...state.past.slice(0, draft.historyLength),
    { label, snapshot: copyState(draft.checkpoint) }
  ]
  if (result.correctionWindow != null)
    result.correctionWindow = {
      remainingMs: 10000,
      revision: result.correctionWindow.revision + 1
    }
  return result
}
export function scoringReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState {
  if (event.type === 'PRESENTATION')
    return state.presentationEnabled === event.enabled
      ? state
      : { ...state, presentationEnabled: event.enabled }
  if (event.type === 'RESET')
    return {
      ...initialScoringState(event.session, state.presentationEnabled),
      log: [...event.log],
      ...(event.readOnly === true ? { readOnly: true } : {})
    }
  if (event.type === 'CELEBRATION_DONE')
    return state.celebration?.id === event.id &&
      state.celebration.generation === event.generation
      ? { ...state, celebration: null }
      : state
  if (event.type === 'PRESENTATION_CONTACT') {
    const sequence = state.presentation
    if (
      sequence?.kind !== 'hit' ||
      sequence.stage !== 'swing' ||
      sequence.id !== event.id ||
      sequence.generation !== event.generation
    )
      return state
    return { ...state, presentation: { ...sequence, stage: 'flight' } }
  }
  if (event.type === 'PRESENTATION_DONE') {
    const sequence = state.presentation
    if (
      sequence?.id !== event.id ||
      sequence.generation !== event.generation ||
      sequence.stage !== event.stage
    )
      return state
    const next = { ...snapshotOf(state), past: state.past, presentation: null }
    if (sequence.kind === 'throw') {
      completeDefense(next, sequence)
      if (sequence.stage === 'tag' && next.runnerDraft != null) {
        const draft = next.runnerDraft
        next.past = [
          ...next.past.slice(0, draft.historyLength),
          {
            label: `Out by ${next.session.gameData.players[sequence.receiver].fullName}`,
            snapshot: copyState(draft.checkpoint)
          }
        ]
        delete next.runnerDraft
        delete next.moreDraft
      }
    }
    if (sequence.kind === 'hit' && sequence.out) {
      const point = outBatterPoint(sequence)
      if (next.pendingPlay != null) next.pendingPlay.batterPoint = point
      const motion = next.motions.find(
        m => m.playerId === sequence.batter && !m.complete
      )
      if (motion != null) motion.waypoints[0] = point
      if (
        next.runnerAction?.purpose === 'batterRetirement' &&
        next.phase === 'chooseDefender'
      )
        approachFirst(
          next,
          sequence.batter,
          point,
          outBatterPoint(sequence, Infinity)
        )
    }
    settleRunners(next)
    return next
  }
  if (
    state.presentation != null &&
    !['UNDO', 'GESTURE', 'RUNNER_CANCEL', 'CANCEL_RUNNER'].includes(
      event.type
    ) &&
    !(
      event.type === 'MOTION_DONE' &&
      state.presentation.kind === 'hit' &&
      state.presentation.stage === 'flight'
    )
  )
    return state
  if (
    ['MORE', 'PITCH', 'OUTCOME'].includes(event.type) &&
    !bottomActionsAllowed(state)
  )
    return state
  if (event.type === 'MORE') return moreReducer(state, event)
  if (event.type === 'GESTURE')
    return state.activeGesture === event.active
      ? state
      : { ...state, activeGesture: event.active }
  if (
    event.type === 'RUNNER_CANCEL' ||
    event.type === 'CANCEL_RUNNER' ||
    (event.type === 'UNDO' &&
      (state.runnerDraft != null || state.moreDraft != null) &&
      !(
        state.phase === 'chooseDefender' &&
        (state.runnerAction?.defensiveRoute?.length ?? 0) > 0 &&
        state.past.length > (state.runnerDraft?.historyLength ?? 0)
      ))
  )
    return cancelRunnerDraft(state)
  if (
    event.type === 'RUNNER_DECIDE' &&
    event.decision === 'safe' &&
    state.runnerAction?.origin === 'current' &&
    state.runnerAction.from === state.runnerAction.to &&
    state.runnerAction.returnPhase !== 'resolveBatter'
  )
    return cancelRunnerDraft(state)
  if (event.type === 'UNDO') {
    const last = state.past.at(-1)
    if (last == null || state.readOnly === true) return state
    const next = {
      ...copyState(last.snapshot),
      presentation: null,
      celebration: null,
      generation: state.generation + 1,
      past: state.past.slice(0, -1)
    }
    for (const motion of next.motions) motion.generation = next.generation
    if (next.correctionWindow != null)
      next.correctionWindow = {
        remainingMs: 10000,
        revision: next.correctionWindow.revision + 1
      }
    return next
  }
  if (event.type === 'TIMER_TICK') {
    const timer = state.correctionWindow
    if (
      state.activeGesture === true ||
      state.phase !== 'correctionWindow' ||
      timer == null ||
      event.generation !== state.generation ||
      event.revision !== timer.revision ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs <= 0
    )
      return state
    const next = {
      ...state,
      correctionWindow: {
        ...timer,
        remainingMs: Math.max(0, timer.remainingMs - event.elapsedMs)
      }
    }
    return next.correctionWindow.remainingMs === 0 ? closePlay(next) : next
  }
  if (event.type === 'RUNNER_DROP') {
    if (event.generation !== state.generation) return state
    const offense = state.session.liveData.linescore.offense
    const from =
      [offense.first?.id, offense.second?.id, offense.third?.id].indexOf(
        event.id
      ) + 1
    if (event.to !== from && event.to !== from + 1) return state
    const proposed = scoringReducer(state, {
      type: 'RUNNER_PROPOSE',
      id: event.id,
      to: event.to
    })
    if (proposed === state) return state
    let decided = scoringReducer(proposed, {
      type: 'RUNNER_DECIDE',
      decision: event.decision
    })
    if (decided.phase === 'runnerReason' && decided.moreDraft != null)
      decided = scoringReducer(decided, {
        type: 'RUNNER_REASON',
        reason: decided.moreDraft.action
      })
    return decided.phase === 'runnerDecision'
      ? cancelRunnerDraft(decided)
      : decided
  }
  const runnerResult = runnerTransition(state, event)
  if (runnerResult != null) return runnerResult
  if (event.type === 'OUTCOME')
    return chooseOutcome(state, event.outcome, event.contactKind)
  if (event.type === 'LANDING')
    return placeLanding(
      state,
      event.point,
      event.generation,
      event.landingHeight
    )
  if (event.type === 'FIELDER')
    return placeFielder(
      state,
      event.id,
      event.point,
      event.generation,
      event.landingHeight
    )
  if (event.type === 'TRAJECTORY')
    return acceptTrajectory(state, event.angle, event.generation)
  if (event.type === 'ROSTER' || event.type === 'OVERRIDE') {
    if (
      state.moreDraft != null ||
      (state.phase !== 'ready' && state.phase !== 'awaitingBatter')
    )
      return state
    return accepted(
      state,
      event.type === 'ROSTER' ? 'Set team roster' : 'Override game state',
      next => {
        if (event.type === 'ROSTER')
          act(next, {
            type: 'lineup',
            kind: 'roster',
            setup: setupOf(event.draft),
            ...(event.nextBatter == null
              ? {}
              : { nextBatter: event.nextBatter })
          })
        else
          act(next, {
            type: 'gameFlow',
            kind: 'override',
            ...event.draft,
            batter: event.draft.batter ?? undefined,
            pitcher: event.draft.pitcher ?? undefined
          })
        next.phase = 'ready'
        next.generation++
      }
    )
  }
  if (event.type === 'CLOSE_PLAY') {
    if (
      state.activeGesture === true ||
      (event.generation != null && event.generation !== state.generation) ||
      (event.revision != null &&
        event.revision !== state.correctionWindow?.revision) ||
      (event.sequence != null &&
        event.sequence !== state.session.meta.sequence) ||
      state.runnerAction != null ||
      state.session.homeQueue.length > 0 ||
      state.motions.some(motion => !motion.complete)
    )
      return state
    return closePlay(state)
  }
  if (event.type === 'END_HALF')
    return state.phase !== 'ready' || state.moreDraft != null
      ? state
      : accepted(state, 'End half inning', next => {
          act(next, { type: 'gameFlow', kind: 'endHalf' })
          next.motions = []
          next.pendingPlay = null
          next.generation++
          next.phase =
            next.session.awaitingBatter == null ? 'ready' : 'awaitingBatter'
        })
  if (event.type === 'END_GAME')
    return (state.phase !== 'ready' && state.phase !== 'awaitingBatter') ||
      state.moreDraft != null
      ? state
      : accepted(state, 'End game', next => {
          act(next, { type: 'gameFlow', kind: 'endGame' })
        })
  if (state.phase !== 'ready') return state
  if (event.type === 'SWITCH_SIDE') {
    if (
      !canSwitchBatter(state.session) ||
      state.session.liveData.plays.currentPlay?.matchup.batSide.code ===
        event.side
    )
      return state
    return accepted(
      state,
      `Batter ${event.side === 'L' ? 'left' : 'right'} handed`,
      next => {
        act(next, { type: 'lineup', kind: 'batterSide', batSide: event.side })
      }
    )
  }
  if (event.type !== 'PITCH' || state.moreDraft != null) return state
  const labels = {
    ball: 'Ball',
    called: 'Called Strike',
    swing: 'Swing and Miss',
    foul: 'Foul Ball'
  }
  return accepted(state, labels[event.kind], next => {
    if (state.presentationEnabled === true)
      next.presentation = pitchPresentation(state, event.kind)
    act(next, {
      type: 'pitch',
      call: ({ ball: 'B', called: 'C', swing: 'S', foul: 'F' } as const)[
        event.kind
      ]
    })
    settleRunners(next)
  })
}
