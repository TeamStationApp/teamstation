import { randomUUID } from 'node:crypto'

import type { Kysely, Selectable } from 'kysely'

import type { TessChange } from '../../common/api'
import { badRequest, conflict, HttpError, notFound } from '../../common/errors'
import type { Database, TessChangesTable } from '../db/database'
import { isUuid } from './attachments'
import { type ApiMethod, checkApiRequest } from './denyList'
import { whileLive } from './liveUser'
import {
  apiCall,
  type ApiCallOptions,
  type Credentials,
  LOOPBACK_DEADLINE_MS
} from './loopback'

/**
 * The changes Tess proposes. She never runs one: `confirmChange` stores the
 * request as she wrote it, with what it sets in plain words (`details`), the
 * app shows a reply's changes as a table with each request folded under it,
 * and they run only when the person holds Confirm, with their own
 * credentials, through the same API and the same permission checks as a
 * tap. A change not confirmed within 30 minutes, or before the person's next
 * message, expires.
 */

export const CHANGE_TTL_MS = 30 * 60 * 1000

/** How much of the server's answer to a change is kept and reported. */
export const MAX_CHANGE_RESULT = 4000

/**
 * A change still running this long after it began was lost with its worker
 * or its last update: its request had long since had its answer or given
 * up. Whether it happened is unknown.
 */
export const LOST_AFTER_MS = LOOPBACK_DEADLINE_MS + 30000

/** The most changes one hold confirms. */
export const MAX_BATCH = 50

export const UNKNOWN_CHANGE =
  'This change may or may not have run. Check whether it happened before asking Tess again.'

type ChangeRow = Selectable<TessChangesTable>
export type WriteMethod = Exclude<ApiMethod, 'GET'>

export interface ProposedChange {
  method: WriteMethod
  /** The checked path, below `/api/v1`, with any query. */
  path: string
  body?: unknown
  summary: string
  /** What it sets, label by label, in plain words, in the model's order. */
  details?: ChangeDetail[]
}

export interface ChangeDetail {
  label: string
  value: string
}

/**
 * Stores a change to be confirmed, and answers its id; once the person's
 * account is deleted, 410.
 */
export async function proposeChange(
  db: Kysely<Database>,
  userId: string,
  change: ProposedChange,
  now: Date
): Promise<string> {
  const id = randomUUID()
  await whileLive(db, userId, async trx => {
    await trx
      .insertInto('tess_changes')
      .values({
        id,
        user_id: userId,
        method: change.method,
        path: change.path,
        body: change.body === undefined ? null : JSON.stringify(change.body),
        summary: change.summary,
        details: change.details == null ? null : JSON.stringify(change.details),
        expires_at: new Date(now.getTime() + CHANGE_TTL_MS)
      })
      .execute()
  })
  return id
}

/**
 * Expires every change the person has not confirmed: they moved on. Answers
 * the ids it expired.
 */
export async function expirePendingChanges(
  db: Kysely<Database>,
  userId: string
): Promise<string[]> {
  const rows = await db
    .updateTable('tess_changes')
    .set({ status: 'expired' })
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .returning('id')
    .execute()
  return rows.map(row => row.id)
}

/**
 * Makes pending again the changes a message expired, when that message was
 * taken back: the person did not move on after all. Their own time limit
 * still holds when one is confirmed.
 */
export async function restoreExpiredChanges(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  await db
    .updateTable('tess_changes')
    .set({ status: 'pending' })
    .where('user_id', '=', userId)
    .where('id', 'in', ids)
    .where('status', '=', 'expired')
    .execute()
}

/** Whether a change has been running so long at `now` that it was lost. */
function lost(row: ChangeRow, now: Date): boolean {
  return (
    row.status === 'running' &&
    row.started_at != null &&
    now.getTime() - new Date(row.started_at).getTime() > LOST_AFTER_MS
  )
}

/** The stored details, as pairs of strings, or none. */
function storedDetails(value: unknown): ChangeDetail[] | undefined {
  if (!Array.isArray(value)) return undefined
  const details = value.flatMap((item: unknown): ChangeDetail[] => {
    const { label, value } = (item ?? {}) as Record<string, unknown>
    return typeof label === 'string' && typeof value === 'string'
      ? [{ label, value }]
      : []
  })
  return details.length === 0 ? undefined : details
}

/**
 * A change as the app shows it at `now`: one lost mid-run is unknown. Its
 * details, when Tess gave any, are its row of the table. A pending one says
 * when it expires, and how long it has left as of `now`, which the app
 * counts from when it receives it, so it stops waiting for its hold then
 * whatever its own clock says.
 */
