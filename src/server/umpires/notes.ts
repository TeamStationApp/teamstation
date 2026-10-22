import { type Kysely, sql, type Transaction } from 'kysely'

import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import { type UmpireLevel, umpireLevelName } from '../../common/umpires'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { requireGroupAdmin } from '../groups/rights'
import { gameLeague } from './assignments'

export async function noteTypes(
  db: Kysely<Database>,
  league: string
): Promise<UmpireLevel[]> {
  return await db
    .selectFrom('umpire_note_types as t')
    .select(['t.id', 't.name', 't.position'])
    .select(
      sql<boolean>`exists(select 1 from game_umpire_notes n where n.note_type_id=t.id)`.as(
        'inUse'
      )
    )
    .where('t.league_id', '=', league)
    .orderBy('t.position')
    .orderBy('t.id')
    .execute()
}
export async function addNoteType(
  db: Transaction<Database>,
  league: string,
  raw: unknown
): Promise<UmpireLevel> {
  const held = await noteTypes(db, league)
  let name: string
  try {
    name = umpireLevelName(
      raw,
      held.map(t => t.name)
    )
  } catch (e) {
    throw badRequest((e as Error).message.replace(/level/gi, 'notes type'))
  }
  const type = {
    id: makeId('umpireNoteType'),
    name,
    position: (held.at(-1)?.position ?? -1) + 1
  }
  await db
    .insertInto('umpire_note_types')
    .values({ ...type, league_id: league })
    .execute()
  return { ...type, inUse: false }
}
async function requireNoteType(
  db: Kysely<Database>,
  league: string,
  id: string
): Promise<void> {
  const row = await db
    .selectFrom('umpire_note_types')
    .select('id')
    .where('id', '=', id)
    .where('league_id', '=', league)
    .executeTakeFirst()
  if (row == null) throw notFound('No umpire notes type in this league')
}
export async function removeNoteType(
  db: Transaction<Database>,
  league: string,
  id: string
): Promise<void> {
  await requireNoteType(db, league, id)
  await db.deleteFrom('umpire_note_types').where('id', '=', id).execute()
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2000)
    throw badRequest('Supply notes of at most 2000 characters')
  return raw.trim() === '' ? '' : raw
}
export async function saveNote(
  db: Transaction<Database>,
  actor: Actor,
  game: string,
  type: string,
  body: { before?: unknown; value?: unknown }
): Promise<{ value: string }> {
  const before = text(body?.before)
  const value = text(body?.value)
  // Parent graph and identity locks are held by the route before resolving the league.
  const league = await gameLeague(db, game)
  await lockKeys(db, [`umpires:${league}`])
  await requireGroupAdmin(db, actor, { kind: 'league', id: league })
  const settings = await db
    .selectFrom('leagues')
    .select('umpire_management')
    .where('id', '=', league)
    .executeTakeFirstOrThrow()
  if (!settings.umpire_management) throw forbidden('Umpire management is off')
  await requireNoteType(db, league, type)
  const held = await db
    .selectFrom('game_umpire_notes')
    .select('value')
    .where('game_id', '=', game)
    .where('note_type_id', '=', type)
    .executeTakeFirst()
  const current = held?.value ?? ''
  if (current === value) return { value }
  if (current !== before)
    throw conflict(
      'This note changed. Reload the schedule before editing it again.'
    )
  if (value === '')
    await db
      .deleteFrom('game_umpire_notes')
      .where('game_id', '=', game)
      .where('note_type_id', '=', type)
      .execute()
  else
    await db
      .insertInto('game_umpire_notes')
      .values({ game_id: game, note_type_id: type, value })
      .onConflict(oc =>
        oc.columns(['game_id', 'note_type_id']).doUpdateSet({ value })
      )
      .execute()
  return { value }
}
