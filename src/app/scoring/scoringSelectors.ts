import {
  baseIds,
  battingSide,
  canSwitchBatter,
  fieldingSide,
  refOf
} from '../../common/scoring/rules'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { ScoreboardState } from '../field/scoreboardModel'
import type { ScoringSessionState, ScoringSnapshot } from './scoringTypes'

/**
 * What the screen shows and when it lets the scorer act. Who is where, and
 * who bats and fields, are the scoring library's answers, asked here.
 */
export { baseIds, battingSide, canSwitchBatter, fieldingSide }
export const playerRef = refOf

export function scoreboardFor(session: ScoringSessionState): ScoreboardState {
  const board = scoreboardOfGame(session)
  // Field labels already carry short names; keep the entire supplied name.
  const person = (
    fullName: string
  ): { firstName: string; lastName: string } => ({
    firstName: fullName,
    lastName: ''
  })
  return {
    awayTeam: session.gameData.teams.away.name,
    homeTeam: session.gameData.teams.home.name,
    awayScore: board.awayScore,
    homeScore: board.homeScore,
    batter: person(board.batterName),
    pitcher: person(board.pitcherName),
    pitchCount: board.numPitches,
    balls: board.balls,
    strikes: board.strikes,
    outs: board.outs,
    inning: board.inning,
    half: board.half === 'bottom' ? 'bottom' : 'top'
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
