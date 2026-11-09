import type { RosterEntry } from '../../common/api'
import { shortName } from '../../common/names'
import { gamePlayerNames } from '../../common/replay/replayNames'
import { begun } from '../../common/scoring/lineup'
import { awaitingResult, battingLineupKey } from '../../common/scoring/rules'
import {
  type DefaultLineups,
  defaultsUnaccepted,
  withVisibleDefaults
} from '../../common/scoring/startingSetup'
import { copyState, isPosition } from '../../common/scoring/state'
import { createPlayers, type FieldPlayer } from '../field/fieldModel'
import { fieldingSide } from './scoringSelectors'
import {
  type FielderRef,
  type Position,
  POSITIONS,
  type ScoringPlayer,
  type ScoringSessionState,
  type ScoringState
} from './scoringTypes'

/** Every position nobody is playing: each is drawn as a plate to fill. */
export function emptyPositions(session: ScoringSessionState): Position[] {
  const defense = session.liveData.boxscore.teams[fieldingSide(session)].defense
  return POSITIONS.filter(position => defense[position] == null)
}
/**
 * The positions scoring waits for: only the pitcher. Any other position
 * nobody is playing is played by a nameless stand-in when a ball goes there.
 */
export function missingDefense(session: ScoringSessionState): Position[] {
  return emptyPositions(session).includes('P') ? ['P'] : []
}
/**
 * The fielder a drawn player is to the game: his player id, or, for an
 * empty position's plate (`empty-SS`), that position's stand-in.
 */
export function fielderRefOf(player: {
  id: string
  playerId?: number
  standIn?: string
}): FielderRef | undefined {
  if (player.playerId != null) return player.playerId
  const position = player.standIn ?? /^empty-(.+)$/.exec(player.id)?.[1]
  return isPosition(position) ? position : undefined
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
 * read the same take another letter, the same way a roster does. A player
 * named in full only for this reader is drawn by the public label he keeps
 * beside it (`compactName`), unchanged, and everyone else breaks ties
 * against it: these are the labels the field draws.
 */
export function shortPlayerNames(
  players: Iterable<
    Pick<
      ScoringPlayer,
      | 'id'
      | 'fullName'
      | 'firstName'
      | 'lastName'
      | 'nameFormat'
      | 'compactName'
      | 'compactFormat'
    >
  >
): Map<number, string> {
  const list = [...players]
  // A compact label stands in the collision check as the public label it is,
  // so a player named here lengthens against it, as he did before full names.
  const names = gamePlayerNames(
    list.map(player =>
      player.compactName == null
        ? player
        : {
            id: player.id,
            fullName: player.compactName,
            firstName: '',
            lastName: '',
            ...(player.compactFormat == null
              ? {}
              : { nameFormat: player.compactFormat })
          }
    )
  )
  const out = new Map<number, string>()
  for (const player of list) {
    // The public label, written by the server with collisions broken.
    if (player.compactName != null) {
      out.set(player.id, player.compactName.trim())
      continue
    }
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
    // A label full only for this reader keeps the public one beside it.
    const compactName =
      currentName === '' ? player.compactName : entry.compactName
    const compactFormat =
      currentName === '' ? player.compactFormat : entry.compactFormat
    if (
      fullName === player.fullName &&
      jersey === player.jersey &&
      entry.nameFormat === player.nameFormat &&
      compactName === player.compactName &&
      compactFormat === player.compactFormat
    )
      continue
    // The format travels with the label: one without the other misreads it.
    const {
      nameFormat: _held,
      compactName: _compact,
      compactFormat: _compactFormat,
      ...rest
    } = player
    players[player.id] = {
      ...rest,
      fullName,
      jersey,
      ...(entry.nameFormat == null ? {} : { nameFormat: entry.nameFormat }),
      ...(compactName == null ? {} : { compactName }),
      ...(compactFormat == null ? {} : { compactFormat })
    }
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
  const missing = emptyPositions(session)
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
