import { type AddressInfo, createServer, type Socket } from 'node:net'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { serverConfig } from '../serverConfig'
import {
  type DatabaseRole,
  isPoolTimeout,
  makeDatabase,
  makePool,
  poolSettings,
  starvationCheck
} from './database'

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
  const sizes = { worker: 9, primary: 8, statsBuilder: 7, ingest: 6 }
  const roles: DatabaseRole[] = ['worker', 'primary', 'statsBuilder', 'ingest']

  it('takes its size from its role', () => {
    for (const role of roles)
      expect(poolSettings(role, sizes)).deep.equals({
        max: sizes[role],
        application_name: `teamstation-${role}`,
        connectionTimeoutMillis: 5000
      })
  })

  it('reads the configured sizes', () => {
    for (const role of roles) {
      const pool = makePool(testDatabaseUrl, undefined, { role })
      expect(pool.options.max).to.equal(serverConfig.databasePoolSizes[role])
      expect(pool.options.connectionTimeoutMillis).to.equal(5000)
      pool.end().catch(() => undefined)
    }
  })

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
})

describe('isPoolTimeout', () => {
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
    expect(isPoolTimeout(await failureOf(pool.query('select 1')))).equals(true)
    held.release()
    await pool.end()
  })

  it('knows a connection that could not open in time', async () => {
    // Accepts the connection and never answers it.
    const sockets: Socket[] = []
    const silent = createServer(socket => sockets.push(socket))
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const { port } = silent.address() as AddressInfo
    const pool = new Pool({
      connectionString: `postgres://127.0.0.1:${port}/none`,
      connectionTimeoutMillis: 50
    })
    expect(isPoolTimeout(await failureOf(pool.query('select 1')))).equals(true)
    await pool.end()
    for (const socket of sockets) socket.destroy()
    silent.close()
  })

  it('knows nothing else', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl })
    expect(
      isPoolTimeout(await failureOf(pool.query('select from no_such_table')))
    ).equals(false)
    await pool.end()
    expect(isPoolTimeout('timeout exceeded when trying to connect')).equals(
      false
    )
    expect(isPoolTimeout(undefined)).equals(false)
  })
})

describe('starvationCheck', () => {
  const fixture = (): {
    pool: { totalCount: number; idleCount: number; waitingCount: number }
    logged: string[]
    reported: string[]
    clock: { at: number }
    check: () => void
  } => {
    const pool = { totalCount: 10, idleCount: 0, waitingCount: 0 }
    const logged: string[] = []
    const reported: string[] = []
    const clock = { at: 1000 }
    const check = starvationCheck(
      pool,
      'worker',
      message => logged.push(message),
      message => reported.push(message),
      () => clock.at
    )
    return { pool, logged, reported, clock, check }
  }

  it('says nothing while nothing waits', () => {
    const f = fixture()
    f.check()
    f.clock.at += 600_000
    f.check()
    expect(f.logged).deep.equals([])
    expect(f.reported).deep.equals([])
  })

  it('logs the counts and the role when something waits', () => {
    const f = fixture()
    f.pool.waitingCount = 4
    f.check()
    expect(f.logged).deep.equals([
      'database: worker pool starved: total 10, idle 0, waiting 4'
    ])
    expect(f.reported).deep.equals(['database: worker pool starved'])
  })

  it('logs every 30 seconds and reports every 5 minutes', () => {
    const f = fixture()
    f.pool.waitingCount = 1
    f.check()
    f.clock.at += 29_999
    f.check()
    expect(f.logged).to.have.length(1)
    f.clock.at += 1
    f.check()
    expect(f.logged).to.have.length(2)
    expect(f.reported).to.have.length(1)
    f.clock.at += 270_000
    f.check()
    expect(f.reported).to.have.length(2)
  })
})

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
