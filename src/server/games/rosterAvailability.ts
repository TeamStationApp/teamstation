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
import { compactFields, readerNaming } from '../groups/playerNamePrivacy'
import { resolveGumboIds } from '../scoring/gumboIds'
import { teamRoster } from '../teams/teamRoster'
import { withdrawnLabels } from '../users/nameBook'
import type { Reader } from '../users/readerNames'
import { withdrawnUserId } from './withdrawn'

/** Both teams' rosters only when asked for: `null` otherwise. */
export interface GameAvailability<Rostered extends boolean = boolean> {
  guests: Guests
  unrostered: Unrostered
  guestPlayers: Record<Side, RosterEntry[]>
  roster: Rostered extends true ? Record<Side, RosterEntry[]> : null
}

/**
 * Both membership and game-only identities are read through their surviving
 * accounts. A reader that shows the game, not its lineups, passes
 * `roster: false` and reads neither team's roster. The guests `options.reader`
 * may read in full are named in full, with the public label beside
 * (`compactName`, `compactFormat`); a write passes no reader.
 */
export async function gameAvailability<Rostered extends boolean>(
  db: Kysely<Database>,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    guests: unknown
    unrostered: unknown
    currentPlay: unknown
    pregame?: unknown
  },
  options: { roster: Rostered; reader?: Reader }
): Promise<GameAvailability<Rostered>> {
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
  const naming = await readerNaming(db, people, options.reader)
  const { names, formats } = naming
  // A rejected pool player who played stays a guest, under the placeholder.
  const withdrawn =
    (await withdrawnLabels(db, [game.id])).get(game.id) ??
    new Map<number, string>()
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
      const label = withdrawn.get(id) ?? withdrawn.get(original)
      guestPlayers[side].push(
        asRosterEntry({
          // A withdrawn line carries no account: scoring reads it by gumbo id.
          userId: label == null ? user.id : withdrawnUserId(game.id, id),
          gumboId: id,
          shortName: label ?? names.get(user.id)!,
          // A placeholder is no name to format.
          nameFormat:
            label != null ||
            formats.get(user.id) === DEFAULT_PLAYER_NAME_PRIVACY
              ? undefined
              : formats.get(user.id),
          ...(label != null
            ? {}
            : compactFields(naming, {
                id: user.id,
                displayName: user.display_name,
                firstName: user.first_name,
                lastName: user.last_name
              })),
          jersey: detail?.jersey ?? held?.jersey ?? null,
          positions: detail?.positions ?? held?.positions ?? [],
          bats: label == null ? user.bats : null,
          throws: label == null ? user.throws : null,
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
  const roster = options.roster
    ? await Promise.all([
        teamRoster(db, undefined, game.away_team_id),
        teamRoster(db, undefined, game.home_team_id)
      ]).then(([away, home]) => ({ away, home }))
    : null
  return {
    guests,
    unrostered,
    guestPlayers,
    roster: roster as GameAvailability<Rostered>['roster']
  }
}
