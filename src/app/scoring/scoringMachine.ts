import type { Problem, ScoringAction } from '../../common/scoring/actions'
import {
  awaitingResult,
  completesHitOffer,
  currentSetupError,
  overrideOf,
  tiebreakerSetupError,
  undoesHitOffer
} from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { copyGame, setupOf } from '../../common/scoring/state'
import {
  acceptTrajectory,
  chooseOutcome,
  placeFielder,
  placeLanding
} from './battedBall'
import {
  answerOf,
  completeSentence,
  leadRunnersFirst,
  playDefaults,
  sentenceQuestion,
  settleBetween,
  stealsByBase
} from './dictatedCompletion'
import { advanceReel, beginReel, ReelBuilder } from './dictatedReel'
import { moreEligibility, moreReducer } from './moreActions'
import {
  accepted,
  act,
  completeDefense,
  destination,
  forceOutInRelay,
  Refused,
  runnerReducer,
  settleRunners
} from './scoringFlow'
import { approachFirst } from './scoringMotion'
import { outBatterPoint, pitchPresentation } from './scoringPresentation'
import { bottomActionsAllowed, canSwitchBatter } from './scoringSelectors'
import {
  CORRECTION_WINDOW_MS,
  type GameCheckpoint,
  type HistoryEntry,
  type ScoringDraft,
  type ScoringEvent,
  type ScoringScreenState,
  type ScoringSessionState,
  type ScoringSnapshot,
  type ScoringState
} from './scoringTypes'

/**
 * The scoring screen's reducer. It turns what the scorer does — a tap, a drag,
 * a menu choice — into actions the scoring library applies, and keeps the
 * screen's own state: the step the scorer is on, what is being drawn, and the
 * history Undo walks back through.
 *
 * Undo keeps no copy of the game per step. Each step records the log's length
 * and the screen, and the game is kept once per plate appearance, as it
 * opened (`checkpoints`); the first, every tenth and the newest two hold a
 * copy of the game. An Undo copies the newest of those at or before the
 * step, applies the log from there to the step with the library's
 * `applyAction`, in the order the screen applied it, truncates the log, and
 * restores the screen. So the history grows with the log, not with the game
 * times the number of taps.
 */

export { accepted, copyGame }

