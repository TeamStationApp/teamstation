import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { serverConfig } from '../serverConfig'
import { runCheckoutsAs } from './checkouts'
import { isConnectionUnavailable, makeDatabase, makePool } from './database'

describe('the database pool', () => {
  let admin: Pool

  before(() => {
    admin = new Pool({ connectionString: testDatabaseUrl })
  })

  after(async () => {
    await admin.end()
  })

  it('hears an idle connection lost to a restart instead of crashing', async () => {
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message))
    const client = await pool.connect()
    const { rows } = await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )
    client.release()
    expect(pool.idleCount).to.equal(1)

    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])
    await waitFor(() => pool.totalCount === 0)

    expect(logged).to.have.length(1)
    expect(logged[0]).to.match(/^database: connection lost: /)
    const again = await pool.query<{ one: number }>('select 1 as one')
    expect(again.rows[0].one).to.equal(1)
    await pool.end()
  })

  it('hears a checked-out connection lost mid-query: the query rejects and the process stays up', async () => {
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message))
    const client = await pool.connect()
    const { rows } = await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )
    // Unheard, the 'error' this connection raises below would be thrown out of
    // the socket's event handler, and mocha would fail the run as uncaught.
    const running = client.query('select pg_sleep(30)')
    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])

    let failure: unknown
    try {
      await running
    } catch (error) {
      failure = error
    }
    expect(String(failure)).to.match(/terminat/)
    await waitFor(() => logged.length > 0)
    expect(logged[0]).to.match(/^database: connection lost: /)

    client.release()
    expect(pool.totalCount).to.equal(0)
    const again = await pool.query<{ one: number }>('select 1 as one')
    expect(again.rows[0].one).to.equal(1)
    await pool.end()
  })
})

describe('a pool with no role', () => {
  it('is what a pool has always been: ten connections and no timeout', async () => {
    const pool = makePool(testDatabaseUrl)
    expect(pool.options.max).to.equal(10)
    expect(pool.options.connectionTimeoutMillis).to.equal(undefined)
    expect(pool.options.application_name).to.equal(undefined)
    const { rows } = await pool.query<{ name: string }>(
      `select current_setting('application_name') as name`
    )
    expect(rows[0].name).to.equal('')
    await pool.end()
  })
})

describe('a pool with a role', () => {
  it('names itself to the database', async () => {
    const db = makeDatabase(testDatabaseUrl, { role: 'ingest' })
    const { rows } = await sql<{
      name: string
    }>`select current_setting('application_name') as name`.execute(db)
    expect(rows[0].name).to.equal('teamstation-ingest')
    await db.destroy()
  })

  it('stops looking for waiters once it has ended', async function () {
    this.timeout(5000)
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message), {
      role: 'worker'
    })
    await pool.end()
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(logged).deep.equals([])
  })

  it('reports waiters it finds while running', async function () {
    this.timeout(5000)
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message), {
      role: 'primary'
    })
    const held = await Promise.all(
      Array.from({ length: pool.options.max ?? 0 }, async () => {
        return await pool.connect()
      })
    )
    const waiting = pool.connect()
    await waitFor(() => logged.length > 0)
    expect(logged[0]).to.match(/^database: primary pool starved: total \d+/)
    for (const client of held) client.release()
    ;(await waiting).release()
    await pool.end()
  })

  it('says whose checkout held its client too long', async function () {
    this.timeout(8000)
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message), {
      role: 'worker'
    })
    const client = await runCheckoutsAs('GET /held', async () => {
      return await pool.connect()
    })
    await new Promise(resolve => setTimeout(resolve, 2100))
    client.release()
    await waitFor(() => logged.some(line => line.startsWith('db-checkout ')))
    const line = logged.find(line => line.startsWith('db-checkout '))!
    expect(
      JSON.parse(line.slice('db-checkout '.length)).longHolds[0]
    ).deep.include({ route: 'GET /held', n: 1 })
    await pool.end()
  })
})

