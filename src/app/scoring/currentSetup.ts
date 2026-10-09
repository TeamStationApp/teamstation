import type { RosterEntry } from '../../common/api'
import { shortName } from '../../common/names'
import { awaitingResult, battingLineupKey } from '../../common/scoring/rules'
import { copyState } from '../../common/scoring/state'
import { createPlayers, type FieldPlayer } from '../field/fieldModel'
import { fieldingSide } from './scoringSelectors'
import {
  type Position,
  POSITIONS,
  type ScoringPlayer,
  type ScoringSessionState,
  type ScoringState
} from './scoringTypes'

export function missingDefense(session: ScoringSessionState): Position[] {
  const defense = session.liveData.boxscore.teams[fieldingSide(session)].defense
  return POSITIONS.filter(position => defense[position] == null)
}
export function setupEditable(state: ScoringState): boolean {
  return (
    !state.session.final &&
    ['ready', 'awaitingBatter'].includes(state.phase) &&
    state.pendingPlay == null &&
    state.session.pending == null &&
    !awaitingResult(state.session) &&
    state.runnerAction == null &&
    state.runnerDraft == null &&
    state.moreDraft == null &&
    state.presentation == null &&
    state.activeGesture !== true &&
    !state.motions.some(motion => !motion.complete)
  )
}
export function battingWarningKey(session: ScoringSessionState): string {
  return battingLineupKey(session)
}
export function lineupCountMessage(count: number): string {
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight'
  ]
  return count === 0
    ? 'No players in lineup'
    : `Only ${words[count] ?? String(count)} ${count === 1 ? 'player' : 'players'} in lineup`
}
export function defensiveRosterLabel(player: ScoringPlayer): string {
  const short = shortName({ id: player.id, displayName: player.fullName })
  const name = short === '' ? '?' : short
  const jersey = player.jersey.trim()
  return `${jersey === '' ? '' : `#${jersey} `}${name}`
}
/** Current roster details for display, without changing saved plays or lineups. */
export function withRosterDetails(
  session: ScoringSessionState,
  rosters: Readonly<Record<string, readonly RosterEntry[]>>
): ScoringSessionState {
  const players = { ...session.gameData.players }
  let changed = false
  for (const player of Object.values(players)) {
    if (player.local || player.userId == null) continue
    const entry = rosters[player.teamId]?.find(
      row => row.isPlayer && row.userId === player.userId
    )
    if (entry == null) continue
    const currentName = entry.shortName.trim()
    const fullName = currentName === '' ? player.fullName : currentName
    const jersey = entry.jersey?.trim() ?? ''
    if (fullName === player.fullName && jersey === player.jersey) continue
    players[player.id] = { ...player, fullName, jersey }
    changed = true
  }
  return changed
    ? { ...session, gameData: { ...session.gameData, players } }
    : session
}
export function assignDefender(
  session: ScoringSessionState,
  position: Position,
  id: number
): ScoringSessionState {
  const next = copyState(session)
  const team = next.liveData.boxscore.teams[fieldingSide(next)]
  if (!team.players.includes(id)) return next
  for (const slot of POSITIONS)
    if (team.defense[slot] === id) team.defense[slot] = null
  team.defense[position] = id
  return next
}
export function emptyDefensePlayers(
  session: ScoringSessionState
): FieldPlayer[] {
  const missing = missingDefense(session)
  return createPlayers()
    .filter(player => missing.includes(player.id as Position))
    .map(player => ({
      ...player,
      id: `empty-${player.id}`,
      displayName: player.id,
      name: `Assign ${player.id}`,
      jersey: '',
      emptyPosition: true
    }))
}
