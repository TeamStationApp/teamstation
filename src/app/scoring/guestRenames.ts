import type { RosterEntry, TeamStationClient } from '../../common/api'
import type { GameState } from '../../common/scoring/state'
import { draftOfLocalPlayer } from './playerDraft'

/** A game-only player whose name a roster draft corrected. */
export interface GuestRename {
  gumboId: number
  firstName: string
  lastName: string
}

/**
 * The game-only players whose names `draft` corrects (`editLocalPlayerDraft`)
 * against the game it was opened over: each one in both, game-only in the
 * draft, whose trimmed first or last name differs from the halves the
 * editor started him from (`draftOfLocalPlayer`). Only the halves are
 * compared: the game names him by his short name, which the editor's whole
 * name never equals, and a game read with no halves starts him from his
 * short name split, which is no correction until it is edited. A guest the
 * draft made is named already.
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
    const shown = draftOfLocalPlayer(was)
    if (shown.firstName.trim() === first && shown.lastName.trim() === last)
      continue
    if (first === '' && last === '') continue
    renames.push({ gumboId: player.id, firstName: first, lastName: last })
  }
  return renames
}

/** A guest as Save Rosters finds his account: his user id by gumbo id. */
type GuestAccount = Pick<RosterEntry, 'userId' | 'gumboId' | 'pool'>

/**
 * Sends each correction to the guest's account, in order, before the setup
 * that shows it is saved: a game's players are named from their accounts,
 * so the setup alone would not keep it. A guest this screen does not know,
 * one another device added since it opened, is looked up once in the
 * game's guests as they are now (`lookUp`); one still unknown refuses every
 * correction before any is sent, as his name could not be kept.
 */
export async function sendGuestRenames(
  client: Pick<TeamStationClient, 'renameGuestPlayer'>,
  gameId: string,
  renames: readonly GuestRename[],
  guests: Iterable<GuestAccount>,
  lookUp?: () => Promise<Iterable<GuestAccount>>
): Promise<void> {
  const userOf = new Map<number, string>()
  // A pool player keeps their own name: nothing to send, whatever was typed.
  const pool = new Set<number>()
  const add = (from: Iterable<GuestAccount>): void => {
    for (const guest of from)
      if (guest.gumboId != null) {
        userOf.set(guest.gumboId, guest.userId)
        if (guest.pool === true) pool.add(guest.gumboId)
      }
  }
  add(guests)
  const unknown = (): boolean =>
    renames.some(rename => !userOf.has(rename.gumboId))
  if (unknown() && lookUp != null) add(await lookUp().catch(() => []))
  if (unknown())
    throw new Error(
      "This game-only player's name cannot be corrected here. Open the game again and try once more."
    )
  for (const rename of renames.filter(({ gumboId }) => !pool.has(gumboId)))
    await client.renameGuestPlayer(
      gameId,
      userOf.get(rename.gumboId)!,
      { firstName: rename.firstName, lastName: rename.lastName },
      rename.gumboId
    )
}
