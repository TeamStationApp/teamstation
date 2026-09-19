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
 * Jordan Pujols is why. An import issues a player id per team, so five teams
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
