import type { Kysely } from 'kysely'

import { survivorsOf, UnresolvedAccount } from '../admin/people'
import type { Database } from '../db/database'

/** Stored scoring ids resolve through the original account and its final survivor. */
export async function resolveGumboIds(
  db: Kysely<Database>,
  ids: readonly number[]
): Promise<Map<number, number>> {
  const originals = await scoringUsers(db, ids)
  if (originals.size === 0) return new Map()
  const targets = [...new Set(originals.values())]
  const mappings = await db
    .selectFrom('gumbo_ids')
    .selectAll()
    .where('user_id', 'in', targets)
    .execute()
  if (mappings.length !== targets.length)
    throw new UnresolvedAccount('Missing surviving scoring identity')
  const byUser = new Map(mappings.map(row => [row.user_id, row.gumbo_id]))
  return new Map(
    [...originals].map(([id, userId]) => [id, byUser.get(userId)!])
  )
}

/** The account to show for each historical scoring identity. Never allocates. */
export async function scoringUsers(
  db: Kysely<Database>,
  ids: readonly number[]
): Promise<Map<number, string>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const originals = await db
    .selectFrom('gumbo_ids')
    .selectAll()
    .where('gumbo_id', 'in', wanted)
    .execute()
  if (originals.length !== wanted.length)
    throw new UnresolvedAccount('Missing original scoring identity')
  const survivors = await survivorsOf(
    db,
    originals.map(row => row.user_id)
  )
  return new Map(
    originals.map(row => [row.gumbo_id, survivors.get(row.user_id)!])
  )
}

/** Historical scoring identities for an already expanded set of account aliases. */
export async function gumboIdsOfUsers(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<number[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', [...userIds])
    .execute()
  return rows.map(row => row.gumbo_id)
}
