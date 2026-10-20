import type { RosterEntry } from '../common/api'
import { shortName } from '../common/names'
import {
  asNewRosterPlayer,
  type NewRosterPlayer
} from '../common/playerSettings'
import { userIdOfGumbo } from '../common/userId'

let nextUserId = 8_800_001

/** A roster entry for a player a test just created, with a fresh user id. */
export function mintedRosterEntry(
  player: NewRosterPlayer,
  userId = nextUserId++
): RosterEntry {
  const displayName = [player.firstName, player.lastName]
    .filter(part => part !== '')
    .join(' ')
  return {
    userId: userIdOfGumbo(userId),
    gumboId: userId,
    shortName: shortName({
      id: userId,
      firstName: player.firstName,
      lastName: player.lastName,
      displayName
    }),
    nameDetails: {
      firstName: player.firstName === '' ? null : player.firstName,
      lastName: player.lastName === '' ? null : player.lastName,
      displayName
    },
    avatarUrl: null,
    jersey: player.jersey,
    positions: [...player.positions],
    isPlayer: true,
    role: 'member',
    bats: player.bats,
    throws: player.throws,
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    walkUpSong: null
  }
}

/** The same, from the JSON a Create Player form posts. */
export function rosterEntryFromBody(raw: unknown): RosterEntry {
  return mintedRosterEntry(asNewRosterPlayer(raw))
}
