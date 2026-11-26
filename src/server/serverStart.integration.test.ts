import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer, get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import { createClient } from 'redis'
import { generateVAPIDKeys } from 'web-push'
import WebSocket from 'ws'

import { SCOREBOARD_CLOSE } from '../common/scoreboard'
import { SEARCH_SOCKET_PATH } from '../common/search/types'
import { userIdOfGumbo } from '../common/userId'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { dropScratchDatabase, testDatabaseUrl } from '../migrate/testDatabase'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import { pushTestPrefix } from '../test/pushQueueKit'
import { testRedisUrl } from '../test/scoreboardKit'
import { createSession } from './auth/sessions'
import { makeDatabase } from './db/database'
import { ratePrefix } from './valkey/apiBudgets'

/**
 * The server as `npm start` runs it, in its own process on a scratch
 * database: one process that is both the API and the ingest, and a primary
 * with two workers. Each answers a chat route through the whole app, and
 * stops on SIGTERM.
 */
const ROOT = resolve(__dirname, '../..')

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port =
        typeof address === 'object' && address != null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

/** One signed-out search through the server's search socket: its first frame. */
async function searchSignedOut(
  base: string
): Promise<{ type: string; seq?: number }> {
  const ws = new WebSocket(
    `${base.replace(/^http/, 'ws')}${SEARCH_SOCKET_PATH}`
  )
  try {
    return await new Promise((resolve, reject) => {
      ws.once('error', reject)
      ws.once('message', data => {
        resolve(JSON.parse((data as Buffer).toString('utf8')))
      })
      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            type: 'search',
            seq: 1,
            text: 'nobody here',
            location: null,
            mode: 'all'
          })
        )
      })
    })
  } finally {
    ws.close()
  }
}

