import {
  addPlayer,
  allocatePlayer,
  applyOverride,
  applyRoster,
  baseIds,
  battingSide,
  canSwitchBatter,
  createIdentityMap,
  fieldingSide,
  freshGame,
  newSetup,
  type Override,
  overrideOf,
  refOf,
  type RosterPlayer,
  validateRoster
} from './lineup'
import { type HomeRunKind, homeRunKind, isFair, PARK } from './park'
import {
  copyState,
  type GameSetup,
  type GameState,
  type Movement,
  type ResolutionOutcome
} from './state'

/**
 * Questions about a game the caller already has. Nothing here changes a game:
 * the scoring screen asks before it acts — to grey out a choice, filter a
 * list, or refuse a drag — and never works baseball out for itself.
 */

export {
  addPlayer,
  allocatePlayer,
  baseIds,
  battingSide,
  canSwitchBatter,
  createIdentityMap,
  fieldingSide,
  freshGame,
  homeRunKind,
  isFair,
  newSetup,
  overrideOf,
  PARK,
  refOf,
  validateRoster
}
export type { HomeRunKind, Override, RosterPlayer }

/** Why this roster could not be taken now, or undefined when it could. */
export function rosterError(
  state: GameState,
  setup: GameSetup,
  nextBatter?: number
): string | undefined {
  return applyRoster(state, setup, nextBatter).error
}

/** Why this correction could not be made, or undefined when it could. */
export function overrideError(
  state: GameState,
  draft: Override
): string | undefined {
  return applyOverride(state, draft).error
}

export const ADVANCE_SAFE_REASONS = [
  'Steal',
  'Wild Pitch',
  'Passed Ball',
  'Throwing Error',
  'Fielding Error',
  'Defensive Indifference',
  'Other'
] as const
export const ADVANCE_OUT_REASONS = [
  'Caught Stealing',
  'Offensive Interference',
  'Out on Appeal',
  'Other'
] as const
export const STATIONARY_OUT_REASONS = [
  'Picked Off',
  'Offensive Interference',
  'Out on Appeal',
  'Other'
] as const

/** The reasons a scorer chooses from for a runner who moved between pitches. */
export function runnerReasons(move: {
  decision?: 'safe' | 'out'
  from: number
  to: number
}): readonly string[] {
  if (move.decision === 'safe') return ADVANCE_SAFE_REASONS
  return move.from === move.to ? STATIONARY_OUT_REASONS : ADVANCE_OUT_REASONS
}

/** How many bases each hit, and an error, gives every runner. */
export const HIT_BASES: Partial<Record<ResolutionOutcome, number>> = {
  Single: 1,
  Error: 1,
  Double: 2,
  Triple: 3,
  'Home Run': 4
}

export function trajectoryLabel(angle: number): string {
  const value = Math.round(angle)
  return value >= 48
    ? 'Pop Fly'
    : value >= 35
      ? 'Fly Ball'
      : value >= 10
        ? 'Line Drive'
        : value >= -25
          ? 'Ground Ball'
          : 'Chopper'
}

export function outcomeAvailable(
  outcome: string,
  hasRunners: boolean
): boolean {
  return outcome !== "Fielder's Choice" || hasRunners
}

/** The steepest a ball can leave the bat, in degrees. */
export const MAX_LAUNCH_ANGLE = 85

/**
 * A caught ball, and a ball over the fence, left the bat at 10° or more; every
 * ball left it between -45° and MAX_LAUNCH_ANGLE.
 */
export function allowedAngle(
  angle: number,
  outcome: string,
  kind?: HomeRunKind
): number {
  return Math.round(
    Math.max(
      outcome === 'Ball Caught' ||
        (outcome === 'Home Run' && kind === 'out-of-park')
        ? 10
        : -45,
      Math.min(MAX_LAUNCH_ANGLE, angle)
    )
  )
}

