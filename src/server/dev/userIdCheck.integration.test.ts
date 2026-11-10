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
import { compareUserIds } from './userIdCompare'
import {
  captureUserIds,
  snapshotPaths,
  snapshotSql,
  type UserIdSnapshot
} from './userIdSnapshot'

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