export function copyState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function initialScoringState(
  session: ScoringSessionState,
  presentationEnabled = false
): ScoringState {
  const owned = copyGame(session)
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
    past: [],
    checkpoints: []
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
/**
 * The screen picking up a game whose log so far is `log`. A play the screen
 * would close by itself — an award, say — closes as it opens, and that close
 * joins the log, so the log always makes the game the screen shows.
 */
export function resumedScoringState(
  session: ScoringSessionState,
  log: ScoringState['log'],
  presentationEnabled = false
): ScoringState {
  const state = initialScoringState(session, presentationEnabled)
  return { ...state, log: [...log, ...state.log] }
}

/**
 * Whether the screen, picking the game up here, would act on it by itself:
 * the game is a step no Undo can come to rest on.
 */
export function actsOnOpening(session: ScoringSessionState): boolean {
  return initialScoringState(session).log.length > 0
}

export function snapshotOf(state: ScoringState): ScoringSnapshot {
  // The log is shared: nothing changes an action once it is logged, and a
  // step that logs one makes a new log (`act`).
  const {
    past: _past,
    checkpoints: _checkpoints,
    session,
    log,
    ...rest
  } = state
  return { ...copyState(rest), log, session: copyGame(session) }
}

/** A copy of the screen without the game or its history. */
export function screenOf(state: ScoringState): ScoringScreenState {
  const {
    past: _past,
    checkpoints: _checkpoints,
    session: _session,
    log: _log,
    ...screen
  } = state
  return copyState(screen)
}

/** The plate appearance a game is on: the plays it has finished. */
function appearanceOf(session: ScoringSessionState): number {
  return session.liveData.plays.allPlays.length
}

/** How many plate appearances apart the kept copies of the game are. */
export const CHECKPOINT_SPACING = 10

/**
 * Whether the checkpoint at `index` of `count` keeps its copy of the game:
 * the first, every tenth, and the newest two. Any other is rebuilt from the
 * nearest earlier copy, so an Undo replays at most about ten appearances.
 */
export function keepsGame(index: number, count: number): boolean {
  return index % CHECKPOINT_SPACING === 0 || index >= count - 2
}

/**
 * The checkpoints once `state` is recorded as the start of a step or a
 * draft: a new one when this is a plate appearance the newest does not
 * cover. Only those `keepsGame` names keep a copy of the game.
 */
export function checkpointsFor(state: ScoringState): GameCheckpoint[] {
  const newest = state.checkpoints.at(-1)
  const appearance = appearanceOf(state.session)
  if (newest?.appearance === appearance) return state.checkpoints
  const checkpoints = [
    ...state.checkpoints,
    {
      logLength: state.log.length,
      appearance,
      session: copyGame(state.session)
    }
  ]
  const retired = checkpoints.length - 3
  if (retired > 0 && !keepsGame(retired, checkpoints.length))
    checkpoints[retired] = { ...checkpoints[retired], session: null }
  return checkpoints
}

/** The history once `state` is recorded as the start of a step. */
export function withStep(
  state: ScoringState,
  label: string
): Pick<ScoringState, 'past' | 'checkpoints'> {
  return {
    past: [
      ...state.past,
      { label, logLength: state.log.length, screen: screenOf(state) }
    ],
    checkpoints: checkpointsFor(state)
  }
}

/** Where a draft begins: here, recorded so cancelling can come back. */
export function draftAt(
  state: ScoringState,
  screen: ScoringScreenState = screenOf(state)
): ScoringDraft {
  return {
    historyLength: state.past.length,
    logLength: state.log.length,
    screen
  }
}

/**
 * Applies `log` from `start` up to `end` to `session`, in place: the caller
 * owns `session`, and nothing else holds it.
 */
function replay(
  session: ScoringSessionState,
  log: ScoringState['log'],
  start: number,
  end: number
): ScoringSessionState {
  for (let index = start; index < end; index++) {
    const applied = applyAction(session, log[index], { inPlace: true })
    if (applied.problems.length > 0)
      throw new Error(
        `The log does not replay at ${index}: ${applied.problems[0].message}`
      )
    session = applied.state
  }
  return session
}

/**
 * The game when the log was `logLength` long: the newest checkpoint at or
 * before it that holds a game, with the log applied from there, copied. A
 * checkpoint passed on the way that `keepsGame` names gets its copy of the
 * game back, so the newest and the one before it always hold one.
 */
function gameAt(
  state: Pick<ScoringState, 'log' | 'checkpoints'>,
  logLength: number
): { session: ScoringSessionState; checkpoints: GameCheckpoint[] } {
  const checkpoints = state.checkpoints.filter(
    checkpoint => checkpoint.logLength <= logLength
  )
  let from = checkpoints.length - 1
  // The one before the newest is rebuilt too, if it has lost its game.
  if (from > 0 && checkpoints[from - 1].session == null) from--
  while (from > 0 && checkpoints[from].session == null) from--
  const first = checkpoints[from]?.session
  if (first == null) throw new Error(`No checkpoint at log length ${logLength}`)
  // A checkpoint's game is never changed: the replay works on a copy of it,
  // taken only once there is something to apply.
  let session = first
  let owned = false
  let applied = checkpoints[from].logLength
  const replayTo = (end: number): void => {
    if (end === applied) return
    if (!owned) session = copyGame(session)
    owned = true
    session = replay(session, state.log, applied, end)
    applied = end
  }
  for (let index = from + 1; index < checkpoints.length; index++) {
    const held = checkpoints[index].session
    if (held != null) {
      session = held
      owned = false
      applied = checkpoints[index].logLength
      continue
    }
    replayTo(checkpoints[index].logLength)
    if (keepsGame(index, checkpoints.length))
      checkpoints[index] = {
        ...checkpoints[index],
        session: copyGame(session)
      }
  }
  replayTo(logLength)
  // A copy, as the screen's own game always is (no undefined fields).
  return { session: copyGame(session), checkpoints }
}

/**
 * The state as it was when the log was `where.logLength` long and the screen
 * was `where.screen`, with the history as far back as `historyLength`.
 */
function restoreTo(
  state: ScoringState,
  where: Pick<HistoryEntry, 'logLength' | 'screen'>,
  historyLength: number
): ScoringState {
  const { session, checkpoints } = gameAt(state, where.logLength)
  return {
    ...copyState(where.screen),
    session,
    log: state.log.slice(0, where.logLength),
    past: state.past.slice(0, historyLength),
    checkpoints
  }
}

/** Closes the decided play: the game moves on to the next batter. */
/**
 * The game when the log was `logLength` long: rebuilt from the checkpoints,
 * or, before the first of them — a game picked up with its log already
 * played — from `opening`, the game before the whole log.
 */
export function sessionAt(
  state: Pick<ScoringState, 'log' | 'checkpoints'>,
  logLength: number,
  opening: () => ScoringSessionState
): ScoringSessionState {
  if (state.checkpoints.some(checkpoint => checkpoint.logLength <= logLength))
    return gameAt(state, logLength).session
  return replay(copyGame(opening()), state.log, 0, logLength)
}

export function closePlay(state: ScoringState): ScoringState {
  if (state.phase !== 'correctionWindow') return state
  const next = {
    ...snapshotOf(state),
    past: state.past,
    checkpoints: state.checkpoints
  }
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
    ...restoreTo(state, draft, draft.historyLength),
    celebration: null,
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
              historyLength: state.moreDraft.historyLength,
              logLength: state.moreDraft.logLength,
              screen: state.moreDraft.screen
            }
          : draftAt(state, { ...screenOf(state), activeGesture: false })),
      checkpoints: checkpointsFor(state)
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
      checkpoints: state.checkpoints,
      correctionWindow: state.correctionWindow
    }
  const label =
    state.runnerAction?.reason ?? result.past.at(-1)?.label ?? 'Runner movement'
  delete result.runnerDraft
  delete result.moreDraft
  result.past = [
    ...state.past.slice(0, draft.historyLength),
    { label, logLength: draft.logLength, screen: copyState(draft.screen) }
  ]
  if (result.correctionWindow != null)
    result.correctionWindow = {
      remainingMs: CORRECTION_WINDOW_MS,
      revision: result.correctionWindow.revision + 1
    }
  return result
}
export function scoringReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState {
  let next = reduce(state, event)
  // A sentence that came back while the last one was shown applies once the
  // screen is at rest again.
  while (
    next.queuedDictation != null &&
    next.queuedDictation.length > 0 &&
    next.reel == null &&
    atRest(next)
  ) {
    const [first, ...rest] = next.queuedDictation
    const waiting: ScoringState = { ...next }
    if (rest.length > 0) waiting.queuedDictation = rest
    else delete waiting.queuedDictation
    next = dictated(waiting, first)
  }
  return next
}
function reduce(state: ScoringState, event: ScoringEvent): ScoringState {
  if (event.type === 'PRESENTATION')
    return state.presentationEnabled === event.enabled
      ? state
      : { ...state, presentationEnabled: event.enabled }
  if (event.type === 'RESET')
    return {
      ...resumedScoringState(
        event.session,
        event.log,
        state.presentationEnabled
      ),
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
    const next = {
      ...snapshotOf(state),
      past: state.past,
      checkpoints: state.checkpoints,
      presentation: null
    }
    // A dictated picture shows what the sentence already recorded.
    if (sequence.dictated === true) {
      advanceReel(next)
      settleRunners(next)
      return next
    }
    if (sequence.kind === 'throw') {
      completeDefense(next, sequence)
      if (sequence.stage === 'tag' && next.runnerDraft != null) {
        const draft = next.runnerDraft
        next.past = [
          ...next.past.slice(0, draft.historyLength),
          {
            label: `Out by ${next.session.gameData.players[sequence.receiver].fullName}`,
            logLength: draft.logLength,
            screen: copyState(draft.screen)
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
  // Above the presentation guard, so a sentence spoken mid-animation is told
  // why rather than swallowed.
  if (event.type === 'DICTATED') return dictated(state, event)
  if (event.type === 'DICTATION_ANSWER') {
    const question = state.dictationQuestion
    const actions = question == null ? undefined : answerOf(question, event)
    if (question == null || actions == null) return state
    return dictated(state, {
      transcript: question.transcript,
      actions,
      acceptedLineup:
        event.acceptedLineup === undefined
          ? question.acceptedLineup
          : event.acceptedLineup,
      answered: true
    })
  }
  if (event.type === 'DICTATION_DISMISS') {
    if (state.dictationQuestion == null) return state
    const { dictationQuestion: _dropped, ...rest } = state
    return rest
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
    const next: ScoringState = {
      ...restoreTo(state, last, state.past.length - 1),
      presentation: null,
      celebration: null,
      generation: state.generation + 1
    }
    delete next.dictation
    delete next.reel
    delete next.queuedDictation
    delete next.dictationQuestion
    for (const motion of next.motions) motion.generation = next.generation
    if (next.correctionWindow != null)
      next.correctionWindow = {
        remainingMs: CORRECTION_WINDOW_MS,
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
    if (
      state.phase === 'chooseDefender' &&
      state.runnerAction?.purpose === 'batterRetirement'
    )
      return forceOutInRelay(
        state,
        event.id,
        event.to,
        event.decision,
        event.generation
      )
    const offense = state.session.liveData.linescore.offense
    const from =
      [offense.first?.id, offense.second?.id, offense.third?.id].indexOf(
        event.id
      ) + 1
    // Unforced hit-offer undo / safe re-take: commit in one step, no Safe/Out.
    // Out on a re-take falls through so the Safe/Out strip can put him out.
    // settleRunners so homeDecision waits out the return / re-advance motion.
    if (
      (event.to === from - 1 &&
        undoesHitOffer(state.session, event.id, from, event.to)) ||
      (event.to === from + 1 &&
        event.decision === 'safe' &&
        completesHitOffer(state.session, event.id, from, event.to))
    ) {
      const back = event.to === from - 1
      return accepted(
        state,
        `${back ? 'Back' : 'Advance'} ${state.session.gameData.players[event.id].fullName}`,
        next => {
          act(next, {
            type: 'runnerMovement',
            runner: event.id,
            to: destination(event.to)
          })
          next.phase = 'runnerMovement'
          settleRunners(next)
        }
      )
    }
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
    return acceptTrajectory(
      state,
      event.angle,
      event.generation,
      event.dragged === true
    )
  if (event.type === 'TIEBREAKER_OUTS') {
    if (
      moreEligibility(state, 'Place a Runner (Tiebreaker)') != null ||
      tiebreakerSetupError(state.session) != null ||
      !Number.isInteger(event.outs) ||
      event.outs < 0 ||
      event.outs > 2 ||
      state.session.liveData.linescore.outs === event.outs
    )
      return state
    return accepted(state, 'Set Outs', next => {
      const draft = overrideOf(next.session)
      act(next, {
        type: 'gameFlow',
        kind: 'override',
        ...draft,
        outs: event.outs,
        batter: draft.batter ?? undefined,
        pitcher: draft.pitcher ?? undefined
      })
      next.generation++
    })
  }
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
        next.phase =
          next.session.awaitingBatter == null ? 'ready' : 'awaitingBatter'
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

/**
 * The scoring screen's state around `scoringReducer`. An Undo tap that
 * reaches back past what was scored on this screen, into play saved before
 * it opened, is taken back through the saved game rather than the reducer.
 * Such taps wait here in order, and the screen takes each back one at a time
 * from the game as the taps before it left it (`SAVED_UNDONE`). So a tap
 * that comes before the screen has drawn the last one still takes exactly one
 * step, even where the history runs out.
 */
export interface ScoringScreenModel {
  scoring: ScoringState
  /** Undo taps waiting to take back play saved before the screen opened. */
  savedUndos: number
  /** How many such taps have been taken back so far. */
  savedUndone: number
}

/** One tap into the saved game taken back: the game it left, if it could. */
export interface SavedUndone {
  type: 'SAVED_UNDONE'
  undone?: { session: ScoringSessionState; log: ScoringState['log'] }
}

export function scoringScreenModel(scoring: ScoringState): ScoringScreenModel {
  return { scoring, savedUndos: 0, savedUndone: 0 }
}

export function scoringScreenReducer(
  model: ScoringScreenModel,
  event: ScoringEvent | SavedUndone
): ScoringScreenModel {
  const { scoring } = model
  if (event.type === 'SAVED_UNDONE')
    return {
      scoring:
        event.undone == null
          ? scoring
          : scoringReducer(scoring, { type: 'RESET', ...event.undone }),
      savedUndos: Math.max(0, model.savedUndos - 1),
      savedUndone: model.savedUndone + 1
    }
  if (
    event.type === 'UNDO' &&
    scoring.past.length === 0 &&
    scoring.log.length > 0 &&
    scoring.readOnly !== true
  )
    return { ...model, savedUndos: model.savedUndos + 1 }
  const next = scoringReducer(scoring, event)
  return next === scoring ? model : { ...model, scoring: next }
}

/** The steps a dictated sentence may land on: nothing drawn, nothing moving. */
const AT_REST: ReadonlyArray<ScoringState['phase']> = [
  'ready',
  'awaitingBatter',
  'correctionWindow'
]

/**
 * Whether the screen is at rest: on a step where a dictated sentence may land,
 * with nothing being drafted and nothing animating.
 */
export function atRest(state: ScoringState): boolean {
  return (
    AT_REST.includes(state.phase) &&
    state.runnerDraft == null &&
    state.moreDraft == null &&
    state.presentation == null &&
    state.reel == null
  )
}

/**
 * A dictated sentence. It is one edit: every action applies, as one entry in
 * Undo labelled with what was said, or none does and the reason is kept for
 * the screen. At a setup boundary the valid prior-half prefix finishes,
 * while rejected next-half actions are omitted from the saved log.
 */
function dictated(
  state: ScoringState,
  event: {
    transcript: string
    actions: readonly ScoringAction[]
    acceptedLineup?: string | null
    /** The whole sentence an answer came to: not asked about again. */
    answered?: boolean
  }
): ScoringState {
  const { transcript } = event
  if (event.actions.length === 0) return state
  if (
    state.readOnly !== true &&
    state.session.pending == null &&
    !awaitingResult(state.session) &&
    !['lineup', 'gameFlow'].includes(event.actions[0].type)
  ) {
    const problem = currentSetupError(state.session, event.acceptedLineup)
    if (problem != null)
      return {
        ...state,
        dictationQuestion: undefined,
        dictation: { transcript, problem: { code: 'notNow', message: problem } }
      }
  }
  // What was left to be assumed is filled in, a steal is the runner's on the
  // base before the one taken, and runners who move together go lead runner
  // first, however they were said.
  const between = settleBetween(
    state.session,
    leadRunnersFirst(
      state.session,
      stealsByBase(
        state.session,
        playDefaults(state.session, event.actions, transcript),
        transcript
      )
    )
  )
  const { actions } = between
  const { dictation: _last, dictationQuestion: _asked, ...current } = state
  const refused = (message: string): ScoringState => ({
    ...current,
    dictation: { transcript, problem: { code: 'notNow', message } }
  })
  // `act` throws before it reaches the rules engine here, so a dry run
  // cannot see it.
  if (state.readOnly === true) return refused('Scoring is read-only')
  // The last sentence is still being shown. The game already holds it, so
  // this one was spoken about the game as it is: it waits its turn.
  if (state.reel != null)
    return {
      ...state,
      queuedDictation: [
        ...(state.queuedDictation ?? []),
        {
          transcript,
          actions: [...actions],
          acceptedLineup: event.acceptedLineup
        }
      ]
    }
  if (!atRest(state))
    return refused('Finish what is on screen, then say it again')
  // What the sentence leaves the screen unable to settle is asked first.
  const asked = sentenceQuestion(
    state.session,
    transcript,
    actions,
    event.answered === true
  )
  if (asked != null)
    return {
      ...current,
      dictationQuestion: {
        transcript,
        acceptedLineup: event.acceptedLineup,
        ...asked
      }
    }
  // What a first play needs answered before the rest of the sentence.
  if (between.question != null)
    return {
      ...current,
      dictationQuestion: {
        transcript,
        acceptedLineup: event.acceptedLineup,
        ...between.question
      }
    }
  let game = state.session
  let prefix = actions
  let setupProblem: Problem | undefined
  for (const [index, action] of actions.entries()) {
    const applied = applyAction(game, action, {
      requireCurrentSetup: true,
      acceptedLineup: event.acceptedLineup
    })
    if (applied.problems.length > 0) {
      const problem = applied.problems[0]
      if (
        index > 0 &&
        problem.code === 'notNow' &&
        /^(Missing defensive positions:|No players in lineup|Accept the current batting lineup)/.test(
          problem.message
        )
      ) {
        prefix = actions.slice(0, index)
        setupProblem = problem
        break
      }
      return {
        ...current,
        dictation: { transcript, problem }
      }
    }
    game = applied.state
  }
  // Whatever the play is left waiting on is finished, or asked.
  const done = completeSentence(state.session, prefix)
  if ('question' in done)
    return {
      ...current,
      dictationQuestion: {
        transcript,
        acceptedLineup: event.acceptedLineup,
        ...done.question
      }
    }
  const sentence = done.actions
  const reel = new ReelBuilder(state.presentationEnabled === true)
  const next = accepted(current, transcript, edit => {
    sentence.forEach((action, index) => {
      reel.before(edit, action, sentence.slice(index + 1))
      const known = new Set(edit.motions.map(motion => motion.id))
      act(edit, action)
      reel.after(edit.motions.filter(motion => !known.has(motion.id)))
      edit.motions = edit.motions.filter(motion => known.has(motion.id))
    })
    if (reel.homeRunKind != null)
      edit.celebration = {
        id: `${edit.generation}:${edit.session.meta.sequence}:home-run`,
        generation: edit.generation,
        kind: reel.homeRunKind
      }
    beginReel(edit, reel.finish(edit))
    settleRunners(edit)
  })
  // The dry run and `act` consult the same rules, so this is only a guard.
  if (next === current) return refused('The game would not take that')
  return {
    ...next,
    dictation: {
      transcript,
      ...(setupProblem == null ? {} : { problem: setupProblem })
    }
  }
}