describe('the server process', function () {
  this.timeout(120000)
  const name = `teamstation_server_start_${Date.now()}_${process.pid}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const member = userIdOfGumbo(4701)
  // A pair that can sign, so Web Push stays on.
  const webPush = {
    ...generateVAPIDKeys(),
    subject: 'mailto:push@example.test'
  }
  let admin: Pool | undefined
  let dir = ''

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query(`create database ${name}`)
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
    }
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    dir = mkdtempSync(join(tmpdir(), 'ts-server-start-'))
  })

  after(async function () {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    if (admin != null) {
      await dropScratchDatabase(admin, name, { timeoutMs: 20000 })
      await admin.end()
    }
  })

  /** Starts it with `workers`, waits for every worker, then hands it over. */
  async function start(
    workers: number,
    run: (base: string, said: () => string) => Promise<void>,
    settings: Record<string, unknown> = {}
  ): Promise<number | null> {
    const port = await freePort()
    const home = join(dir, `workers-${workers}`)
    mkdirSync(join(home, 'media'), { recursive: true })
    mkdirSync(join(home, 'work'), { recursive: true })
    writeFileSync(
      join(home, 'serverConfig.json'),
      JSON.stringify({
        databaseUrl: scratchUrl,
        listenHost: '127.0.0.1',
        listenPort: port,
        clusterWorkers: workers,
        statsBuilder: false,
        logRequests: false,
        // The push queue, and the change feed's keys, on a prefix of its own.
        redis: { url: testRedisUrl, prefix: pushTestPrefix() },
        appLinks: {
          apps: [
            { origin: 'https://app.teamstation.app' },
            { origin: 'https://tv.example.test', tvLogin: true },
            { origin: 'https://tv2.example.test', tvLogin: true }
          ]
        },
        mediaDir: join(home, 'media'),
        workDir: join(home, 'work'),
        // The clustered run names its own uploads directory and a Space
        // nothing answers at, so a chat delete is wired to take its
        // attachments off it.
        ...(workers > 1
          ? {
              uploadsDir: join(home, 'uploads'),
              space: {
                endpoint: 'http://127.0.0.1:1',
                bucket: 'scratch',
                accessKeyId: 'scratch-id',
                secretAccessKey: 'scratch-secret',
                pathStyle: true
              }
            }
          : {}),
        ...settings
      })
    )
    const server: ChildProcess = spawn(
      process.execPath,
      ['-r', 'sucrase/register', join(ROOT, 'src/server/index.ts')],
      {
        cwd: home,
        env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let said = ''
    const exited = new Promise<number | null>(resolve => {
      server.once('exit', code => {
        resolve(code)
      })
    })
    await new Promise<void>((resolve, reject) => {
      const hear = (chunk: Buffer): void => {
        said += chunk.toString('utf8')
        if ((said.match(/ listening on /g) ?? []).length >= workers) resolve()
      }
      server.stdout?.on('data', hear)
      server.stderr?.on('data', hear)
      exited
        .then(code => {
          reject(new Error(`the server exited ${String(code)}: ${said}`))
        })
        .catch(reject)
    })
    try {
      await run(`http://127.0.0.1:${port}`, () => said)
    } finally {
      server.kill('SIGTERM')
    }
    return await exited
  }

  it('recovers shared budgets across two workers, a local fallback, a writer restart and ACL changes', async function () {
    this.timeout(180000)
    const binary = ['valkey-server', 'redis-server'].find(
      bin => spawnSync(bin, ['--version']).status === 0
    )
    if (binary == null) return this.skip()
    const port = await freePort()
    const url = 'redis://127.0.0.1:' + port
    const prefix = pushTestPrefix()
    const db = makeDatabase(scratchUrl)
    const userId = userIdOfGumbo(4858)
    let token: string
    try {
      await insertFixtureUsers(db, {
        id: userId,
        legacyId: 'usr_recovery_fixture',
        login_enabled: true,
        display_name: 'Demo Staff'
      })
      token = (await createSession(db, userId, undefined)).token
    } finally {
      await db.destroy()
    }
    // A full row allowance takes 200 seconds to recover. A replaced worker
    // starts with a fresh local allowance while its sibling still holds debt.
    async function batches(base: string): Promise<number[]> {
      const results: number[] = []
      for (let i = 0; i < 4; i++) {
        const r = await fetch(base + '/api/v1/teams/missing-fixture/games', {
          method: 'POST',
          headers: {
            connection: 'close',
            'content-type': 'application/json',
            authorization: 'Bearer ' + token
          },
          body: JSON.stringify({ games: Array(200).fill({}) })
        })
        await r.arrayBuffer()
        results.push(r.status)
      }
      return results
    }
    const storeDirectory = mkdtempSync(join(dir, 'rate-store-'))
    let child: ChildProcess | undefined
    let stopped: Promise<unknown> | undefined
    async function boot(): Promise<void> {
      child = spawn(
        binary!,
        [
          '--port',
          String(port),
          '--bind',
          '127.0.0.1',
          '--dir',
          storeDirectory,
          '--save',
          '',
          '--appendonly',
          'no'
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      stopped = once(child, 'exit')
      const output = child.stdout!
      await Promise.race([
        new Promise<void>(resolve => {
          let tail = ''
          const listen = (chunk: Buffer): void => {
            tail = (tail + chunk.toString().toLowerCase()).slice(-1024)
            if (tail.includes('ready to accept connections')) {
              output.off('data', listen)
              resolve()
            }
          }
          output.on('data', listen)
        }),
        stopped.then(() => {
          throw new Error('Test store exited before it was ready')
        })
      ])
    }
    async function halt(): Promise<void> {
      child?.kill('SIGTERM')
      await stopped
      child = undefined
    }
    const admin = async (): Promise<ReturnType<typeof createClient>> => {
      const c = createClient({ url, socket: { reconnectStrategy: false } })
      c.on('error', () => {})
      await c.connect()
      return c
    }
    async function getWorkers(
      base: string,
      readiness: string,
      expected = 2
    ): Promise<number[]> {
      const pids = new Set<number>()
      const deadline = Date.now() + 35000
      while (pids.size < expected && Date.now() < deadline) {
        const r = await fetch(base + '/api/v1/health', {
          headers: { connection: 'close', 'x-forwarded-for': '192.0.2.49' }
        })
        expect(r.status).equals(200)
        const body = await r.json()
        if (body.apiRateLimits.readiness === readiness) {
          expect(body.apiRateLimits.mode).equals('enforce')
          if (readiness === 'ready')
            expect(body.apiRateLimits.degradedMs).equals(0)
          else expect(body.apiRateLimits.degradedMs).to.be.at.least(0)
          if (readiness === 'failed')
            expect(body.apiRateLimits.fault).equals('permissions')
          pids.add(body.pid)
        }
        // The readiness monitor is a guest too. Keep it below its 240/minute budget.
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(pids.size, 'workers reporting ' + readiness).equals(expected)
      return [...pids]
    }
    async function burst(
      base: string,
      ip: string,
      count: number
    ): Promise<number[]> {
      const statuses: number[] = []
      for (let i = 0; i < count; i++) {
        const r = await fetch(base + '/api/v1/graphql', {
          method: 'POST',
          headers: {
            connection: 'close',
            'x-forwarded-for': ip,
            'content-type': 'application/json'
          },
          body: '{"query":"{ __typename }"}'
        })
        await r.arrayBuffer()
        statuses.push(r.status)
      }
      return statuses
    }
    const config = {
      apiRateLimitMode: 'enforce',
      backgroundJobs: false,
      redis: { url, prefix }
    }
    try {
      await boot()
      let c = await admin()
      await c.sendCommand(['ACL', 'SETUSER', 'default', '-evalsha'])
      await c.close()
      await start(
        2,
        async (base, said) => {
          await getWorkers(base, 'failed')
          expect(said()).includes('check writer credentials and ACLs')
          c = await admin()
          await c.sendCommand([
            'ACL',
            'SETUSER',
            'default',
            '+evalsha',
            'resetkeys',
            '~*:expensive'
          ])
          // The script can write expensive keys, but the remaining families are still forbidden.
          await new Promise(resolve => setTimeout(resolve, 5500))
          await getWorkers(base, 'failed')
          await c.sendCommand(['ACL', 'SETUSER', 'default', 'allkeys'])
          const pids = await getWorkers(base, 'ready')
          expect(await c.info('replication')).matches(/role:master/)
          const clients = await c.clientList()
          for (const pid of pids)
            expect(
              clients.some(row => row.name === 'live-playlists-' + pid)
            ).equals(true)
          // A distinct deployment on the very same writable primary has its own four.
          await start(
            1,
            async other => {
              await getWorkers(other, 'ready', 1)
              expect(await burst(base, '192.0.2.41', 5)).deep.equals([
                401, 401, 401, 401, 429
              ])
              expect(await burst(other, '192.0.2.41', 5)).deep.equals([
                401, 401, 401, 401, 429
              ])
            },
            { ...config, redis: { url, prefix: prefix + '-other' } }
          )
          await c.sendCommand(['SCRIPT', 'FLUSH'])
          expect(await burst(base, '192.0.2.42', 1)).deep.equals([401])
          // Give one guest fixture debt long enough to outlast worker and store restarts.
          const key =
            ratePrefix(prefix, 'enforce') + 'guest:192.0.2.43:expensive'
          const debtMs = 300000 // Outlast even an instrumented run's 180-second deadline.
          await c.set(key, String(Date.now() + debtMs), { PX: debtMs })
          await c.sendCommand(['SAVE'])
          await c.close()
          await halt()
          const previous = await getWorkers(base, 'degraded')
          const local = await burst(base, '192.0.2.43', 16)
          expect(local.filter(s => s === 401)).has.length(8)
          expect(local.filter(s => s === 429)).has.length(8)
          const charged = await batches(base)
          expect(charged.filter(s => s === 404)).has.length(2)
          expect(charged.filter(s => s === 429)).has.length(2)
          // The verified PID belongs to a worker the fixture itself just forked.
          process.kill(previous[0], 'SIGTERM')
          const deadline = Date.now() + 35000
          let restarted = false
          while (!restarted && Date.now() < deadline) {
            const pids = await getWorkers(base, 'degraded', 1)
            restarted = !previous.includes(pids[0])
          }
          expect(restarted).equals(true)
          const afterRestart = await batches(base)
          expect(afterRestart.filter(s => s === 404)).has.length(1)
          expect(afterRestart.filter(s => s === 429)).has.length(3)
          await boot()
          await getWorkers(base, 'ready')
          expect(await burst(base, '192.0.2.43', 1)).deep.equals([429])
          c = await admin()
          try {
            await c.sendCommand(['ACL', 'SETUSER', 'default', '-evalsha'])
            await getWorkers(base, 'failed') // The HTTP health read itself uses admission.
            const restricted = await burst(base, '192.0.2.45', 16)
            expect(restricted.filter(s => s === 401)).has.length(8)
            expect(restricted.filter(s => s === 429)).has.length(8)
            await c.sendCommand(['ACL', 'SETUSER', 'default', '+evalsha'])
            await getWorkers(base, 'ready')
            expect(await burst(base, '192.0.2.45', 5)).deep.equals([
              401, 401, 401, 401, 429
            ])
            expect(said()).includes('shared enforcement is ready again')
          } finally {
            await c.close()
          }
        },
        config
      )
    } finally {
      if (child != null) await halt()
    }
  })

  it('shares API limits between workers, sessions, HTTP and the search socket', async function () {
    const prefix = pushTestPrefix()
    const userId = userIdOfGumbo(4851)
    const db = makeDatabase(scratchUrl)
    const client = createClient({ url: testRedisUrl })
    await client.connect()
    try {
      await insertFixtureUsers(db, {
        id: userId,
        legacyId: 'usr_budget_fixture',
        login_enabled: true,
        display_name: 'Demo Reader'
      })
      const a = await createSession(db, userId, undefined)
      const b = await createSession(db, userId, undefined)
      const code = await start(
        2,
        async base => {
          const call = async (ip: string, token?: string): Promise<Response> =>
            await fetch(base + '/api/v1/graphql', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-forwarded-for': ip,
                ...(token == null ? {} : { authorization: 'Bearer ' + token })
              },
              body: JSON.stringify({ query: '{ __typename }' })
            })
          const ip = '192.0.2.7'
          const guests = await Promise.all(
            Array.from({ length: 6 }, async () => await call(ip))
          )
          expect(guests.filter(r => r.status === 401)).has.length(4)
          const refused = guests.filter(r => r.status === 429)
          expect(refused).has.length(2)
          expect(await refused[0].json()).deep.includes({
            code: 'rateLimited',
            details: {
              retryAfterSec: Number(refused[0].headers.get('retry-after'))
            }
          })
          expect((await call(ip, 'expired-fixture')).status).equals(429)
          expect((await call('192.0.2.8')).status).equals(401)
          const accounts = await Promise.all(
            Array.from(
              { length: 8 },
              async (_, i) => await call(ip, i % 2 === 0 ? a.token : b.token)
            )
          )
          expect(accounts.map(r => r.status)).deep.equals(Array(8).fill(200))
          expect((await call('198.51.100.4', b.token)).status).equals(429)
          expect(
            (
              await fetch(base + '/api/v1/time', {
                headers: { authorization: 'Bearer ' + a.token }
              })
            ).status
          ).equals(200)

          // Only release this fixture's GraphQL allowance. The import has a
          // separate row budget, shared across team IDs and sessions.
          await client.del(
            ratePrefix(prefix, 'enforce') + 'account:' + userId + ':expensive'
          )
          const batch = async (team: string): Promise<Response> =>
            await fetch(base + '/api/v1/teams/' + team + '/games', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: 'Bearer ' + a.token,
                'x-forwarded-for': ip
              },
              body: JSON.stringify({ games: Array(200).fill({}) })
            })
          expect((await batch('missing-one')).status).equals(404)
          const nextBatch = await batch('missing-two')
          expect(nextBatch.status).equals(429)
          expect(Number(nextBatch.headers.get('retry-after'))).greaterThan(190)

          // Admission leads to the configured dictation handler's own authentication.
          const dictation = new WebSocket(
            base.replace(/^http/, 'ws') + '/api/v1/dictation'
          )
          const dictationStatus = await new Promise<number>(
            (resolve, reject) => {
              dictation.once('error', reject)
              dictation.once('open', () => {
                dictation.close()
                reject(
                  new Error('Expected the dictation route to require a session')
                )
              })
              dictation.once('unexpected-response', (_, res) => {
                res.resume()
                resolve(res.statusCode!)
              })
            }
          )
          expect(dictationStatus).equals(401)

          // A guest can still reach the scoreboard's own admission check.
          const board = new WebSocket(
            base.replace(/^http/, 'ws') + '/api/v1/scoreboard/missing/socket'
          )
          const boardClose = await new Promise<number>((resolve, reject) => {
            board.once('error', reject)
            board.once('close', resolve)
          })
          expect(boardClose).equals(SCOREBOARD_CLOSE.closed)

          const url = base.replace(/^http/, 'ws') + SEARCH_SOCKET_PATH
          const headers = {
            'x-forwarded-for': ip,
            authorization: 'Bearer ' + b.token
          }
          // A mistyped upgrade path closes without spending a signed operation.
          const aggregateKey =
            ratePrefix(prefix, 'enforce') + 'account:' + userId + ':aggregate'
          const before = await client.get(aggregateKey)
          const unknown = new WebSocket(
            base.replace(/^http/, 'ws') + '/unknown-protocol',
            { headers }
          )
          unknown.on('error', () => undefined)
          await new Promise<void>(resolve =>
            unknown.once('close', () => {
              resolve()
            })
          )
          expect(await client.get(aggregateKey)).equals(before)
          const ws = new WebSocket(url, { headers })
          try {
            await new Promise<void>((resolve, reject) => {
              ws.once('open', resolve)
              ws.once('error', reject)
            })
            // A frame uses the same account budget as an aggregate HTTP read.
            // Place that one fixture key at its burst limit on the shared clock.
            await client.set(
              ratePrefix(prefix, 'enforce') +
                'account:' +
                userId +
                ':aggregate',
              String(Date.now() + 48 * 400 + 5000),
              { PX: 30000 }
            )
            const closed = new Promise<number>(resolve =>
              ws.once('close', resolve)
            )
            ws.send(
              JSON.stringify({
                type: 'search',
                seq: 1,
                text: 'demo',
                location: null,
                mode: 'all'
              })
            )
            expect(await closed).equals(1013)
          } finally {
            ws.terminate()
          }

          // An exhausted arrival budget refuses an upgrade before reading credentials.
          await client.set(
            ratePrefix(prefix, 'enforce') + 'ip:' + ip,
            String(Date.now() + 20000),
            { PX: 30000 }
          )
          const status = await new Promise<number | undefined>(
            (resolve, reject) => {
              const denied = new WebSocket(url, { headers })
              denied.on('error', reject)
              denied.once('unexpected-response', (_, res) => {
                res.resume()
                resolve(res.statusCode)
                denied.terminate()
              })
            }
          )
          expect(status).equals(429)
        },
        {
          apiRateLimitMode: 'enforce',
          redis: { url: testRedisUrl, prefix },
          dictation: { apiKey: 'fixture-placeholder' }
        }
      )
      expect(code).equals(0)
    } finally {
      await client.close()
      await db.destroy()
    }
  })

  it('replays the same gated HTTP, upgrade and open-search trace across modes', async function () {
    const db = makeDatabase(scratchUrl)
    const client = createClient({ url: testRedisUrl })
    await client.connect()
    try {
      const userId = userIdOfGumbo(4861)
      await insertFixtureUsers(db, {
        id: userId,
        legacyId: 'usr_mode_fixture',
        login_enabled: true,
        display_name: 'Demo Reader'
      })
      const session = await createSession(db, userId, undefined)
      const email = 'budget-fixture@example.test'
      await db
        .insertInto('rate_events')
        .values(
          Array.from({ length: 10 }, (_, i) => ({
            id: 'rate-fixture-' + i,
            scope: 'passwordParameters.address',
            key: email
          }))
        )
        .execute()
      const prefix = pushTestPrefix()
      const ip = '192.0.2.40'
      const headers = {
        authorization: 'Bearer ' + session.token,
        'x-forwarded-for': ip,
        'content-type': 'application/json'
      }
      const reports = new Map<string, string[]>()
      for (const mode of ['off', 'observe', 'enforce'] as const) {
        const ns = ratePrefix(prefix, mode)
        const prefill = async (key: string): Promise<void> => {
          // The fixture's controlled debt gives both modes identical decisions
          // despite different process startup and dispatch times.
          if (mode !== 'off')
            await client.set(ns + key, String(Date.now() + 400000), {
              PX: 500000
            })
        }
        let output: () => string = () => ''
        const exit = await start(
          1,
          async (base, said) => {
            output = said
            const enforcing = mode === 'enforce'
            const arrival = 'ip:' + ip
            const account = 'account:' + userId
            const aggregate = account + ':aggregate'
            const rows = account + ':schedule-rows'
            const batch = async (): Promise<Response> =>
              await fetch(base + '/api/v1/teams/missing/games', {
                method: 'POST',
                headers,
                body: JSON.stringify({ games: [{}] })
              })
            const open = (): WebSocket =>
              new WebSocket(base.replace(/^http/, 'ws') + SEARCH_SOCKET_PATH, {
                headers
              })
            const frame = async (
              ws: WebSocket,
              seq: number
            ): Promise<string> => {
              const answer = new Promise<string>((resolve, reject) => {
                const closed = (code: number): void => {
                  ws.off('message', message)
                  resolve(String(code))
                }
                const message = (data: Buffer): void => {
                  ws.off('close', closed)
                  resolve(JSON.parse(data.toString()).type)
                }
                ws.once('close', closed)
                ws.once('message', message)
                ws.once('error', reject)
              })
              ws.send(
                JSON.stringify({
                  type: 'search',
                  seq,
                  text: '',
                  location: null,
                  mode: 'all'
                })
              )
              return await answer
            }
            await prefill(arrival)
            expect((await batch()).status).equals(enforcing ? 429 : 404)
            expect(await client.exists(ns + rows)).equals(0)
            const denied = open()
            try {
              const outcome = await new Promise<number>((resolve, reject) => {
                denied.once('error', reject)
                denied.once('open', () => {
                  resolve(101)
                })
                denied.once('unexpected-response', (_, res) => {
                  res.resume()
                  resolve(res.statusCode!)
                })
              })
              expect(outcome).equals(enforcing ? 429 : 101)
              await client.del(ns + arrival)
              if (!enforcing) expect(await frame(denied, 1)).equals('results')
              expect(await client.exists(ns + aggregate)).equals(0)
            } finally {
              denied.terminate()
            }
            await prefill(account + ':expensive')
            const query = await fetch(base + '/api/v1/graphql', {
              method: 'POST',
              headers,
              body: JSON.stringify({ query: '{ teams { id } }' })
            })
            expect(query.status).equals(enforcing ? 429 : 200)
            if (!enforcing)
              expect((await query.json()).data.teams).to.be.an('array')
            expect(await client.exists(ns + aggregate)).equals(0)
            expect((await batch()).status).equals(enforcing ? 429 : 404)
            expect(await client.exists(ns + rows)).equals(0)
            await client.del(ns + account + ':expensive')
            await prefill(rows)
            expect((await batch()).status).equals(enforcing ? 429 : 404)
            const ws = open()
            try {
              await new Promise<void>((resolve, reject) => {
                ws.once('open', resolve)
                ws.once('error', reject)
              })
              await prefill(aggregate)
              expect(await frame(ws, 1)).equals(enforcing ? '1013' : 'results')
              await client.del(ns + aggregate)
              if (!enforcing) expect(await frame(ws, 2)).equals('results')
              expect(await client.exists(ns + aggregate)).equals(0)
              expect(
                (await fetch(base + '/api/v1/me/roles', { headers })).status
              ).equals(200)
              expect(await client.exists(ns + aggregate)).equals(
                mode === 'off' ? 0 : 1
              )
            } finally {
              ws.terminate()
            }
            const login = await fetch(
              base + '/api/v1/auth/password/parameters',
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ email })
              }
            )
            expect(login.status).equals(429)
            if (mode === 'off')
              expect(await client.keys(ns + '*')).deep.equals([])
          },
          { apiRateLimitMode: mode, redis: { url: testRedisUrl, prefix } }
        )
        expect(exit).equals(0)
        const refusals = output()
          .split('\n')
          .filter(s => s.includes('api_rate_decisions '))
          .map(s => JSON.parse(s.split('api_rate_decisions ')[1]))
          .filter(s => s.decision === 'refused')
          .map(s => [s.tier, s.transport, s.scope, s.n].join('/'))
          .sort()
        reports.set(mode, refusals)
      }
      expect(reports.get('off')).deep.equals([])
      expect(reports.get('observe')).deep.equals(
        [
          'arrival/http/arrivalIp/1',
          'arrival/upgrade/arrivalIp/1',
          'expensive/http/account/2',
          'rows/http/account/1',
          'aggregate/search/account/1'
        ].sort()
      )
      expect(reports.get('enforce')).deep.equals(reports.get('observe'))
    } finally {
      await client.close()
      await db.destroy()
    }
  })

  it('registers production TV links implicitly and excludes companion-only origins', async function () {
    const code = await start(
      1,
      async base => {
        for (const [appOrigin, status] of [
          ['https://app.teamstation.app', 200],
          ['https://companion.example.test', 400]
        ] as const) {
          const response = await fetch(`${base}/api/v1/auth/tv/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: 'Apple TV', appOrigin })
          })
          const link = await new Promise<{ status: number; location?: string }>(
            (resolve, reject) => {
              httpGet(
                `${base}/tv-login?token=${'a'.repeat(43)}&server=https%3A%2F%2Fdevelop5.teamstation.app`,
                {
                  headers: { host: 'app.teamstation.app' }
                },
                response => {
                  response.resume()
                  resolve({
                    status: response.statusCode ?? 0,
                    location: response.headers.location
                  })
                }
              ).on('error', reject)
            }
          )
          expect(link.status).equals(302)
          expect(link.location).equals(
            `https://develop5.teamstation.app/account/tv?token=${'a'.repeat(43)}`
          )
          expect(response.status).equals(status)
          if (status === 200) {
            const login = await response.json()
            expect(new URL(login.qrUrl).origin).equals(appOrigin)
          }
        }
      },
      {
        appLinks: {
          knownServers: ['https://develop5.teamstation.app'],
          apps: [
            { origin: 'https://app.teamstation.app' },
            { origin: 'https://companion.example.test' }
          ]
        }
      }
    )
    expect(code).equals(0)
  })

  it('reads its push settings and answers the push routes', async function () {
    const code = await start(
      1,
      async base => {
        // Mounted, and for a signed-in session only.
        const key = await fetch(`${base}/api/v1/push/web-key`)
        expect(key.status).equals(401)
        const register = await fetch(`${base}/api/v1/me/push-registrations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'ios', address: '00ab'.repeat(16) })
        })
        expect(register.status).equals(401)
      },
      {
        push: {
          webPush,
          logFile: join(dir, 'push.jsonl')
        }
      }
    )
    expect(code).equals(0)
  })

  it('starts with a push key it cannot read, and leaves only that service off', async function () {
    const code = await start(
      1,
      async (base, said) => {
        const health = await fetch(`${base}/api/v1/health`)
        expect(health.status).equals(200)
        const key = await fetch(`${base}/api/v1/push/web-key`)
        expect(key.status).equals(401)
        // Said by the push sender, the one process that reads the keys.
        const deadline = Date.now() + 30000
        while (!said().includes('push sender: started')) {
          if (Date.now() > deadline) throw new Error('no push sender')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        expect(said()).match(/push: APNs is off, its key cannot be read: /)
        expect(said()).match(/push: FCM is off, its key cannot be read: /)
        expect(said()).not.match(/push: Web Push is off/)
      },
      {
        push: {
          apns: {
            keyId: 'KEY1234567',
            teamId: 'TEAM123456',
            p8Key: '-----BEGIN PRIVATE KEY-----\\nMIGTAgEAMBMG',
            topic: 'app.example.test'
          },
          fcm: {
            projectId: 'demo-project',
            clientEmail: 'push@demo-project.iam.example.test',
            privateKey: 'not a key'
          },
          webPush
        }
      }
    )
    expect(code).equals(0)
  })

  it('starts and serves with Valkey away, and the push queue says so', async function () {
    const code = await start(
      1,
      async (base, said) => {
        const health = await fetch(`${base}/api/v1/health`)
        expect(health.status).equals(200)
        const deadline = Date.now() + 30000
        while (!/push queue: .*ECONNREFUSED/.test(said())) {
          if (Date.now() > deadline) throw new Error(`nothing said: ${said()}`)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      },
      { redis: { url: 'redis://127.0.0.1:1', prefix: 'away' } }
    )
    expect(code).equals(0)
  })

  for (const workers of [1, 2]) {
    it(`serves the chat routes with ${workers === 1 ? 'one process' : 'a primary and two workers'}, and stops on SIGTERM`, async function () {
      const code = await start(workers, async (base, said) => {
        const health = await fetch(`${base}/api/v1/health`)
        expect(health.status).equals(200)
        const tv = await fetch(`${base}/api/v1/auth/tv/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'Apple TV' })
        })
        expect(tv.status).equals(200)
        const login = await tv.json()
        expect(new URL(login.qrUrl).origin).equals('https://tv.example.test')
        // Signed out, a chat route answers through the app as it is wired.
        const chats = await fetch(`${base}/api/v1/chat/conversations`)
        expect(chats.status).equals(401)
        const unknown = await fetch(`${base}/api/v1/no-such-route`)
        expect(unknown.status).equals(404)
        // The search socket takes its upgrade, signed out too.
        const frame = await searchSignedOut(base)
        expect(frame).include({ type: 'results', seq: 1 })
        // Each worker builds the place catalog's search indexes once it
        // listens, without waiting for a search.
        const deadline = Date.now() + 20000
        const ready = (): number =>
          (said().match(/: search places ready in \d+ ms/g) ?? []).length
        while (ready() < workers && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 50))
        expect(ready()).equals(workers)
      })
      expect(code).equals(0)
    })

    it(`downloads the IP database from ${workers === 1 ? 'the one process' : 'the primary alone'}, and keeps searching when it is unreadable`, async function () {
      const asked: string[] = []
      const standIn = createHttpServer((request, response) => {
        asked.push(request.url ?? '')
        response.end(gzipSync('not a database'))
      })
      await new Promise<void>(resolve => {
        standIn.listen(0, '127.0.0.1', resolve)
      })
      const address = standIn.address()
      const standInPort =
        typeof address === 'object' && address != null ? address.port : 0
      const ipDir = join(dir, `ip-places-${workers}`)
      try {
        const code = await start(
          workers,
          async (base, said) => {
            const deadline = Date.now() + 20000
            while (
              !said().includes('no database from') &&
              Date.now() < deadline
            )
              await new Promise(resolve => setTimeout(resolve, 50))
            expect(said().match(/IP places: no database from/g)).length(1)
            const now = new Date()
            const month = now.toISOString().slice(0, 7)
            const last = new Date(
              Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
            )
              .toISOString()
              .slice(0, 7)
            // Both broken: this month's, then last month's, and no more.
            expect(asked).deep.equals([
              `/dbip-city-lite-${month}.mmdb.gz`,
              `/dbip-city-lite-${last}.mmdb.gz`
            ])
            // Nothing unreadable is swapped in.
            expect(readdirSync(ipDir)).deep.equals([])
            expect(await searchSignedOut(base)).include({
              type: 'results',
              seq: 1
            })
          },
          {
            ipPlaces: {
              dir: ipDir,
              source: `http://127.0.0.1:${standInPort}/dbip-city-lite-{month}.mmdb.gz`
            }
          }
        )
        expect(code).equals(0)
      } finally {
        standIn.close()
      }
    })

    it(`runs background jobs only where the flag is on, with ${workers === 1 ? 'one process' : 'a primary and two workers'}`, async function () {
      const scratch = new Pool({ connectionString: scratchUrl })
      try {
        const marks = async (): Promise<number> => {
          const { rows } = await scratch.query<{ count: string }>(
            'select count(*) from chat_dirty'
          )
          return Number(rows[0].count)
        }
        const connected = async (role: string): Promise<number> => {
          const { rows } = await scratch.query<{ count: string }>(
            `select count(*) from pg_stat_activity
             where datname = $1 and application_name = $2`,
            [name, `teamstation-${role}`]
          )
          return Number(rows[0].count)
        }
        const builders = async (): Promise<number> =>
          await connected('statsBuilder')
        const senders = async (): Promise<number> =>
          await connected('pushSender')
        const waitFor = async (
          ready: () => Promise<boolean>
        ): Promise<void> => {
          const deadline = Date.now() + 30000
          while (!(await ready())) {
            if (Date.now() > deadline) throw new Error('it never happened')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }

        const reminded = async (): Promise<number> => {
          const { rows } = await scratch.query<{ count: string }>(
            'select count(*) from push_reminders_sent where event_id = $1',
            [eventId]
          )
          return Number(rows[0].count)
        }

        // Somebody who said yes to an event starting within the hour.
        const eventId = `tev_jobs_${workers}`
        await scratch.query(
          `insert into users (id, display_name) values ($1, 'Nolan Ryan')
             on conflict do nothing`,
          [member]
        )
        await scratch.query(
          `insert into teams (id, name) values ('tem_jobs', 'Hawks')
             on conflict do nothing`
        )
        await scratch.query(
          `insert into memberships (id, user_id, team_id)
             values ('mem_jobs', $1, 'tem_jobs') on conflict do nothing`,
          [member]
        )
        // Signed in on a phone with RSVPed events on.
        await scratch.query(
          `insert into auth_sessions (id, user_id, token_hash, expires_at)
             values ('ses_jobs', $1, 'hash_jobs', now() + interval '1 day')
             on conflict do nothing`,
          [member]
        )
        await scratch.query(
          `insert into push_registrations
             (id, user_id, session_id, platform, address_key, address, environment, rsvp_events)
             values ('psh_jobs', $1, 'ses_jobs', 'android', 'token-jobs', 'token-jobs', 'production', true)
             on conflict do nothing`,
          [member]
        )
        await scratch.query(
          `insert into team_events (id, team_id, title, start_at)
             values ($1, 'tem_jobs', 'Batting cage', now() + interval '1 hour')`,
          [eventId]
        )
        await scratch.query(
          `insert into team_event_rsvps (event_id, user_id, response)
             values ($1, $2, 'yes')`,
          [eventId, member]
        )
        // A mark left for whoever drains on start, and only that one: the
        // rows above mark their team too.
        await scratch.query('delete from chat_dirty')
        await scratch.query(
          "insert into chat_dirty (scope_type, scope_id) values ('team', 'tm_jobs')"
        )
        const off = await start(
          workers,
          async base => {
            const health = await fetch(`${base}/api/v1/health`)
            expect(health.status).equals(200)
            await new Promise(resolve => setTimeout(resolve, 2000))
            expect(await marks()).equals(1)
            expect(await builders()).equals(0)
            expect(await senders()).equals(0)
            expect(await reminded()).equals(0)
          },
          { backgroundJobs: false, statsBuilder: true }
        )
        expect(off).equals(0)

        let stopped = (): string => ''
        const on = await start(
          workers,
          async (_base, said) => {
            await waitFor(async () => (await marks()) === 0)
            await waitFor(async () => (await builders()) > 0)
            // The primary queues the event's start; its push sender, forked
            // and supervised, reminds of it.
            await waitFor(async () =>
              said().includes(
                `push sender: sent 1 RSVP reminder(s) for teamEvent ${eventId}`
              )
            )
            expect(await senders()).greaterThan(0)
            expect(await reminded()).equals(1)
            stopped = said
          },
          // Its transport: the push log, as a seat without keys has. With
          // none for the phone, the reminder would be given back unsent.
          { statsBuilder: true, push: { logFile: join(dir, 'jobs.jsonl') } }
        )
        expect(on).equals(0)
        // Stopped with the server, its connections gone with it.
        expect(stopped()).match(/push sender: stopped on SIGTERM/)
        expect(await senders()).equals(0)
      } finally {
        await scratch.end()
      }
    })
  }
})