/** A wild pitch or passed ball needs a ball, or a strike the catcher missed. */
export function hasEligiblePitch(state: GameState): boolean {
  const ref = state.recentPitch
  if (ref == null) return false
  const plays = [
    ...state.liveData.plays.allPlays,
    state.liveData.plays.currentPlay
  ]
  const pitch = plays.find(play => play?.about.atBatIndex === ref.atBatIndex)
    ?.playEvents[ref.index]
  return pitch?.isPitch === true && ['B', 'C', 'S'].includes(pitch.details.code)
}

export type MoreAction =
  | 'Wild Pitch'
  | 'Passed Ball'
  | 'Balk'
  | 'Put Batter on Base'
  | 'Batter Out — Other'
  | 'Place a Runner (Tiebreaker)'
  | 'Hit by Pitch'
  | 'Intentional Walk'
  | "Catcher's Interference"
  | 'Dropped Third Strike'

/**
 * Why one of the "more" actions cannot happen now, as far as the game goes, or
 * undefined when it can. The screen adds its own reasons — a play still being
 * drawn, a gesture in progress — before it asks this.
 */
export function moreEligibility(
  state: GameState,
  action: MoreAction
): string | undefined {
  if (action === 'Put Batter on Base' && baseIds(state).some(id => id != null))
    return 'Requires empty bases'
  if (state.liveData.plays.currentPlay == null)
    return 'Choose the next batter first'
  if (
    action === 'Dropped Third Strike' &&
    (state.liveData.linescore.strikes !== 2 ||
      (baseIds(state)[0] != null && state.liveData.linescore.outs < 2))
  )
    return 'Requires two strikes and first empty or two outs'
  if (
    (action === 'Wild Pitch' || action === 'Passed Ball') &&
    !hasEligiblePitch(state)
  )
    return 'Record an eligible pitch first'
  if (
    ['Wild Pitch', 'Passed Ball', 'Balk'].includes(action) &&
    !baseIds(state).some(id => id != null)
  )
    return 'No runners on base'
}

/** Some runner on the play has no base yet: the batter's choice is open. */
export function choiceOpen(state: GameState): boolean {
  return (
    state.pending != null &&
    state.liveData.linescore.outs < 3 &&
    state.pending.movements.some(
      move => move.to < 4 && move.decision === 'pending'
    )
  )
}

/**
 * Why a runner may not be called safe at `to`, or undefined when he may.
 * During the batter's choice the trailing runners must stay behind him;
 * otherwise the base must be free and nobody may be passed.
 */
export function runnerDecisionError(
  state: GameState,
  move: { playerId: number; from: number; to: number }
): string | undefined {
  if (move.to === 0) return 'The batter must reach a base to be safe.'
  const bases = baseIds(state)
  if (!choiceOpen(state)) {
    if (bases[move.to - 1] != null && bases[move.to - 1] !== move.playerId)
      return 'That base is occupied. Move the lead runner first.'
    if (
      bases.some(
        (id, index) =>
          id != null &&
          id !== move.playerId &&
          index + 1 > move.from &&
          index + 1 < move.to
      )
    )
      return 'Move the lead runner first; runners cannot pass each other.'
  } else {
    const trailing = (state.pending?.movements ?? []).filter(
      other =>
        other.playerId !== move.playerId &&
        other.decision !== 'out' &&
        other.from < move.from
    )
    if (trailing.some(other => other.to >= move.to && move.to < 4))
      return 'Choose a base ahead of the trailing runners.'
  }
}

/**
 * Sending the lead runner headed home back to third, and every runner behind
 * him back one base where he must: the movements that would leave, or null
 * when some runner behind him cannot give ground.
 */
