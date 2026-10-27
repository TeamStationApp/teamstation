import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { actorForToken } from '../auth/sessions'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { seasonRoutes } from '../routes/seasons'
import { statsRoutes } from '../routes/stats'
import { teamRoutes } from '../routes/teams'
import { runUserIdCheck } from './userIdCheck'
import { compareUserIds, normalizeIdentity } from './userIdCompare'
import {
  canonical,
  captureUserIds,
  identityKey,
  type Json,
  type JsonObject,
  snapshotApi,
  snapshotPaths,
  snapshotSql,
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

describe('user identity snapshot across real database schemas', function () {
  this.timeout(60000)
  const name = `teamstation_userids_${process.pid}_${Date.now()}`
  const admin = new Pool({ connectionString: testDatabaseUrl })
  let pool: Pool
  let db: Kysely<Database>
  let server: ReturnType<express.Express['listen']>
  let origin: string
  let dir: string
  let baseline: UserIdSnapshot

  before(async function () {
    attachInt8Parser()
    await admin.query(`create database ${name}`)
    const url = new URL(testDatabaseUrl)
    url.pathname = '/' + name
    pool = new Pool({ connectionString: url.toString() })
    await migrateUp(
      pool,
      migrations.filter(m => m.name <= '065radarReadings')
    )
    await pool.query(`insert into users (id, "legacyId", display_name, is_admin, login_enabled)
      values (1, 'usr_1111111111111111', 'Babe Ruth', true, true),
      (2, 'usr_2222222222222222', 'Jackie Robinson', false, false),
      (3, 'usr_3333333333333333', 'Willie Mays', false, false)`)
    // The node administrator signs in by an address, as every account does.
    await pool.query(`insert into user_emails (id, user_id, email, is_primary, verified_at)
      values ('uem_one', 1, 'babe@example.test', true, '2026-01-01')`)
    await pool.query(
      `insert into teams (id, name) values ('tem_one', 'Harbor'), ('tem_two', 'Valley')`
    )
    await pool.query(
      `insert into seasons (id, name, year) values ('sea_one', 'Spring', 2026)`
    )
    await pool.query(
      `insert into season_teams (season_id, team_id) values ('sea_one', 'tem_one'), ('sea_one', 'tem_two')`
    )
    await pool.query(`insert into games (id, season_id, home_team_id, away_team_id, start_at)
      values ('gam_one', 'sea_one', 'tem_one', 'tem_two', '2026-01-01')`)
    await pool.query(`insert into game_player_stats (id, game_id, team_id, user_id, pa, ab, h)
      values ('gps_one', 'gam_one', 'tem_one', 1, 2, 2, 1)`)
    await pool.query(`insert into events (id, "gameId", gumbo) values
      ('evt_one', 'gam_one', '{"about":{"atBatIndex":0},"result":{"eventType":"game_advisory"}}')`)
    await pool.query(`insert into audit_log (id, actor_user_id, method, path, before)
      values ('aud_history', 1, 'POST', '/example', '{"userId":1}')`)
    await pool.query(`insert into creation_idempotency (user_id, key, body_hash, response)
      values (1, 'fixture-key', 'fixture-hash', '{"userId":1}')`)
    // Capture each schema with the final adapter. The HTTP server runs the
    // current application schema; older application APIs are proved by the
    // pinned A/B/C deployment comparison.
    const client = await pool.connect()
    try {
      const capture = async (): Promise<UserIdSnapshot> => ({
        ...(await snapshotSql(client)),
        api: {},
        captureStartedAt: new Date().toISOString(),
        captureFinishedAt: new Date().toISOString()
      })
      const original = await capture()
      expect(original.migrations.at(-1)).equals('065radarReadings')
      expect(original.absentTables).deep.equals([
        'game_guest_details',
        'game_placeholder_guests',
        'gumbo_ids'
      ])
      expect(original.tables.users.types!.id).equals('bigint')
      expect(original.preservedCounts!.audit_log).equals(1)
      await migrateUp(
        pool,
        migrations.filter(m => m.name > '065radarReadings' && m.name < '068')
      )
      const rostered = await capture()
      expect(
        compareUserIds(original, rostered, {
          allowPlaceholders: true,
          allowMerged: true
        }).differences
      ).deep.equals([])
      // The chat tables' bridge to text ids (068chatUserIdBridge, proved by
      // its own tests) rewrites their user columns on purpose, so 068gumboIds
      // is compared from after it.
      await migrateUp(
        pool,
        migrations.filter(m => m.name === '068chatUserIdBridge')
      )
      const bridged = await capture()
      await migrateUp(
        pool,
        migrations.filter(m => m.name.startsWith('068'))
      )
      const separated = await capture()
      expect(compareUserIds(bridged, separated).differences).deep.equals([])
      expect(separated.userColumns.gumbo_ids).deep.equals(['user_id'])
      expect(separated.tables.game_guest_details).not.equals(undefined)
      await migrateUp(
        pool,
        migrations.filter(m => m.name >= '069' && m.name < '071')
      )
      const canonical = await capture()
      expect(compareUserIds(separated, canonical).differences).deep.equals([])
      expect(canonical.absentTables).deep.equals([])
      expect(canonical.tables.users.types!.id).equals('text')
      await pool.query(
        `update audit_log set before = '{"userId":2}' where id = 'aud_history'`
      )
      expect(compareUserIds(canonical, await capture()).equal).equals(false)
      await pool.query(
        `update audit_log set before = '{"userId":1}' where id = 'aud_history'`
      )
      await pool.query(
        `update creation_idempotency set response = '{"userId":2}' where key = 'fixture-key'`
      )
      expect(compareUserIds(canonical, await capture()).equal).equals(false)
      await pool.query(
        `update creation_idempotency set response = '{"userId":1}' where key = 'fixture-key'`
      )
      const missing = structuredClone(canonical)
      missing.absentTables!.push('unexpected_table')
      expect(compareUserIds(separated, missing).equal).equals(false)
      const wrongType = structuredClone(canonical)
      wrongType.tables.memberships.types!.user_id = 'bigint'
      expect(() => compareUserIds(separated, wrongType)).throws(
        'Incorrect user column type'
      )
      const changedHistory = structuredClone(canonical)
      changedHistory.preservedCounts!.audit_log++
      expect(compareUserIds(separated, changedHistory).equal).equals(false)
    } finally {
      client.release()
    }
    // Historical identity comparisons end at 070; current HTTP routes use the current schema.
    await migrateUp(pool, migrations)
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    const media: MediaContext = {
      ffmpegPath: 'ffmpeg',
      mediaRoot: '/tmp',
      mediaSecret: 'synthetic',
      publicUrl: 'http://example.test',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: false
      }
    }
    const app = express()
    app.use((req, _res, next) => {
      actorForToken(db, req.headers.authorization?.slice(7) ?? '')
        .then(actor => {
          req.actor = actor
          next()
        })
        .catch(next)
    })
    app.use(seasonRoutes(db, media), teamRoutes(db, media), statsRoutes(db))
    app.use(errorHandler)
    server = app.listen(0)
    const address = server.address()
    if (address == null || typeof address === 'string')
      throw new Error('Missing test port')
    origin = `http://127.0.0.1:${address.port}`
    dir = await mkdtemp(join(tmpdir(), 'user-id-check-'))
  })

  after(async function () {
    if (server != null)
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
      )
    if (db != null) await db.destroy()
    if (pool != null && !pool.ended) await pool.end()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
    if (dir != null) await rm(dir, { recursive: true, force: true })
  })

  it('captures every listed endpoint from a real authenticated server and removes its session', async function () {
    baseline = await captureUserIds(pool, origin)
    expect(baseline.userIdType).equals('text')
    expect(baseline.tables.users.rows).has.length(3)
    expect(Object.keys(baseline.api)).deep.equals(snapshotPaths(baseline))
    expect(Object.keys(baseline.api)).has.length(21)
    expect(baseline.tables.notification_events.columns).contains(
      'recorded_recipients'
    )
    expect(baseline.userColumns.memberships).contains('user_id')
    expect((await pool.query('select * from auth_sessions')).rows).has.length(0)
    expect(
      compareUserIds(baseline, await captureUserIds(pool, origin)).equal
    ).equals(true)
  })

  it('cleans up after API failure and detects mutations during capture', async function () {
    for (const request of [
      async () => Response.json({}, { status: 500 }),
      async () => {
        await pool.query(
          `update users set display_name = 'Hank Aaron' where id = $1`,
          [userIdOfGumbo(3)]
        )
        return Response.json([])
      }
    ]) {
      let message = ''
      try {
        await captureUserIds(pool, origin, request)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).not.equals('')
      expect((await pool.query('select * from auth_sessions')).rows).has.length(
        0
      )
    }
  })

  it('refuses missing admins and unsupported schema identities without leaving sessions', async function () {
    await pool.query('update users set is_admin = false')
    try {
      await captureUserIds(pool, origin)
      expect.fail('Expected missing admin failure')
    } catch (error) {
      expect((error as Error).message).contains('No enabled node admin')
    }
    await pool.query('update users set is_admin = true where id = $1', [
      userIdOfGumbo(1)
    ])
    const client = await pool.connect()
    try {
      const snap = await snapshotSql(client)
      expect(snap.migrations.at(-1)).equals(migrations.at(-1)!.name)
    } finally {
      client.release()
    }
  })

  it('runs the CLI snapshot and compare paths with private files and value-free output', async function () {
    const output: string[] = []
    const print = (line: string): void => {
      output.push(line)
    }
    const url = new URL(testDatabaseUrl)
    url.pathname = '/' + name
    const file = join(dir, 'snapshot.json')
    expect(
      await runUserIdCheck(
        [
          'snapshot',
          '--database',
          url.toString(),
          '--api',
          origin,
          '--out',
          file
        ],
        print
      )
    ).equals(0)
    expect(
      await runUserIdCheck(
        ['compare', file, file, '--out', join(dir, 'compare.log')],
        print
      )
    ).equals(0)
    const modified = JSON.parse(await readFile(file, 'utf8')) as UserIdSnapshot
    modified.tables.game_player_stats.rows[0].h = 7
    await writeFile(join(dir, 'changed.json'), JSON.stringify(modified))
    expect(
      await runUserIdCheck(
        [
          'compare',
          file,
          join(dir, 'changed.json'),
          '--out',
          join(dir, 'changed.log')
        ],
        print
      )
    ).equals(1)
    expect(output.join('\n'))
      .not.contains('Babe Ruth')
      .and.not.contains(url.toString())
    const command = promisify(execFile)
    const child = await command(process.execPath, [
      '-r',
      'sucrase/register',
      'src/server/dev/userIdCheck.ts',
      'compare',
      file,
      file,
      '--out',
      join(dir, 'child.log')
    ])
    expect(child.stdout).contains('0 differences')
    let cliFailed = false
    try {
      await command(process.execPath, [
        '-r',
        'sucrase/register',
        'src/server/dev/userIdCheck.ts',
        'unknown'
      ])
    } catch (error) {
      cliFailed = true
      expect((error as { stderr: string }).stderr).contains(
        'Expected snapshot or compare'
      )
    }
    expect(cliFailed).equals(true)
    for (const args of [
      [],
      ['snapshot'],
      ['snapshot', '--database', '--api'],
      ['compare'],
      ['compare', file, file, '--out', file, '--allow-merged']
    ]) {
      let failed = false
      try {
        await runUserIdCheck(args, print)
      } catch {
        failed = true
      }
      expect(failed).equals(true)
    }
  })
})
