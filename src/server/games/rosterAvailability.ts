import type { Kysely } from 'kysely'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { type Guests, storedGuests } from '../../common/guests'
import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { recordOf } from '../../common/scoring/gumbo'
import type { Side } from '../../common/scoring/state'
import { teamsOfRow } from '../../common/teamLists'
import { storedUnrostered, type Unrostered } from '../../common/unroster'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { formatForReader, publicFormats } from '../groups/playerNamePrivacy'
import { resolveGumboIds } from '../scoring/gumboIds'
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
    pregame?: unknown
  }
): Promise<GameAvailability> {
  const guests = storedGuests(game.guests, teamsOfRow(game))
  const unrostered = storedUnrostered(game.unrostered, teamsOfRow(game))
  const all = [
    ...guests.away,
    ...guests.home,
    ...unrostered.away,
    ...unrostered.home
  ]
  const resolved = await resolveGumboIds(db, all)
  const resolve = (id: number): number => resolved.get(id)!
  const originalGuests = [...new Set([...guests.away, ...guests.home])]
  const profiles =
    originalGuests.length === 0
      ? []
      : await db
          .selectFrom('gumbo_ids')
          .innerJoin('users', 'users.id', 'gumbo_ids.user_id')
          .selectAll('users')
          .select('gumbo_id')
          .where('gumbo_id', 'in', [...new Set(originalGuests.map(resolve))])
          .execute()
  const details =
    originalGuests.length === 0
      ? []
      : await db
          .selectFrom('game_guest_details')
          .innerJoin(
            'gumbo_ids',
            'gumbo_ids.user_id',
            'game_guest_details.user_id'
          )
          .selectAll('game_guest_details')
          .select('gumbo_id')
          .where('game_id', '=', game.id)
          .execute()
  // Older guests keep the jersey/positions from their most recent stored setup.
  const records =
    originalGuests.length === 0
      ? []
      : [
          game.currentPlay,
          ...(await readPlays(db, game.id)).reverse().map(row => row.gumbo),
          // The lineups the game began with: older than any play.
          ...(game.pregame == null ? [] : [{ teamStation: game.pregame }])
        ]
          .map(play => recordOf(play, teamsOfRow(game)))
          .filter(record => record != null)
  const guestPlayers: GameAvailability['guestPlayers'] = { away: [], home: [] }
  const teamOf = new Map(
    (['away', 'home'] as const).flatMap(side =>
      guests[side].map(
        original =>
          [
            resolve(original),
            side === 'away' ? game.away_team_id : game.home_team_id
          ] as const
      )
    )
  )
  const people = profiles.map(user => ({
    person: {
      id: user.id,
      displayName: user.display_name,
      firstName: user.first_name,
      lastName: user.last_name
    },
    teamId: teamOf.get(user.gumbo_id)
  }))
  const formats = await publicFormats(db, people)
  const names = formatForReader(
    people.map(({ person }) => ({ person, format: formats.get(person.id)! }))
  )
  for (const side of ['away', 'home'] as const) {
    for (const original of guests[side]) {
      const id = resolve(original)
      if (guestPlayers[side].some(row => row.gumboId === id)) continue
      const user = profiles.find(row => row.gumbo_id === id)!
      const held = records
        .map(record => record.setupBefore.players[original])
        .find(player => player != null)
      const detail =
        details.find(row => row.gumbo_id === id) ??
        details.find(row => row.gumbo_id === original)
      guestPlayers[side].push(
        asRosterEntry({
          userId: user.id,
          gumboId: id,
          shortName: names.get(user.id)!,
          nameFormat:
            formats.get(user.id) === DEFAULT_PLAYER_NAME_PRIVACY
              ? undefined
              : formats.get(user.id),
          jersey: detail?.jersey ?? held?.jersey ?? null,
          positions: detail?.positions ?? held?.positions ?? [],
          bats: user.bats,
          throws: user.throws,
          isPlayer: true,
          ...(detail?.pool === true ? { pool: true } : {}),
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
