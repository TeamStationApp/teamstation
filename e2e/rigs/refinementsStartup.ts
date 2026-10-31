import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import path from 'node:path'

import { Pool } from 'pg'

import { asSeasonStats, asStandingsRow } from '../../src/common/api'
import { userIdOfGumbo } from '../../src/common/userId'
import { migrations } from '../../src/migrate/migrations'
import { migrateUp } from '../../src/migrate/runner'
import { testDatabaseUrl } from '../../src/migrate/testDatabase'
import { createSession } from '../../src/server/auth/sessions'
import { makeDatabase } from '../../src/server/db/database'
import { insertFixtureUsers } from '../../src/test/insertFixtureUsers'

/** Real entry-point smoke: isolated configuration, database, Redis and object endpoint. */
async function availablePort(): Promise<number> {
  const server = createPortServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close(error => {
      error == null ? resolve() : reject(error)
    })
  )
  return port
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid == null || child.exitCode != null || child.signalCode != null)
    return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server == null) return
  server.closeAllConnections()
  await new Promise<void>(resolve =>
    server.close(() => {
      resolve()
    })
  )
}

async function startupSmoke(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  assert(
    artifacts != null && path.isAbsolute(artifacts),
    'TS_REFINEMENTS_ARTIFACTS must be an absolute output directory'
  )
  const support = path.join(
    artifacts,
    'support',
    `startup-${randomBytes(6).toString('hex')}`
  )
  const coverage =
    process.env.TS_REFINEMENTS_STARTUP_V8 ?? path.join(support, 'startup-v8')
  await mkdir(support, { recursive: true, mode: 0o700 })
  await mkdir(coverage, { recursive: true, mode: 0o700 })
  const name = `refinements_startup_${randomBytes(8).toString('hex')}`
  const database = new URL(testDatabaseUrl)
  database.pathname = `/${name}`
  const admin = new Pool({ connectionString: testDatabaseUrl })
  let created = false
  let db: ReturnType<typeof makeDatabase> | undefined
  let worker: ChildProcess | undefined
  let redis: ChildProcess | undefined
  let objectServer: Server | undefined
  let spawnFailure: Error | undefined
  const workerLog = createWriteStream(path.join(support, 'worker.log'), {
    mode: 0o600
  })
  const redisLog = createWriteStream(path.join(support, 'redis.log'), {
    mode: 0o600
  })
  try {
    await admin.query(`create database ${name}`)
    created = true
    const migrationPool = new Pool({ connectionString: database.toString() })
    try {
      await migrateUp(migrationPool, migrations)
    } finally {
      await migrationPool.end()
    }
    db = makeDatabase(database.toString())
    await insertFixtureUsers(db, [
      {
        id: userIdOfGumbo(101),
        legacyId: 'usr_startup_viewer',
        display_name: 'Demo Viewer',
        login_enabled: true
      },
      {
        id: userIdOfGumbo(102),
        legacyId: 'usr_startup_outsider',
        display_name: 'Demo Outsider',
        login_enabled: true
      }
    ])
    await db
      .insertInto('seasons')
      .values({
        starts_on: `2027-03-01`,
        ends_on: `2027-05-31`,
        id: 'sea_startup',
        name: 'Demo Startup Season',
        year: 2027
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: 'smb_startup',
        season_id: 'sea_startup',
        user_id: userIdOfGumbo(101),
        role: 'member',
        source: 'manual'
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        {
          id: 'tem_startup_home',
          name: 'Demo Hosts',
          logo_path: 'demo-startup/hosts'
        },
        {
          id: 'tem_startup_away',
          name: 'Demo Visitors',
          logo_path: 'demo-startup/visitors'
        }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values(
        ['tem_startup_home', 'tem_startup_away'].map(teamId => ({
          season_id: 'sea_startup',
          team_id: teamId
        }))
      )
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_startup',
        home_team_id: 'tem_startup_home',
        away_team_id: 'tem_startup_away',
        season_id: 'sea_startup',
        start_at: new Date('2027-04-01T19:00:00Z'),
        status: 'final',
        home_score: 5,
        away_score: 2
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_startup',
        game_id: 'gam_startup',
        gumbo_id: 101,
        team_id: 'tem_startup_home',
        pa: 4,
        ab: 3,
        h: 2,
        singles: 2,
        bb: 1,
        pitch_bf: 6,
        pitch_outs: 6,
        pitch_er: 1
      })
      .execute()
    const token = (await createSession(db, userIdOfGumbo(101), 'startup-smoke'))
      .token
    const outsiderToken = (
      await createSession(db, userIdOfGumbo(102), 'startup-smoke')
    ).token
    const port = await availablePort()
    const redisPort = await availablePort()
    objectServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=',
          'base64'
        )
      )
    })
    await new Promise<void>(resolve =>
      objectServer!.listen(0, '127.0.0.1', resolve)
    )
    const objectAddress = objectServer.address()
    assert(objectAddress != null && typeof objectAddress !== 'string')
    const objectOrigin = `http://127.0.0.1:${objectAddress.port}`
    await writeFile(
      path.join(support, 'serverConfig.json'),
      JSON.stringify({
        listenHost: '127.0.0.1',
        listenPort: port,
        clusterWorkers: 1,
        statsBuilder: false,
        databaseUrl: database.toString(),
        primaryUrlOverride: `127.0.0.1:${port}`,
        workDir: path.join(support, 'work'),
        mediaDir: path.join(support, 'media'),
        uploadsDir: path.join(support, 'uploads'),
        purgeReplacedRecordings: false,
        serveMediaLocally: false,
        logRequests: false,
        sessionSecret: randomBytes(32).toString('hex'),
        mediaSecret: randomBytes(32).toString('hex'),
        live: { enabled: false },
        googlePlaces: { apiKey: 'placeholder-key', baseUrl: objectOrigin },
        redis: {
          url: `redis://127.0.0.1:${redisPort}`,
          prefix: `${name}:`,
          caFile: ''
        },
        space: {
          endpoint: objectOrigin,
          region: 'demo',
          bucket: 'demo-startup',
          accessKeyId: randomBytes(12).toString('hex'),
          secretAccessKey: randomBytes(32).toString('hex'),
          pathStyle: true
        }
      }),
      { mode: 0o600 }
    )
    redis = spawn(
      process.env.TS_REDIS_SERVER ?? 'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(redisPort),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        support
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    redis.once('error', error => {
      spawnFailure = error
    })
    redis.stdout?.pipe(redisLog, { end: false })
    redis.stderr?.pipe(redisLog, { end: false })
    worker = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        path.resolve(__dirname, '../../src/server/index.ts')
      ],
      {
        cwd: support,
        env: { ...process.env, NODE_V8_COVERAGE: coverage },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    worker.once('error', error => {
      spawnFailure = error
    })
    worker.stdout?.pipe(workerLog, { end: false })
    worker.stderr?.pipe(workerLog, { end: false })
    const origin = `http://127.0.0.1:${port}`
    let healthy = false
    for (let i = 0; i < 100; i++) {
      assert(
        spawnFailure == null,
        'The isolated startup child could not launch'
      )
      assert(
        worker.exitCode == null && worker.signalCode == null,
        'The isolated entry point exited before health was ready'
      )
      try {
        const response = await fetch(`${origin}/api/v1/health`, {
          signal: AbortSignal.timeout(500)
        })
        if (response.status === 200) {
          const health = (await response.json()) as {
            status: string
            database: string
            dictation: boolean
          }
          assert.equal(health.status, 'ok')
          assert.equal(health.database, 'ok')
          assert.equal(health.dictation, false)
          healthy = true
          break
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(healthy, 'The isolated entry point did not become healthy')
    const standingsResponse = await fetch(
      `${origin}/api/v1/seasons/sea_startup/standings?includeExhibitions=false`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    assert.equal(standingsResponse.status, 200)
    const standings = ((await standingsResponse.json()) as unknown[]).map(
      asStandingsRow
    )
    assert.equal(standings[0].teamId, 'tem_startup_home')
    assert.equal(standings[0].w, 1)
    assert(
      standings.every(row => row.logoUrl != null),
      'Production stats routing must receive its media context'
    )
    for (const row of standings) {
      const logo = new URL(row.logoUrl!)
      assert.equal(logo.origin, objectOrigin)
      assert(logo.searchParams.has('X-Amz-Signature'))
      assert.equal((await fetch(logo)).status, 200)
    }
    const statsResponse = await fetch(
      `${origin}/api/v1/seasons/sea_startup/stats`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    assert.equal(statsResponse.status, 200)
    const stats = asSeasonStats(await statsResponse.json())
    assert.equal(stats.seasonId, 'sea_startup')
    assert.equal(stats.batting[0].h, 2)
    assert.equal(stats.pitching[0].ip, '2.0')
    const refused = await fetch(`${origin}/api/v1/seasons/sea_startup/stats`, {
      headers: { authorization: `Bearer ${outsiderToken}` }
    })
    assert.equal(refused.status, 404)
    console.log(
      'Production entry smoke passed: health, season standings, signed local logos, authorized season stats and outsider refusal.'
    )
    console.log(`Startup V8 coverage: ${coverage}`)
    await writeFile(
      path.join(artifacts, 'support', 'startup-coverage-path.txt'),
      coverage + '\n',
      { mode: 0o600 }
    )
  } finally {
    await stopChild(worker)
    await stopChild(redis)
    await closeServer(objectServer)
    workerLog.end()
    redisLog.end()
    await db?.destroy()
    if (created) await admin.query(`drop database ${name} with (force)`)
    await admin.end()
  }
}

startupSmoke().catch(() => {
  console.error(
    'Production entry smoke failed; inspect the private support logs.'
  )
  process.exitCode = 1
})
