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
}
export function addPlayerDraft(
  session: ScoringSessionState,
  side: Side,
  draft: PlayerDraft
): number {
  const error = playerDraftError(draft)
  if (error != null) throw new Error(error)
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  const id = addDevelopmentPlayer(
    session,
    side,
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
    player.userId != null ||
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
