import {
  applyAwardMovements,
  prepareBatterResult,
  recordRunner,
  settleRunners
} from './runnerRules'
import { moreEvents } from './scoringContract'
import { accepted, snapshotOf } from './scoringMachine'
import {
  baseIds,
  battingSide,
  fieldingSide,
  playerRef
} from './scoringSelectors'
import type { Movement, ScoringEvent, ScoringState } from './scoringTypes'
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
      'Strike Three, Not Caught'
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
export function hasEligiblePitch(state: ScoringState): boolean {
  const ref = state.recentPitch
  if (ref == null) return false
  const plays = [
    ...state.session.liveData.plays.allPlays,
    state.session.liveData.plays.currentPlay
  ]
  const pitch = plays.find(play => play?.about.atBatIndex === ref.atBatIndex)
    ?.playEvents[ref.index]
  return pitch?.isPitch === true && ['B', 'C', 'S'].includes(pitch.details.code)
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
  if (
    action === 'Put Batter on Base' &&
    baseIds(state.session).some(id => id != null)
  )
    return 'Requires empty bases'
  if (state.session.liveData.plays.currentPlay == null)
    return 'Choose the next batter first'
  if (
    action === 'Strike Three, Not Caught' &&
    (state.session.liveData.linescore.strikes !== 2 ||
      (baseIds(state.session)[0] != null &&
        state.session.liveData.linescore.outs < 2))
  )
    return 'Requires two strikes and first empty or two outs'
  if (
    (action === 'Wild Pitch' || action === 'Passed Ball') &&
    !hasEligiblePitch(state)
  )
    return 'Record an eligible pitch first'
  if (
    ['Wild Pitch', 'Passed Ball', 'Balk'].includes(action) &&
    !baseIds(state.session).some(id => id != null)
  )
    return 'No runners on base'
}
export function recordMoreEvent(
  state: ScoringState,
  action: MoreAction,
  isPitch = false
): void {
  const play = state.session.liveData.plays.currentPlay!
  const line = state.session.liveData.linescore
  play.playEvents.push({
    index: play.playEvents.length,
    isPitch,
    type: isPitch ? 'pitch' : 'action',
    details: { description: action, code: moreEvents[action] },
    count: { balls: line.balls, strikes: line.strikes, outs: line.outs },
    player: play.matchup.pitcher
  })
  if (isPitch) {
    const counts =
      state.session.liveData.boxscore.teams[fieldingSide(state.session)]
        .pitchCounts
    counts[play.matchup.pitcher.id] = (counts[play.matchup.pitcher.id] ?? 0) + 1
  }
}
export function moreReducer(
  state: ScoringState,
  event: Extract<ScoringEvent, { type: 'MORE' }>
): ScoringState {
  const { action, base, playerId } = event.input
  if (!(action in moreEvents) || moreEligibility(state, action) != null)
    return state
  const occupied = baseIds(state.session)
  const play = state.session.liveData.plays.currentPlay!
  if (action === 'Wild Pitch' || action === 'Passed Ball')
    return {
      ...state,
      moreDraft: {
        action,
        checkpoint: snapshotOf(state),
        historyLength: state.past.length
      }
    }
  if (
    action === 'Place a Runner (Tiebreaker)' &&
    (base == null ||
      ![1, 2, 3].includes(base) ||
      occupied[base - 1] != null ||
      playerId == null ||
      playerId === play.matchup.batter.id ||
      occupied.includes(playerId) ||
      !state.session.liveData.boxscore.teams[
        battingSide(state.session)
      ].players.includes(playerId))
  )
    return state
  if (
    action === 'Put Batter on Base' &&
    (base == null || ![1, 2, 3].includes(base))
  )
    return state
  return accepted(state, action, next => {
    next.recentPitch = null
    recordMoreEvent(
      next,
      action,
      action === 'Hit by Pitch' || action === 'Strike Three, Not Caught'
    )
    const current = next.session.liveData.plays.currentPlay!
    const line = next.session.liveData.linescore
    if (action === 'Place a Runner (Tiebreaker)') {
      line.offense[(['first', 'second', 'third'] as const)[base! - 1]] =
        playerRef(next.session, playerId!)
      recordRunner(
        next,
        {
          playerId: playerId!,
          from: 0,
          to: base!,
          force: false,
          decision: 'safe'
        },
        action
      )
      return
    }
    next.pendingPlay = {
      automaticAward: [
        'Hit by Pitch',
        'Intentional Walk',
        "Catcher's Interference",
        'Balk',
        'Put Batter on Base'
      ].includes(action),
      outcome:
        action === 'Balk'
          ? 'Balk'
          : action === 'Batter Out — Other'
            ? 'Batter Out — Other'
            : action === 'Strike Three, Not Caught'
              ? 'Dropped Third Strike'
              : action === 'Put Batter on Base'
                ? 'Manual placement'
                : 'Walk',
      sameAppearance: action === 'Balk',
      originalBases: occupied,
      originalRuns: line.teams[battingSide(next.session)].runs,
      originalOuts: line.outs,
      originalRunnerRecordCount: current.runners.length,
      movements: [],
      trajectoryAccepted: true
    }
    if (action !== 'Balk') {
      current.result.event =
        action === 'Strike Three, Not Caught' ? 'Strikeout' : action
      current.result.eventType = moreEvents[action]
      current.result.description = action
      current.source.gamestation.outcome = action
    }
    if (action === 'Strike Three, Not Caught') {
      line.strikes = 3
      current.count.strikes = 3
      prepareBatterResult(next)
      return
    }
    if (action === 'Batter Out — Other') {
      next.runnerAction = {
        playerId: current.matchup.batter.id,
        from: 0,
        to: 0,
        origin: 'current',
        returnPhase: 'correctionWindow',
        decision: 'out',
        reason: action
      }
      next.phase = 'chooseThrower'
      return
    }
    const movements: Movement[] = []
    if (action === 'Balk') {
      occupied.forEach((id, index) => {
        if (id != null)
          movements.push({
            playerId: id,
            from: index + 1,
            to: index + 2,
            force: true,
            decision: index === 2 ? 'pending' : 'safe'
          })
      })
    } else if (action === 'Put Batter on Base') {
      movements.push({
        playerId: current.matchup.batter.id,
        from: 0,
        to: base!,
        force: false,
        decision: 'safe'
      })
    } else {
      movements.push({
        playerId: current.matchup.batter.id,
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
          decision: to === 4 ? 'pending' : 'safe'
        })
      })
    }
    if (next.pendingPlay.automaticAward === true)
      for (const movement of movements) {
        movement.decision = 'safe'
        movement.automaticHome = movement.to === 4
      }
    next.pendingPlay.movements = movements
    applyAwardMovements(next, action)
    next.phase = 'runnerMovement'
    settleRunners(next)
  })
}