export function changeView(row: ChangeRow, now = new Date()): TessChange {
  const details = storedDetails(row.details)
  const status = lost(row, now) ? 'unknown' : row.status
  return {
    id: row.id,
    summary: row.summary,
    method: row.method,
    path: row.path,
    body: row.body ?? null,
    status,
    ...(details == null ? {} : { details }),
    ...(status === 'pending'
      ? {
          expiresAt: new Date(row.expires_at).toISOString(),
          expiresInMs: Math.max(
            0,
            new Date(row.expires_at).getTime() - now.getTime()
          )
        }
      : {})
  }
}

/** The person's changes with these ids, as the app shows them, by id. */
export async function changesById(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[],
  now = new Date()
): Promise<Map<string, TessChange>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('tess_changes')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', 'in', [...ids])
    .execute()
  return new Map(rows.map(row => [row.id, changeView(row, now)]))
}

export interface ConfirmDeps {
  db: Kysely<Database>
  origin: () => string
  now?: () => Date
  /** The loopback's `fetch` and deadline, replaced in tests. */
  loopback?: ApiCallOptions
}

/**
 * Runs one of the person's pending changes, once. Another person's change,
 * or none, is not found; one that is not pending, or has expired, is a
 * conflict, and one lost mid-run is stored as `unknown` and refused with a
 * note to check it. Setting `running` only where the change is still
 * `pending` is what makes two confirms run it once. A change the server
 * gave no answer to (out of time, or unreachable) is `unknown` too: giving
 * up on the request does not undo a write it may already have made, so the
 * table and Tess both say to check. Answers the change as it ended, and the
 * note Tess is told it with. `batchNow`, for one of a batch, is the moment
 * the batch was confirmed, against which its time is checked; it is still
 * marked as starting when it does start, so a long batch's later changes are
 * not taken for lost while they run.
 */
