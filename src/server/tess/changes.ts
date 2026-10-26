import { randomUUID } from 'node:crypto'

import type { Kysely, Selectable } from 'kysely'

import type { TessChange } from '../../common/api'
import { conflict, notFound } from '../../common/errors'
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
 * request as she wrote it, the app shows that request on a card, and it runs
 * only when the person holds Confirm, with their own credentials, through
 * the same API and the same permission checks as a tap. A change not
 * confirmed within 30 minutes, or before the person's next message, expires.
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

/** A change as the app shows it at `now`: one lost mid-run is unknown. */
export function changeView(row: ChangeRow, now = new Date()): TessChange {
  return {
    id: row.id,
    summary: row.summary,
    method: row.method,
    path: row.path,
    body: row.body ?? null,
    status: lost(row, now) ? 'unknown' : row.status
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
 * card and Tess both say to check. Answers the change as it ended, and the
 * note Tess is told it with.
 */
export async function runChange(
  deps: ConfirmDeps,
  userId: string,
  credentials: Credentials,
  changeId: string
): Promise<{ change: TessChange; note: string }> {
  if (!isUuid(changeId)) throw notFound('No such change')
  const now = deps.now?.() ?? new Date()
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
    .set({ status: 'running', started_at: now })
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