describe('isConnectionUnavailable', () => {
  const failureOf = async (attempt: Promise<unknown>): Promise<unknown> => {
    try {
      await attempt
    } catch (error) {
      return error
    }
    throw new Error('it should have failed')
  }

  it('knows a pool with nothing free past the timeout', async () => {
    const pool = new Pool({
      connectionString: testDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 50
    })
    const held = await pool.connect()
    expect(
      isConnectionUnavailable(await failureOf(pool.query('select 1')))
    ).equals(true)
    held.release()
    await pool.end()
  })

  it('knows a connection the server ended, as it does in a restart', async () => {
    const victim = new Client({ connectionString: testDatabaseUrl })
    victim.on('error', () => undefined)
    await victim.connect()
    const { rows } = await victim.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )
    const failing = failureOf(victim.query('select pg_sleep(10)'))
    const admin = new Client({ connectionString: testDatabaseUrl })
    await admin.connect()
    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])
    await admin.end()
    expect(isConnectionUnavailable(await failing)).equals(true)
    await victim.end().catch(() => undefined)
  })

  it('knows nothing else', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl })
    expect(
      isConnectionUnavailable(
        await failureOf(pool.query('select from no_such_table'))
      )
    ).equals(false)
    await pool.end()
    expect(
      isConnectionUnavailable('timeout exceeded when trying to connect')
    ).equals(false)
    expect(isConnectionUnavailable(undefined)).equals(false)
  })
})

