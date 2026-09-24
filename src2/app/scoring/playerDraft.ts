import { addDevelopmentPlayer } from './developmentSession'
import type { ScoringSessionState, Side } from './scoringTypes'

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
  throws: 'left' | 'right'
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
