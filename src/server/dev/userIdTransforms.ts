import { shortNames } from '../../common/names'
import { userIdOfGumbo } from '../../common/userId'
import {
  canonical,
  identityKey,
  type Json,
  type JsonObject,
  type UserIdSnapshot
} from './userIdSnapshot'

function object(value: Json | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
function record(value: Json | undefined): JsonObject {
  if (!object(value)) throw new Error('Expected a recorded identity object')
  return value
}
function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value))
    throw new Error('Expected a recorded identity list')
  return value
}

interface Guest {
  game: string
  sid: string
  side: 'away' | 'home'
  profiles: JsonObject[]
  id: number
}

/** Derive all placeholder sources, including a guest introduced only by an action. */
function placeholders(snapshot: UserIdSnapshot): Map<string, Guest> {
  const candidates = new Map<
    string,
    {
      game: string
      sid: string
      profiles: JsonObject[]
      sides: Set<Guest['side']>
    }
  >()
  const games = new Map(
    snapshot.tables.games.rows.map(game => [identityKey(game.id), game])
  )
  const inspect = (game: string, setup: JsonObject): void => {
    const teams = games.get(game)
    if (teams == null) throw new Error('Missing historical placeholder game')
    const identities = record(setup.identities)
    for (const [sid, source] of Object.entries(
      record(identities.sessionToSource)
    )) {
      if (source !== null) continue
      const player = record(record(setup.players)[sid])
      const sides = record(setup.sides)
      const on = (['away', 'home'] as const).filter(
        side =>
          array(record(sides[side]).players).includes(Number(sid)) ||
          (teams[`${side}_team_id`] != null &&
            player.teamId === teams[`${side}_team_id`])
      )
      if (!/^\d+$/.test(sid))
        throw new Error('Ambiguous historical placeholder')
      const key = `${game}:${sid}`
      const prior = candidates.get(key)
      const held = prior ?? {
        game,
        sid,
        profiles: [],
        sides: new Set<Guest['side']>()
      }
      held.profiles.push(player)
      for (const side of on) held.sides.add(side)
      candidates.set(key, held)
    }
  }
  const documents = [
    ...(snapshot.tables.events?.rows ?? []).map(row => ({
      game: identityKey(row.gameId),
      doc: row.gumbo
    })),
    ...(snapshot.tables.games?.rows ?? []).map(row => ({
      game: identityKey(row.id),
      doc: row.currentPlay
    }))
  ]
  for (const { game, doc } of documents) {
    if (
      !object(doc) ||
      !object(doc.teamStation) ||
      doc.teamStation.version !== 1
    )
      continue
    const saved = doc.teamStation
    let setup = structuredClone(record(saved.setupBefore))
    inspect(game, setup)
    for (const value of array(saved.actions)) {
      const action = record(value)
      if (action.setup != null) setup = structuredClone(record(action.setup))
      else if (action.type === 'lineup' && action.kind === 'addPlayer') {
        const identities = record(setup.identities)
        const source = record(identities.sessionToSource)
        let sid = Number(identities.nextId)
        if (!Number.isSafeInteger(sid) || sid < 1)
          throw new Error('Invalid next placeholder')
        while (Object.hasOwn(source, String(sid))) sid++
        const side = action.side
        if (side !== 'away' && side !== 'home')
          throw new Error('Missing placeholder side')
        record(setup.players)[sid] = {
          id: sid,
          userId: null,
          fullName: action.name ?? 'New Player'
        }
        source[sid] = null
        identities.nextId = sid + 1
        array(record(record(setup.sides)[side]).players).push(sid)
      } else continue
      inspect(game, setup)
    }
  }
  // A removed guest can have no active side in one snapshot. Require exactly
  // one owner across the baseline's retained profile and every saved setup.
  const found = new Map<string, Guest>()
  for (const [key, held] of candidates) {
    if (held.sides.size !== 1)
      throw new Error('Ambiguous historical placeholder')
    found.set(key, {
      game: held.game,
      sid: held.sid,
      profiles: held.profiles,
      side: [...held.sides][0],
      id: 0
    })
  }
  return found
}

