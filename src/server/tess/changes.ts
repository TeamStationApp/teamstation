import { randomUUID } from 'node:crypto'

import type { Kysely, Selectable } from 'kysely'

import type { TessChange } from '../../common/api'
import { conflict, notFound } from '../../common/errors'
import type { Database, TessChangesTable } from '../db/database'
import { type ApiMethod, checkApiRequest } from './denyList'
import { apiCall, type Credentials } from './loopback'

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

type ChangeRow = Selectable<TessChangesTable>
export type WriteMethod = Exclude<ApiMethod, 'GET'>

export interface ProposedChange {
  method: WriteMethod
  /** The checked path, below `/api/v1`, with any query. */
  path: string
  body?: unknown
  summary: string
}

/** Stores a change to be confirmed, and answers its id. */
export async function proposeChange(
  db: Kysely<Database>,
  userId: string,
  change: ProposedChange,
  now: Date
): Promise<string> {
  const id = randomUUID()
  await db
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
  return id
}

/** Expires every change the person has not confirmed: they moved on. */
export async function expirePendingChanges(
  db: Kysely<Database>,
  userId: string
): Promise<void> {
  await db
    .updateTable('tess_changes')
    .set({ status: 'expired' })
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .execute()
}

/** A change as the app shows it. */
export function changeView(row: ChangeRow): TessChange {
  return {
    id: row.id,
    summary: row.summary,
    method: row.method,
    path: row.path,
    body: row.body ?? null,
    status: row.status
  }
}

/** The person's changes with these ids, as the app shows them, by id. */
export async function changesById(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<Map<string, TessChange>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('tess_changes')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', 'in', [...ids])
    .execute()
  return new Map(rows.map(row => [row.id, changeView(row)]))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ConfirmDeps {
  db: Kysely<Database>
  origin: () => string
  now?: () => Date
}

/**
 * Runs one of the person's pending changes, once. Another person's change,
 * or none, is not found; one that is not pending, or has expired, is a
 * conflict. Setting `running` only where the change is still `pending` is
 * what makes two confirms run it once. Answers the change as it ended, and
 * the note Tess is told it with.
 */
export async function runChange(
  deps: ConfirmDeps,
  userId: string,
  credentials: Credentials,
  changeId: string
): Promise<{ change: TessChange; note: string }> {
  if (!UUID.test(changeId)) throw notFound('No such change')
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
  const running = await deps.db
    .updateTable('tess_changes')
    .set({ status: 'running' })
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
          running.body ?? undefined
        )
  const succeeded = answer.status >= 200 && answer.status < 300
  const result = resultOf(answer.body)
  const ended = await deps.db
    .updateTable('tess_changes')
    .set({
      status: succeeded ? 'done' : 'failed',
      result: JSON.stringify({ status: answer.status, body: result })
    })
    .where('id', '=', changeId)
    .returningAll()
    .executeTakeFirstOrThrow()
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return {
    change: changeView(ended),
    note: `The user confirmed the change "${running.summary}" (${running.method} ${running.path}); the server answered ${answer.status === 0 ? 'nothing' : answer.status}: ${text}`
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
