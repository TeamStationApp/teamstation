import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { compareUserIds, normalizeIdentity } from './userIdCompare'
import {
  canonical,
  identityKey,
  type Json,
  type JsonObject,
  snapshotApi,
  type TableSnapshot,
  type UserIdSnapshot,
  verifyCollections
} from './userIdSnapshot'

function table(rows: JsonObject[], keys = ['id']): TableSnapshot {
  return {
    columns: [...new Set(rows.flatMap(row => Object.keys(row)))].sort(),
    keys,
    rows
  }
}

function sample(): UserIdSnapshot {
  return {
    version: 1,
    captureStartedAt: '2026-01-01T00:00:00.000Z',
    captureFinishedAt: '2026-01-01T00:00:00.000Z',
    migrations: ['065radarReadings'],
    userIdType: 'bigint',
    userColumns: {
      users: ['merged_into'],
      memberships: ['user_id'],
      game_player_stats: ['user_id']
    },
    tables: {
      users: table([{ id: 1, legacyId: 'usr_legacy', merged_into: null }]),
      memberships: table([{ id: 'mem_one', user_id: 1 }]),
      game_player_stats: table([{ id: 'gps_one', user_id: 1, h: 2 }]),
      teams: table([
        {
          id: 'tem_one',
          default_lineup: {
            batters: [{ userId: 1 }],
            defense: { P: { userId: 1 } }
          }
        }
      ]),
      notification_events: table([{ id: 'ntf_one', recorded_recipients: [1] }]),
      external_ids: table([
        { id: 'ext_one', entity_type: 'user', entity_id: 'usr_legacy' },
        { id: 'ext_two', entity_type: 'user', entity_id: 'unknown' }
      ]),
      group_request_sides: table([
        { id: 'side_one', scope_type: 'user', scope_id: '1' },
        {
          id: 'side_two',
          scope_type: 'user',
          scope_id: 'email:fixture@example.test'
        }
      ]),
      group_requests: table([
        {
          id: 'req_one',
          terms: {
            userId: 1,
            recipientUserId: 1,
            playerUserId: 1,
            hostingAuthorizerUserId: 1,
            guardian: { userId: 1 },
            amount: 1
          }
        }
      ])
    },
    preserved: { audit_log: 'unchanged' },
    api: {
      '/players/1/stats': { userId: 1, hits: 2, batting: { userId: 1, h: 2 } }
    }
  }
}

function migrated(): UserIdSnapshot {
  const snapshot = sample()
  const id = userIdOfGumbo(1)
  snapshot.userIdType = 'text'
  snapshot.captureStartedAt = '2026-01-02T00:00:00.000Z'
  snapshot.captureFinishedAt = snapshot.captureStartedAt
  snapshot.migrations.push('068gumboIds', '069userIds', '070playerGumboIds')
  snapshot.userColumns = {
    users: ['merged_into'],
    memberships: ['user_id'],
    gumbo_ids: ['user_id']
  }
  snapshot.tables.users.rows[0].id = id
  snapshot.tables.memberships.rows[0].user_id = id
  snapshot.tables.game_player_stats = table([
    { id: 'gps_one', gumbo_id: 1, h: 2 }
  ])
  snapshot.tables.teams.rows[0].default_lineup = {
    batters: [{ gumboId: 1 }],
    defense: { P: { gumboId: 1 } }
  }
  snapshot.tables.notification_events.rows[0].recorded_recipients = [id]
  snapshot.tables.external_ids.rows[0].entity_id = id
  snapshot.tables.group_request_sides.rows[0].scope_id = id
  snapshot.tables.group_requests.rows[0].terms = {
    userId: id,
    recipientUserId: id,
    playerUserId: id,
    hostingAuthorizerUserId: id,
    guardian: { userId: id },
    amount: 1
  }
  snapshot.tables.gumbo_ids = table(
    [{ gumbo_id: 1, user_id: id, created_at: '2026-01-01T12:00:00.000Z' }],
    ['gumbo_id']
  )
  snapshot.api = {
    [`/players/${id}/stats`]: {
      userId: id,
      hits: 2,
      batting: { userId: id, h: 2 }
    }
  }
  return snapshot
}

