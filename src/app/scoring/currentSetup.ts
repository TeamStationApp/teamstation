import type { RosterEntry } from '../../common/api'
import { shortName, shortNames } from '../../common/names'
import { begun } from '../../common/scoring/lineup'
import { awaitingResult, battingLineupKey } from '../../common/scoring/rules'
import {
  type DefaultLineups,
  defaultsUnaccepted,
  withVisibleDefaults
} from '../../common/scoring/startingSetup'
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
/**
 * Whether the game holds its lineups: it has recorded something, a roster
 * saved or a pitch, or has plays. Before that the screen shows the lineups
 * the game would start with, from the teams' default lineups or rosters, and
 * the scorekeeper accepts them by saving them, changed or not.
 */
export function lineupsHeld(state: ScoringState): boolean {
  return (
    state.log.length > 0 || state.session.liveData.plays.allPlays.length > 0
  )
}

/**
 * The screen's game with each default he can read standing in for a side
 * that is still an unseen roster order, before the first pitch.
 */
export function withVisibleLineups(
  state: ScoringState,
  defaults: DefaultLineups
): ScoringState {
  const session = withVisibleDefaults(state.session, state.log, defaults)
  return session === state.session ? state : { ...state, session }
}

/**
 * Whether Save Rosters accepts the lineup as it stands. A new game is not
 * accepted yet. Before the first pitch, neither is a side still held as the
 * roster order a save left when he can read that team's default.
 */
export function lineupsUnaccepted(
  state: ScoringState,
  defaults: DefaultLineups
): boolean {
  return (
    !lineupsHeld(state) ||
    (!begun(state.session) && defaultsUnaccepted(state.log, defaults))
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
export function defensiveRosterName(player: ScoringPlayer): string {
  // Nonlocal labels come from the roster, which already resolves collisions.
  // Name parts may remain for editing; never use them to shorten that label.
  const name = player.local
    ? shortName({
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        displayName: player.fullName
      })
    : player.fullName.trim()
  return name === '' ? '?' : name
}

/**
 * First name and last initial for everyone drawn from a game. A stored label
 * may already be that short name, or the whole name; two players who would
 * read the same take another letter, the same way a roster does.
 */
export function shortPlayerNames(
  players: Iterable<
    Pick<ScoringPlayer, 'id' | 'fullName' | 'firstName' | 'lastName'>
  >
): Map<number, string> {
  const list = [...players]
  const names = shortNames(
    list.map(player => ({
      id: player.id,
      firstName: player.firstName,
      lastName: player.lastName,
      displayName: player.fullName
    }))
  )
  const out = new Map<number, string>()
  for (const player of list) {
    const stored = player.fullName.trim()
    const shown = names.get(player.id) ?? stored
    // A label that is already an initial keeps its period: `Jordan K.`.
    out.set(
      player.id,
      stored === shown || stored === `${shown}.` ? stored : shown
    )
  }
  return out
}
export function defensiveRosterLabel(player: ScoringPlayer): string {
  const name = defensiveRosterName(player)
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
    if (player.local) continue
    const entry = rosters[player.teamId]?.find(
      row => row.isPlayer && row.gumboId === player.id
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
