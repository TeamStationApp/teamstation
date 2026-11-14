import { type Kysely, sql } from 'kysely'

import type { ActivityPage, Page } from '../../common/api'
import { badRequest } from '../../common/errors'
import {
  ACTIVITY_PAGE_MAX,
  ACTIVITY_PAGE_SIZE,
  type ActivityRow
} from '../../common/userManagement'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import {
  ACTIVITY_AT_FORMAT,
  decodeActivityCursor,
  encodeActivityCursor
} from './activityCursor'
import { appType, deviceLabel } from './deviceLabels'
import { requireSignedInNodeAdmin } from './nodeAdministration'

/** What `GET /node/logins` and `GET /node/sessions` were asked. */
export interface ActivityQuery {
  limit: number
  cursor: string | null
}

/**
 * The query of an activity list: `limit` (1 to 100, 50 when left out) and
 * `cursor`, and nothing else, each at most once.
 */
export function activityQueryOf(query: Record<string, unknown>): ActivityQuery {
  for (const key of Object.keys(query))
    if (key !== 'limit' && key !== 'cursor')
      throw badRequest(`${key} is not a parameter of this list`)
  const { limit, cursor } = query
  if (limit !== undefined && typeof limit !== 'string')
    throw badRequest('Give limit once')
  if (cursor !== undefined && typeof cursor !== 'string')
    throw badRequest('Give cursor once')
  const size = limit === undefined ? ACTIVITY_PAGE_SIZE : Number(limit)
  if (
    limit !== undefined &&
    (!/^\d{1,3}$/.test(limit) || size < 1 || size > ACTIVITY_PAGE_MAX)
  )
    throw badRequest(`limit is a whole number from 1 to ${ACTIVITY_PAGE_MAX}`)
  return { limit: size, cursor: cursor ?? null }
}

interface RawActivity {
  id: string
  at: Date
  cursor_at: string
  user_id: string
  display_name: string
  avatar_path: string | null
  email: string | null
  device_name: string | null
  user_agent: string | null
  chat_name: string | null
  chat_platform: 'web' | 'ios' | 'android' | null
}

/**
 * The columns every activity row reads beside its own: the person, their
 * address (a verified primary first, then the oldest), and the name and
 * platform the sign-in gave chat, if it registered there.
 */
const personColumns = sql`
  u.display_name, u.avatar_path,
  (select e.email from user_emails e where e.user_id = u.id
    order by (e.is_primary and e.verified_at is not null) desc,
      e.verified_at is not null desc, e.created_at, e.id
    limit 1) as email,
  s.device_name, s.user_agent,
  chat.name as chat_name, chat.platform as chat_platform`

/** The device a sign-in registered for chat, its newest still standing. */
const chatDevice = sql`
  left join lateral (
    select d.name, d.platform from chat_devices d
    where d.session_id = s.id and d.revoked_at is null
    order by d.created_at desc limit 1
  ) chat on true`

/**
 * The latest use of any of these accounts' sign-ins, tokens and keys, by
 * account: what the people were last seen doing, wherever.
 */
export async function lastActiveOf(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map()
  const ids = sql.join([...new Set(userIds)])
  const { rows } = await sql<{ user_id: string; last: Date | null }>`
    select user_id, max(last_used_at) as last from (
      select user_id, last_used_at from auth_sessions where user_id in (${ids})
      union all
      select user_id, last_used_at from api_tokens where user_id in (${ids})
      union all
      select user_id, last_used_at from user_api_keys where user_id in (${ids})
    ) uses group by user_id`.execute(db)
  return new Map(
    rows.flatMap(row =>
      row.last == null ? [] : [[row.user_id, new Date(row.last)] as const]
    )
  )
}

