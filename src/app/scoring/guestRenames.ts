import type { RosterEntry, TeamStationClient } from '../../common/api'
import type { GameState } from '../../common/scoring/state'

/** A game-only player whose name a roster draft corrected. */
export interface GuestRename {
  gumboId: number
  firstName: string
  lastName: string
}

/**
 * The game-only players whose names `draft` corrects (`editLocalPlayerDraft`)
 * against the game it was opened over: each one in both, game-only in the
 * draft, named otherwise. A guest the draft made is named already.
 */
export function guestRenames(
  before: GameState,
  draft: GameState
): GuestRename[] {
  const renames: GuestRename[] = []
  for (const [key, player] of Object.entries(draft.gameData.players)) {
    const was = before.gameData.players[Number(key)]
    if (was == null || !player.local) continue
    const first = (player.firstName ?? '').trim()
    const last = (player.lastName ?? '').trim()
    if (
      was.fullName === player.fullName &&
      (was.firstName ?? '').trim() === first &&
      (was.lastName ?? '').trim() === last
    )
      continue
    if (first === '' && last === '') continue
    renames.push({ gumboId: player.id, firstName: first, lastName: last })
  }
  return renames
}

/**
 * Sends each correction to the guest's account, in order, before the setup
 * that shows it is saved: a game's players are named from their accounts,
 * so the setup alone would not keep it. A guest whose account this screen
 * does not know is refused, as his name could not be kept.
 */
export async function sendGuestRenames(
  client: Pick<TeamStationClient, 'renameGuestPlayer'>,
  gameId: string,
  renames: readonly GuestRename[],
  guests: Iterable<Pick<RosterEntry, 'userId' | 'gumboId'>>
): Promise<void> {
  const userOf = new Map<number, string>()
  for (const guest of guests)
    if (guest.gumboId != null) userOf.set(guest.gumboId, guest.userId)
  for (const rename of renames) {
    const userId = userOf.get(rename.gumboId)
    if (userId == null)
      throw new Error(
        "This game-only player's name cannot be corrected here. Open the game again and try once more."
      )
    await client.renameGuestPlayer(
      gameId,
      userId,
      { firstName: rename.firstName, lastName: rename.lastName },
      rename.gumboId
    )
  }
}