/** These are the only stored fields migration 066 is allowed to rewrite. */
function rewriteDocument(value: Json, guests: Guest[]): Json {
  if (
    !object(value) ||
    !object(value.teamStation) ||
    value.teamStation.version !== 1
  )
    return value
  const copy = structuredClone(value)
  const saved = record(copy.teamStation)
  const setup = (raw: Json): Json => {
    const out = record(raw)
    const identities = record(out.identities)
    for (const guest of guests) {
      const sources = record(identities.sessionToSource)
      if (sources[guest.sid] == null) {
        sources[guest.sid] = guest.id
        record(identities.sourceToSession)[`number:${guest.id}`] = Number(
          guest.sid
        )
        const player = record(out.players)[guest.sid]
        // jsonb_set does not create an absent intermediate player object.
        if (object(player)) player.userId = guest.id
      } else if (sources[guest.sid] !== guest.id)
        throw new Error('Conflicting placeholder source')
    }
    return out
  }
  saved.setupBefore = setup(saved.setupBefore)
  for (const raw of array(saved.actions)) {
    const action = record(raw)
    if (Object.hasOwn(action, 'setup')) action.setup = setup(action.setup)
  }
  return copy
}

/** Construct B's additions from A. Candidate data supplies only validated random identities. */
export function expectedPlaceholders(
  before: UserIdSnapshot,
  after: UserIdSnapshot,
  manifest: string[]
): UserIdSnapshot {
  if (
    before.userIdType !== 'bigint' ||
    after.userIdType !== 'bigint' ||
    before.tables.game_placeholder_guests != null
  )
    throw new Error(
      'Placeholder transformation requires the A to B schema transition'
    )
  const expected = structuredClone(before)
  const guests = placeholders(before)
  const mappings = after.tables.game_placeholder_guests?.rows
  if (mappings?.length !== guests.size)
    throw new Error('Missing or extra placeholder mapping')
  const used = new Set(before.tables.users.rows.map(row => identityKey(row.id)))
  const seen = new Set<string>()
  const newUsers: JsonObject[] = []
  for (const mapping of mappings) {
    const key = `${identityKey(mapping.game_id)}:${identityKey(mapping.session_id)}`
    const guest = guests.get(key)
    const id = Number(mapping.user_id)
    if (
      guest == null ||
      seen.has(key) ||
      mapping.side !== guest.side ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      used.has(String(id))
    )
      throw new Error('Invalid or duplicate placeholder mapping')
    seen.add(key)
    used.add(String(id))
    guest.id = id
    const user = after.tables.users.rows.find(row => row.id === id)
    if (
      user == null ||
      typeof user.legacyId !== 'string' ||
      !/^usr_[A-Za-z0-9_-]{16}$/.test(user.legacyId)
    )
      throw new Error('Missing guest legacy identity')
    const legacy =
      BigInt(
        '0x' + Buffer.from(user.legacyId.slice(4), 'base64url').toString('hex')
      ) >> 43n
    if (legacy !== BigInt(id))
      throw new Error('Guest identity does not derive from its legacy id')
    // A guest may be edited in place. Migration 066 picks one retained
    // profile for the new account; its tied snapshots have no defined order.
    // Accept only a complete profile derived from a baseline snapshot, never
    // arbitrary candidate names or a mixture of fields from different edits.
    const profiles = guest.profiles.map(player => {
      const name = player.fullName
      if (typeof name !== 'string')
        throw new Error('Missing historical guest name')
      const fallbackLastName = name.replace(/^[^ ]+ */, '')
      return {
        display_name: name,
        first_name: player.firstName ?? name.split(' ')[0],
        last_name:
          player.lastName ?? (fallbackLastName === '' ? null : fallbackLastName)
      }
    })
    const profile = profiles.find(
      profile =>
        profile.display_name === user.display_name &&
        profile.first_name === user.first_name &&
        profile.last_name === user.last_name
    )
    if (profile == null)
      throw new Error(
        'Guest account profile is absent from historical snapshots'
      )
    newUsers.push({
      id,
      legacyId: user.legacyId,
      merged_into: null,
      ...profile,
      login_enabled: false,
      is_admin: false,
      avatar_path: null
    })
    manifest.push(
      `placeholder ${guest.game}:${guest.side}:${guest.sid} -> ${id}`
    )
    expected.api[`/players/${id}/stats`] = {
      userId: id,
      filter: { seasonId: null, teamId: null, year: null },
      games: 0,
      batting: null,
      pitching: null,
      options: { seasons: [], teams: [], years: [] },
      splits: { by: 'team', batting: [], pitching: [] }
    }
    expected.api[`/players/${id}/plays`] = []
    if (expected.apiInventory != null) {
      expected.apiInventory[`/players/${id}/stats`] = {
        status: 200,
        pages: 1,
        total: null,
        itemIds: []
      }
      expected.apiInventory[`/players/${id}/plays`] = {
        status: 200,
        pages: 1,
        total: 0,
        itemIds: []
      }
    }
  }
  expected.tables.users.rows.push(...newUsers)
  expected.tables.game_placeholder_guests = {
    columns: ['game_id', 'session_id', 'side', 'user_id'],
    keys: ['game_id', 'session_id'],
    rows: [...guests.values()].map(g => ({
      game_id: g.game,
      session_id: Number(g.sid),
      user_id: g.id,
      side: g.side
    }))
  }
  expected.tables.game_guest_details = {
    columns: ['game_id', 'jersey', 'positions', 'user_id'],
    keys: ['game_id', 'user_id'],
    rows: []
  }
  if (expected.absentTables != null)
    expected.absentTables = expected.absentTables.filter(
      name => !['game_placeholder_guests', 'game_guest_details'].includes(name)
    )
  if (expected.tables.users.types != null) {
    expected.tables.game_placeholder_guests.types = {
      game_id: 'text',
      session_id: 'bigint',
      side: 'text',
      user_id: 'bigint'
    }
    expected.tables.game_guest_details.types = {
      game_id: 'text',
      jersey: 'text',
      positions: 'ARRAY',
      user_id: 'bigint'
    }
    expected.tables.games.types = {
      ...expected.tables.games.types,
      guests: 'jsonb',
      unrostered: 'jsonb'
    }
  }
  expected.userColumns.game_placeholder_guests = ['user_id']
  expected.userColumns.game_guest_details = ['user_id']
  expected.migrations.push('066gameGuests', '067gameUnroster')
  expected.migrations.sort()
  expected.tables.games.columns.push('guests', 'unrostered')
  expected.tables.games.columns.sort()
  for (const game of expected.tables.games.rows) {
    const held = [...guests.values()]
      .filter(g => g.game === identityKey(game.id))
      .sort((a, b) => a.sid.localeCompare(b.sid))
    const lists = {
      away: held.filter(g => g.side === 'away').map(g => g.id),
      home: held.filter(g => g.side === 'home').map(g => g.id)
    }
    game.guests = lists
    game.unrostered = { away: [], home: [] }
    game.currentPlay = rewriteDocument(game.currentPlay, held)
    const endpoint = expected.api[`/games/${identityKey(game.id)}`]
    if (endpoint != null) {
      const api = record(endpoint)
      api.guests = structuredClone(lists)
      api.unrostered = { away: [], home: [] }
      api.guestPlayers = { away: [], home: [] }
      const labels = shortNames(
        held.map(guest => {
          const user = newUsers.find(row => row.id === guest.id)!
          return {
            id: guest.id,
            displayName: user.display_name as string,
            firstName: user.first_name as string | null,
            lastName: user.last_name as string | null
          }
        })
      )
      for (const guest of held) {
        // Profiles are taken from the newest recorded setup. Actions retain
        // their exact content and ordering in the SQL comparison below.
        const docs = [
          game.currentPlay,
          ...(expected.tables.events?.rows ?? [])
            .filter(row => row.gameId === game.id)
            .sort((a, b) => Number(b.atBatIndex) - Number(a.atBatIndex))
            .map(row => row.gumbo)
        ]
        let profile: JsonObject | undefined
        for (const doc of docs) {
          if (
            !object(doc) ||
            !object(doc.teamStation) ||
            !object(doc.teamStation.setupBefore)
          )
            continue
          const players = record(doc.teamStation.setupBefore.players)
          const found = players[guest.sid]
          if (object(found)) {
            profile = found
            break
          }
        }
        array(record(api.guestPlayers)[guest.side]).push({
          userId: guest.id,
          shortName: labels.get(guest.id)!,
          jersey: profile?.jersey ?? null,
          positions: profile?.positions ?? [],
          bats: null,
          throws: null,
          isPlayer: true,
          role: 'player',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null,
          avatarUrl: null,
          walkUpSong: null
        })
      }
    }
  }
  for (const event of expected.tables.events?.rows ?? [])
    event.gumbo = rewriteDocument(
      event.gumbo,
      [...guests.values()].filter(g => g.game === identityKey(event.gameId))
    )
  return expected
}

