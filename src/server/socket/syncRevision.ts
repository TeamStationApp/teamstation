import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * The channel a write that changes a screen scope announces itself on. The
 * worker that holds sockets listens on it (`screenScope.ts`) and tells the
 * home, schedule and event scopes the ids concern.
 */
export const SCREEN_SCOPES_CHANNEL = 'screen_scopes'

/** What a write names, so the worker can tell which scopes it concerns. */
export interface ScreenScopeIds {
  gameId?: string
  teamId?: string
  seasonId?: string
  userId?: string
}

/**
 * A `screen_scopes` notify: the ids a write changed, and `byPost` when a
 * scorer's post of plays made the change. That post's play frames already
 * make the game's own screen read it, so that screen lets the notice pass.
 */
export interface ScreenScopePayload extends ScreenScopeIds {
  byPost?: boolean
}

const ID_KEYS = ['gameId', 'teamId', 'seasonId', 'userId'] as const

/**
 * Announces the write, as the last statement of the writing transaction:
 * one statement that notifies once for each distinct set of ids the write
 * names. A set is `byPost` only when every note of it was. The notices carry
 * no revision: a screen reads on a notice, gated by time. Postgres delivers
 * them on commit, so a rollback announces nothing, and this takes no row:
 * writers that announce never wait on each other here.
 */
export async function announceNotedScopes(
  trx: Kysely<Database>,
  ids: ScreenScopePayload | readonly ScreenScopePayload[]
): Promise<void> {
  if (!trx.isTransaction)
    throw new Error(
      'Scope changes are announced inside the writing transaction'
    )
  const named = new Map<string, ScreenScopePayload>()
  for (const each of Array.isArray(ids) ? ids : [ids]) {
    const payload: ScreenScopePayload = {}
    for (const key of ID_KEYS) {
      const id = (each as ScreenScopePayload)[key]
      if (id != null) payload[key] = id
    }
    const key = JSON.stringify(payload)
    const held = named.get(key)
    const byPost =
      (each as ScreenScopePayload).byPost === true &&
      (held == null || held.byPost === true)
    named.set(key, byPost ? { ...payload, byPost } : payload)
  }
  const payloads = [...named.values()].map(payload => JSON.stringify(payload))
  await sql`select pg_notify(${SCREEN_SCOPES_CHANNEL}, payload) from unnest(${payloads}::text[]) as payload`.execute(
    trx
  )
}

/** What each open transaction has changed, until it announces. */
const noted = new WeakMap<Kysely<Database>, ScreenScopePayload[]>()

/**
 * The transactions `atomic` opened, and so announces for when their work is
 * done. A note anywhere else would be kept and never announced.
 */
const announcing = new WeakSet<Kysely<Database>>()

/** `atomic` opened `trx`: it announces what is noted in it. */
export function announcesWhenDone(trx: Kysely<Database>): void {
  announcing.add(trx)
}

/**
 * Records that this transaction changed what a screen scope shows, for the
 * function that opened the transaction to announce once every later write
 * in it is done (`announceNoted`, which `atomic` runs when it opened the
 * transaction). A function given a transaction notes and never announces, so
 * the notify stays the last statement however the writes are composed. A
 * transaction `atomic` did not open throws: nothing would ever announce the
 * note. `byPost` marks a change a post of plays made (`ScreenScopePayload`).
 */
export function noteScopeChange(
  trx: Kysely<Database>,
  ids: ScreenScopePayload
): void {
  if (!trx.isTransaction)
    throw new Error('A screen scope change is noted inside its transaction')
  // A transaction opened some other way would drop the note without a sign.
  if (!announcing.has(trx))
    throw new Error(
      'A screen scope change is noted inside a transaction atomic opened'
    )
  // Nothing the worker could match a socket on: nobody to tell.
  if (ID_KEYS.every(key => ids[key] == null)) return
  const list = noted.get(trx)
  if (list == null) noted.set(trx, [ids])
  else list.push(ids)
}

/** A game's teams and season, as a row names them. */
export interface GameFigureIds {
  home_team_id: string
  away_team_id: string
  season_id: string | null
}

/**
 * Notes a change to what a game counts for on Home's lists, beyond the game
 * itself: its teams' records (a final score), its season's games and
 * videos. Those lists pass over a notice that names only a game, as every
 * play's does, so this also tells the game's teams and season, as its row
 * stands in `trx`, and those of `before` when the write moved it. Only for
 * the writes that change those figures, never for a play. `byPost` marks the
 * game's own notice as a post of plays' (`ScreenScopePayload`).
 */
export async function noteGameFigures(
  trx: Kysely<Database>,
  gameId: string,
  before?: GameFigureIds,
  options: { byPost?: boolean } = {}
): Promise<void> {
  noteScopeChange(
    trx,
    options.byPost === true ? { gameId, byPost: true } : { gameId }
  )
  const now = await trx
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'season_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  for (const row of [before, now]) {
    if (row == null) continue
    noteScopeChange(trx, { teamId: row.home_team_id })
    noteScopeChange(trx, { teamId: row.away_team_id })
    if (row.season_id != null) noteScopeChange(trx, { seasonId: row.season_id })
  }
}

/**
 * Announces everything this transaction noted, as its last statement, or
 * does nothing when it noted nothing. Only the function that opened the
 * transaction calls it.
 */
export async function announceNoted(trx: Kysely<Database>): Promise<void> {
  const list = noted.get(trx)
  if (list == null || list.length === 0) return
  noted.delete(trx)
  await announceNotedScopes(trx, list)
}

/** The ids a change to a team, season or league names; a league names none. */
export function groupScopeIds(
  kind: 'team' | 'season' | 'league',
  id: string
): ScreenScopeIds {
  if (kind === 'team') return { teamId: id }
  if (kind === 'season') return { seasonId: id }
  return {}
}
