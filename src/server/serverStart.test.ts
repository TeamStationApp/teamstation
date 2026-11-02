import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { dropScratchDatabase, testDatabaseUrl } from '../migrate/testDatabase'

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

describe('the server process', function () {
  this.timeout(120000)
  const name = `teamstation_server_start_${Date.now()}_${process.pid}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
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
    run: (base: string) => Promise<void>
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
        appLinks: {
          apps: [{ origin: 'https://tv.example.test', tvLogin: true }]
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
          : {})
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
      await run(`http://127.0.0.1:${port}`)
    } finally {
      server.kill('SIGTERM')
    }
    return await exited
  }

  for (const workers of [1, 2]) {
    it(`serves the chat routes with ${workers === 1 ? 'one process' : 'a primary and two workers'}, and stops on SIGTERM`, async function () {
      const code = await start(workers, async base => {
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
      })
      expect(code).equals(0)
    })
  }
})
