import { type AddressInfo, createServer, type Socket } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { serverConfig } from '../serverConfig'
import {
  type DatabaseRole,
  isConnectionUnavailable,
  isDatabaseOutOfReach,
  makePool,
  poolSettings,
  starvationCheck,
  waitLog
} from './database'

describe('a pool with a role', () => {
  const sizes = {
    worker: 9,
    primary: 8,
    statsBuilder: 7,
    ingest: 6,
    pushSender: 5
  }
  const roles: DatabaseRole[] = [
    'worker',
    'primary',
    'statsBuilder',
    'ingest',
    'pushSender'
  ]

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
    expect(
      isConnectionUnavailable(await failureOf(pool.query('select 1')))
    ).equals(true)
    await pool.end()
    for (const socket of sockets) socket.destroy()
    silent.close()
  })

  it('knows what PgBouncer says when it gives up or has no room', () => {
    for (const message of [
      'query_wait_timeout',
      'client_login_timeout',
      'client_login_timeout (server down)',
      'no more connections allowed (max_client_conn)',
      'no more connections allowed (max_user_connections)',
      'server login has been failing, cached error: connect failed (server_login_retry)',
      'pgbouncer cannot connect to server',
      'server conn crashed?',
      'pooler is shutting down'
    ])
      expect(isConnectionUnavailable(new Error(message))).equals(true, message)
    for (const message of [
      'query_timeout',
      'too many clients already',
      'server login failed: wrong password type'
    ])
      expect(isConnectionUnavailable(new Error(message))).equals(false, message)
  })

  it('knows a connection that dropped', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'Client has encountered a connection error and is not queryable'
    ])
      expect(isConnectionUnavailable(new Error(message))).equals(true, message)
  })

  const coded = (code: string): Error =>
    Object.assign(new Error('whatever it says'), { code })

  it('knows a server that is full or stopping or starting, by SQLSTATE', () => {
    for (const code of ['53300', '57P01', '57P02', '57P03'])
      expect(isConnectionUnavailable(coded(code))).equals(true, code)
  })

  it('knows a socket whose other end is down or gone', () => {
    for (const code of [
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ETIMEDOUT'
    ])
      expect(isConnectionUnavailable(coded(code))).equals(true, code)
  })

  it('tells a database out of reach from connections that are short', () => {
    for (const code of [
      '57P01',
      '57P02',
      '57P03',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ETIMEDOUT'
    ])
      expect(isDatabaseOutOfReach(coded(code))).equals(true, code)
    for (const message of [
      'server login has been failing, cached error: connect failed (server_login_retry)',
      'pgbouncer cannot connect to server',
      'server conn crashed?',
      'pooler is shutting down'
    ])
      expect(isDatabaseOutOfReach(new Error(message))).equals(true, message)
    expect(isDatabaseOutOfReach(coded('53300'))).equals(false)
    expect(isDatabaseOutOfReach(coded('42P01'))).equals(false)
    expect(isDatabaseOutOfReach('ECONNREFUSED')).equals(false)
    for (const message of [
      'timeout exceeded when trying to connect',
      'Connection terminated unexpectedly',
      'query_wait_timeout',
      'no more connections allowed (max_client_conn)'
    ])
      expect(isDatabaseOutOfReach(new Error(message))).equals(false, message)
  })

  it('leaves as faults what asking again would not mend', () => {
    for (const code of [
      '42P01', // no such table
      '57014', // cancelled by a statement timeout
      '53100', // the disk is full
      '53200', // out of memory
      '28P01', // a wrong password
      '3D000', // no such database
      '08P01', // a protocol violation, when no pooler's words go with it
      'ENOTFOUND',
      'EACCES'
    ])
      expect(isConnectionUnavailable(coded(code))).equals(false, code)
    for (const message of [
      // What `pg` says to a query left behind by this process's own `end()`.
      'Connection terminated',
      'Client was closed and is not queryable',
      'Cannot use a pool after calling end on the pool'
    ])
      expect(isConnectionUnavailable(new Error(message))).equals(false, message)
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

describe('waitLog', () => {
  const fixture = (): {
    logged: string[]
    clock: { at: number }
    log: ReturnType<typeof waitLog>
    wait: (ms: number) => void
  } => {
    const logged: string[] = []
    const clock = { at: 5000 }
    const log = waitLog(
      'worker',
      message => logged.push(message),
      () => clock.at
    )
    const wait = (ms: number): void => {
      const done = log.time()
      clock.at += ms
      done()
    }
    return { logged, clock, log, wait }
  }
  const line = (logged: string): unknown =>
    JSON.parse(logged.replace(/^db-wait /, ''))

  it('writes one line a minute, from the clock, of the waits since the last', () => {
    const f = fixture()
    for (const ms of [3, 1, 2, 10, 0.25, 4, 5, 6, 7, 8, 9.04, 2.5]) f.wait(ms)
    f.log.check()
    expect(f.logged).deep.equals([])
    f.clock.at = 5000 + 59_999
    f.log.check()
    expect(f.logged).deep.equals([])
    f.clock.at = 5000 + 60_000
    f.log.check()
    f.log.check()
    expect(f.logged).to.have.length(1)
    expect(f.logged[0]).to.match(/^db-wait \{"role":"worker","n":12,/)
    expect(line(f.logged[0])).deep.equals({
      role: 'worker',
      n: 12,
      p50: 4,
      p95: 10,
      max: 10
    })
    f.wait(1.26)
    f.clock.at += 60_000
    f.log.check()
    expect(line(f.logged[1])).deep.equals({
      role: 'worker',
      n: 1,
      p50: 1.3,
      p95: 1.3,
      max: 1.3
    })
  })

  it('still writes its line in a minute with nothing asked', () => {
    const f = fixture()
    f.clock.at += 60_000
    f.log.check()
    expect(f.logged).deep.equals([
      'db-wait {"role":"worker","n":0,"p50":0,"p95":0,"max":0}'
    ])
  })

  it('reads the clock of the process when given none', () => {
    const logged: string[] = []
    const log = waitLog('primary', message => logged.push(message))
    log.time()()
    log.check()
    expect(logged).deep.equals([])
  })
})