export function homeBackProposal(state: GameState): Movement[] | null {
  const pending = state.pending
  const id = state.homeQueue[0]
  if (pending == null || id == null) return null
  const moves = copyState(pending.movements)
  const lead = moves.find(move => move.playerId === id)
  if (lead == null || lead.force || lead.from === 0) return null
  lead.to = 3
  lead.decision = 'safe'
  lead.resolved = true
  let previous = 3
  for (const move of moves
    .filter(
      move =>
        move.playerId !== id && move.decision !== 'out' && move.from < lead.from
    )
    .sort((a, b) => b.from - a.from)) {
    if (move.to < previous) {
      previous = move.to
      continue
    }
    if (move.from === 0 || move.resolved === true) return null
    const to = previous - 1
    const minimum = pending.originalBases
      .slice(0, move.from)
      .every(other => other != null)
      ? move.from + 1
      : move.from
    if (to < minimum || to < move.to - 1) return null
    move.to = to
    move.decision = to === 4 ? 'pending' : 'safe'
    previous = to
  }
  const occupied = moves
    .filter(move => move.decision !== 'out' && move.to > 0 && move.to < 4)
    .map(move => move.to)
  return new Set(occupied).size === occupied.length ? moves : null
}

/** The batter has been put out on this play. */
export function batterRetired(state: GameState): boolean {
  const batter = state.liveData.plays.currentPlay?.matchup.batter.id
  return (
    state.pending?.movements.some(
      move => move.playerId === batter && move.decision === 'out'
    ) === true
  )
}

/**
 * The runner on `from` is forced to the next base: the batter is still
 * running on a ball in play he has not been put out on, and every base
 * behind the runner was taken when the ball was hit by a runner who has not
 * been put out on this play. Once a runner behind him is out, he must be
 * tagged.
 */
export function forcedFrom(state: GameState, from: number): boolean {
  const pending = state.pending
  if (pending == null || from < 1 || from > 3 || batterRetired(state))
    return false
  const batterRunning =
    pending.outcome === 'Throw Out' ||
    (["Fielder's Choice", 'Error'].includes(pending.outcome) &&
      pending.movements.some(
        move => move.from === 0 && move.decision !== 'out'
      ))
  const out = new Set(
    pending.movements
      .filter(move => move.decision === 'out')
      .map(move => move.playerId)
  )
  return (
    batterRunning &&
    pending.originalBases.slice(0, from).every(id => id != null && !out.has(id))
  )
}

export type Decision =
  | 'awaitingBatter'
  | 'ready'
  | 'batterOut'
  | 'resolveBatter'
  | 'errorAttribution'
  | 'homeDecision'
  | 'close'
  | 'final'

/**
 * What the game is waiting to be told next. `batterOut`: who put the batter
 * out. `resolveBatter`: where the batter and the runners behind the play went.
 * `errorAttribution`: who made the error. `homeDecision`: whether the lead
 * runner headed home was safe. `close`: the play is decided and only needs
 * closing.
 */
export function nextDecision(state: GameState): Decision {
  if (state.final) return 'final'
  const pending = state.pending
  const outs = state.liveData.linescore.outs
  if (pending == null)
    return state.awaitingBatter != null ? 'awaitingBatter' : 'ready'
  if (
    outs < 3 &&
    ['Throw Out', 'Batter Interference', 'Batter Out — Other'].includes(
      pending.outcome
    ) &&
    !batterRetired(state)
  )
    return 'batterOut'
  if (choiceOpen(state)) return 'resolveBatter'
  if (pending.errorPending === true) return 'errorAttribution'
  if (state.homeQueue.length > 0 && outs < 3) return 'homeDecision'
  return 'close'
}

/**
 * A ball is in play and its result has not been given, so only more about the
 * ball or its result can follow — not a pitch.
 */
export function awaitingResult(state: GameState): boolean {
  return (
    state.pending == null &&
    state.liveData.plays.currentPlay?.playEvents.at(-1)?.details.code === 'X'
  )
}

/**
 * A decided play closes itself when there is nothing left a scorer would
 * correct: an award, nobody left on base, or the third out.
 */
export function closesAutomatically(state: GameState): boolean {
  return (
    nextDecision(state) === 'close' &&
    (state.pending?.automaticAward === true ||
      baseIds(state).every(id => id == null) ||
      state.liveData.linescore.outs >= 3)
  )
}
