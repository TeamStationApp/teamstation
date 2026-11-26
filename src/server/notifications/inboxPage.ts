import { randomUUID } from 'node:crypto'

import {
  type Kysely,
  type RawBuilder,
  type Selectable,
  type SelectQueryBuilder,
  sql
} from 'kysely'

import { forbidden } from '../../common/errors'
import {
  CHAT_DEVICE_APPROVAL,
  LOCAL_COPY_EXPIRING,
  RECORDING_UPLOAD
} from '../../common/notifications'
import type {
  Database,
  GroupRequestsTable,
  NotificationEventsTable
} from '../db/database'
import type { StoredRequest } from '../groups/requests'
import type { InboxProjection, RequestState } from './inboxProjection'
import { pendingInformationWhere } from './pending'
import { type InboxMode, pendingRequests } from './pendingRequests'

export interface PageKey {
  rank: number
  sentAt: string
  requestId: string
}
export interface InboxOptions {
  history?: boolean
  sent?: boolean
  cursor?: string
  limit?: number
}
export function pageOptions(options: InboxOptions): {
  mode: InboxMode
  limit: number
  after?: PageKey
} {
  const mode =
    options.history === true
      ? 'history'
      : options.sent === true
        ? 'sent'
        : 'pending'
  let after: PageKey | undefined
  if (options.cursor != null) {
    const parts = options.cursor.split('|')
    const [rank, time, id] = parts.length === 2 ? ['1', ...parts] : parts
    if (
      (rank !== '0' && rank !== '1') ||
      !Number.isFinite(Date.parse(time)) ||
      id == null ||
      parts.length > 3
    )
      throw forbidden('Invalid notification cursor')
    after = { rank: Number(rank), sentAt: time, requestId: id }
  }
  return { mode, limit: Math.max(1, Math.min(100, options.limit ?? 25)), after }
}
export function compareKeys(a: PageKey, b: PageKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.sentAt !== b.sentAt) return a.sentAt < b.sentAt ? -1 : 1
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0
}
export function cursorOf(row: PageKey): string {
  return `${row.rank}|${row.sentAt}|${row.requestId}`
}

// JS compares canonical millisecond ISO strings, including against the cursor's
// original text. Preserve that contract for alternate valid date spellings too.
const requestTime = sql<string>`to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') collate "C"`
const requestId = sql<string>`group_requests.id::text collate "C"`
const informationTime = sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') collate "C"`
const informationId = sql<string>`(case when source_type = ${CHAT_DEVICE_APPROVAL} then source_id else notification_events.id::text end) collate "C"`

/** Tuple predicates share the exact key used to sort the response. */
function afterWhere(
  rank: RawBuilder<number>,
  time: RawBuilder<string>,
  id: RawBuilder<string>,
  after?: PageKey
): RawBuilder<boolean> {
  return after == null
    ? sql<boolean>`true`
    : sql<boolean>`(${rank}, ${time}, ${id}) > (${after.rank}, ${after.sentAt}::text collate "C", ${after.requestId}::text collate "C")`
}

export type Candidate = PageKey &
  (
    | { kind: 'request'; request: StoredRequest; state: RequestState }
    | { kind: 'information'; event: Selectable<NotificationEventsTable> }
  )