describe('user identity comparison', function () {
  it('checks collection completeness and merge-chain play identities against SQL', function () {
    const s = sample()
    s.tables.seasons = table([{ id: 'sea_one' }])
    s.tables.users.rows.push({ id: 2, merged_into: 1 })
    s.tables.events = table([
      { id: 'evt_one', hidden: false },
      { id: 'evt_hidden', hidden: true }
    ])
    s.tables.event_players = table([
      { id: 'ep_one', event_id: 'evt_one', user_id: 2, role: 'batter' },
      { id: 'ep_hidden', event_id: 'evt_hidden', user_id: 1, role: 'batter' }
    ])
    s.api['/seasons'] = [{ id: 'sea_one' }]
    s.api['/players/1/plays'] = [{ eventId: 'evt_one', role: 'batter' }]
    s.api['/players/2/plays'] = [{ eventId: 'evt_one', role: 'batter' }]
    verifyCollections(s)
    for (const change of [
      (v: UserIdSnapshot) => {
        v.api['/seasons'] = []
      },
      (v: UserIdSnapshot) => {
        v.api['/seasons'] = [{ id: 'sea_one' }, { id: 'sea_one' }]
      },
      (v: UserIdSnapshot) => {
        v.api['/seasons'] = null
      },
      (v: UserIdSnapshot) => {
        v.api['/seasons'] = [1]
      },
      (v: UserIdSnapshot) => {
        v.tables.users.rows[0].merged_into = 2
      },
      (v: UserIdSnapshot) => {
        v.tables.users.rows[0].merged_into = 99
      },
      (v: UserIdSnapshot) => {
        v.tables.events.rows = []
      },
      (v: UserIdSnapshot) => {
        v.tables.event_players.rows[0].gumbo_id = 99
      }
    ]) {
      const broken = structuredClone(s)
      change(broken)
      expect(() => {
        verifyCollections(broken)
      }).throws()
    }
    s.tables.gumbo_ids = table([{ gumbo_id: 42, user_id: 2 }], ['gumbo_id'])
    s.tables.event_players.rows[0].gumbo_id = 42
    verifyCollections(s)
  })

  it('compares canonical snapshots without depending on object key order', function () {
    expect(canonical({ b: 2, a: [null, true, 'x'] })).equals(
      '{"a":[null,true,"x"],"b":2}'
    )
    expect(identityKey(1)).equals('1')
    expect(identityKey(null)).equals('null')
    expect(() => identityKey({})).throws('scalar identity')
    expect(compareUserIds(sample(), sample()).equal).equals(true)
    expect(compareUserIds(sample(), migrated()).equal).equals(true)
  })

  it('preserves request inventories while mapping player paths and roster/stat identities', function () {
    const before = sample()
    const after = migrated()
    before.apiInventory = {
      '/players/1/stats': { status: 200, pages: 1, total: null, itemIds: [] },
      '/teams/tem_one/roster': {
        status: 200,
        pages: 1,
        total: 1,
        itemIds: ['1']
      }
    }
    after.apiInventory = {
      [`/players/${userIdOfGumbo(1)}/stats`]: {
        status: 200,
        pages: 1,
        total: null,
        itemIds: []
      },
      '/teams/tem_one/roster': {
        status: 200,
        pages: 1,
        total: 1,
        itemIds: [userIdOfGumbo(1)]
      }
    }
    for (const path of [
      '/teams/tem_one/stats',
      '/teams/tem_one/stats?kind=pitching'
    ]) {
      before.apiInventory[path] = {
        status: 200,
        pages: 1,
        total: 1,
        itemIds: ['1']
      }
      after.apiInventory[path] = {
        status: 200,
        pages: 1,
        total: 1,
        itemIds: [userIdOfGumbo(1)]
      }
    }
    expect(compareUserIds(before, after).equal).equals(true)
    after.apiInventory['/teams/tem_one/roster'].itemIds = []
    expect(compareUserIds(before, after).equal).equals(false)
    const decimal = sample()
    decimal.tables.users.rows[0].id = '1'
    expect((normalizeIdentity(decimal).tables as any).users[0].id).equals(
      userIdOfGumbo(1)
    )
  })

  it('does not hide changed stats, missing fields, metadata or incorrect gumbo mappings', function () {
    for (const change of [
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].h = 3
      },
      (s: UserIdSnapshot) => {
        s.tables.group_requests.rows = []
      },
      (s: UserIdSnapshot) => {
        s.tables.group_requests.columns.push('unrecognized')
      },
      (s: UserIdSnapshot) => {
        s.preserved.audit_log = 'changed'
      },
      (s: UserIdSnapshot) => {
        s.migrations.push('999unexpected')
      },
      (s: UserIdSnapshot) => {
        s.tables.external_ids.rows[1].entity_id = 'changed'
      },
      (s: UserIdSnapshot) => {
        s.userColumns.memberships = []
      },
      (s: UserIdSnapshot) => {
        Reflect.deleteProperty(s.api, `/players/${userIdOfGumbo(1)}/stats`)
      }
    ]) {
      const after = migrated()
      change(after)
      expect(compareUserIds(sample(), after).equal).equals(false)
    }
    const wrong = migrated()
    wrong.api['/teams/tem_one/roster'] = [
      {
        userId: userIdOfGumbo(1),
        gumboId: 2
      }
    ]
    expect(() => compareUserIds(sample(), wrong)).throws(
      'Incorrect API gumbo mapping'
    )
  })

  it('transforms only enumerated API object paths and retains all other identity-shaped fields', () => {
    const id = userIdOfGumbo(1)
    const cases: Array<[string, Json, Json]> = [
      ['/teams/tem_one/roster', [{ userId: 1 }], [{ userId: id, gumboId: 1 }]],
      ['/teams/tem_one/stats', [{ userId: 1 }], [{ userId: id }]],
      ['/teams/tem_one/stats?kind=pitching', [{ userId: 1 }], [{ userId: id }]],
      [
        '/seasons/sea_one/stats',
        { batting: [{ userId: 1 }], pitching: [{ userId: 1 }] },
        { batting: [{ userId: id }], pitching: [{ userId: id }] }
      ],
      [
        '/seasons/sea_one/stats?kind=pitching',
        { batting: [], pitching: [{ userId: 1 }] },
        { batting: [], pitching: [{ userId: id }] }
      ],
      [
        '/games/gam_one/box-score',
        { batting: [{ userId: 1 }], pitching: [] },
        { batting: [{ userId: id }], pitching: [] }
      ],
      [
        '/games/gam_one',
        { guestPlayers: { away: [{ userId: 1 }], home: [] } },
        { guestPlayers: { away: [{ userId: id, gumboId: 1 }], home: [] } }
      ]
    ]
    for (const [path, oldBody, newBody] of cases) {
      const before = sample()
      const after = migrated()
      before.api[path] = oldBody
      after.api[path] = newBody
      const raw = structuredClone(before)
      const result = compareUserIds(before, after)
      expect(result.equal, path).equals(true)
      expect(
        result.transformations.some(line =>
          line.startsWith(`identity api:${path}`)
        )
      ).equals(true)
      expect(before).deep.equals(raw)
      for (const key of [
        'userId',
        'actorId',
        'playerUserId',
        'recipientUserId',
        'guardianUserId',
        'hostingAuthorizerUserId',
        'gumboId'
      ]) {
        const a = structuredClone(before)
        const b = structuredClone(after)
        const target = (body: Json): JsonObject =>
          (Array.isArray(body) ? body[0] : body) as JsonObject
        target(a.api[path]).unexpected = { [key]: 1 }
        target(b.api[path]).unexpected = { [key]: id }
        expect(compareUserIds(a, b).equal, `${path}:${key}`).equals(false)
      }
    }
    for (const path of ['/unknown', '/players/1/plays', '/players/1/unknown']) {
      const before = sample()
      const after = migrated()
      before.api[path] = [{ userId: 1 }]
      after.api[path.replace('/players/1/', `/players/${id}/`)] = [
        { userId: id }
      ]
      expect(compareUserIds(before, after).equal).equals(false)
    }
    const before = sample()
    const after = migrated()
    before.api['/teams/tem_one/roster'] = [{ userId: 1 }]
    after.api['/teams/tem_one/roster'] = [{ userId: id }]
    expect(compareUserIds(before, after).equal).equals(false)
    after.api['/teams/tem_one/roster'] = [{ userId: id, gumboId: 1 }]
    expect(compareUserIds(before, after).equal).equals(true)
    const malformedBodies: Json[] = [
      null,
      {},
      [null],
      [{ other: 1 }],
      { items: [{ userId: 1 }] }
    ]
    for (const malformed of malformedBodies) {
      const broken = structuredClone(after)
      broken.api['/teams/tem_one/roster'] = malformed
      expect(compareUserIds(before, broken).equal).equals(false)
    }
    ;(after.api[`/players/${id}/stats`] as JsonObject).gumboId = 1
    expect(compareUserIds(before, after).equal).equals(false)
  })

  it('compares the same schema exactly, including gumbo timestamps and meaningful array order', function () {
    const a = migrated()
    const b = structuredClone(a)
    b.tables.gumbo_ids.rows[0].created_at = 'later'
    expect(compareUserIds(a, b).equal).equals(false)
    a.api.extra = [1, 2]
    b.api.extra = [2, 1]
    expect(compareUserIds(a, b).differences).contains('$.api.extra[0]')
  })

  it('caps printed differences without losing the total and never prints field values', function () {
    const a = sample()
    const b = sample()
    a.api.extra = Array.from({ length: 30 }, () => 'private@example.test')
    b.api.extra = Array.from({ length: 30 }, () => 'Babe Ruth')
    const result = compareUserIds(a, b)
    expect(result.differenceCount).equals(30)
    expect(result.differences).has.length(20)
    expect(JSON.stringify(result))
      .not.contains('Babe Ruth')
      .and.not.contains('private@example.test')
  })

  it('only renames declared identity fields and leaves unknown values intact', function () {
    const a = sample()
    a.tables.teams.rows.push({ id: 'tem_empty', default_lineup: null })
    a.tables.group_requests.rows.push({
      id: 'req_email',
      terms: { guardian: { email: 'fixture@example.test' } }
    })
    a.tables.external_ids.rows.push({
      id: 'ext_team',
      entity_type: 'team',
      entity_id: '1'
    })
    a.api.extra = { thingId: 1, userId: 99, other: null }
    const normalized = normalizeIdentity(a)
    expect((normalized.api as JsonObject).extra).deep.equals(a.api.extra)
    a.api[`/players/${userIdOfGumbo(1)}/stats`] = null
    expect(() => normalizeIdentity(a)).throws('Duplicate normalized endpoint')
  })

  it('fails closed on paginated or failed endpoint responses', async function () {
    const request =
      (body: Json, status = 200): typeof fetch =>
      async () =>
        Response.json(body, { status })
    expect(
      await snapshotApi(
        ['/one'],
        'https://example.test/',
        'synthetic',
        request([{ id: 'one' }])
      )
    ).deep.equals({ '/one': [{ id: 'one' }] })
    for (const run of [
      async () =>
        await snapshotApi(
          ['/one'],
          'https://example.test',
          'synthetic',
          request({}, 500)
        ),
      async () =>
        await snapshotApi(
          ['/one'],
          'https://example.test',
          'synthetic',
          request({ nextCursor: 'two' })
        ),
      async () =>
        await snapshotApi(
          ['/one', '/one'],
          'https://example.test',
          'synthetic',
          request([])
        )
    ]) {
      let failed = false
      try {
        await run()
      } catch {
        failed = true
      }
      expect(failed).equals(true)
    }
  })
})
