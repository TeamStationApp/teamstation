import { shortName } from '../../common/names'
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
  const batter = session.liveData.linescore.offense.batter
  const pitcher = session.liveData.linescore.defense.P
  // The board's own formatter takes a first name and a last name. A stored
  // label may already be a short name, or it may be the whole name.
  const person = (
    fullName: string
  ): { firstName: string; lastName: string } => {
    const shown = shortName({ id: 0, displayName: fullName })
    const words = shown.split(/\s+/).filter(word => word !== '')
    if (words.length <= 1) return { firstName: words[0] ?? '', lastName: '' }
    return {
      firstName: words.slice(0, -1).join(' '),
      lastName: words[words.length - 1] ?? ''
    }
  }
  return {
    awayTeam: session.gameData.teams.away.name,
    homeTeam: session.gameData.teams.home.name,
    awayScore: board.awayScore,
    homeScore: board.homeScore,
    batter: person(board.batterName),
    batterHits: board.batterNumHits,
    batterAtBats: board.batterAtBats,
    batterJersey:
      batter == null ? undefined : session.gameData.players[batter.id]?.jersey,
    pitcher: person(board.pitcherName),
    pitcherJersey:
      pitcher == null
        ? undefined
        : session.gameData.players[pitcher.id]?.jersey,
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
