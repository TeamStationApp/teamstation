import type { PlayerDraft } from '../app/scoring/playerDraft'
import { asRosterEntry, type RosterEntry } from '../common/api'
import type { Side } from '../common/scoring/state'

/** A deterministic stand-in for successful guest creation in UI unit tests. */
export function guestCreator(firstId = 9000000) {
  let nextId = firstId
  return async (_side: Side, player: PlayerDraft): Promise<RosterEntry> =>
    asRosterEntry({
      ...player,
      userId: nextId++,
      shortName: `${player.firstName} ${player.lastName}`.trim(),
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
}
