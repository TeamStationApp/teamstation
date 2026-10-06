import { type Kysely, sql } from 'kysely'

import type { StaffEntry } from '../../common/api'
import { shortNames } from '../../common/names'
import { type Role, ROLES } from '../../common/roles'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'

/** The roles that make somebody a team's staff. A videographer is not. */
export const STAFF_ROLES = [
  'admin',
  'coach',
  'scorekeeper',
  'songkeeper'
] as const

/** However deep a chain of merges can sensibly go before it is a mistake. */
const MAX_MERGE_DEPTH = 16

/**
 * A team's staff: the people holding a direct `admin`, `coach`,
 * `scorekeeper` or `songkeeper` role on the team itself, with the team's
 * owners and managers as its administrators.
 *
 * Direct only. A role on the team's season or league is not a role on the
 * team here, which is Paul's rule for every flag: "only admins of the team,
 * not carried over from the season or league".
 *
 * Each row is resolved to the person it now is through `merged_into`, so a
 * merged account answers as its survivor and two rows of one person are one
 * entry. Administrators first, then by name.
 */
export async function teamStaff(
  db: Kysely<Database>,
  space: MediaContext['space'],
  teamId: string
): Promise<StaffEntry[]> {
  const roleRows = await db
    .selectFrom('scope_roles')
    .select(['user_id as userId', 'role'])
    .where('scope_type', '=', 'team')
    .where('scope_id', '=', teamId)
    .where('role', 'in', [...STAFF_ROLES])
    .execute()
  const owners = await db
    .selectFrom('memberships')
    .select(['user_id as userId'])
    .where('team_id', '=', teamId)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  const held: Array<{ userId: number; role: Role }> = [
    ...roleRows,
    ...owners.map(row => ({ userId: row.userId, role: 'admin' as const }))
  ]
  if (held.length === 0) return []

  const survivorOf = await survivors(
    db,
    held.map(row => row.userId)
  )
  const rolesOf = new Map<number, Set<Role>>()
  for (const row of held) {
    const userId = survivorOf.get(row.userId)
    if (userId == null) continue
    const roles = rolesOf.get(userId) ?? new Set<Role>()
    roles.add(row.role)
    rolesOf.set(userId, roles)
  }

  const people = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'avatar_path as avatarPath'
    ])
    .where('id', 'in', [...rolesOf.keys()])
    .execute()
  const names = shortNames(
    people.map(person => ({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      displayName: person.displayName
    }))
  )

  return people
    .map(person => ({
      userId: person.id,
      shortName: names.get(person.id) ?? person.displayName,
      avatarUrl: imageUrl(space, person.avatarPath),
      roles: ROLES.filter(role => rolesOf.get(person.id)?.has(role) === true)
    }))
    .sort((a, b) => {
      const byRole = ROLES.indexOf(a.roles[0]) - ROLES.indexOf(b.roles[0])
      if (byRole !== 0) return byRole
      return a.shortName.localeCompare(b.shortName)
    })
}

/**
 * Every row that is one of these people: each id and every row closed into
 * it, however many merges back. A merge leaves what was written about a row
 * where it was (a guardian link names the row the child had when it was
 * made), so a read about a person asks about all of their rows.
 */
export async function rowsOfPeople(
  db: Kysely<Database>,
  userIds: number[]
): Promise<number[]> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return []
  const { rows } = await sql<{ id: number }>`
    with recursive closed (id, depth) as (
      select id, 0
      from users
      where id = any(${unique}::bigint[])
      union all
      select users.id, closed.depth + 1
      from closed
      join users on users.merged_into = closed.id
      where closed.depth < ${MAX_MERGE_DEPTH}
    )
    select distinct id from closed
  `.execute(db)
  return rows.map(row => Number(row.id))
}

/**
 * Each of these user ids mapped to the open row it now is: itself, or the
 * end of its chain of `merged_into`. An id whose chain does not end, which
 * would be a bug in whatever wrote it, maps to nothing.
 */
export async function survivors(
  db: Kysely<Database>,
  userIds: number[]
): Promise<Map<number, number>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()
  const { rows } = await sql<{ startId: number; survivorId: number }>`
    with recursive chain (start_id, id, merged_into, depth) as (
      select id, id, merged_into, 0
      from users
      where id = any(${unique}::bigint[])
      union all
      select chain.start_id, users.id, users.merged_into, chain.depth + 1
      from chain
      join users on users.id = chain.merged_into
      where chain.depth < ${MAX_MERGE_DEPTH}
    )
    select start_id as "startId", id as "survivorId"
    from chain
    where merged_into is null
  `.execute(db)
  return new Map(rows.map(row => [Number(row.startId), Number(row.survivorId)]))
}
