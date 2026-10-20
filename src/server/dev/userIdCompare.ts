import { userIdOfGumbo } from '../../common/userId'
import {
  expectedStableApiOrder,
  normalizeLegacyApiTies
} from './userIdOrdering'
import {
  canonical,
  identityKey,
  type Json,
  type JsonObject,
  type UserIdSnapshot
} from './userIdSnapshot'
import {
  expectedMergedApi,
  expectedPlaceholders,
  expectedRebuiltStats,
  normalizeTransport,
  orderSnapshotTables,
  placeholderDocumentHashes,
  validateNewGumboMappings
} from './userIdTransforms'

export interface Comparison {
  equal: boolean
  differences: string[]
  differenceCount: number
  counts: Record<string, { before: number; after: number }>
  transformations: string[]
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

/** Only these response objects carry account identities in captured endpoints. */
const API_IDENTITIES: Array<{
  endpoint: RegExp
  objects: string[][]
  gumbo?: boolean
}> = [
  { endpoint: /^\/teams\/[^/]+\/roster$/, objects: [['*']], gumbo: true },
  {
    endpoint: /^\/teams\/[^/]+\/stats(?:\?kind=pitching)?$/,
    objects: [['*']]
  },
  {
    endpoint:
      /^\/(?:seasons\/[^/]+\/stats(?:\?kind=pitching)?|games\/[^/]+\/box-score)$/,
    objects: [
      ['batting', '*'],
      ['pitching', '*']
    ]
  },
  {
    endpoint: /^\/players\/[^/]+\/stats$/,
    objects: [[], ['batting'], ['pitching']]
  },
  {
    endpoint: /^\/games\/[^/]+$/,
    objects: [
      ['guestPlayers', 'away', '*'],
      ['guestPlayers', 'home', '*']
    ],
    gumbo: true
  }
]

function apiIds(
  path: string,
  value: Json,
  map: Map<string, Json>,
  gumboByUser: Map<string, Json>,
  addGumbo: boolean,
  manifest: string[]
): Json {
  const rule = API_IDENTITIES.find(rule => rule.endpoint.test(path))
  if (rule == null) return value
  const visit = (held: Json, keys: string[], location: string): void => {
    if (keys.length > 0) {
      const [key, ...rest] = keys
      if (key === '*') {
        if (Array.isArray(held))
          held.forEach((item, index) => {
            visit(item, rest, `${location}[${index}]`)
          })
      } else if (object(held) && Object.hasOwn(held, key)) {
        visit(held[key], rest, `${location}.${key}`)
      }
      return
    }
    if (!object(held) || !Object.hasOwn(held, 'userId')) return
    const id = map.get(identityKey(held.userId)) ?? held.userId
    if (id !== held.userId) {
      held.userId = id
      manifest.push(`identity api:${path}${location}.userId`)
    }
    if (rule.gumbo !== true) return
    const expected = gumboByUser.get(identityKey(id)) ?? null
    if (addGumbo && !Object.hasOwn(held, 'gumboId')) {
      held.gumboId = expected
      manifest.push(`identity api:${path}${location}.gumboId`)
    } else if (Object.hasOwn(held, 'gumboId') && held.gumboId !== expected) {
      throw new Error(`Incorrect API gumbo mapping: ${path}${location}`)
    }
  }
  for (const keys of rule.objects) visit(value, keys, '')
  return value
}

/** Normalize only the declared 068/069 identity changes; unexpected fields survive to diff. */
export function normalizeIdentity(
  snapshot: UserIdSnapshot,
  ignoreNewMappingTime = false,
  manifest: string[] = []
): JsonObject {
  const copy = structuredClone(snapshot)
  for (const [name, table] of Object.entries(copy.tables)) {
    if (table.types == null) continue
    for (const column of [
      ...(copy.userColumns[name] ?? []),
      ...(name === 'users' ? ['id'] : [])
    ]) {
      if (table.types[column] !== copy.userIdType)
        throw new Error(`Incorrect user column type: ${name}.${column}`)
    }
  }
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
    ...row,
    gumbo_id: row.gumbo_id,
    user_id: userMap.get(identityKey(row.user_id)) ?? row.user_id
  }))
  if (ignoreNewMappingTime)
    for (const row of mapped) Reflect.deleteProperty(row, 'created_at')
  const gumboByUser = new Map(
    mapped.map(row => [identityKey(row.user_id), row.gumbo_id])
  )
  const tables: JsonObject = {}
  const schema: JsonObject = {}
  const gumboTypes = {
    gumbo_id: 'bigint',
    user_id: 'text',
    created_at: 'timestamp with time zone'
  }
  schema.gumbo_ids =
    copy.tables.gumbo_ids == null
      ? {
          columns: ['created_at', 'gumbo_id', 'user_id'],
          keys: ['gumbo_id'],
          ...(copy.tables.users.types == null ? {} : { types: gumboTypes })
        }
      : {
          columns: [...copy.tables.gumbo_ids.columns].sort(),
          keys: copy.tables.gumbo_ids.keys,
          ...(copy.tables.gumbo_ids.types == null
            ? {}
            : {
                types: { ...copy.tables.gumbo_ids.types, user_id: 'text' }
              })
        }
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
      ),
      ...(table.types == null
        ? {}
        : {
            types: Object.fromEntries(
              Object.entries(table.types).map(([column, type]) => [
                column === scoring?.[0] ? scoring[1] : column,
                column === scoring?.[0]
                  ? type
                  : userColumns.includes(column) ||
                      (name === 'users' && column === 'id')
                    ? 'text'
                    : type
              ])
            )
          })
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
      /^\/players\/([^/]+)\/(?=stats$|plays$)/,
      (_match, id: string) =>
        `/players/${identityKey(userMap.get(decodeURIComponent(id)) ?? id)}/`
    )
    const normalized = apiIds(
      path,
      body,
      userMap,
      gumboByUser,
      copy.tables.gumbo_ids == null,
      manifest
    )
    if (Object.hasOwn(api, normalizedPath))
      throw new Error('Duplicate normalized endpoint')
    api[normalizedPath] = normalized
  }
  return {
    tables,
    api,
    schema,
    foreignKeys,
    preserved: copy.preserved,
    ...(copy.preservedCounts == null
      ? {}
      : { preservedCounts: copy.preservedCounts }),
    ...(copy.absentTables == null
      ? {}
      : {
          absentTables: copy.absentTables.filter(name => name !== 'gumbo_ids')
        }),
    ...(copy.apiInventory == null
      ? {}
      : {
          apiInventory: Object.fromEntries(
            Object.entries(copy.apiInventory).map(([path, entry]) => [
              path.replace(
                /^\/players\/([^/]+)\/(?=stats$|plays$)/,
                (_match, id: string) =>
                  `/players/${identityKey(userMap.get(decodeURIComponent(id)) ?? id)}/`
              ),
              {
                ...entry,
                itemIds:
                  /^\/teams\/[^/]+\/(roster|stats)(\?kind=pitching)?$/.test(
                    path
                  )
                    ? entry.itemIds.map(id =>
                        identityKey(userMap.get(id) ?? id)
                      )
                    : entry.itemIds
              }
            ])
          )
        }),
    migrations: copy.migrations.filter(
      name => !['068gumboIds', '069userIds', '070playerGumboIds'].includes(name)
    )
  }
}

