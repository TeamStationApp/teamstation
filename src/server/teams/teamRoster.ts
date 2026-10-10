import { type Kysely, sql } from 'kysely'

import type { RosterEntry, RosterSection } from '../../common/api'
import { shortNames } from '../../common/names'
import { type Role, ROLE_FLAGS } from '../../common/roles'
import {
  givenRoleLevelsOnTeam,
  guardiansOf,
  membersAboveTeam,
  type RoleLevel
} from '../access'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { teamWalkUpSongs } from '../routes/walkUpSongs'

/**
 * Who is on a team. Ordinary reads contain short names, for every viewer. A
 * route that has authorized roster management may explicitly request private
 * name details.
 *
 * The people are every member of the team, everybody a season or league
 * above it makes a member of it, everybody given a role on the team, on the
 * seasons it belongs to or on its league, every guardian of one of its
 * players, and everybody who follows it.
 *
 * Each person is listed once, in the first section that fits: `admin`
 * (owner, manager or an admin role), `staff` (any role flag), `player`,
 * `family` (a guardian of a player here), `spectator` (a member with none of
 * those, of the team or through its season or league), then `follower`.
 * Somebody who coaches and is also a parent is staff, which is what they are
 * here for; a member who follows the team too is a spectator.
 *
 * Each entry carries the person's walk-up song on this team, or `null`: a
 * song belongs to a player's place on a team, so the same child reads
 * another team's song only on that team's roster.
 */
export async function teamRoster(
  db: Kysely<Database>,
  space: MediaContext['space'],
  teamId: string,
  includeFullNames = false
): Promise<RosterEntry[]> {
  const members = await db
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
  const memberIds = new Set(members.map(row => row.userId))

  const given = await givenRoleLevelsOnTeam(db, teamId)
  const above = await membersAboveTeam(db, teamId)
  const family = new Set(
    await guardiansOf(
      db,
      members.filter(row => row.isPlayer).map(row => row.userId)
    )
  )
  const followers = await followersOf(db, teamId)

  // Staff given their role above the team, members of its seasons and
  // league, guardians and followers need no membership of the team: they are
  // listed as people without a place on it, while their account is open. A
  // member is listed however their account stands.
  const outsideIds = [
    ...new Set([...given.keys(), ...above.keys(), ...family, ...followers])
  ].filter(userId => !memberIds.has(userId))
  const outside =
    outsideIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select([
            'id as userId',
            'display_name as displayName',
            'first_name as firstName',
            'last_name as lastName',
            'bats',
            'throws',
            'avatar_path as avatarPath'
          ])
          .where('id', 'in', outsideIds)
          .where('merged_into', 'is', null)
          .where('disabled_at', 'is', null)
          .orderBy('display_name')
          .execute()
  const rows = [
    ...members,
    ...outside.map(row => ({
      ...row,
      jersey: null,
      positions: [],
      isPlayer: false,
      role: 'member'
    }))
  ]

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

  const placed = (
    row: (typeof rows)[number]
  ): Pick<RosterEntry, 'section' | 'staffRoles' | 'inheritedFrom'> => {
    const held = given.get(row.userId) ?? new Map<Role, RoleLevel>()
    const staffRoles = ROLE_FLAGS.filter(flag => held.has(flag))
    const admin =
      held.has('admin') || row.role === 'owner' || row.role === 'manager'
    const section: RosterSection = admin
      ? 'admin'
      : staffRoles.length > 0
        ? 'staff'
        : row.isPlayer
          ? 'player'
          : family.has(row.userId)
            ? 'family'
            : memberIds.has(row.userId) || above.has(row.userId)
              ? 'spectator'
              : 'follower'
    // The role that put somebody in their section is the one their pill
    // names, at the highest level that gives it: for a spectator, being a
    // member, which a season or league above gives as the team does.
    if (section === 'spectator') {
      const level = above.get(row.userId)
      return {
        section,
        staffRoles,
        inheritedFrom: level == null ? null : { level, role: 'member' }
      }
    }
    const placing: Role | undefined = admin ? 'admin' : staffRoles[0]
    const level = placing == null ? undefined : held.get(placing)
    return {
      section,
      staffRoles,
      inheritedFrom:
        placing == null || level == null || level === 'team'
          ? null
          : { level, role: placing }
    }
  }
  const order: Record<RosterSection, number> = {
    admin: 0,
    staff: 1,
    player: 2,
    family: 3,
    spectator: 4,
    follower: 5
  }

  return rows
    .map((row): RosterEntry => ({
      userId: row.userId,
      nameDetails:
        includeFullNames && row.isPlayer
          ? {
              firstName: row.firstName,
              lastName: row.lastName,
              displayName: row.displayName
            }
          : undefined,
      bats: row.bats,
      throws: row.throws,
      shortName: names.get(row.userId) ?? row.displayName,
      avatarUrl: imageUrl(space, row.avatarPath),
      jersey: row.jersey,
      positions: row.positions,
      isPlayer: row.isPlayer,
      role: row.role,
      ...placed(row),
      walkUpSong: songs.get(row.userId) ?? null
    }))
    .sort((a, b) => {
      const bySection = order[a.section] - order[b.section]
      if (bySection !== 0) return bySection
      // The team's own people first, then those given their place above it.
      const byLevel =
        Number(a.inheritedFrom != null) - Number(b.inheritedFrom != null)
      if (byLevel !== 0) return byLevel
      return a.shortName.localeCompare(b.shortName)
    })
}

/**
 * Everybody who follows the team, or a team merged into it (the teams
 * `followMerges` leads here from), by an open account that is not disabled.
 * A follow made by a row since closed into another is not the open row's:
 * `GET /me/follows` reads follows by the row signed in as, too.
 */
async function followersOf(
  db: Kysely<Database>,
  teamId: string
): Promise<number[]> {
  const { rows } = await sql<{ user_id: number }>`
    with recursive merged(id) as (
      select ${teamId}::text
      union
      select teams.id from teams
      inner join merged on teams.merged_into = merged.id
    )
    select distinct follows.user_id
    from follows
    inner join users on users.id = follows.user_id
    where follows.group_type = 'team'
      and follows.group_id in (select id from merged)
      and users.disabled_at is null
      and users.merged_into is null
  `.execute(db)
  return rows.map(row => Number(row.user_id))
}
