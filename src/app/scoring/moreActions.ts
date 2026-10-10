import { shortName } from '../../common/scoring/actions'
import { moreEligibility as gameEligibility } from '../../common/scoring/rules'
import { moreEvents } from './scoringContract'
import { accepted, act, settleRunners } from './scoringFlow'
import { checkpointsFor, draftAt } from './scoringMachine'
import type { ScoringEvent, ScoringState } from './scoringTypes'

/**
 * The "more" menu: the things that happen at the plate or between pitches
 * without a ball in play. The game decides what each one does; the screen
 * adds its own reason to wait, and drafts the runner a wild pitch moved.
 */
export const MORE_GROUPS = [
  { label: 'Between pitches', actions: ['Balk'] },
  {
    label: "Didn't see it",
    actions: [
      'Put Batter on Base',
      'Batter Out — Other',
      'Place a Runner (Tiebreaker)'
    ]
  },
  {
    label: 'This pitch',
    actions: [
      'Hit by Pitch',
      'Intentional Walk',
      "Catcher's Interference",
      'Dropped Third Strike'
    ]
  }
] as const
export type MoreAction = keyof typeof moreEvents
export interface MoreInput {
  action: MoreAction
  base?: number
  playerId?: number
  destinations?: Record<number, number>
}
export function moreEligibility(
  state: ScoringState,
  action: MoreAction
): string | undefined {
  if (
    state.phase !== 'ready' ||
    state.moreDraft != null ||
    state.runnerDraft != null ||
    state.activeGesture === true ||
    state.motions.some(m => !m.complete)
  )
    return 'Finish the current play first'
  return gameEligibility(state.session, action)
}
export function moreReducer(
  state: ScoringState,
  event: Extract<ScoringEvent, { type: 'MORE' }>
): ScoringState {
  const { action, base, playerId } = event.input
  if (!(action in moreEvents) || moreEligibility(state, action) != null)
    return state
  if (action === 'Wild Pitch' || action === 'Passed Ball')
    return {
      ...state,
      moreDraft: { action, ...draftAt(state) },
      checkpoints: checkpointsFor(state)
    }
  const bases = ['1B', '2B', '3B'] as const
  if (
    (action === 'Place a Runner (Tiebreaker)' ||
      action === 'Put Batter on Base') &&
    (base == null || ![1, 2, 3].includes(base))
  )
    return state
  if (action === 'Place a Runner (Tiebreaker)' && playerId == null) return state
  const runner =
    playerId == null ? undefined : state.session.gameData.players[playerId]
  const label =
    action === 'Place a Runner (Tiebreaker)'
      ? `Place ${runner == null ? `Player ${playerId}` : (runner.fullName ?? shortName(runner))} on ${bases[base! - 1]}`
      : action
  return accepted(state, label, next => {
    const batter = next.session.liveData.plays.currentPlay!.matchup.batter.id
    if (action === 'Place a Runner (Tiebreaker)') {
      act(next, {
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: playerId!,
        base: bases[base! - 1]
      })
      next.motions = []
      return
    }
    if (action === 'Balk') act(next, { type: 'batteryEvent', kind: 'balk' })
    else if (action === 'Put Batter on Base')
      act(next, {
        type: 'result',
        eventType: 'manual_placement',
        base: bases[base! - 1]
      })
    else if (action === 'Dropped Third Strike')
      act(next, { type: 'result', eventType: 'strikeout' })
    else if (action === 'Batter Out — Other') {
      act(next, { type: 'result', eventType: 'other_out' })
      next.runnerAction = {
        playerId: batter,
        from: 0,
        to: 0,
        origin: 'current',
        returnPhase: 'correctionWindow',
        decision: 'out',
        reason: action
      }
      next.phase = 'chooseThrower'
      return
    } else
      act(next, {
        type: 'result',
        eventType: moreEvents[action]
      })
    next.phase = 'runnerMovement'
    settleRunners(next)
  })
}
