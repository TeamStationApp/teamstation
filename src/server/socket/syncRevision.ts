import type { RequestHandler } from 'express'
import { type Kysely, sql } from 'kysely'

import { REVISION_HEADER } from '../../common/api'
import type { Database } from '../db/database'

/**
 * The channel a write that changes a screen scope announces itself on. The
 * worker that holds sockets listens on it (`screenScope.ts`) and tells the
 * home, schedule and event scopes the ids concern.
 */
export const SCREEN_SCOPES_CHANNEL = 'screen_scopes'

export { REVISION_HEADER }

/** What a write names, so the worker can tell which scopes it concerns. */
export interface ScreenScopeIds {
  gameId?: string
  teamId?: string
  seasonId?: string
  userId?: string
}

/** A `screen_scopes` notify: the ids, and the revision the write took. */
export interface ScreenScopePayload extends ScreenScopeIds {
  /** `sync_clock.value` as a decimal string. */
  revision: string
}

/**
 * Takes the next revision and announces it, as the last two statements of
 * the writing transaction: one clock update, then one statement that
 * notifies once for each set of ids the write names, all at that revision.
 *
 * The update holds the clock row until that transaction commits, so a
 * second writer waits here, takes the revision after this one and commits
 * after it: revisions become visible in the order they were taken. Nothing
 * after these two statements waits on another row, so a writer that already
 * holds a game row cannot deadlock with one that holds the clock. Notify is
 * delivered on commit, so a rollback announces nothing. Returns the revision.
 */
export async function bumpSyncClock(
  trx: Kysely<Database>,
  ids: ScreenScopeIds | readonly ScreenScopeIds[]
): Promise<string> {
  if (!trx.isTransaction)
    throw new Error('The sync clock is bumped inside the writing transaction')
  // One row on purpose, and a cost: every writer that noted a scope change
  // waits on this row from here until its commit, so those commits go one
  // at a time. A sequence would not hold them, but its values are taken in
  // call order, not commit order, so a GET could read a revision whose
  // earlier one has not committed yet and miss it for good.
  const { rows } = await sql<{
    value: string
  }>`update sync_clock set value = value + 1 where id = 1 returning value::text as value`.execute(
    trx
  )
  const revision = rows[0].value
  const named = new Map<string, ScreenScopePayload>()
  for (const each of Array.isArray(ids) ? ids : [ids]) {
    const payload: ScreenScopePayload = { revision }
    for (const key of ['gameId', 'teamId', 'seasonId', 'userId'] as const) {
      const id = (each as ScreenScopeIds)[key]
      if (id != null) payload[key] = id
    }
    named.set(JSON.stringify(payload), payload)
  }
  const payloads = [...named.keys()]
  await sql`select pg_notify(${SCREEN_SCOPES_CHANNEL}, payload) from unnest(${payloads}::text[]) as payload`.execute(
    trx
  )
  return revision
}

/** What each open transaction has changed, until it bumps the clock. */
const noted = new WeakMap<Kysely<Database>, ScreenScopeIds[]>()

/**
 * The transactions `atomic` opened, and so bumps the clock for when their
 * work is done. A note anywhere else would be kept and never announced.
 */
const bumping = new WeakSet<Kysely<Database>>()

/** `atomic` opened `trx`: it bumps the clock for what is noted in it. */
export function bumpsWhenDone(trx: Kysely<Database>): void {
  bumping.add(trx)
}

/**
 * Records that this transaction changed what a screen scope shows, for the
 * function that opened the transaction to announce once every later write
 * in it is done (`bumpNotedScopes`, which `atomic` runs when it opened the
 * transaction). A function given a transaction notes and never bumps, so
 * the clock and its notify stay the last two statements however the writes
 * are composed. A transaction `atomic` did not open throws: nothing would
 * ever announce the note.
 */
export function noteScopeChange(
  trx: Kysely<Database>,
  ids: ScreenScopeIds
): void {
  if (!trx.isTransaction)
    throw new Error('A screen scope change is noted inside its transaction')
  // A transaction opened some other way would drop the note without a sign.
  if (!bumping.has(trx))
    throw new Error(
      'A screen scope change is noted inside a transaction atomic opened'
    )
  // Nothing the worker could match a socket on: nobody to tell.
  if (Object.values(ids).every(id => id == null)) return
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
 * the writes that change those figures, never for a play.
 */
export async function noteGameFigures(
  trx: Kysely<Database>,
  gameId: string,
  before?: GameFigureIds
): Promise<void> {
  noteScopeChange(trx, { gameId })
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
 * Bumps the clock for everything this transaction noted, as its last two
 * statements, or does nothing when it noted nothing. Only the function that
 * opened the transaction calls it. Returns the revision taken.
 */
export async function bumpNotedScopes(
  trx: Kysely<Database>
): Promise<string | undefined> {
  const list = noted.get(trx)
  if (list == null || list.length === 0) return undefined
  noted.delete(trx)
  return await bumpSyncClock(trx, list)
}

/** The revision as this transaction's snapshot has it. */
export async function readSyncClock(db: Kysely<Database>): Promise<string> {
  const { rows } = await sql<{
    value: string
  }>`select value::text as value from sync_clock where id = 1`.execute(db)
  return rows[0].value
}

/**
 * A read-only GET a subscribed screen uses, in one `REPEATABLE READ`
 * transaction whose first statement reads the clock. Every read the handler
 * makes through `trx` sees the rows as of that revision, which the response
 * carries as `x-teamstation-revision`. A notice newer than it is a write
 * the response cannot have seen.
 *
 * The cost of one transaction: it holds a pooled connection, and a
 * snapshot, for as long as the handler runs, its work that is not the
 * database's included. A route with more of that to do after its last read
 * (a call to another service) uses `withRevisionThen`.
 */
export function withRevision(
  db: Kysely<Database>,
  handler: (
    trx: Kysely<Database>,
    ...args: Parameters<RequestHandler>
  ) => Promise<void>
): RequestHandler {
  return withRevisionThen(db, async (trx, req, res, next) => {
    await handler(trx, req, res, next)
    return async () => undefined
  })
}

/** What a read-only GET does once its transaction has committed. */
export type AfterCommit = () => Promise<void>

/**
 * `withRevision` for a handler that answers in two steps: its reads in the
 * transaction, and then the step it returns, which runs once the
 * transaction has committed and its connection is back in the pool.
 */
export function withRevisionThen(
  db: Kysely<Database>,
  handler: (
    trx: Kysely<Database>,
    ...args: Parameters<RequestHandler>
  ) => Promise<AfterCommit>
): RequestHandler {
  return (req, res, next) => {
    db.transaction()
      .setIsolationLevel('repeatable read')
      .execute(async trx => {
        res.setHeader(REVISION_HEADER, await readSyncClock(trx))
        return await handler(trx, req, res, next)
      })
      .then(async after => {
        await after()
      })
      .catch(next)
  }
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
