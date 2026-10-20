import type { RosterEntry } from '../../common/api'
import {
  JERSEY_MAX_LENGTH,
  type NewRosterPlayer,
  PLAYER_POSITIONS as STORED_POSITIONS
} from '../../common/playerSettings'
import { asGumboId } from '../../common/userId'
import { addDevelopmentPlayer } from './developmentSession'
import type { ScoringPlayer, ScoringSessionState, Side } from './scoringTypes'

export const PLAYER_POSITIONS = [
  'P',
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF',
  'DH',
  'EH'
] as const
export interface PlayerDraft {
  firstName: string
  lastName: string
  jersey: string
  bats: 'left' | 'switch' | 'right'
  throws: 'left' | 'right' | null
  positions: string[]
}
export const emptyPlayerDraft = (): PlayerDraft => ({
  firstName: '',
  lastName: '',
  jersey: '',
  bats: 'right',
  throws: 'right',
  positions: []
})
export function playerDraftError(draft: PlayerDraft): string | undefined {
  if (`${draft.firstName}${draft.lastName}`.trim() === '')
    return 'Enter a player name.'
  if (!/^\d*$/.test(draft.jersey.trim()))
    return 'Use digits for the jersey number.'
  if (draft.jersey.trim().length > JERSEY_MAX_LENGTH)
    return `A jersey number is at most ${JERSEY_MAX_LENGTH} characters.`
}
export function addPlayerDraft(
  session: ScoringSessionState,
  side: Side,
  draft: PlayerDraft,
  playerId: number
): number {
  const error = playerDraftError(draft)
  if (error != null) throw new Error(error)
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  const id = addDevelopmentPlayer(
    session,
    side,
    playerId,
    [firstName, lastName].filter(Boolean).join(' '),
    draft.jersey.trim()
  )
  Object.assign(session.gameData.players[id], {
    firstName,
    lastName,
    bats: draft.bats,
    throws: draft.throws,
    positions: PLAYER_POSITIONS.filter(position =>
      draft.positions.includes(position)
    )
  })
  return id
}

/** The body `POST /teams/:teamId/roster-players` stores. `EH` stays on the game only. */
export function rosterPlayerBody(draft: PlayerDraft): NewRosterPlayer {
  const error = playerDraftError(draft)
  if (error != null) throw new Error(error)
  const jersey = draft.jersey.trim()
  return {
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    jersey: jersey === '' ? null : jersey,
    bats: draft.bats,
    throws: draft.throws,
    positions: STORED_POSITIONS.filter(position =>
      draft.positions.includes(position)
    )
  }
}

/**
 * Puts a player who already exists on the team into this game. `userId` is
 * the server's identity, so the person can be merged later. The typed name
 * stays on the session; the roster entry is what the edit-roster list reads.
 */
export function addRosteredPlayer(
  session: ScoringSessionState,
  side: Side,
  entry: Pick<RosterEntry, 'gumboId' | 'shortName'>,
  draft: PlayerDraft
): number {
  const error = playerDraftError(draft)
  if (error != null) throw new Error(error)
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  const id = asGumboId(entry.gumboId)
  if (!session.meta.tagOrder.includes(id)) session.meta.tagOrder.push(id)
  const team = session.liveData.boxscore.teams[side]
  const player = {
    id,
    teamId: session.gameData.teams[side].id,
    fullName: entry.shortName,
    firstName,
    lastName,
    jersey: draft.jersey.trim(),
    bats: draft.bats,
    throws: draft.throws,
    positions: PLAYER_POSITIONS.filter(position =>
      draft.positions.includes(position)
    ),
    local: false
  }
  const existing = session.gameData.players[id]
  if (existing == null) session.gameData.players[id] = player
  else Object.assign(existing, player, { id })
  if (!team.players.includes(id)) team.players.push(id)
  return id
}

export function draftOfLocalPlayer(player: ScoringPlayer): PlayerDraft {
  const [first, ...last] = player.fullName.trim().split(/\s+/)
  const hasParts =
    `${player.firstName ?? ''}${player.lastName ?? ''}`.trim() !== ''
  return {
    firstName: hasParts ? (player.firstName ?? '') : first,
    lastName: hasParts ? (player.lastName ?? '') : last.join(' '),
    jersey: player.jersey,
    bats: player.bats,
    throws: player.throws,
    positions: [...player.positions]
  }
}

/** Correct a game-only identity in place; Save Rosters persists its setup. */
export function editLocalPlayerDraft(
  session: ScoringSessionState,
  side: Side,
  id: number,
  draft: PlayerDraft
): void {
  const player = session.gameData.players[id]
  if (
    player == null ||
    !player.local ||
    !session.liveData.boxscore.teams[side].players.includes(id)
  ) {
    throw new Error('This game-only player is not on the roster.')
  }
  const error = playerDraftError(draft)
  if (error != null) throw new Error(error)
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  Object.assign(player, {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    jersey: draft.jersey.trim(),
    bats: draft.bats,
    throws: draft.throws,
    positions: PLAYER_POSITIONS.filter(position =>
      draft.positions.includes(position)
    )
  })
}
