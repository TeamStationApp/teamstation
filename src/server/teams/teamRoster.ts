import type { Kysely } from 'kysely'

import type { RosterEntry } from '../../common/api'
import { shortNames } from '../../common/names'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { teamWalkUpSongs } from '../routes/walkUpSongs'

/**
 * Who is on a team. Every viewer reads the same answer.
 *
 * Everybody reads short names, coaches and administrators included. The whole
 * name is never on a roster: it is only behind `GET /players/:userId/name`,
 * for the person editing it.
 *
 * Each entry carries the person's walk-up song on this team, or `null`: a
 * song belongs to a player's place on a team, so the same child reads
 * another team's song only on that team's roster.
 */
export async function teamRoster(
  db: Kysely<Database>,
  space: MediaContext['space'],
  teamId: string
): Promise<RosterEntry[]> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as userId',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName',
      'users.bats as bats',
      'users.throws as throws',
      'users.avatar_path as avatarPath',
      'memberships.jersey as jersey',
      'memberships.positions as positions',
      'memberships.is_player as isPlayer',
      'memberships.role as role'
    ])
    .where('memberships.team_id', '=', teamId)
    .where('users.merged_into', 'is', null)
    .orderBy('users.display_name')
    .execute()

  // First name, last initial, worked out across the whole roster so two
  // children called Jordan do not both come out `Jordan P`.
  const names = shortNames(
    rows.map(row => ({
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName
    }))
  )

  const songs = await teamWalkUpSongs(db, teamId)

  // Coaches, then players, then followers. A person appears once, in the
  // first group that fits: somebody who coaches and is also a parent is a
  // coach, which is what they are here for.
  const group = (row: (typeof rows)[number]): string =>
    row.role === 'owner' || row.role === 'manager'
      ? 'coach'
      : row.isPlayer
        ? 'player'
        : 'follower'
  const order = { coach: 0, player: 1, follower: 2 }

  return [
    ...rows
      .map(row => ({
        userId: row.userId,
        bats: row.bats,
        throws: row.throws,
        shortName: names.get(row.userId) ?? row.displayName,
        avatarUrl: imageUrl(space, row.avatarPath),
        jersey: row.jersey,
        positions: row.positions,
        isPlayer: row.isPlayer,
        role: row.role,
        group: group(row),
        walkUpSong: songs.get(row.userId) ?? null
      }))
      .sort((a, b) => {
        const byGroup =
          order[a.group as keyof typeof order] -
          order[b.group as keyof typeof order]
        if (byGroup !== 0) return byGroup
        return a.shortName.localeCompare(b.shortName)
      })
  ]
}
