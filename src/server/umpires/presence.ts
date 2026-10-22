import type { Kysely } from 'kysely'

import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'

/** Personal schedule metadata, restricted to the games already visible to the caller. */
export async function assignedUmpireGames(
  db: Kysely<Database>,
  actor: Actor | undefined,
  gameIds: string[]
): Promise<Set<string>> {
  if (actor == null || gameIds.length === 0) return new Set()
  const person = await onePerson(db, actor.userId)
  const rows = await db
    .selectFrom('umpire_assignments as a')
    .innerJoin('games as g', 'g.id', 'a.game_id')
    .innerJoin('seasons as s', 's.id', 'g.season_id')
    .innerJoin('leagues as l', 'l.id', 's.league_id')
    .select('a.game_id')
    .where('a.game_id', 'in', gameIds)
    .where('a.user_id', 'in', person.userIds)
    .where('l.umpire_management', '=', true)
    .where('g.status', '!=', 'cancelled')
    .where('g.withdrawn_at', 'is', null)
    .distinct()
    .execute()
  return new Set(rows.map(row => row.game_id))
}