/** SQL tables are unordered; their keys identify rows. Documents keep array ordering. */
export function orderSnapshotTables(snapshot: UserIdSnapshot): void {
  for (const table of Object.values(snapshot.tables))
    table.rows.sort((a, b) =>
      canonical(table.keys.map(k => a[k])).localeCompare(
        canonical(table.keys.map(k => b[k]))
      )
    )
}

/** The full hash is redundant only during the explicitly allowed document rewrite. */
export function placeholderDocumentHashes(snapshot: UserIdSnapshot): void {
  for (const row of snapshot.tables.events?.rows ?? [])
    if (object(row.gumbo)) {
      delete row.gumbo.documentHash
      delete row.gumbo.storedTextHash
    }
  for (const row of snapshot.tables.games?.rows ?? [])
    if (object(row.currentPlay)) {
      delete row.currentPlay.documentHash
      delete row.currentPlay.storedTextHash
    }
}

/** Independent aggregate arithmetic; the changed production stat/merge code is not the oracle. */
export function expectedMergedApi(
  snapshot: UserIdSnapshot,
  manifest: string[]
): void {
  const users = new Map(
    snapshot.tables.users.rows.map(row => [identityKey(row.id), row])
  )
  const resolve = (id: Json): Json => {
    const seen = new Set<string>()
    let user = users.get(identityKey(id))
    if (user == null) throw new Error('Missing merge account')
    while (user.merged_into != null) {
      const key = identityKey(user.id)
      if (seen.has(key)) throw new Error('Cyclic merge graph')
      seen.add(key)
      user = users.get(identityKey(user.merged_into))
      if (user == null) throw new Error('Missing merge survivor')
    }
    return user.id
  }
  for (const user of users.values()) {
    const final = resolve(user.id)
    if (final !== user.id)
      manifest.push(`merge ${identityKey(user.id)} -> ${identityKey(final)}`)
  }
  const sums: Record<string, string[]> = {
    batting: [
      'g',
      'pa',
      'ab',
      'h',
      'singles',
      'doubles',
      'triples',
      'hr',
      'bb',
      'k',
      'r',
      'rbi',
      'hbp',
      'sb',
      'cs',
      'sf',
      'sh',
      'roe',
      'fc',
      'pik'
    ],
    pitching: [
      'g',
      'outs',
      'bf',
      'h',
      'hr',
      'hbp',
      'r',
      'er',
      'bb',
      'k',
      'gs',
      'pitches',
      'kl',
      'pitchAb',
      'wp',
      'lob',
      'bk',
      'pik',
      'cs',
      'sb'
    ]
  }
  const round = (v: number, n = 3): number => Math.round(v * 10 ** n) / 10 ** n
  const regroup = (values: Json[], kind: string): Json[] => {
    // Baselines may already resolve merges. Preserve their exact labels and
    // endpoint-specific ordering when no identity actually needs regrouping.
    if (values.every(raw => resolve(record(raw).userId) === record(raw).userId))
      return values
    const grouped = new Map<string, JsonObject[]>()
    for (const raw of values) {
      const row = record(raw)
      const key = identityKey(resolve(row.userId))
      const held = grouped.get(key) ?? []
      held.push(row)
      grouped.set(key, held)
    }
    const out: JsonObject[] = []
    for (const [id, rows] of grouped) {
      const first = rows[0]
      const final = resolve(first.userId)
      if (rows.length === 1 && first.userId === final) {
        out.push(first)
        continue
      }
      const merged: JsonObject = { ...first, userId: final }
      for (const field of sums[kind]) {
        if (!rows.every(r => Object.hasOwn(r, field)))
          throw new Error('Incomplete aggregate input')
        merged[field] = rows.some(r => r[field] === null)
          ? null
          : rows.reduce((n, r) => n + Number(r[field]), 0)
      }
      merged.teamId = rows.every(r => r.teamId === first.teamId)
        ? first.teamId
        : null
      const known = new Set([
        ...sums[kind],
        'userId',
        'teamId',
        'shortName',
        'rates',
        ...(kind === 'batting' ? ['firstPa'] : ['ip', 'eraInnings'])
      ])
      if (rows.some(r => Object.keys(r).some(k => !known.has(k))))
        throw new Error('Unknown aggregate field')
      const n = (key: string): number => Number(merged[key])
      const rates: JsonObject = {}
      if (kind === 'batting') {
        const positions = rows
          .map(r => r.firstPa)
          .filter(v => v != null)
          .map(Number)
        merged.firstPa = positions.length === 0 ? null : Math.min(...positions)
        if (n('sb') + n('cs') > 0)
          rates.sbPct = round(n('sb') / (n('sb') + n('cs')))
        if (n('ab') > 0) {
          rates.avg = round(n('h') / n('ab'))
          rates.slg = round(
            (n('singles') + 2 * n('doubles') + 3 * n('triples') + 4 * n('hr')) /
              n('ab')
          )
        }
        const chances = n('ab') + n('bb') + n('hbp') + n('sf')
        if (chances > 0)
          rates.obp = round((n('h') + n('bb') + n('hbp')) / chances)
        if (rates.obp != null && rates.slg != null)
          rates.ops = round(Number(rates.obp) + Number(rates.slg))
      } else {
        merged.eraInnings =
          n('outs') === 0
            ? 6
            : rows.reduce(
                (n, r) => n + Number(r.outs) * Number(r.eraInnings),
                0
              ) / n('outs')
        merged.ip = `${Math.floor(n('outs') / 3)}.${n('outs') % 3}`
        if (merged.pitchAb != null && n('pitchAb') > 0)
          rates.baa = round(n('h') / n('pitchAb'))
        if (merged.sb != null && merged.cs != null && n('sb') + n('cs') > 0)
          rates.sbPct = round(n('sb') / (n('sb') + n('cs')))
        if (n('outs') > 0) {
          rates.era = round((n('eraInnings') * n('er')) / (n('outs') / 3), 2)
          rates.whip = round((n('h') + n('bb')) / (n('outs') / 3), 2)
        }
      }
      merged.rates = rates
      out.push(merged)
      manifest.push(`aggregate ${kind} ${id}: ${rows.length} rows`)
    }
    if (out.some(row => Object.hasOwn(row, 'shortName'))) {
      const names = shortNames(
        out.map(row => {
          const u = users.get(identityKey(row.userId))!
          return {
            id: identityKey(u.id),
            firstName: u.first_name as string | null,
            lastName: u.last_name as string | null,
            displayName: u.display_name as string
          }
        })
      )
      for (const row of out)
        if (Object.hasOwn(row, 'shortName'))
          row.shortName = names.get(identityKey(row.userId))!
    }
    return out.sort(
      (a, b) =>
        Number(b[kind === 'batting' ? 'pa' : 'outs']) -
        Number(a[kind === 'batting' ? 'pa' : 'outs'])
    )
  }
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!object(value)) return
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'batting' || key === 'pitching') && Array.isArray(child))
        value[key] = regroup(child, key)
      else visit(child)
    }
  }
  for (const [path, body] of Object.entries(snapshot.api)) {
    if (/^\/teams\/[^/]+\/stats(?:\?|$)/.test(path) && Array.isArray(body)) {
      snapshot.api[path] = regroup(
        body,
        path.includes('kind=pitching') ? 'pitching' : 'batting'
      )
      continue
    }
    if (
      /^\/(?:teams|seasons)\/[^/]+\/stats(?:\?|$)/.test(path) ||
      /^\/games\/[^/]+\/box-score$/.test(path)
    )
      visit(body)
  }
}

