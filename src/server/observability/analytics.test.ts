import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type {
  EventName,
  EventRecord
} from '../../common/observability/contract'
import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { deleteAccount } from '../account/deleteAccount'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  analyticsBatch,
  eraseAnalytics,
  pruneAnalytics,
  storeAnalytics
} from './analytics'
import { AnalyticsReader } from './query'
import { analyticsRoutes } from './routes'
import { startAnalytics } from './service'

const event = (
  E: EventName = 'session_started',
  P: EventRecord['P'] = {}
): EventRecord => ({
  D: new Date().toISOString(),
  A: 'TS web',
  I: randomUUID(),
  E,
  L: 'info',
  R: 1,
  P
})
async function fails(run: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  expect(failed).equals(true)
}

describe('analytics PostgreSQL and HTTP isolation', function () {
  this.timeout(60000)
  let h: AccountHarness,
    owner: Pool,
    reader: AnalyticsReader,
    readerPool: Pool,
    server: Server,
    origin: string,
    dbUrl: string
  const role = 'analytics_test_' + randomBytes(6).toString('hex')
  const password = randomBytes(24).toString('hex')
  const actor = { userId: userIdOfGumbo(101), isAdmin: false, scopes: [] }
  const admin = { userId: userIdOfGumbo(102), isAdmin: true, scopes: [] }
  before(async () => {
    h = await accountHarness()
    const database = (
      await sql<{ name: string }>`SELECT current_database() AS name`.execute(
        h.db
      )
    ).rows[0].name
    const location = new URL(testDatabaseUrl)
    location.pathname = '/' + database
    dbUrl = location.toString()
    owner = new Pool({ connectionString: dbUrl })
    await owner.query(
      `CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`
    )
    await owner.query(
      `REVOKE CREATE,TEMP ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA analytics TO ${role}; GRANT SELECT ON analytics.events TO ${role}; ALTER ROLE ${role} SET default_transaction_read_only=on`
    )
    location.username = role
    location.password = password
    reader = new AnalyticsReader(location.toString())
    readerPool = new Pool({ connectionString: location.toString() })
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', admin.userId)
      .execute()
    const app = express()
    app.use(withActor(h.db))
    app.use(jsonBody)
    app.use('/api/v1', analyticsRoutes(h.db, reader))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    await h.db
      .insertInto('games')
      .values({
        id: 'gam_analytics',
        home_team_id: 'tem_account',
        away_team_id: 'tem_account',
        start_at: new Date()
      })
      .execute()
    await h.db
      .insertInto('videos')
      .values({
        id: 'vid_analytics',
        game_id: 'gam_analytics',
        title: 'Synthetic video',
        kind: 'program',
        storage: 'local',
        status: 'ready'
      })
      .execute()
  })
  after(async () => {
    if (server != null)
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    await reader?.close()
    await readerPool?.end()
    await owner?.end()
    await h?.close()
    const cleanup = new Pool({ connectionString: testDatabaseUrl })
    await cleanup.query(`DROP ROLE IF EXISTS ${role}`)
    await cleanup.end()
  })
  async function post(
    path: string,
    body: unknown,
    user?: 101 | 102,
    content = 'application/json'
  ): Promise<Response> {
    return await fetch(origin + '/api/v1' + path, {
      method: 'POST',
      headers: {
        'content-type': content,
        ...(user == null
          ? {}
          : { authorization: 'Bearer ' + h.tokens.get(user)! })
      },
      body: content === 'application/json' ? JSON.stringify(body) : String(body)
    })
  }
  it('durably accepts and deduplicates authorized events without trusting identity', async () => {
    const row = event('page_viewed', { pg: 'home' })
    expect((await post('/analytics/events', [row])).status).equals(202)
    expect((await post('/analytics/events', [row])).status).equals(202)
    const stored = await owner.query(
      'SELECT * FROM analytics.events WHERE event_id=$1',
      [row.I]
    )
    expect(stored.rows).length(1)
    expect(stored.rows[0].user_id).equals(null)
    const known = event('login_succeeded', { mt: 'password' })
    expect((await post('/analytics/events', [known], 101)).status).equals(202)
    expect(
      (
        await owner.query(
          'SELECT user_id FROM analytics.events WHERE event_id=$1',
          [known.I]
        )
      ).rows[0].user_id
    ).equals(actor.userId)
    const failed = event('login_failed', { mt: 'password', ec: 'invalid' })
    expect(
      (
        await post(
          '/analytics/events',
          JSON.stringify(failed) + '\n',
          undefined,
          'application/x-ndjson'
        )
      ).status
    ).equals(202)
    expect(
      (
        await owner.query(
          'SELECT user_id FROM analytics.events WHERE event_id=$1',
          [failed.I]
        )
      ).rows[0].user_id
    ).equals(null)
    const playback = event('watch_progress', {
      vi: 'vid_analytics',
      ps: randomUUID(),
      ms: 12000
    })
    expect((await post('/analytics/events', [playback], 101)).status).equals(
      202
    )
    await storeAnalytics(h.db, [event('account_created')], admin, true)
    expect(
      (
        await owner.query(
          "SELECT count(*) FROM analytics.events WHERE event_name='account_created'"
        )
      ).rows[0].count
    ).equals(1)
  })
  it('rejects private properties, wrong identities/apps and unauthorized video references atomically', async () => {
    const denied: Array<[unknown, number, 101 | undefined]> = [
      [[{ ...event(), U: 'usr_forged' }], 400, 101],
      [[event('app_error', { chat: 'secret-canary' })], 400, 101],
      [[{ ...event(), A: 'cam' }], 400, 101],
      [[event('account_created')], 403, 101],
      [[event('login_succeeded', { mt: 'password' })], 401, undefined],
      [[event('page_viewed', { pg: 'settings' })], 403, undefined],
      [
        [event('login_failed', { mt: 'password', ec: 'storage' })],
        400,
        undefined
      ],
      [
        [
          event('watch_progress', {
            vi: 'vid_missing',
            ps: randomUUID(),
            ms: 1
          })
        ],
        403,
        101
      ],
      [[], 400, 101],
      [Array.from({ length: 51 }, () => event()), 400, 101],
      ['invalid', 400, 101],
      [[event('search_submitted', { n: -1 })], 400, 101],
      [[event('signup_started', { mt: 'secret-canary' })], 400, undefined]
    ]
    for (const [body, status, user] of denied)
      expect(
        (await post('/analytics/events', body, user)).status,
        JSON.stringify(body)
      ).equals(status)
    expect(
      (
        await post('/analytics/events', [
          event('watch_progress', {
            vi: 'vid_analytics',
            ps: randomUUID(),
            ms: 1
          })
        ])
      ).status
    ).equals(401)
    const accepted = event()
    expect(
      (
        await post(
          '/analytics/events',
          [accepted, event('account_created')],
          101
        )
      ).status
    ).equals(403)
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM analytics.events WHERE event_id=$1',
          [accepted.I]
        )
      ).rows[0].count
    ).equals(0)
    await fails(async () => {
      await storeAnalytics(h.db, [event()], {
        ...actor,
        userId: userIdOfGumbo(999)
      })
    })
    await h.db
      .updateTable('videos')
      .set({ hidden: true })
      .where('id', '=', 'vid_analytics')
      .execute()
    expect(
      (
        await post(
          '/analytics/events',
          [
            event('watch_progress', {
              vi: 'vid_analytics',
              ps: randomUUID(),
              ms: 1
            })
          ],
          101
        )
      ).status
    ).equals(403)
    await h.db
      .updateTable('videos')
      .set({ hidden: false })
      .where('id', '=', 'vid_analytics')
      .execute()
    for (const body of [
      null,
      {},
      'bad',
      Array.from({ length: 50 }, () => ({
        ...event(),
        extra: 'x'.repeat(2000)
      }))
    ])
      expect(() => analyticsBatch(body)).throws()
    expect(
      (
        await post(
          '/analytics/events',
          'x'.repeat(65537),
          101,
          'application/x-ndjson'
        )
      ).status
    ).equals(413)
  })
  it('requires admin access and the independent restricted reader role', async () => {
    const request = {
      sql: 'select event_name,count(*) as n from analytics.events group by event_name order by n desc'
    }
    expect((await post('/admin/analytics/query', request)).status).equals(401)
    expect((await post('/admin/analytics/query', request, 101)).status).equals(
      403
    )
    const response = await post('/admin/analytics/query', request, 102)
    expect(response.status).equals(200)
    expect(
      ((await response.json()) as { rows: unknown[] }).rows.length
    ).greaterThan(0)
    for (const body of [
      null,
      [],
      { ...request, extra: 1 },
      { sql: 'select * from users' },
      { sql: 'delete from analytics.events' }
    ])
      expect((await post('/admin/analytics/query', body, 102)).status).equals(
        400
      )
    for (const query of [
      'select * from public.users',
      'delete from analytics.events',
      'insert into analytics.events select * from analytics.events',
      'create temporary table probe (x int)',
      'create schema probe'
    ])
      await fails(async () => await readerPool.query(query))
    const ownerReader = new AnalyticsReader(dbUrl)
    try {
      await fails(
        async () => await ownerReader.query('select * from analytics.events')
      )
    } finally {
      await ownerReader.close()
    }
    expect(() => new AnalyticsReader('')).throws()
    const absent = new AnalyticsReader('postgres://localhost:1/absent')
    try {
      await fails(
        async () => await absent.query('select * from analytics.events')
      )
    } finally {
      await absent.close()
    }
    const app = express()
    app.use(withActor(h.db))
    app.use(jsonBody)
    app.use('/api/v1', analyticsRoutes(h.db))
    app.use(errorHandler)
    const missing = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => missing.once('listening', resolve))
    try {
      expect(
        (
          await fetch(
            'http://127.0.0.1:' +
              (missing.address() as AddressInfo).port +
              '/api/v1/admin/analytics/query',
            {
              method: 'POST',
              headers: {
                authorization: 'Bearer ' + h.tokens.get(102)!,
                'content-type': 'application/json'
              },
              body: JSON.stringify(request)
            }
          )
        ).status
      ).equals(503)
    } finally {
      await new Promise<void>(resolve =>
        missing.close(() => {
          resolve()
        })
      )
    }
  })
  it('caps rows, bytes and concurrency, times out on locks, and releases connections', async () => {
    await owner.query(`INSERT INTO analytics.events(occurred_at,event_id,app,event_name,schema_revision,properties)
      SELECT now(),md5(i::text)::uuid,'TS','session_started',1,jsonb_build_object('pg',repeat('x',3000)) FROM generate_series(1,1100) i`)
    const capped = await reader.query('select event_id from analytics.events')
    expect(capped.rows).length(1000)
    expect(capped.truncated).equals(true)
    const bytes = await reader.query('select * from analytics.events')
    expect(bytes.rows.length).lessThan(1000)
    expect(bytes.truncated).equals(true)
    const lock = await owner.connect()
    await lock.query('BEGIN; LOCK analytics.events IN ACCESS EXCLUSIVE MODE')
    try {
      const first = reader.query('select * from analytics.events').then(
        () => false,
        () => true
      )
      const second = reader.query('select * from analytics.events').then(
        () => false,
        () => true
      )
      await fails(
        async () => await reader.query('select * from analytics.events')
      )
      expect(await first).equals(true)
      expect(await second).equals(true)
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
    expect(
      (await reader.query('select count(*) from analytics.events')).rows
    ).length(1)
  })
  it('expires old analytics in bounded work and erases all selected identities', async () => {
    await owner.query(
      "INSERT INTO analytics.events(occurred_at,event_id,app,event_name,schema_revision,properties) VALUES(now()-interval '181 days',$1,'TS','session_started',1,'{}')",
      [randomUUID()]
    )
    await pruneAnalytics(h.db)
    expect(
      (
        await owner.query(
          "SELECT count(*) FROM analytics.events WHERE occurred_at<now()-interval '180 days'"
        )
      ).rows[0].count
    ).equals(0)
    await eraseAnalytics(h.db, [])
    await eraseAnalytics(h.db, [actor.userId, admin.userId])
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM analytics.events WHERE user_id IS NOT NULL'
        )
      ).rows[0].count
    ).equals(0)
    // Force a real rollback failure by terminating the restricted backend while it is waiting.
    const lock = await owner.connect()
    await lock.query('BEGIN; LOCK analytics.events IN ACCESS EXCLUSIVE MODE')
    const query = reader.query('select * from analytics.events').then(
      () => false,
      () => true
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    await owner.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1',
      [role]
    )
    expect(await query).equals(true)
    await lock.query('ROLLBACK')
    lock.release()
    await storeAnalytics(h.db, [event()], actor)
    await deleteAccount(h.db, actor.userId)
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM analytics.events WHERE user_id=$1',
          [actor.userId]
        )
      ).rows[0].count
    ).equals(0)
    expect(
      (await post('/analytics/events', [event('login_succeeded')], 101)).status
    ).equals(401)
  })
  it('starts and stops the actual application process with analytics enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analytics-server-'))
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>(resolve =>
      probe.close(() => {
        resolve()
      })
    )
    await writeFile(
      join(root, 'serverConfig.json'),
      JSON.stringify({
        databaseUrl: dbUrl,
        analyticsReaderUrl: dbUrl,
        listenHost: '127.0.0.1',
        listenPort: port,
        clusterWorkers: 1,
        statsBuilder: false,
        primaryUrlOverride: '127.0.0.1:' + port,
        workDir: join(root, 'work'),
        mediaDir: join(root, 'media'),
        live: { enabled: false },
        redis: { url: 'redis://127.0.0.1:1', prefix: 'fixture' },
        space: { accessKeyId: '', secretAccessKey: '' }
      })
    )
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        resolvePath('src/server/index.ts')
      ],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = new Promise<number | null>(resolve =>
      child.once('exit', resolve)
    )
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(Error('Application startup timeout'))
        }, 10000)
        child.once('exit', () => {
          clearTimeout(timeout)
          reject(Error('Application exited before readiness'))
        })
        child.stdout.on('data', data => {
          if (String(data).includes('listening on')) {
            clearTimeout(timeout)
            resolve()
          }
        })
        child.stderr.resume()
      })
      const response = await fetch(
        'http://127.0.0.1:' + port + '/api/v1/analytics/events',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([event()])
        }
      )
      expect(response.status).equals(202)
      // The owner URL is deliberately misconfigured and must never grant query access.
      const query = await fetch(
        'http://127.0.0.1:' + port + '/api/v1/admin/analytics/query',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + h.tokens.get(102)!
          },
          body: JSON.stringify({ sql: 'select * from analytics.events' })
        }
      )
      expect(query.status).equals(503)
    } finally {
      child.kill('SIGTERM')
      await exited
      await rm(root, { recursive: true, force: true })
    }
    await owner.query(
      "INSERT INTO analytics.events(occurred_at,event_id,app,event_name,schema_revision,properties) VALUES(now()-interval '181 days',$1,'TS','session_started',1,'{}')",
      [randomUUID()]
    )
    const stop = startAnalytics(express(), h.db, undefined, 5)
    await new Promise(resolve => setTimeout(resolve, 40))
    await stop()
    expect(
      (
        await owner.query(
          "SELECT count(*) FROM analytics.events WHERE occurred_at<now()-interval '180 days'"
        )
      ).rows[0].count
    ).equals(0)
  })
})