/** Windows remain bounded even when live authority rejects every candidate. */
export async function* requestPages(
  rows: SelectQueryBuilder<
    Database,
    'group_requests',
    Selectable<GroupRequestsTable>
  >,
  projection: InboxProjection,
  mode: InboxMode,
  after?: PageKey,
  signal?: AbortSignal
): AsyncGenerator<Candidate> {
  const now = projection.clock.now()
  let query = pendingRequests(rows, mode, now)
  if (mode === 'sent')
    query = query.where('status', '=', 'pending').where('expires_at', '>', now)
  if (mode === 'history')
    query = query.where(eb =>
      eb.or([eb('status', '!=', 'pending'), eb('expires_at', '<=', now)])
    )
  const stopped = (): boolean => signal?.aborted === true
  if (stopped()) return
  const cursor = sql.id(`notification_page_${randomUUID().replaceAll('-', '')}`)
  const selected = query
    .where(afterWhere(sql<number>`1::integer`, requestTime, requestId, after))
    .orderBy(requestTime)
    .orderBy(requestId)
  let declared = false
  let failed = false
  try {
    // readInbox owns this transaction. A server cursor evaluates the exact
    // keyset/order once, instead of repeating its authorization subqueries and
    // sort for every rejected window. Only 100 rows enter application memory.
    await sql`declare ${cursor} no scroll cursor for ${selected}`.execute(
      projection.db
    )
    declared = true
    while (!stopped()) {
      const found = (
        await sql<StoredRequest>`fetch forward 100 from ${cursor}`.execute(
          projection.db
        )
      ).rows
      if (stopped() || found.length === 0) return
      const states = await projection.requests(found)
      for (const request of found) {
        if (stopped()) return
        const state = states.get(request.id)
        if (state == null) continue
        const pending = state.canAct || state.news
        if (
          mode === 'pending'
            ? pending
            : mode === 'sent'
              ? state.canWithdraw
              : state.status !== 'pending' && !pending
        )
          yield {
            rank: 1,
            sentAt: request.sent_at.toISOString(),
            requestId: request.id,
            kind: 'request',
            request,
            state
          }
      }
      if (found.length < 100) return
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (declared) {
      const close = sql`close ${cursor}`.execute(projection.db)
      // A failed statement can already have aborted the transaction. Preserve
      // that original failure; rollback releases its cursor in that case.
      if (failed) await close.catch(() => undefined)
      else await close
    }
  }
}

export async function* informationPages(
  db: Kysely<Database>,
  userId: string,
  now: Date,
  mode: InboxMode,
  after?: PageKey
): AsyncGenerator<Candidate> {
  if (mode === 'sent') return
  const rank =
    mode === 'pending'
      ? sql<number>`case when source_type in (${RECORDING_UPLOAD}, ${LOCAL_COPY_EXPIRING}) then 0 else 1 end`
      : sql<number>`1::integer`
  const rows = db
    .selectFrom('notification_events')
    .selectAll()
    .where('source_type', '!=', 'groupRequest')
    .where(sql<boolean>`recorded_recipients @> ${[userId]}::text[]`)
    .where(eb =>
      mode === 'pending'
        ? pendingInformationWhere(eb, userId, now)
        : eb.not(pendingInformationWhere(eb, userId, now))
    )
    .where(eb =>
      eb.or([
        eb('source_type', '!=', CHAT_DEVICE_APPROVAL),
        eb.exists(
          eb
            .selectFrom('chat_links')
            .innerJoin(
              'chat_devices',
              'chat_devices.id',
              'chat_links.new_device_id'
            )
            .select('chat_links.id')
            .whereRef('chat_links.id', '=', 'notification_events.source_id')
            .where('chat_links.user_id', '=', userId)
        )
      ])
    )
  while (true) {
    const found = await rows
      .where(afterWhere(rank, informationTime, informationId, after))
      .orderBy(rank)
      .orderBy(informationTime)
      .orderBy(informationId)
      .limit(100)
      .execute()
    if (found.length === 0) return
    for (const event of found) {
      const key = {
        rank:
          mode === 'pending' &&
          [RECORDING_UPLOAD, LOCAL_COPY_EXPIRING].includes(event.source_type)
            ? 0
            : 1,
        sentAt: event.created_at.toISOString(),
        requestId:
          event.source_type === CHAT_DEVICE_APPROVAL
            ? event.source_id
            : event.id
      }
      after = key
      yield { ...key, kind: 'information', event }
    }
    if (found.length < 100) return
  }
}

/** Read one lookahead from sorted streams, without materializing their history. */
export async function mergePage<T extends PageKey>(
  streams: Array<AsyncIterator<T>>,
  limit: number
): Promise<{ page: T[]; nextCursor: string | null }> {
  const found: T[] = []
  let failed = false
  try {
    const heads = await Promise.all(
      streams.map(async stream => await stream.next())
    )
    while (found.length <= limit) {
      let selected = -1
      for (let i = 0; i < heads.length; i++)
        if (
          heads[i].done !== true &&
          (selected < 0 ||
            compareKeys(heads[i].value, heads[selected].value) < 0)
        )
          selected = i
      if (selected < 0) break
      found.push(heads[selected].value)
      if (found.length > limit) break
      heads[selected] = await streams[selected].next()
    }
    const page = found.slice(0, limit)
    return {
      page,
      nextCursor: found.length > limit ? cursorOf(page[page.length - 1]) : null
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    const closing = Promise.all(
      streams.map(async stream => await stream.return?.())
    )
    if (failed) await closing.catch(() => undefined)
    else await closing
  }
}
