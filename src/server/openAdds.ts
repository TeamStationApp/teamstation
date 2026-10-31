import { type Kysely, sql, type SqlBool } from 'kysely'

import type { OnePerson } from './admin/people'
import type { Database } from './db/database'

/**
 * Who a team holds only by an open add, apart from `access.ts` because name
 * formats read it, and migrations read those: this file must stay free of
 * anything that loads the server.
 */

/** However deep a chain of merges can go, as `onePerson` walks it. */
const MAX_MERGE_DEPTH = 16

/**
 * `onePerson` for several rows at once, in one query: each row asked about,
 * keyed by itself, as the open row it is now and every row closed into that
 * one. Walks the merges the way `onePerson` does: up to whoever is still open,
 * stopping at a loop or after `MAX_MERGE_DEPTH` steps, then back down.
 */
export async function peopleOf(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, OnePerson>> {
  const asked = [...new Set(userIds)]
  const people = new Map<string, OnePerson>()
  if (asked.length === 0) return people
  const { rows } = await sql<{ start: string; survivor: string; id: string }>`
    with recursive up(start, id, depth, path) as (
      select asked.id, asked.id, 0, array[asked.id]
      from unnest(${asked}::text[]) as asked(id)
      union all
      select up.start, users.merged_into, up.depth + 1,
        up.path || users.merged_into
      from up
      inner join users on users.id = up.id
      where users.merged_into is not null
        and not users.merged_into = any(up.path)
        and up.depth < ${MAX_MERGE_DEPTH}
    ),
    survivor(start, id) as (
      select distinct on (start) start, id from up order by start, depth desc
    ),
    down(start, id, depth) as (
      select start, id, 0 from survivor
      union
      select down.start, users.id, down.depth + 1
      from down
      inner join users on users.merged_into = down.id
      where down.depth < ${MAX_MERGE_DEPTH}
    )
    select down.start, survivor.id as survivor, down.id
    from down
    inner join survivor on survivor.start = down.start
    group by down.start, survivor.id, down.id
    order by down.start, min(down.depth), down.id
  `.execute(db)
  for (const row of rows) {
    const person = people.get(row.start)
    if (person == null)
      people.set(row.start, { userId: row.survivor, userIds: [row.id] })
    else person.userIds.push(row.id)
  }
  return people
}

/** One add a team still holds a person by, with every row of that person. */
interface OpenHold {
  teamId: string
  userIds: string[]
  /** The add made their row: they were not on the team before it. */
  newcomer: boolean
}

/**
 * The holds in force: a roster add inside the window its player's side may
 * reject it in, while the row it landed on stands as a player's. Removing them
 * ends it, so does a merge that took the row away, and so does their side
 * accepting a later add of them. Until then their name,
 * hands and family are not the team's: a rejection undoes the add, and could
 * not undo those. An add made before rows were recorded has none to check, and
 * counts. `userIds` are what a merge since left of the person, so a read by
 * row and a read by the id stored both find them.
 */
async function openHolds(
  db: Kysely<Database>,
  scope: { teamIds: readonly string[] } | { userIds: readonly string[] }
): Promise<OpenHold[]> {
  const asked = 'teamIds' in scope ? scope.teamIds : scope.userIds
  if (asked.length === 0) return []
  const rows = await db
    .selectFrom('group_requests')
    .leftJoin('memberships', join =>
      join.on(
        sql<SqlBool>`memberships.id = group_requests.terms->>'membershipId'`
      )
    )
    .select([
      'group_requests.initiating_team_id as teamId',
      'group_requests.sent_at as sentAt',
      'memberships.is_player as isPlayer',
      sql<string>`group_requests.terms->>'userId'`.as('userId'),
      sql<string | null>`group_requests.terms->>'membershipId'`.as(
        'membershipId'
      ),
      sql<
        boolean | null
      >`(group_requests.terms->>'createdMembership')::boolean`.as(
        'createdMembership'
      )
    ])
    .where('group_requests.kind', '=', 'playerAdd')
    .where('group_requests.status', '=', 'applied')
    .where('group_requests.expires_at', '>', new Date())
    .where(sql<string>`group_requests.terms->>'mode'`, '=', 'roster')
    .where(
      'teamIds' in scope
        ? sql.ref<string>('group_requests.initiating_team_id')
        : sql<string>`group_requests.terms->>'userId'`,
      'in',
      [...asked]
    )
    .execute()
  const standing = rows.filter(
    row => row.membershipId == null || row.isPlayer === true
  )
  const people = await peopleOf(
    db,
    standing.map(row => row.userId)
  )
  const accepted =
    standing.length === 0
      ? []
      : await db
          .selectFrom('group_requests')
          .select([
            'initiating_team_id as teamId',
            'sent_at as sentAt',
            sql<string>`terms->>'userId'`.as('userId')
          ])
          .where('kind', '=', 'playerAdd')
          .where('status', '=', 'accepted')
          .where(sql<string>`terms->>'mode'`, '=', 'roster')
          .where(
            'initiating_team_id',
            'in',
            standing.map(row => row.teamId!)
          )
          .execute()
  return standing.flatMap(row => {
    const userIds = people.get(row.userId)?.userIds ?? [row.userId]
    const answered = accepted.some(
      later =>
        later.teamId === row.teamId &&
        later.sentAt > row.sentAt &&
        userIds.includes(later.userId)
    )
    return answered
      ? []
      : [
          {
            teamId: row.teamId!,
            userIds,
            newcomer: row.createdMembership === true
          }
        ]
  })
}

/** The rows of the people each team holds only by an open add (`openHolds`). */
export async function openAddsOf(
  db: Kysely<Database>,
  teamIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const held = new Map(teamIds.map(id => [id, new Set<string>()]))
  for (const hold of await openHolds(db, { teamIds }))
    for (const id of hold.userIds) held.get(hold.teamId)?.add(id)
  return held
}

/**
 * `openAddsOf`, of those the add brought to the team: somebody already on it
 * in another role stays where they were in its chats and people lists, though
 * what is theirs is held from the team all the same.
 */
export async function openArrivalsOf(
  db: Kysely<Database>,
  teamIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const held = new Map(teamIds.map(id => [id, new Set<string>()]))
  for (const hold of await openHolds(db, { teamIds }))
    if (hold.newcomer)
      for (const id of hold.userIds) held.get(hold.teamId)?.add(id)
  return held
}

/** The rows of the people a team holds only by an open add (`openHolds`). */
export async function openAdds(
  db: Kysely<Database>,
  teamId: string
): Promise<Set<string>> {
  return (await openAddsOf(db, [teamId])).get(teamId)!
}

/** The teams holding a person only by an open add (`openHolds`). */
export async function openAddTeams(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<string[]> {
  const people = await peopleOf(db, userIds)
  const holds = await openHolds(db, {
    userIds: [...people.values()].flatMap(person => person.userIds)
  })
  return [...new Set(holds.map(hold => hold.teamId))]
}

/** Whether a team holds a person only by an open add (`openHolds`). */
export async function heldByOpenAdd(
  db: Kysely<Database>,
  teamId: string,
  userIds: readonly string[]
): Promise<boolean> {
  return (await openAddTeams(db, userIds)).includes(teamId)
}