export function compareUserIds(
  before: UserIdSnapshot,
  after: UserIdSnapshot,
  options: {
    allowPlaceholders?: boolean
    allowMerged?: boolean
    allowRebuiltStats?: boolean
  } = {}
): Comparison {
  const transformations: string[] = []
  const legacyTransition =
    options.allowPlaceholders === true &&
    before.userIdType === 'bigint' &&
    after.userIdType === 'bigint' &&
    !before.migrations.includes('067gameUnroster') &&
    after.migrations.includes('067gameUnroster')
  validateNewGumboMappings(before, after)
  const ignoreNewMappingTime =
    before.tables.gumbo_ids == null && after.tables.gumbo_ids != null
  before = structuredClone(before)
  after = structuredClone(after)
  if (options.allowRebuiltStats === true) {
    if (options.allowPlaceholders === true || options.allowMerged === true)
      throw new Error(
        'Stats rebuild cannot combine with identity transformations'
      )
    expectedRebuiltStats(before, after, transformations)
  }
  if (options.allowPlaceholders === true) {
    before = expectedPlaceholders(before, after, transformations)
    placeholderDocumentHashes(before)
    placeholderDocumentHashes(after)
  }
  if (options.allowMerged === true) {
    if (before.userIdType !== 'bigint' || after.userIdType !== 'bigint')
      throw new Error('Merge transformation is restricted to A to B')
    expectedMergedApi(before, transformations)
  }
  if (before.userIdType === 'bigint' && after.userIdType === 'text')
    expectedStableApiOrder(before, transformations)
  if (legacyTransition) {
    normalizeLegacyApiTies(before, transformations)
    normalizeLegacyApiTies(after, transformations)
  }
  normalizeTransport(before, transformations)
  normalizeTransport(after, transformations)
  orderSnapshotTables(before)
  orderSnapshotTables(after)
  delete before.captureStartedAt
  delete before.captureFinishedAt
  delete after.captureStartedAt
  delete after.captureFinishedAt
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
    compare(
      normalizeIdentity(before, ignoreNewMappingTime, transformations),
      normalizeIdentity(after, ignoreNewMappingTime, transformations),
      '$'
    )
  }
  return {
    equal: differenceCount === 0,
    differences,
    differenceCount,
    counts,
    transformations: [...new Set(transformations)]
  }
}