/** Only signing timestamps/signatures on the enumerated media response fields vary. */
export function normalizeTransport(
  snapshot: UserIdSnapshot,
  manifest: string[]
): void {
  const fields = new Set([
    'avatarUrl',
    'logoUrl',
    'homeLogoUrl',
    'awayLogoUrl',
    'posterUrl',
    'stillUrl'
  ])
  const visit = (value: Json, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, i) => {
        visit(child, `${path}[${i}]`)
      })
      return
    }
    if (!object(value)) return
    for (const [key, child] of Object.entries(value)) {
      const at = `${path}.${key}`
      if (fields.has(key) && typeof child === 'string') {
        let url: URL
        try {
          url = new URL(child)
        } catch {
          continue
        }
        let changed = false
        const query = url.searchParams
        if (
          query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
          query.has('X-Amz-Date') &&
          query.has('X-Amz-Signature')
        ) {
          if (
            !/^\d{8}T\d{6}Z$/.test(query.get('X-Amz-Date')!) ||
            !/^[a-f0-9]{64}$/.test(query.get('X-Amz-Signature')!)
          )
            throw new Error(`Malformed signed media transport: ${at}`)
          query.set('X-Amz-Date', '[signing-time]')
          query.set('X-Amz-Signature', '[signature]')
          const credential = query.get('X-Amz-Credential')
          if (credential != null)
            query.set(
              'X-Amz-Credential',
              credential.replace(/\/\d{8}\//, '/[signing-date]/')
            )
          changed = true
        }
        if (
          /^\/api\/v1\/videos\/[^/]+\/stills\/\d+\.jpg$/.test(url.pathname) &&
          query.has('t')
        ) {
          if (!/^\d+\.[A-Za-z0-9_-]{43}$/.test(query.get('t')!))
            throw new Error(`Malformed still transport: ${at}`)
          query.set('t', '[expiry.signature]')
          changed = true
        }
        if (changed) {
          value[key] = url.toString()
          manifest.push(`transport ${at}`)
        }
      } else visit(child, at)
    }
  }
  for (const [path, body] of Object.entries(snapshot.api))
    if (/^\/(seasons|teams|games|players)(?:\/|$)/.test(path))
      visit(body, `api:${path}`)
}