describe('a pool that logs its wait', () => {
  /** A clock that counts its readings and moves only when told. */
  const counted = (): { at: number; reads: number; now: () => number } => {
    const clock = {
      at: 0,
      reads: 0,
      now: () => {
        clock.reads += 1
        return clock.at
      }
    }
    return clock
  }
  const waitLines = (logged: string[]): string[] =>
    logged.filter(message => message.startsWith('db-wait '))

  it('times nothing and logs nothing with logDatabaseWait off', async function () {
    this.timeout(5000)
    expect(serverConfig.logDatabaseWait).equals(false)
    for (const logWait of [false, undefined]) {
      const logged: string[] = []
      const clock = counted()
      const pool = makePool(testDatabaseUrl, message => logged.push(message), {
        role: 'worker',
        logWait,
        now: clock.now
      })
      // Its statements are still timed for the checkout watch, on a clock of
      // its own; the wait log's is never read.
      const client = await pool.connect()
      await client.query('select 1')
      client.release()
      await pool.query('select 1')
      clock.at += 60_000
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect(clock.reads).equals(0)
      expect(waitLines(logged)).deep.equals([])
      await pool.end()
    }
  })

  it('logs no wait for a pool with no role', async () => {
    const logged: string[] = []
    const clock = counted()
    const pool = makePool(testDatabaseUrl, message => logged.push(message), {
      logWait: true,
      now: clock.now
    })
    await pool.query('select 1')
    expect(clock.reads).equals(0)
    await pool.end()
  })

  it('times only the first statement of each checkout, and logs them once a minute', async function () {
    this.timeout(8000)
    const logged: string[] = []
    const clock = counted()
    const pool = makePool(testDatabaseUrl, message => logged.push(message), {
      role: 'worker',
      logWait: true,
      now: clock.now
    })
    const db = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool })
    })
    // One checkout of four statements: begin, two selects, commit.
    await db.transaction().execute(async trx => {
      await sql`select 1`.execute(trx)
      await sql`select 2`.execute(trx)
    })
    // One of three, by hand, and two of one, through the pool's own query.
    const client = await pool.connect()
    for (const n of [1, 2, 3]) await client.query(`select ${n}`)
    client.release()
    await pool.query('select 1')
    await new Promise<void>((resolve, reject) => {
      pool.query('select 2', error => {
        if (error == null) resolve()
        else reject(error)
      })
    })
    expect(waitLines(logged)).deep.equals([])
    clock.at += 60_000
    await waitFor(() => waitLines(logged).length > 0)
    expect(waitLines(logged)).deep.equals([
      'db-wait {"role":"worker","n":4,"p50":0,"p95":0,"max":0}'
    ])
    await db.destroy()
  })
})

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Needs a PgBouncer on the machine, and skips without one. */
describe('isConnectionUnavailable against a real PgBouncer', function () {
  this.timeout(30000)
  const wait = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  let dir: string
  let bouncer: ChildProcess | undefined
  let url: string

  before(async function () {
    const found = spawnSync('pgbouncer', ['--version'], { stdio: 'ignore' })
    if (found.status !== 0) {
      this.skip()
      return
    }
    const target = new URL(testDatabaseUrl)
    const port = await freePort()
    dir = mkdtempSync(join(tmpdir(), 'poolerRefusals-'))
    const config = join(dir, 'pgbouncer.ini')
    const user = target.username === '' ? userInfo().username : target.username
    writeFileSync(
      config,
      `[databases]
* = host=${target.hostname === 'localhost' ? '127.0.0.1' : target.hostname} port=${target.port} user=${user}
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${port}
unix_socket_dir =
pool_mode = transaction
auth_type = any
default_pool_size = 1
max_client_conn = 3
query_wait_timeout = 1
logfile = ${join(dir, 'pgbouncer.log')}
ignore_startup_parameters = extra_float_digits,options
`
    )
    bouncer = spawn('pgbouncer', [config], { stdio: 'ignore' })
    url = `postgres://${user}@127.0.0.1:${port}/postgres`
    const deadline = Date.now() + 5000
    for (;;) {
      const client = new Client({ connectionString: url })
      const up = await client.connect().then(
        () => true,
        () => false
      )
      await client.end().catch(() => undefined)
      if (up) break
      if (Date.now() > deadline) throw new Error('PgBouncer never answered')
      await wait(50)
    }
  })

  after(async function () {
    bouncer?.kill()
    if (dir != null) rmSync(dir, { recursive: true, force: true })
  })

  const failure = async (attempt: Promise<unknown>): Promise<Error> =>
    await attempt.then(
      () => {
        throw new Error('it should have failed')
      },
      (error: unknown) => error as Error
    )

  it('knows a query that waited too long for a server connection, past the pool’s own limit', async () => {
    const pool = new Pool({
      connectionString: url,
      max: 3,
      connectionTimeoutMillis: 5000
    })
    pool.on('error', () => undefined)
    const holding = pool.query('select pg_sleep(2)')
    await wait(100)
    const error = await failure(pool.query('select 1'))
    expect(error.message).equals('query_wait_timeout')
    expect(isConnectionUnavailable(error)).equals(true)
    await holding.catch(() => undefined)
    await pool.end()
  })

  it('knows a client it has no room for', async () => {
    const clients = Array.from(
      { length: 3 },
      () => new Client({ connectionString: url })
    )
    for (const client of clients) {
      client.on('error', () => undefined)
      await client.connect()
    }
    const extra = new Client({ connectionString: url })
    extra.on('error', () => undefined)
    const error = await failure(extra.connect())
    expect(error.message).equals(
      'no more connections allowed (max_client_conn)'
    )
    expect(isConnectionUnavailable(error)).equals(true)
    await extra.end().catch(() => undefined)
    for (const client of clients) await client.end()
  })

  it('knows the pooler dying under a query, the query after it, and the client left behind', async () => {
    const pool = new Pool({ connectionString: url, max: 2 })
    pool.on('error', () => undefined)
    const held = await pool.connect()
    held.on('error', () => undefined)
    const inFlight = failure(pool.query('select pg_sleep(10)'))
    await wait(100)
    bouncer?.kill('SIGKILL')
    const dropped = await inFlight
    expect(dropped.message).equals('Connection terminated unexpectedly')
    expect(isConnectionUnavailable(dropped)).equals(true)
    await wait(50)
    const left = await failure(held.query('select 1'))
    expect(left.message).equals(
      'Client has encountered a connection error and is not queryable'
    )
    expect(isConnectionUnavailable(left)).equals(true)
    held.release(true)
    const refused = await failure(pool.query('select 1'))
    expect((refused as Error & { code?: string }).code).equals('ECONNREFUSED')
    expect(isConnectionUnavailable(refused)).equals(true)
    await pool.end()
  })
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise(resolve => probe.close(resolve))
  return port
}
