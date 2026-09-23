import { acceptTrajectory, chooseOutcome, placeFielder } from './battedBall'
import { moreReducer } from './moreActions'
import { prepareTerminalPitch, runnerReducer } from './runnerRules'
import { asScoringPlay } from './scoringContract'
import { applyOverrideDraft, applyRosterDraft } from './scoringEdits'
import { pitchPresentation } from './scoringPresentation'
import {
  baseIds,
  battingSide,
  canSwitchBatter,
  fieldingSide,
  playerRef,
  startAppearance
} from './scoringSelectors'
import type {
  ScoringEvent,
  ScoringSessionState,
  ScoringSnapshot,
  ScoringState
} from './scoringTypes'

export function copyState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
export function initialScoringState(
  session: ScoringSessionState,
  presentationEnabled = false
): ScoringState {
  const owned = copyState(session)
  const awaitingBatter =
    owned.liveData.plays.currentPlay == null ? startAppearance(owned) : null
  return {
    session: owned,
    presentationEnabled,
    presentation: null,
    motions: [],
    runnerAction: null,
    correctionWindow: null,
    phase: awaitingBatter == null ? 'ready' : 'awaitingBatter',
    pendingPlay: null,
    homeQueue: [],
    awaitingBatter,
    generation: 0,
    past: []
  }
}
export function snapshotOf(state: ScoringState): ScoringSnapshot {
  const { past: _past, ...snapshot } = state
  return copyState(snapshot)
}
export function accepted(
  state: ScoringState,
  label: string,
  edit: (next: ScoringState) => void
): ScoringState {
  const next: ScoringState = {
    ...snapshotOf(state),
    past: [...state.past, { label, snapshot: snapshotOf(state) }]
  }
  edit(next)
  if (next.correctionWindow != null)
    next.correctionWindow = {
      remainingMs: 10000,
      revision: next.correctionWindow.revision + 1
    }
  next.session.meta.sequence++
  return next
}
export function nextHalf(state: ScoringState): void {
  const line = state.session.liveData.linescore
  if (!line.isTopInning) line.currentInning++
  line.isTopInning = !line.isTopInning
  line.inningState = line.isTopInning ? 'Top' : 'Bottom'
  const number = line.currentInning
  line.currentInningOrdinal = `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][number % 10] ?? 'th')}`
  line.balls = 0
  line.strikes = 0
  line.outs = 0
  line.offense = { batter: null, first: null, second: null, third: null }
  state.motions = []
  state.runnerAction = null
  state.correctionWindow = null
  state.pendingPlay = null
  state.homeQueue = []
  state.generation++
  state.recentPitch = null
  state.awaitingBatter = startAppearance(state.session)
  state.phase = state.awaitingBatter == null ? 'ready' : 'awaitingBatter'
}
function closePlay(state: ScoringState): ScoringState {
  if (state.phase !== 'correctionWindow' || state.pendingPlay == null)
    return state
  const next = { ...snapshotOf(state), past: state.past }
  const session = next.session
  const play = session.liveData.plays.currentPlay
  if (play == null) return state
  play.about.isComplete = true
  play.result.awayScore = session.liveData.linescore.teams.away.runs
  play.result.homeScore = session.liveData.linescore.teams.home.runs
  session.liveData.plays.allPlays.push(asScoringPlay(play))
  const lineup = session.liveData.boxscore.teams[battingSide(session)]
  lineup.battingIndex = (lineup.battingIndex + 1) % lineup.battingOrder.length
  next.motions = []
  next.runnerAction = null
  next.correctionWindow = null
  next.pendingPlay = null
  next.homeQueue = []
  if (session.liveData.linescore.outs >= 3) nextHalf(next)
  else {
    session.liveData.linescore.balls = 0
    session.liveData.linescore.strikes = 0
    next.awaitingBatter = startAppearance(session)
    next.phase = next.awaitingBatter == null ? 'ready' : 'awaitingBatter'
  }
  session.meta.sequence++
  return next
}
function cancelRunnerDraft(state: ScoringState): ScoringState {
  const draft = state.runnerDraft ?? state.moreDraft
  if (draft == null) return state
  const restored: ScoringState = {
    ...copyState(draft.checkpoint),
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
  result.session.meta.sequence = draft.checkpoint.session.meta.sequence + 1
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
    return { ...state, presentation: null }
  }
  if (
    state.presentation != null &&
    !['UNDO', 'GESTURE'].includes(event.type) &&
    !(
      event.type === 'MOTION_DONE' &&
      state.presentation.kind === 'hit' &&
      state.presentation.stage === 'flight'
    )
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
      (state.runnerDraft != null || state.moreDraft != null))
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
    if (last == null) return state
    const next = {
      ...copyState(last.snapshot),
      presentation: null,
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
    const from = baseIds(state.session).indexOf(event.id) + 1
    if (event.to !== from && event.to !== from + 1) return state
    const proposed = scoringReducer(state, {
      type: 'RUNNER_PROPOSE',
      id: event.id,
      to: event.to
    })
    if (proposed == null || proposed === state) return state
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
  if (event.type === 'OUTCOME') return chooseOutcome(state, event.outcome)
  if (event.type === 'FIELDER')
    return placeFielder(state, event.id, event.point, event.generation)
  if (event.type === 'TRAJECTORY')
    return acceptTrajectory(state, event.angle, event.generation)
  if (event.type === 'ROSTER' || event.type === 'OVERRIDE') {
    if (
      state.moreDraft != null ||
      (state.phase !== 'ready' && state.phase !== 'awaitingBatter')
    )
      return state
    const result =
      event.type === 'ROSTER'
        ? applyRosterDraft(state, event.draft, event.nextBatter)
        : applyOverrideDraft(state, event.draft)
    if (result.session == null) return state
    return accepted(
      state,
      event.type === 'ROSTER' ? 'Set team roster' : 'Override game state',
      next => {
        next.recentPitch = null
        next.session = result.session!
        next.phase = 'ready'
        next.awaitingBatter = null
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
      state.homeQueue.length > 0 ||
      state.motions.some(motion => !motion.complete)
    )
      return state
    return closePlay(state)
  }
  if (event.type === 'END_HALF')
    return state.phase !== 'ready' || state.moreDraft != null
      ? state
      : accepted(state, 'End half inning', nextHalf)
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
        const play = next.session.liveData.plays.currentPlay
        if (play != null) play.matchup.batSide.code = event.side
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
    const session = next.session
    const line = session.liveData.linescore
    const play = session.liveData.plays.currentPlay
    if (play == null) throw new Error('Ready requires an active play')
    if (state.presentationEnabled === true)
      next.presentation = pitchPresentation(state, event.kind)
    const before = { balls: line.balls, strikes: line.strikes, outs: line.outs }
    const pitcher = play.matchup.pitcher.id
    const counts =
      session.liveData.boxscore.teams[fieldingSide(session)].pitchCounts
    counts[pitcher] = (counts[pitcher] ?? 0) + 1
    play.playEvents.push({
      index: play.playEvents.length,
      isPitch: true,
      type: 'pitch',
      details: {
        code: { ball: 'B', called: 'C', swing: 'S', foul: 'F' }[event.kind],
        description: labels[event.kind]
      },
      count: before,
      player: play.matchup.pitcher
    })
    next.recentPitch =
      event.kind === 'foul'
        ? null
        : {
            atBatIndex: play.about.atBatIndex,
            index: play.playEvents.length - 1
          }
    if (event.kind === 'ball') line.balls++
    else if (event.kind !== 'foul' || line.strikes < 2) line.strikes++
    if (line.balls >= 4 || line.strikes >= 3) {
      const walk = line.balls >= 4
      const originalBases = baseIds(session)
      next.pendingPlay = {
        outcome: walk ? 'Walk' : 'Strikeout',
        originalRunnerRecordCount: play.runners.length,
        originalBases,
        originalRuns: line.teams[battingSide(session)].runs,
        originalOuts: line.outs,
        movements: [],
        trajectoryAccepted: true
      }
      play.result.event = walk ? 'Walk' : 'Strikeout'
      play.result.eventType = walk ? 'walk' : 'strikeout'
      play.result.description = play.result.event
      play.source.gamestation.outcome = play.result.event
      if (walk) {
        let carry: number | null = play.matchup.batter.id
        for (let base = 1; base <= 3 && carry != null; base++) {
          const id: number = carry
          carry = originalBases[base - 1]
          const key = (['first', 'second', 'third'] as const)[base - 1]
          line.offense[key] = playerRef(session, id)
          next.pendingPlay.movements.push({
            playerId: id,
            from: base - 1,
            to: base,
            force: true,
            decision: 'safe'
          })
        }
        if (carry != null) {
          next.homeQueue = [carry]
          next.pendingPlay.movements.push({
            playerId: carry,
            from: 3,
            to: 4,
            force: true,
            decision: 'pending'
          })
        }
      } else line.outs++
      next.phase =
        next.homeQueue.length === 0 ? 'correctionWindow' : 'homeDecision'
      prepareTerminalPitch(next)
    }
    play.count = { balls: line.balls, strikes: line.strikes, outs: line.outs }
    asScoringPlay(play)
  })
}
