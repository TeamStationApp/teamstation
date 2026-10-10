import type { Kysely } from 'kysely'

import { conflict, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'

/** Identity merging cannot silently choose a different management lineage. */
export async function mergeParents(
  db: Kysely<Database>,
  fromId: string,
  intoId: string,
  apply = false
): Promise<void> {
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'kind', 'league_id', 'merged_into'])
    .where('id', 'in', [fromId, intoId])
    .execute()
  const from = teams.find(team => team.id === fromId)
  const into = teams.find(team => team.id === intoId)
  if (from == null || into == null) throw notFound()
  if (
    (await db
      .selectFrom('games')
      .select('id')
      .where(eb =>
        eb.or([
          eb.and([
            eb('home_team_id', '=', fromId),
            eb('away_team_id', '=', intoId)
          ]),
          eb.and([
            eb('home_team_id', '=', intoId),
            eb('away_team_id', '=', fromId)
          ])
        ])
      )
      .executeTakeFirst()) != null
  )
    throw conflict(
      'These teams have played each other; merging would make a team its own opponent'
    )
  if (from.merged_into != null || into.merged_into != null)
    throw conflict('Use the surviving team identity')
  if (from.kind === 'full' && into.kind !== 'full')
    throw conflict('A full team must remain a full team after merging')
  if (from.kind === 'full' && from.league_id !== into.league_id)
    throw conflict(
      'Resolve conflicting management parents before merging these teams'
    )
  const edges = await db
    .selectFrom('season_team_parents')
    .select(['season_id', 'team_id'])
    .where('team_id', 'in', [fromId, intoId])
    .execute()
  const seasons = [...new Set(edges.map(row => row.season_id))]
  if (seasons.length > 1 && into.league_id == null)
    throw conflict('Multiple parent seasons require one common non-null league')
  if (!apply) return
  await db
    .deleteFrom('season_team_parents')
    .where('team_id', '=', fromId)
    .execute()
  if (from.kind === 'full') {
    if (seasons.length > 0)
      await db
        .insertInto('season_team_parents')
        .values(seasons.map(id => ({ season_id: id, team_id: intoId })))
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
    const roles = await db
      .selectFrom('scope_roles')
      .selectAll()
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', fromId)
      .execute()
    for (const role of roles)
      await db
        .insertInto('scope_roles')
        .values({ ...role, id: makeId('scopeRole'), scope_id: intoId })
        .onConflict(oc =>
          oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
        )
        .execute()
  }
  await db
    .deleteFrom('scope_roles')
    .where('scope_type', '=', 'team')
    .where('scope_id', '=', fromId)
    .execute()
  await db
    .updateTable('teams')
    .set({ custodian_id: intoId })
    .where('custodian_type', '=', 'team')
    .where('custodian_id', '=', fromId)
    .execute()
  await db
    .updateTable('group_requests')
    .set({ status: 'superseded', resolved_at: new Date() })
    .where('status', '=', 'pending')
    .where(
      'id',
      'in',
      db
        .selectFrom('group_request_sides')
        .select('request_id')
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', fromId)
    )
    .execute()
}
