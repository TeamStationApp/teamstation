import type { Kysely } from 'kysely'

import type { RosterEntry } from '../../common/api'
import { shortNames } from '../../common/names'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { teamWalkUpSongs } from '../routes/walkUpSongs'

/** A roster entry as sent: a fan's has no `walkUpSong`. */
export type RosterRow = Omit<RosterEntry, 'walkUpSong'> &
  Partial<Pick<RosterEntry, 'walkUpSong'>>

/**
 * Who is on a team. Every viewer who can see the team reads the same answer;
 * a fan, who only follows it, reads less of it (`view: 'fan'`).
 *
 * Everybody reads short names, coaches and administrators included. The whole
 * name is never on a roster: it is only behind `GET /players/:userId/name`,
 * for the person editing it.
 *
 * Each entry carries the person's walk-up song on this team, or `null`: a
 * song belongs to a player's place on a team, so the same child reads
 * another team's song only on that team's roster.
 *
 * A fan reads the coaches and the players and nobody else: not the people
 * who only follow the team or can watch it — parents among them — and no
 * walk-up songs. Their entries carry no `walkUpSong` key at all.
 */
export async function teamRoster(
  db: Kysely<Database>,
  space: MediaContext['space'],
  teamId: string,
  view: 'full' | 'fan' = 'full'
): Promise<RosterRow[]> {
  const allRows = await db
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
  const rows =
    view === 'fan' ? allRows.filter(row => group(row) !== 'follower') : allRows

  // Everybody who may see this team but is not on it: the right can be
  // given on the team, on its season or on its league, and from the team
  // page's point of view all three are the same thing — somebody who
  // follows it. Gathered separately because they have no membership row.
  const followerRows =
    view === 'fan'
      ? []
      : await db
          .selectFrom('season_members')
          .innerJoin('users', 'users.id', 'season_members.user_id')
          .innerJoin(
            'season_teams',
            'season_teams.season_id',
            'season_members.season_id'
          )
          .select([
            'users.id as userId',
            'users.display_name as displayName',
            'users.first_name as firstName',
            'users.last_name as lastName',
            'users.bats as bats',
            'users.throws as throws',
            'users.avatar_path as avatarPath'
          ])
          .where('season_teams.team_id', '=', teamId)
          .where('users.merged_into', 'is', null)
          .distinct()
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

  const songs = view === 'fan' ? new Map() : await teamWalkUpSongs(db, teamId)

  const onTheTeam = new Set(rows.map(row => row.userId))
  const followers = followerRows.filter(row => !onTheTeam.has(row.userId))
  const followerNames = shortNames(
    followers.map(row => ({
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName
    }))
  )

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
        ...(view === 'fan' ? {} : { walkUpSong: songs.get(row.userId) ?? null })
      }))
      .sort((a, b) => {
        const byGroup =
          order[a.group as keyof typeof order] -
          order[b.group as keyof typeof order]
        if (byGroup !== 0) return byGroup
        return a.shortName.localeCompare(b.shortName)
      }),
    ...followers
      .map(row => ({
        userId: row.userId,
        bats: row.bats,
        throws: row.throws,
        shortName: followerNames.get(row.userId) ?? row.displayName,
        avatarUrl: imageUrl(space, row.avatarPath),
        jersey: null,
        positions: [] as string[],
        isPlayer: false,
        role: 'member',
        group: 'follower',
        walkUpSong: null
      }))
      .sort((a, b) => a.shortName.localeCompare(b.shortName))
  ]
}

/**
 * Coaches, then players, then followers. A person appears once, in the first
 * group that fits: somebody who coaches and is also a parent is a coach,
 * which is what they are here for.
 */
function group(row: { role: string; isPlayer: boolean }): string {
  return row.role === 'owner' || row.role === 'manager'
    ? 'coach'
    : row.isPlayer
      ? 'player'
      : 'follower'
}
