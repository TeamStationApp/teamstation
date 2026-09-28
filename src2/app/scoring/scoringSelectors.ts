import {
  baseIds,
  battingSide,
  canSwitchBatter,
  fieldingSide,
  refOf
} from '../../common/scoring/rules'
import type { ScoreboardState } from '../field/scoreboardModel'
import type { PlayerRef } from './scoringContract'
import type { ScoringSessionState, ScoringSnapshot } from './scoringTypes'

/**
 * What the screen shows and when it lets the scorer act. Who is where, and
 * who bats and fields, are the scoring library's answers, asked here.
 */
export { baseIds, battingSide, canSwitchBatter, fieldingSide }
export const playerRef = refOf

export function scoreboardFor(session: ScoringSessionState): ScoreboardState {
  const line = session.liveData.linescore
  // Field labels already carry short names; keep the entire supplied name.
  const person = (
    ref: PlayerRef | null
  ): { firstName: string; lastName: string } => ({
    firstName: ref?.fullName ?? '',
    lastName: ''
  })
  const pitcher = line.defense.P
  return {
    awayTeam: session.gameData.teams.away.name,
    homeTeam: session.gameData.teams.home.name,
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs,
    batter: person(line.offense.batter),
    pitcher: person(pitcher),
    pitchCount:
      pitcher == null
        ? 0
        : (session.liveData.boxscore.teams[fieldingSide(session)].pitchCounts[
            pitcher.id
          ] ?? 0),
    balls: line.balls,
    strikes: line.strikes,
    outs: line.outs,
    inning: line.currentInning,
    half: line.inningState === 'Bottom' ? 'bottom' : 'top'
  }
}

/** Bottom scoring actions remain locked until every current-play interaction settles. */
export function bottomActionsAllowed(state: ScoringSnapshot): boolean {
  return (
    state.phase === 'ready' &&
    state.presentation == null &&
    state.activeGesture !== true &&
    state.runnerAction == null &&
    state.runnerDraft == null &&
    state.moreDraft == null &&
    !state.motions.some(motion => !motion.complete)
  )
}
