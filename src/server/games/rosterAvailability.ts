import type { Kysely } from 'kysely'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { asGuests, type Guests } from '../../common/guests'
import { shortNames } from '../../common/names'
import { recordOf } from '../../common/scoring/gumbo'
import type { Side } from '../../common/scoring/state'
import { asUnrostered, type Unrostered } from '../../common/unroster'
import { survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { teamRoster } from '../teams/teamRoster'

export interface GameAvailability {
  guests: Guests
  unrostered: Unrostered
  guestPlayers: Record<Side, RosterEntry[]>
  roster: Record<Side, RosterEntry[]>
}

/** Both membership and game-only identities are read through their surviving accounts. */
export async function gameAvailability(
  db: Kysely<Database>,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    guests: unknown
    unrostered: unknown
    currentPlay: unknown
  }
): Promise<GameAvailability> {
  const guests = asGuests(game.guests)
  const unrostered = asUnrostered(game.unrostered)
  const all = [
    ...guests.away,
    ...guests.home,
    ...unrostered.away,
    ...unrostered.home
  ]
  const resolved = await survivorsOf(db, all)
  const resolve = (id: number): number => resolved.get(id)!
  const originalGuests = [...new Set([...guests.away, ...guests.home])]
  const profiles =
    originalGuests.length === 0
      ? []
      : await db
          .selectFrom('users')
          .selectAll()
          .where('id', 'in', [...new Set(originalGuests.map(resolve))])
          .execute()
  const details =
    originalGuests.length === 0
      ? []
      : await db
          .selectFrom('game_guest_details')
          .selectAll()
          .where('game_id', '=', game.id)
          .execute()
  // Older guests keep the jersey/positions from their most recent stored setup.
  const records =
    originalGuests.length === 0
      ? []
      : [
          game.currentPlay,
          ...(await readPlays(db, game.id)).reverse().map(row => row.gumbo)
        ]
          .map(recordOf)
          .filter(record => record != null)
  const guestPlayers: GameAvailability['guestPlayers'] = { away: [], home: [] }
  const names = shortNames(
    profiles.map(user => ({
      id: user.id,
      displayName: user.display_name,
      firstName: user.first_name,
      lastName: user.last_name
    }))
  )
  for (const side of ['away', 'home'] as const) {
    for (const original of guests[side]) {
      const id = resolve(original)
      if (guestPlayers[side].some(row => row.userId === id)) continue
      const user = profiles.find(row => row.id === id)!
      const held = records
        .map(record => record.setupBefore.players[original])
        .find(player => player != null)
      const detail =
        details.find(row => row.user_id === id) ??
        details.find(row => row.user_id === original)
      guestPlayers[side].push(
        asRosterEntry({
          userId: id,
          shortName: names.get(user.id)!,
          jersey: detail?.jersey ?? held?.jersey ?? null,
          positions: detail?.positions ?? held?.positions ?? [],
          bats: user.bats,
          throws: user.throws,
          isPlayer: true,
          role: 'player',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null
        })
      )
    }
    guests[side] = [...new Set(guests[side].map(resolve))]
    unrostered[side] = [...new Set(unrostered[side].map(resolve))]
  }
  const [away, home] = await Promise.all([
    teamRoster(db, undefined, game.away_team_id),
    teamRoster(db, undefined, game.home_team_id)
  ])
  return { guests, unrostered, guestPlayers, roster: { away, home } }
}
