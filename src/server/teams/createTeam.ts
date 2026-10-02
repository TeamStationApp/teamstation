import { type Kysely, sql, type Transaction } from 'kysely'

import type {
  CreatedTeamSeason,
  CreateTeamBody,
  CreateTeamResponse
} from '../../common/createTeam'
import { conflict, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { type ExternalIdKey, recordExternalId } from '../db/externalIds'
import { followMerges } from './followMerges'

/**
 * Makes a full team, puts it in a season, and records the ids another system
 * knows it by — or, when one of those ids already names a team, makes no team
 * and answers with that one, recording on it the body's ids nothing holds
 * yet. It is not moved into the asked season.
 *
 * All in one transaction. Each external id, and a season asked for by name,
 * is locked first, so two posts of the same team at once make one team and
 * one season rather than two.
 */
export async function createTeam(
  db: Kysely<Database>,
  body: CreateTeamBody
): Promise<CreateTeamResponse> {
  return await db.transaction().execute(async trx => {
    const keys = body.externalIds.map(
      one => `team:${one.system}:${one.kind}:${one.id}`
    )
    if ('name' in body.season) {
      keys.push(
        `season:${body.season.name.toLowerCase()}:${String(body.season.year)}`
      )
    }
    // In one order, so two posts that share two keys cannot each hold one.
    for (const key of [...new Set(keys)].sort()) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
        trx
      )
    }

    const { held, orphans } = await heldTeam(trx, body)
    if (held != null) return held

    const season = await resolveSeason(trx, body.season)
    const teamId = makeId('team')
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        name: body.name,
        kind: 'full',
        created_from: 'api'
      })
      .execute()
    await trx
      .insertInto('season_teams')
      .values({ season_id: season.id, team_id: teamId })
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
    if (orphans.length > 0) {
      await trx
        .updateTable('external_ids')
        .set({ entity_id: teamId })
        .where('id', 'in', orphans)
        .execute()
    }
    for (const externalId of body.externalIds) {
      await recordExternalId(trx, 'team', teamId, externalId)
    }
    return { id: teamId, name: body.name, created: true, season }
  })
}

/**
 * The team one of the body's external ids already names, as the answer to
 * give instead of making one, with the body's unheld ids recorded on it. An
 * id held by something other than a team is a conflict, wherever it is in the
 * body: the table holds each id once, whatever it is on.
 *
 * `orphans` are the `external_ids` rows of asked ids whose team row is gone.
 * They name nothing, so a team made now takes them over.
 */
async function heldTeam(
  trx: Transaction<Database>,
  body: CreateTeamBody
): Promise<{ held?: CreateTeamResponse; orphans: string[] }> {
  const orphans: string[] = []
  if (body.externalIds.length === 0) return { orphans }
  const rows = await trx
    .selectFrom('external_ids')
    .select(['id', 'entity_type', 'entity_id', 'system', 'kind', 'external_id'])
    .where(eb =>
      eb.or(
        body.externalIds.map(one =>
          eb.and([
            eb('system', '=', one.system),
            eb('kind', '=', one.kind),
            eb('external_id', '=', one.id)
          ])
        )
      )
    )
    .execute()

  const find = (one: ExternalIdKey): (typeof rows)[number] | undefined =>
    rows.find(
      held =>
        held.system === one.system &&
        held.kind === one.kind &&
        held.external_id === one.id
    )
  for (const one of body.externalIds) {
    const row = find(one)
    if (row != null && row.entity_type !== 'team') {
      throw conflict(
        `${one.system} ${one.kind} ${one.id} is already on a ${row.entity_type}`
      )
    }
  }

  // In the order the body gave them, so the answer does not depend on how
  // the database happened to return the rows.
  for (const one of body.externalIds) {
    const row = find(one)
    if (row == null) continue
    const teamId = await followMerges(trx, row.entity_id)
    const team = await trx
      .selectFrom('teams')
      .select(['id', 'name'])
      .where('id', '=', teamId)
      .executeTakeFirst()
    if (team == null) {
      orphans.push(row.id)
      continue
    }
    // The ids the body names that nothing holds yet are this team's too,
    // and are recorded on it rather than dropped.
    for (const other of body.externalIds) {
      if (find(other) == null) {
        await recordExternalId(trx, 'team', team.id, other)
      }
    }
    return {
      held: { id: team.id, name: team.name, created: false, season: null },
      orphans
    }
  }
  return { orphans }
}

/**
 * The season named by id, which must exist, or by name and year: the one
 * already called that in that year, ignoring case and outer spaces, else a
 * new one in no league.
 */
async function resolveSeason(
  trx: Transaction<Database>,
  asked: CreateTeamBody['season']
): Promise<CreatedTeamSeason> {
  if ('id' in asked) {
    const season = await trx
      .selectFrom('seasons')
      .select(['id', 'name', 'year'])
      .where('id', '=', asked.id)
      .executeTakeFirst()
    if (season == null) throw notFound(`No season ${asked.id}`)
    return { ...season, created: false }
  }

  const held = await trx
    .selectFrom('seasons')
    .select(['id', 'name', 'year'])
    .where(sql<boolean>`lower(btrim(name)) = lower(${asked.name})`)
    .where('year', '=', asked.year)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst()
  if (held != null) return { ...held, created: false }

  const id = makeId('season')
  await trx
    .insertInto('seasons')
    .values({
      id,
      // Null on purpose: a league is something a person makes and moves
      // seasons into, not something a team implies.
      league_id: null,
      name: asked.name,
      year: asked.year
    })
    .execute()
  return { id, name: asked.name, year: asked.year, created: true }
}
