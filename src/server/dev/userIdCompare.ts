import { userIdOfGumbo } from '../../common/userId'
import {
  canonical,
  identityKey,
  type Json,
  type JsonObject,
  type UserIdSnapshot
} from './userIdSnapshot'

export interface Comparison {
  equal: boolean
  differences: string[]
  differenceCount: number
  counts: Record<string, { before: number; after: number }>
}

function object(value: Json): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function derive(value: Json): Json {
  if (value == null) return null
  if (typeof value === 'number') return userIdOfGumbo(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    return userIdOfGumbo(Number(value))
  }
  return value
}

const SCORING_COLUMNS: Record<string, [string, string]> = {
  event_players: ['user_id', 'gumbo_id'],
  game_player_stats: ['user_id', 'gumbo_id'],
  eventCredits: ['creditUserId', 'creditGumboId']
}

function lineup(value: Json): Json {
  if (!object(value)) return value
  const rename = (player: Json): Json => {
    if (!object(player) || !Object.hasOwn(player, 'userId')) return player
    const { userId, ...rest } = player
    return { ...rest, gumboId: userId }
  }
  return {
    ...value,
    ...(Object.hasOwn(value, 'lineup') ? { lineup: lineup(value.lineup) } : {}),
    ...(Array.isArray(value.batters)
      ? { batters: value.batters.map(rename) }
      : {}),
    ...(object(value.defense)
      ? {
          defense: Object.fromEntries(
            Object.entries(value.defense).map(([key, player]) => [
              key,
              rename(player)
            ])
          )
        }
      : {})
  }
}

/** Exact named fields for the enumerated API contracts, never arbitrary *Id keys. */
const API_USER_FIELDS = new Set([
  'userId',
  'actorId',
  'recipientUserId',
  'playerUserId',
  'guardianUserId',
  'hostingAuthorizerUserId'
])

function apiIds(value: Json, map: Map<string, Json>): Json {
  if (Array.isArray(value)) return value.map(item => apiIds(item, map))
  if (!object(value)) return value
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = API_USER_FIELDS.has(key)
      ? (map.get(identityKey(child)) ?? child)
      : apiIds(child, map)
  }
  return out
}