async function pageOf(
  db: Kysely<Database>,
  raw: RawActivity[],
  limit: number,
  space: SpaceSettings | undefined
): Promise<Page<ActivityRow>> {
  const rows = raw.slice(0, limit)
  const last = await lastActiveOf(
    db,
    rows.map(row => row.user_id)
  )
  const tail = rows.at(-1)
  return {
    items: rows.map(row => {
      const facts = {
        deviceName: row.device_name,
        chatDeviceName: row.chat_name,
        chatPlatform: row.chat_platform,
        userAgent: row.user_agent
      }
      return {
        id: row.id,
        at: new Date(row.at).toISOString(),
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        avatarUrl: space == null ? null : imageUrl(space, row.avatar_path),
        lastActiveAt: last.get(row.user_id)?.toISOString() ?? null,
        device: deviceLabel(facts),
        appType: appType(facts)
      }
    }),
    nextCursor:
      raw.length > limit && tail != null
        ? encodeActivityCursor({ at: tail.cursor_at, id: tail.id })
        : null,
    prevCursor: null,
    anchorId: null,
    counts: null
  }
}

/**
 * Every sign-in still stored, newest first: each one a login, so one person
 * signing in three times is three rows. A restored session or a refreshed
 * token makes none. A cursor walks down from where a page ended, so rows
 * that arrive meanwhile, newer than any on the page, never shift it.
 */
export async function recentLogins(
  db: Kysely<Database>,
  actor: Actor,
  query: ActivityQuery,
  space?: SpaceSettings
): Promise<Page<ActivityRow>> {
  await requireSignedInNodeAdmin(
    db,
    actor,
    'Only a node administrator, signed in, can see logins and sessions'
  )
  const from = query.cursor == null ? null : decodeActivityCursor(query.cursor)
  const { rows } = await sql<RawActivity>`
    select s.id, s.created_at as at,
      to_char(s.created_at at time zone 'UTC', ${ACTIVITY_AT_FORMAT}) as cursor_at,
      s.user_id, ${personColumns}
    from auth_sessions s join users u on u.id = s.user_id ${chatDevice}
    where ${
      from == null
        ? sql`true`
        : sql`(s.created_at, s.id collate "C") < (${from.at}::timestamptz, ${from.id} collate "C")`
    }
    order by s.created_at desc, s.id collate "C" desc
    limit ${query.limit + 1}`.execute(db)
  return await pageOf(db, rows, query.limit, space)
}

/**
 * Every device session recorded, newest start first, paged as logins are.
 * The first page says when recording began: there are none before it.
 */
export async function recentSessions(
  db: Kysely<Database>,
  actor: Actor,
  query: ActivityQuery,
  space?: SpaceSettings
): Promise<ActivityPage> {
  await requireSignedInNodeAdmin(
    db,
    actor,
    'Only a node administrator, signed in, can see logins and sessions'
  )
  const from = query.cursor == null ? null : decodeActivityCursor(query.cursor)
  const { rows } = await sql<RawActivity>`
    select ds.id, ds.started_at as at,
      to_char(ds.started_at at time zone 'UTC', ${ACTIVITY_AT_FORMAT}) as cursor_at,
      ds.user_id, ${personColumns}
    from device_sessions ds
      join auth_sessions s on s.id = ds.auth_session_id
      join users u on u.id = ds.user_id ${chatDevice}
    where ${
      from == null
        ? sql`true`
        : sql`(ds.started_at, ds.id collate "C") < (${from.at}::timestamptz, ${from.id} collate "C")`
    }
    order by ds.started_at desc, ds.id collate "C" desc
    limit ${query.limit + 1}`.execute(db)
  const page = await pageOf(db, rows, query.limit, space)
  if (from != null) return page
  // The migration that made the table is when recording began.
  const { rows: since } = await sql<{ applied_at: Date }>`
    select applied_at from schema_migrations
    where name = '118deviceSessions'`.execute(db)
  return {
    ...page,
    recordedSince:
      since[0] == null ? null : new Date(since[0].applied_at).toISOString()
  }
}
