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
    run: (base: string) => Promise<void>,
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
        // Signed out, a chat route answers through the app as it is wired.
        const chats = await fetch(`${base}/api/v1/chat/conversations`)
        expect(chats.status).equals(401)
        const unknown = await fetch(`${base}/api/v1/no-such-route`)
        expect(unknown.status).equals(404)
      })
      expect(code).equals(0)
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
        const builders = async (): Promise<number> => {
          const { rows } = await scratch.query<{ count: string }>(
            `select count(*) from pg_stat_activity
             where datname = $1 and application_name = 'teamstation-statsBuilder'`,
            [name]
          )
          return Number(rows[0].count)
        }
        const waitFor = async (
          ready: () => Promise<boolean>
        ): Promise<void> => {
          const deadline = Date.now() + 30000
          while (!(await ready())) {
            if (Date.now() > deadline) throw new Error('it never happened')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }

        // A mark left for whoever drains on start.
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
          },
          { backgroundJobs: false, statsBuilder: true }
        )
        expect(off).equals(0)

        const on = await start(
          workers,
          async () => {
            await waitFor(async () => (await marks()) === 0)
            await waitFor(async () => (await builders()) > 0)
          },
          { statsBuilder: true }
        )
        expect(on).equals(0)
      } finally {
        await scratch.end()
      }
    })
  }
})
