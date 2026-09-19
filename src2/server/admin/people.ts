import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * Every row that is one person.
 *
 * A merged account is closed rather than deleted — `users.merged_into` points
 * at whoever it became — and nothing moves underneath it: the plays, the stat
 * lines and the team memberships stay where they were written, under the id
 * that was current at the time. That is deliberate, because an id already
 * handed out has to keep resolving and because a merge has to be undoable.
 *
 * It means a read that wants everything a person has done cannot ask about one
 * id. It has to ask about all of them, which is what this is for: the survivor,
 * and every row that has been merged into them, however long the chain.
 *
 * Jensen Puey is why. An import issues a player id per team, so five teams
 * over two years made five people out of one child, and each of his pages knew
 * about one fifth of him.
 */
export interface OnePerson {
  /** The row still open, which is the one to answer as. */
  userId: string
  /** That row and every one closed into it, for a query to sum over. */
  userIds: string[]
}

/** However deep a chain of merges can sensibly go before it is a mistake. */
const MAX_DEPTH = 16

export async function onePerson(
  db: Kysely<Database>,
  userId: string
): Promise<OnePerson> {
  // Up the chain to whoever is still open. A cycle would be a bug in whatever
  // wrote it; the guard means it cannot become a hung request.
  let survivor = userId
  const walked = new Set<string>([userId])
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    const row = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', survivor)
      .executeTakeFirst()
    const next = row?.merged_into
    if (next == null || walked.has(next)) break
    walked.add(next)
    survivor = next
  }

  // And back down it, gathering everybody who became them.
  const userIds = new Set<string>([survivor])
  let frontier = [survivor]
  for (let step = 0; step < MAX_DEPTH && frontier.length > 0; step += 1) {
    const rows = await db
      .selectFrom('users')
      .select(['id'])
      .where('merged_into', 'in', frontier)
      .execute()
    frontier = rows.map(row => row.id).filter(id => !userIds.has(id))
    for (const id of frontier) userIds.add(id)
  }

  return { userId: survivor, userIds: [...userIds] }
}

/**
 * Closes one row into another: the merge itself.
 *
 * The memberships move with it. A membership is a person on a team — the
 * jersey, the positions, the role — and leaving it under a closed row is what
 * took 31 children off six rosters the first time this ran: every roster asks
 * for people who are still open, so a child whose surviving row belonged to
 * another team simply vanished from the team they actually play for.
 *
 * Where the survivor is already on that team, the closing row's membership is
 * dropped rather than moved: two rows for one child on one team is the thing
 * being undone, and the survivor's own row is the one with the jersey somebody
 * checked.
 */
export async function closeInto(
  db: Kysely<Database>,
  closing: string,
  keeping: string
): Promise<void> {
  if (closing === keeping) return

  const theirs = await db
    .selectFrom('memberships')
    .select(['id', 'team_id'])
    .where('user_id', '=', closing)
    .execute()
  const already = new Set(
    (
      await db
        .selectFrom('memberships')
        .select(['team_id'])
        .where('user_id', '=', keeping)
        .execute()
    ).map(row => row.team_id)
  )

  for (const membership of theirs) {
    if (already.has(membership.team_id)) {
      await db
        .deleteFrom('memberships')
        .where('id', '=', membership.id)
        .execute()
      continue
    }
    await db
      .updateTable('memberships')
      .set({ user_id: keeping })
      .where('id', '=', membership.id)
      .execute()
    already.add(membership.team_id)
  }

  await db
    .updateTable('users')
    .set({ merged_into: keeping })
    .where('id', '=', closing)
    .execute()
}

/**
 * Moves what a merge left behind.
 *
 * Idempotent, and run every time the merge tool runs: rows closed before the
 * memberships moved with them are the reason a roster can be missing a child,
 * and there is no way to tell from the row itself whether it was tidied.
 */
export async function tidyClosedRows(db: Kysely<Database>): Promise<number> {
  const stranded = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(['memberships.user_id as userId', 'users.merged_into as keeping'])
    .where('users.merged_into', 'is not', null)
    .distinct()
    .execute()

  let moved = 0
  for (const row of stranded) {
    if (row.keeping == null) continue
    // Through the chain, not one step: a row can be closed into a row that was
    // itself closed later.
    const person = await onePerson(db, row.userId)
    await closeInto(db, row.userId, person.userId)
    moved += 1
  }
  return moved
}

/** Who each of these ids is now, for a read that has rows rather than a name. */
export async function survivorsOf(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, string>> {
  const survivors = new Map<string, string>()
  if (userIds.length === 0) return survivors
  const rows = await db
    .selectFrom('users')
    .select(['id', 'merged_into'])
    .where('id', 'in', [...new Set(userIds)])
    .execute()

  const closedInto = new Map<string, string>()
  for (const row of rows) {
    if (row.merged_into != null) closedInto.set(row.id, row.merged_into)
  }
  for (const row of rows) {
    let id = row.id
    const walked = new Set<string>([id])
    while (true) {
      const next = closedInto.get(id)
      if (next == null || walked.has(next)) break
      walked.add(next)
      id = next
      // The chain can leave the batch, and then one more lookup settles it.
      if (!closedInto.has(id)) {
        const beyond = await db
          .selectFrom('users')
          .select(['merged_into'])
          .where('id', '=', id)
          .executeTakeFirst()
        if (beyond?.merged_into == null) break
        closedInto.set(id, beyond.merged_into)
      }
    }
    survivors.set(row.id, id)
  }
  return survivors
}
