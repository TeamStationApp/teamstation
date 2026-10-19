import { createHash, randomBytes } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject {
  [key: string]: Json
}

export interface TableSnapshot {
  columns: string[]
  keys: string[]
  rows: JsonObject[]
}

export interface UserIdSnapshot {
  version: 1
  migrations: string[]
  userIdType: 'bigint' | 'text'
  userColumns: Record<string, string[]>
  tables: Record<string, TableSnapshot>
  preserved: Record<string, string>
  api: Record<string, Json>
}

export function identityKey(value: Json): string {
  if (value == null) return 'null'
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Expected a scalar identity')
  }
  return String(value)
}

export function canonical(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value != null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

function hash(value: Json): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function identifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"'
}

const WHOLE_TABLES = [
  'game_player_stats',
  'eventCredits',
  'event_players',
  'gumbo_ids',
  'game_placeholder_guests',
  'game_guest_details',
  'group_requests',
  'group_request_sides'
]

const FIELDS: Record<string, string[]> = {
  users: [
    'id',
    'legacyId',
    'merged_into',
    'display_name',
    'first_name',
    'last_name',
    'login_enabled',
    'is_admin',
    'avatar_path'
  ],
  teams: ['id', 'default_lineup'],
  seasons: ['id'],
  games: [
    'id',
    'home_team_id',
    'away_team_id',
    'season_id',
    'guests',
    'unrostered',
    'currentPlay'
  ],
  events: ['id', 'gameId', 'atBatIndex', 'gumbo', 'hidden'],
  notification_events: ['id', 'recorded_recipients'],
  external_ids: [
    'id',
    'system',
    'kind',
    'external_id',
    'entity_type',
    'entity_id'
  ]
}

