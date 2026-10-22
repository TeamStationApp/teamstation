import { type Kysely, sql, type Transaction } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import { umpireLevelName, type UmpireType } from '../../common/umpires'
import type { Database } from '../db/database'

export async function types(
  db: Kysely<Database>,
  league: string
): Promise<UmpireType[]> {
  return await db
    .selectFrom('umpire_types as t')
    .select(['t.id', 't.name', 't.position'])
    .select(
      sql<boolean>`exists(select 1 from season_umpire_type_requirements r where r.type_id=t.id)
      or exists(select 1 from umpire_certifications c where c.type_id=t.id)
      or exists(select 1 from umpire_assignments a where split_part(a.slot,':',1)=t.id)`.as(
        'inUse'
      )
    )
    .where('t.league_id', '=', league)
    .orderBy('t.position')
    .orderBy('t.id')
    .execute()
}
export async function requireType(
  db: Kysely<Database>,
  league: string,
  id: string
): Promise<void> {
  const row = await db
    .selectFrom('umpire_types')
    .select('id')
    .where('id', '=', id)
    .where('league_id', '=', league)
    .executeTakeFirst()
  if (row == null) throw notFound('No umpire type in this league')
}
export async function addType(
  db: Transaction<Database>,
  league: string,
  raw: unknown
): Promise<UmpireType> {
  const held = await types(db, league)
  let name: string
  try {
    name = umpireLevelName(
      raw,
      held.map(t => t.name)
    )
  } catch (e) {
    throw badRequest((e as Error).message.replace(/level/gi, 'type'))
  }
  const type = {
    id: makeId('umpireType'),
    name,
    position: (held.at(-1)?.position ?? -1) + 1
  }
  await db
    .insertInto('umpire_types')
    .values({ ...type, league_id: league })
    .execute()
  const seasons = await db
    .selectFrom('season_umpire_requirements as r')
    .innerJoin('seasons as s', 's.id', 'r.season_id')
    .select('r.season_id')
    .where('s.league_id', '=', league)
    .execute()
  if (seasons.length > 0)
    await db
      .insertInto('season_umpire_type_requirements')
      .values(
        seasons.map(s => ({
          ...s,
          type_id: type.id,
          required_count: 1,
          optional_count: 0
        }))
      )
      .execute()
  return { ...type, inUse: seasons.length > 0 }
}
export async function removeType(
  db: Transaction<Database>,
  league: string,
  id: string
): Promise<void> {
  await requireType(db, league, id)
  await db
    .deleteFrom('umpire_assignments')
    .where(sql<string>`split_part(slot,':',1)`, '=', id)
    .execute()
  await db.deleteFrom('umpire_types').where('id', '=', id).execute()
}
