import type { Kysely } from 'kysely'

import {
  type UmpireCertification,
  type UmpirePosition,
  umpirePositions,
  type UmpireType,
  type UmpireTypeCount
} from '../common/umpires'
import type { Database } from '../server/db/database'

export const fixtureTypes: UmpireType[] = [
  { id: 'uty_plate', name: 'Plate', position: 0, inUse: true },
  { id: 'uty_field', name: 'Field', position: 1, inUse: true }
]
export function fixturePositions(
  plate = true,
  field = 1,
  optional = 0
): UmpirePosition[] {
  return umpirePositions(fixtureTypes, [
    { typeId: 'uty_plate', required: plate ? 1 : 0, optional: 0 },
    { typeId: 'uty_field', required: field, optional }
  ])
}
export async function seedUmpireTypes(
  db: Kysely<Database>,
  league: string
): Promise<void> {
  await db
    .insertInto('umpire_types')
    .values(
      fixtureTypes.map(({ inUse, ...t }) => ({ ...t, league_id: league }))
    )
    .execute()
}
export async function seedUmpireCounts(
  db: Kysely<Database>,
  season: string,
  plate = true,
  field = 1,
  optional = 0
): Promise<void> {
  await db
    .insertInto('season_umpire_type_requirements')
    .values([
      {
        season_id: season,
        type_id: 'uty_plate',
        required_count: plate ? 1 : 0,
        optional_count: 0
      },
      {
        season_id: season,
        type_id: 'uty_field',
        required_count: field,
        optional_count: optional
      }
    ])
    .onConflict(oc =>
      oc.columns(['season_id', 'type_id']).doUpdateSet(eb => ({
        required_count: eb.ref('excluded.required_count'),
        optional_count: eb.ref('excluded.optional_count')
      }))
    )
    .execute()
}
export function fixtureCertifications(
  levelId: string,
  plate: boolean,
  field: boolean
): UmpireCertification[] {
  return [
    { levelId, typeId: 'uty_plate', enabled: plate },
    { levelId, typeId: 'uty_field', enabled: field }
  ]
}
export function fixtureCounts(
  plate: boolean,
  field: number,
  optional = 0
): UmpireTypeCount[] {
  return [
    { typeId: 'uty_plate', required: plate ? 1 : 0, optional: 0 },
    { typeId: 'uty_field', required: field, optional }
  ]
}