/** Database data remains private; reports print paths and counts, never values. */
export async function snapshotSql(
  client: PoolClient,
  sessionId?: string
): Promise<Omit<UserIdSnapshot, 'api'>> {
  const columns = await client.query<{
    table_name: string
    column_name: string
    data_type: string
  }>(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = 'public' order by table_name, ordinal_position`
  )
  const schema = new Map<string, string[]>()
  let userIdType: 'bigint' | 'text' | undefined
  for (const row of columns.rows) {
    const held = schema.get(row.table_name) ?? []
    held.push(row.column_name)
    schema.set(row.table_name, held)
    if (row.table_name === 'users' && row.column_name === 'id') {
      if (row.data_type !== 'bigint' && row.data_type !== 'text') {
        throw new Error('Unsupported user id column type')
      }
      userIdType = row.data_type
    }
  }
  if (userIdType == null) throw new Error('Missing users table')
  const fkRows = await client.query<{
    table_name: string
    column_name: string
  }>(
    `select distinct t.relname as table_name, a.attname as column_name
     from pg_constraint c join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.users'::regclass
       and n.nspname = 'public' order by 1, 2`
  )
  const userColumns: Record<string, string[]> = {}
  for (const row of fkRows.rows) {
    ;(userColumns[row.table_name] ??= []).push(row.column_name)
  }
  const pkRows = await client.query<{
    table_name: string
    column_name: string
  }>(
    `select t.relname as table_name, a.attname as column_name
     from pg_constraint c join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     cross join lateral unnest(c.conkey) with ordinality k(attnum, position)
     join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
     where c.contype = 'p' and n.nspname = 'public' order by t.relname, k.position`
  )
  const primary: Record<string, string[]> = {}
  for (const row of pkRows.rows) {
    ;(primary[row.table_name] ??= []).push(row.column_name)
  }
  const tables: Record<string, TableSnapshot> = {}
  const names = new Set([
    ...WHOLE_TABLES,
    ...Object.keys(FIELDS),
    ...Object.keys(userColumns)
  ])
  for (const name of [...names].sort()) {
    const available = schema.get(name)
    if (available == null) continue
    const keys = primary[name] ?? []
    if (keys.length === 0) throw new Error(`Missing primary key: ${name}`)
    const selected = WHOLE_TABLES.includes(name)
      ? available
      : [
          ...new Set([
            ...keys,
            ...(FIELDS[name] ?? []),
            ...(userColumns[name] ?? [])
          ])
        ].filter(column => available.includes(column))
    const where =
      name === 'auth_sessions' && sessionId != null ? 'where id <> $1' : ''
    const result = await client.query<{ row: JsonObject }>(
      `select row_to_json(held) as row from
        (select ${selected.map(identifier).join(', ')} from ${identifier(name)} ${where}
         order by ${keys.map(identifier).join(', ')}) held`,
      where === '' ? [] : [sessionId]
    )
    const rows = result.rows.map(({ row }) => {
      for (const field of name === 'events'
        ? ['gumbo']
        : name === 'games'
          ? ['currentPlay']
          : []) {
        const document = row[field]
        if (document == null) continue
        if (Array.isArray(document) || typeof document !== 'object') {
          throw new Error(`Invalid scoring document: ${name}`)
        }
        const { teamStation = null, ...gumbo } = document
        row[field] = {
          documentHash: hash(document),
          gumboHash: hash(gumbo),
          teamStation
        }
      }
      return row
    })
    tables[name] = { columns: [...selected].sort(), keys, rows }
  }
  const migrations = await client.query<{ name: string }>(
    'select name from schema_migrations order by name'
  )
  const preserved: Record<string, string> = {}
  for (const name of [
    'audit_log',
    'rate_events',
    'creation_idempotency',
    'oauth_records'
  ]) {
    if (!schema.has(name)) continue
    const result = await client.query<{ row: JsonObject }>(
      `select row_to_json(t) as row from ${identifier(name)} t`
    )
    preserved[name] = hash(
      result.rows
        .map(item => item.row)
        .sort((a, b) => canonical(a).localeCompare(canonical(b)))
    )
  }
  return {
    version: 1,
    migrations: migrations.rows.map(row => row.name),
    userIdType,
    userColumns,
    tables,
    preserved
  }
}

/** Every endpoint and each supported stat kind, enumerated from SQL identities. */
export function snapshotPaths(sql: Omit<UserIdSnapshot, 'api'>): string[] {
  const out = new Set(['/seasons'])
  const ids = (table: string): string[] =>
    (sql.tables[table]?.rows ?? []).map(row =>
      encodeURIComponent(identityKey(row.id))
    )
  for (const id of ids('seasons')) {
    out.add(`/seasons/${id}/teams`)
    out.add(`/seasons/${id}/standings`)
    out.add(`/seasons/${id}/stats`)
    out.add(`/seasons/${id}/stats?kind=pitching`)
  }
  for (const id of ids('teams')) {
    for (const suffix of ['stats', 'stats?kind=pitching', 'games', 'roster'])
      out.add(`/teams/${id}/${suffix}`)
  }
  for (const id of ids('games')) {
    out.add(`/games/${id}`)
    out.add(`/games/${id}/box-score`)
  }
  for (const id of ids('users')) {
    out.add(`/players/${id}/stats`)
    out.add(`/players/${id}/plays`)
  }
  return [...out].sort()
}

/** Validate complete collections against SQL, including composite play identities. */
export function verifyCollections(snapshot: UserIdSnapshot): void {
  const expectIds = (
    path: string,
    expected: string[],
    key: (row: JsonObject) => string
  ): void => {
    const value = snapshot.api[path]
    if (
      !Array.isArray(value) ||
      value.some(
        row => row == null || typeof row !== 'object' || Array.isArray(row)
      )
    ) {
      throw new Error(`Expected collection: ${path}`)
    }
    const actual = value.map(row => key(row as JsonObject))
    if (new Set(actual).size !== actual.length)
      throw new Error(`Duplicate collection identity: ${path}`)
    if (canonical([...actual].sort()) !== canonical([...expected].sort())) {
      throw new Error(`Incomplete collection: ${path}`)
    }
  }
  expectIds(
    '/seasons',
    snapshot.tables.seasons.rows.map(row => identityKey(row.id)),
    row => identityKey(row.id)
  )
  const users = new Map(
    snapshot.tables.users.rows.map(row => [identityKey(row.id), row])
  )
  const openUser = (id: string): string => {
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(id)) throw new Error('Cyclic merge graph')
      seen.add(id)
      const user = users.get(id)
      if (user == null) throw new Error('Missing user in merge graph')
      if (user.merged_into == null) return id
      id = identityKey(user.merged_into)
    }
  }
  const events = new Map(
    snapshot.tables.events.rows.map(row => [identityKey(row.id), row])
  )
  const gums = new Map(
    snapshot.tables.gumbo_ids?.rows.map(row => [
      identityKey(row.gumbo_id),
      identityKey(row.user_id)
    ]) ?? []
  )
  for (const id of users.keys()) {
    const target = openUser(id)
    const expected: string[] = []
    for (const row of snapshot.tables.event_players.rows) {
      const event = events.get(identityKey(row.event_id))
      if (event == null) throw new Error('Missing scoring event')
      if (event.hidden === true) continue
      const player =
        row.gumbo_id == null
          ? identityKey(row.user_id)
          : gums.get(identityKey(row.gumbo_id))
      if (player == null) throw new Error('Missing scoring mapping')
      if (openUser(player) === target)
        expected.push(identityKey(row.event_id) + ':' + identityKey(row.role))
    }
    expectIds(
      `/players/${encodeURIComponent(id)}/plays`,
      expected,
      row => identityKey(row.eventId) + ':' + identityKey(row.role)
    )
  }
}

/** Current endpoints return complete arrays/objects; paginated responses are refused until adapted. */
export async function snapshotApi(
  paths: string[],
  origin: string,
  token: string,
  request: typeof fetch = fetch
): Promise<Record<string, Json>> {
  const api: Record<string, Json> = {}
  for (const path of paths) {
    if (Object.hasOwn(api, path)) throw new Error('Duplicate snapshot endpoint')
    const response = await request(origin.replace(/\/$/, '') + path, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok)
      throw new Error(`Snapshot endpoint failed: ${path} (${response.status})`)
    const body = (await response.json()) as Json
    if (
      body != null &&
      !Array.isArray(body) &&
      typeof body === 'object' &&
      ('nextCursor' in body || 'nextPage' in body || 'hasMore' in body)
    ) {
      throw new Error(`Pagination needs an explicit adapter: ${path}`)
    }
    api[path] = body
  }
  return api
}

export async function captureUserIds(
  pool: Pool,
  apiOrigin: string,
  request: typeof fetch = fetch
): Promise<UserIdSnapshot> {
  const client = await pool.connect()
  const token = randomBytes(32).toString('hex')
  const sessionId = 'ses_' + randomBytes(12).toString('hex')
  let inserted = false
  try {
    const admin = await client.query<{ id: string | number }>(
      `select id from users where is_admin and login_enabled and merged_into is null
       and disabled_at is null order by id limit 1`
    )
    if (admin.rows.length === 0)
      throw new Error('No enabled node admin for snapshot')
    await client.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [
        sessionId,
        admin.rows[0].id,
        createHash('sha256').update(token).digest('hex')
      ]
    )
    inserted = true
    await client.query('begin isolation level repeatable read read only')
    const before = await snapshotSql(client, sessionId)
    await client.query('commit')
    const api = await snapshotApi(
      snapshotPaths(before),
      apiOrigin,
      token,
      request
    )
    await client.query('begin isolation level repeatable read read only')
    const after = await snapshotSql(client, sessionId)
    await client.query('commit')
    if (
      canonical(before as unknown as Json) !==
      canonical(after as unknown as Json)
    ) {
      throw new Error(
        'Database changed during snapshot; stop writers and retry'
      )
    }
    const snapshot = { ...before, api }
    verifyCollections(snapshot)
    return snapshot
  } finally {
    try {
      await client.query('rollback')
      if (inserted)
        await client.query('delete from auth_sessions where id = $1', [
          sessionId
        ])
    } finally {
      client.release()
    }
  }
}