export async function runChange(
  deps: ConfirmDeps,
  userId: string,
  credentials: Credentials,
  changeId: string,
  batchNow?: Date
): Promise<{ change: TessChange; note: string }> {
  const now = batchNow ?? deps.now?.() ?? new Date()
  if (!isUuid(changeId)) throw notFound('No such change')
  const found = await deps.db
    .selectFrom('tess_changes')
    .selectAll()
    .where('id', '=', changeId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (found == null) throw notFound('No such change')
  if (found.status === 'pending' && new Date(found.expires_at) <= now) {
    await deps.db
      .updateTable('tess_changes')
      .set({ status: 'expired' })
      .where('id', '=', changeId)
      .where('status', '=', 'pending')
      .execute()
    throw conflict('This change has expired. Ask Tess again.')
  }
  if (lost(found, now)) {
    await deps.db
      .updateTable('tess_changes')
      .set({ status: 'unknown' })
      .where('id', '=', changeId)
      .where('status', '=', 'running')
      .execute()
    throw conflict(UNKNOWN_CHANGE)
  }
  if (found.status === 'unknown') throw conflict(UNKNOWN_CHANGE)
  const running = await deps.db
    .updateTable('tess_changes')
    .set({
      status: 'running',
      started_at: batchNow == null ? now : (deps.now?.() ?? new Date())
    })
    .where('id', '=', changeId)
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', now)
    .returningAll()
    .executeTakeFirst()
  if (running == null) throw conflict(`This change is already ${found.status}`)

  // Checked again, as it was when proposed: the list may have grown since.
  const checked = checkApiRequest(running.method, running.path)
  const answer =
    typeof checked === 'string'
      ? { status: 403, body: checked, truncated: false }
      : await apiCall(
          deps.origin(),
          credentials,
          running.method,
          `${checked.path}${checked.search}`,
          undefined,
          running.body ?? undefined,
          deps.loopback
        )
  const unanswered = answer.status === 0
  const succeeded = answer.status >= 200 && answer.status < 300
  const result = resultOf(answer.body)
  const ended = await deps.db
    .updateTable('tess_changes')
    .set({
      status: unanswered ? 'unknown' : succeeded ? 'done' : 'failed',
      result: JSON.stringify({ status: answer.status, body: result })
    })
    .where('id', '=', changeId)
    .returningAll()
    .executeTakeFirstOrThrow()
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  const confirmed = `The user confirmed the change "${running.summary}" (${running.method} ${running.path})`
  return {
    change: changeView(ended),
    note: unanswered
      ? `${confirmed}; the server gave no answer, so it may or may not have happened. Tell them to check whether it did before asking for it again.`
      : `${confirmed}; the server answered ${answer.status}: ${text}`
  }
}

/**
 * Runs a batch of the person's pending changes, the ones a reply proposed,
 * held as one: each once, in the order given. The batch is looked at whole
 * first, and nothing runs unless it all can: one named twice is a bad
 * request, one that is not the person's (or no change) is not found, and one
 * no longer pending, past its time or lost mid-run is a conflict, the last
 * two stored as `expired` and `unknown`, as `runChange` stores them. Then
 * each runs, its time checked at the batch's `now`, so a batch accepted
 * whole runs whole however long its requests take; one that fails, on the
 * server or (one taken meanwhile) before it ran, does not stop the rest, nor
 * does one whose run breaks off with an error of the server's own
 * (`brokenOff`). Answers each change as it ended, and the note Tess is told
 * it with.
 */
export async function runChanges(
  deps: ConfirmDeps,
  userId: string,
  credentials: Credentials,
  changeIds: readonly string[]
): Promise<Array<{ change: TessChange; note: string }>> {
  if (changeIds.length === 0 || changeIds.length > MAX_BATCH)
    throw badRequest(`Confirm 1 to ${MAX_BATCH} changes`)
  if (new Set(changeIds).size !== changeIds.length)
    throw badRequest('A change is named twice')
  if (!changeIds.every(isUuid)) throw notFound('No such change')
  const now = deps.now?.() ?? new Date()
  const rows = await deps.db
    .selectFrom('tess_changes')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', 'in', [...changeIds])
    .execute()
  if (rows.length !== changeIds.length) throw notFound('No such change')
  const late = rows.filter(
    row => row.status === 'pending' && new Date(row.expires_at) <= now
  )
  if (late.length > 0) {
    await deps.db
      .updateTable('tess_changes')
      .set({ status: 'expired' })
      .where(
        'id',
        'in',
        late.map(row => row.id)
      )
      .where('status', '=', 'pending')
      .execute()
    throw conflict('These changes have expired. Ask Tess again.')
  }
  const gone = rows.filter(row => lost(row, now))
  if (gone.length > 0) {
    await deps.db
      .updateTable('tess_changes')
      .set({ status: 'unknown' })
      .where(
        'id',
        'in',
        gone.map(row => row.id)
      )
      .where('status', '=', 'running')
      .execute()
    throw conflict(UNKNOWN_CHANGE)
  }
  if (rows.some(row => row.status === 'unknown')) throw conflict(UNKNOWN_CHANGE)
  const settled = rows.find(row => row.status !== 'pending')
  if (settled != null) throw conflict(`A change is already ${settled.status}`)
  const byId = new Map(rows.map(row => [row.id, row]))
  const ran: Array<{ change: TessChange; note: string }> = []
  for (const changeId of changeIds) {
    try {
      ran.push(await runChange(deps, userId, credentials, changeId, now))
    } catch (error) {
      const row = byId.get(changeId)!
      ran.push(
        error instanceof HttpError
          ? {
              change:
                (await changesById(deps.db, userId, [changeId], now)).get(
                  changeId
                ) ?? changeView(row, now),
              note: `The change "${row.summary}" (${row.method} ${row.path}) did not run: ${error.message}`
            }
          : await brokenOff(deps.db, userId, row, now)
      )
    }
  }
  return ran
}

/**
 * A change of a batch whose run broke off with an error of the server's own,
 * a database's say, rather than an answer: stored and told as `failed` when
 * it is still pending, so it provably never ran, and otherwise as `unknown`,
 * since its request may have gone out. Never throws, so the rest of the
 * batch runs and every change of it gets its note.
 */
async function brokenOff(
  db: Kysely<Database>,
  userId: string,
  row: ChangeRow,
  now: Date
): Promise<{ change: TessChange; note: string }> {
  const named = `The change "${row.summary}" (${row.method} ${row.path})`
  try {
    const failed = await db
      .updateTable('tess_changes')
      .set({ status: 'failed' })
      .where('id', '=', row.id)
      .where('user_id', '=', userId)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst()
    if (failed != null)
      return {
        change: changeView(failed, now),
        note: `${named} did not run: something went wrong before it could.`
      }
    await db
      .updateTable('tess_changes')
      .set({ status: 'unknown' })
      .where('id', '=', row.id)
      .where('user_id', '=', userId)
      .where('status', '=', 'running')
      .execute()
  } catch {
    // Unstored, it is told as unknown all the same.
  }
  return {
    change: { ...changeView(row, now), status: 'unknown' },
    note: `${named} may or may not have run: ${UNKNOWN_CHANGE}`
  }
}

/** The server's answer, as JSON when it is JSON, cut to a few thousand characters. */
function resultOf(body: string): unknown {
  if (body.length > MAX_CHANGE_RESULT)
    return `${body.slice(0, MAX_CHANGE_RESULT)}… [cut]`
  if (body === '') return ''
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}