/** Normalize only the declared 068/069 identity changes; unexpected fields survive to diff. */
export function normalizeIdentity(snapshot: UserIdSnapshot): JsonObject {
  const copy = structuredClone(snapshot)
  const userMap = new Map<string, Json>()
  const legacyMap = new Map<string, Json>()
  for (const user of copy.tables.users.rows) {
    const id = copy.userIdType === 'bigint' ? derive(user.id) : user.id
    userMap.set(identityKey(user.id), id)
    if (typeof user.legacyId === 'string') legacyMap.set(user.legacyId, id)
  }
  const mapping =
    copy.tables.gumbo_ids?.rows ??
    copy.tables.users.rows.map(row => ({ gumbo_id: row.id, user_id: row.id }))
  const mapped = mapping.map(row => ({
    gumbo_id: row.gumbo_id,
    user_id: userMap.get(identityKey(row.user_id)) ?? row.user_id
  }))
  const gumboByUser = new Map(
    mapped.map(row => [identityKey(row.user_id), row.gumbo_id])
  )
  const tables: JsonObject = {}
  const schema: JsonObject = {}
  const foreignKeys: JsonObject = { gumbo_ids: ['user_id'] }
  for (const [name, table] of Object.entries(copy.tables)) {
    if (name === 'gumbo_ids') continue
    const scoring = SCORING_COLUMNS[name]
    const userColumns = copy.userColumns[name] ?? []
    schema[name] = {
      columns: table.columns
        .map(column => (column === scoring?.[0] ? scoring[1] : column))
        .sort(),
      keys: table.keys.map(column =>
        column === scoring?.[0] ? scoring[1] : column
      )
    }
    const normalizedFk = userColumns.filter(column => column !== scoring?.[0])
    if (normalizedFk.length > 0) foreignKeys[name] = normalizedFk
    const rows = table.rows.map(row => {
      const out = { ...row }
      for (const column of userColumns) {
        if (column !== scoring?.[0])
          out[column] = userMap.get(identityKey(out[column])) ?? out[column]
      }
      if (name === 'users') out.id = userMap.get(identityKey(out.id)) ?? out.id
      if (scoring != null && Object.hasOwn(out, scoring[0])) {
        out[scoring[1]] = out[scoring[0]]
        Reflect.deleteProperty(out, scoring[0])
      }
      if (
        name === 'teams' &&
        copy.userIdType === 'bigint' &&
        copy.tables.gumbo_ids == null
      )
        out.default_lineup = lineup(out.default_lineup)
      if (
        name === 'notification_events' &&
        Array.isArray(out.recorded_recipients)
      ) {
        out.recorded_recipients = out.recorded_recipients.map(
          id => userMap.get(identityKey(id)) ?? id
        )
      }
      if (name === 'external_ids' && out.entity_type === 'user') {
        out.entity_id =
          userMap.get(identityKey(out.entity_id)) ??
          legacyMap.get(identityKey(out.entity_id)) ??
          out.entity_id
      }
      if (name === 'group_request_sides' && out.scope_type === 'user') {
        out.scope_id = userMap.get(identityKey(out.scope_id)) ?? out.scope_id
      }
      if (name === 'group_requests' && object(out.terms)) {
        const terms = { ...out.terms }
        for (const field of [
          'userId',
          'recipientUserId',
          'playerUserId',
          'hostingAuthorizerUserId'
        ]) {
          if (Object.hasOwn(terms, field))
            terms[field] =
              userMap.get(identityKey(terms[field])) ?? terms[field]
        }
        if (object(terms.guardian) && Object.hasOwn(terms.guardian, 'userId')) {
          terms.guardian = {
            ...terms.guardian,
            userId:
              userMap.get(identityKey(terms.guardian.userId)) ??
              terms.guardian.userId
          }
        }
        out.terms = terms
      }
      return out
    })
    tables[name] = rows.sort((a, b) => canonical(a).localeCompare(canonical(b)))
  }
  tables.gumbo_ids = mapped.sort((a, b) =>
    canonical(a).localeCompare(canonical(b))
  )
  const api: JsonObject = {}
  for (const [path, body] of Object.entries(copy.api)) {
    const normalizedPath = path.replace(
      /^\/players\/([^/]+)\//,
      (_match, id: string) =>
        `/players/${identityKey(userMap.get(decodeURIComponent(id)) ?? id)}/`
    )
    const normalized = apiIds(body, userMap)
    const checkGumbo = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(checkGumbo)
      if (!object(value)) return value
      const out = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, checkGumbo(child)])
      )
      if (Object.hasOwn(out, 'gumboId') && Object.hasOwn(out, 'userId')) {
        const expected = gumboByUser.get(identityKey(out.userId)) ?? null
        if (out.gumboId !== expected)
          throw new Error(`Incorrect API gumbo mapping: ${path}`)
        delete out.gumboId
      }
      return out
    }
    if (Object.hasOwn(api, normalizedPath))
      throw new Error('Duplicate normalized endpoint')
    api[normalizedPath] = checkGumbo(normalized)
  }
  return {
    tables,
    api,
    schema,
    foreignKeys,
    preserved: copy.preserved,
    migrations: copy.migrations.filter(
      name => !['068gumboIds', '069userIds', '070playerGumboIds'].includes(name)
    )
  }
}

export function compareUserIds(
  before: UserIdSnapshot,
  after: UserIdSnapshot
): Comparison {
  const differences: string[] = []
  let differenceCount = 0
  const counts: Comparison['counts'] = {}
  for (const key of new Set([
    ...Object.keys(before.tables),
    ...Object.keys(after.tables)
  ])) {
    counts[`sql.${key}`] = {
      before: before.tables[key]?.rows.length ?? 0,
      after: after.tables[key]?.rows.length ?? 0
    }
  }
  counts.api = {
    before: Object.keys(before.api).length,
    after: Object.keys(after.api).length
  }
  const note = (path: string): void => {
    differenceCount++
    if (differences.length < 20) differences.push(path)
  }
  const compare = (a: Json, b: Json, path: string): void => {
    if (canonical(a) === canonical(b)) return
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) note(`${path}.length`)
      for (let i = 0; i < Math.min(a.length, b.length); i++)
        compare(a[i], b[i], `${path}[${i}]`)
    } else if (object(a) && object(b)) {
      for (const key of [
        ...new Set([...Object.keys(a), ...Object.keys(b)])
      ].sort()) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key))
          note(`${path}.${key}`)
        else compare(a[key], b[key], `${path}.${key}`)
      }
    } else note(path)
  }
  if (
    before.userIdType === after.userIdType &&
    canonical(before.migrations) === canonical(after.migrations)
  ) {
    compare(before as unknown as Json, after as unknown as Json, '$')
  } else {
    compare(normalizeIdentity(before), normalizeIdentity(after), '$')
  }
  return { equal: differenceCount === 0, differences, differenceCount, counts }
}