/** Every pre-existing account gets exactly its original integer, within the recorded cutover interval. */
export function validateNewGumboMappings(
  before: UserIdSnapshot,
  after: UserIdSnapshot
): void {
  if (before.tables.gumbo_ids != null || after.tables.gumbo_ids == null) return
  const start = Date.parse(before.captureFinishedAt ?? '')
  const end = Date.parse(after.captureStartedAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error('Missing or invalid migration time window')
  const rows = after.tables.gumbo_ids.rows
  if (rows.length !== before.tables.users.rows.length)
    throw new Error('Missing or extra initial gumbo mappings')
  const expected = new Map(
    before.tables.users.rows.map(row => [identityKey(row.id), row.id])
  )
  const seen = new Set<string>()
  for (const row of rows) {
    const id = identityKey(row.gumbo_id)
    if (!expected.has(id) || seen.has(id))
      throw new Error('Unexpected initial gumbo identity')
    seen.add(id)
    const user =
      after.userIdType === 'text'
        ? userIdOfGumbo(Number(expected.get(id)))
        : expected.get(id)
    if (row.user_id !== user) throw new Error('Incorrect initial gumbo account')
    const created =
      typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN
    if (!Number.isFinite(created) || created < start || created > end)
      throw new Error('Gumbo mapping timestamp outside migration window')
    if (
      canonical(Object.keys(row).sort()) !==
      canonical(['created_at', 'gumbo_id', 'user_id'])
    )
      throw new Error('Unexpected initial gumbo fields')
  }
}

/** A rebuild replaces storage rows, never scoring identities or business values. */
export function expectedRebuiltStats(
  before: UserIdSnapshot,
  after: UserIdSnapshot,
  manifest: string[]
): void {
  if (
    before.userIdType !== 'text' ||
    after.userIdType !== 'text' ||
    canonical(before.migrations) !== canonical(after.migrations)
  )
    throw new Error('Stats rebuild comparison requires the same final schema')
  const start = Date.parse(before.captureFinishedAt ?? '')
  const end = Date.parse(after.captureStartedAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error('Missing or invalid rebuild time window')
  const indexed = (snapshot: UserIdSnapshot): Map<string, JsonObject> => {
    const rows = snapshot.tables.game_player_stats?.rows
    if (rows == null) throw new Error('Missing rebuilt statistics table')
    const map = new Map<string, JsonObject>()
    const ids = new Set<string>()
    for (const row of rows) {
      if (
        typeof row.id !== 'string' ||
        !/^gps_[A-Za-z0-9_-]{16}$/.test(row.id) ||
        ids.has(row.id)
      )
        throw new Error('Invalid or duplicate statistics storage identity')
      ids.add(row.id)
      if (
        typeof row.game_id !== 'string' ||
        typeof row.gumbo_id !== 'number' ||
        !Number.isSafeInteger(row.gumbo_id) ||
        row.gumbo_id < 1 ||
        (row.team_id !== null && typeof row.team_id !== 'string')
      )
        throw new Error('Invalid statistics business identity')
      const key = canonical([row.game_id, row.gumbo_id, row.team_id])
      if (map.has(key))
        throw new Error('Duplicate statistics business identity')
      map.set(key, row)
    }
    return map
  }
  const old = indexed(before)
  const rebuilt = indexed(after)
  if (old.size !== rebuilt.size)
    throw new Error('Rebuild changed statistics row count')
  for (const [key, row] of old) {
    const next = rebuilt.get(key)
    if (next == null)
      throw new Error('Rebuild changed statistics business identity')
    if (row.id === next.id && row.computed_at === next.computed_at) continue
    const computed =
      typeof next.computed_at === 'string' ? Date.parse(next.computed_at) : NaN
    if (!Number.isFinite(computed) || computed < start || computed > end)
      throw new Error('Statistics computation timestamp outside rebuild window')
    row.id = next.id
    row.computed_at = next.computed_at
    manifest.push(`stats-rebuild ${key}: id,computed_at`)
  }
  for (const [path, body] of Object.entries(before.api)) {
    const next = after.api[path]
    if (
      !/^\/games\/[^/]+\/box-score$/.test(path) ||
      !object(body) ||
      !object(next)
    )
      continue
    const priorStatus = body.stats
    const nextStatus = next.stats
    if (
      !object(priorStatus) ||
      !object(nextStatus) ||
      !Object.hasOwn(priorStatus, 'builtAt') ||
      !Object.hasOwn(nextStatus, 'builtAt') ||
      priorStatus.builtAt === nextStatus.builtAt
    )
      continue
    const builtAt =
      typeof nextStatus.builtAt === 'string'
        ? Date.parse(nextStatus.builtAt)
        : NaN
    if (!Number.isFinite(builtAt) || builtAt < start || builtAt > end)
      throw new Error('API stats build timestamp outside rebuild window')
    priorStatus.builtAt = nextStatus.builtAt
    manifest.push(`stats-rebuild api:${path}.stats.builtAt`)
  }
}
