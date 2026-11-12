import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool, type PoolClient } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { runCheckoutsAs, watchCheckouts } from './checkouts'

/** The pool's `db-checkout` lines, read back. */
function linesOf(logged: string[]): Array<Record<string, unknown>> {
  return logged
    .filter(line => line.startsWith('db-checkout '))
    .map(line => JSON.parse(line.slice('db-checkout '.length)))
}

async function waitFor(done: () => boolean): Promise<void> {
  const until = Date.now() + 5000
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('watching a pool’s checkouts', () => {
  let pool: Pool
  let logged: string[]
  let clock: number
  let watch: { check: () => void; stop: () => void }

  const memory = (): { rss: number; heapUsed: number } => ({
    rss: 3 * 1048576 * 1024,
    heapUsed: 1048576 * 1024
  })
  const loopDelay = {
    percentile: () => 250e6,
    max: 900e6,
    reset() {}
  }

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 1 })
    logged = []
    clock = 0
    watch = watchCheckouts(pool, 'worker', message => logged.push(message), {
      now: () => clock,
      queueAt: 1,
      memory,
      loopDelay
    })
  })

  after(async () => {
    watch.stop()
    await pool.end()
  })

  it('says nothing while nothing waited or held a client long', async () => {
    await runCheckoutsAs('GET /quick', async () => {
      await pool.query('select 1')
    })
    watch.check()
    expect(logged).deep.equals([])
  })

  it('names who waited, who held the client, and how much of the hold was idle', async () => {
    const secret = 'a value nobody may log'
    const holder: PoolClient = await runCheckoutsAs(
      'POST /games/:gameId/thing',
      async () => await pool.connect()
    )
    clock = 100
    await holder.query('select $1::text', [secret])
    // A second checkout waits for the only client.
    const waiting = runCheckoutsAs(
      'GET /videos/:videoId/wall-timeline',
      async () => await pool.query('select 2')
    )
    await waitFor(() => pool.waitingCount === 1)

    // While it waits, the client held is listed: idle, and for how long.
    clock = 3100
    watch.check()
    const [held] = linesOf(logged)
    expect(held).deep.include({
      role: 'worker',
      total: 1,
      idle: 0,
      waiting: 1,
      rssMb: 3072,
      heapMb: 1024,
      loopDelayMs: { p99: 250, max: 900 }
    })
    expect(held.held).deep.equals([
      {
        route: 'POST /games/:gameId/thing',
        ms: 3100,
        queryMs: 0,
        inQuery: false
      }
    ])

    // The hold ends; the waiter gets the client and is a slow wait.
    clock = 4100
    holder.release()
    await waiting
    clock = 20_000
    watch.check()
    const [, after] = linesOf(logged)
    expect(after.slowWaits).deep.equals([
      { route: 'GET /videos/:videoId/wall-timeline', n: 1, maxMs: 4000 }
    ])
    expect(after.timedOut).to.equal(0)
    expect(after.longHolds).deep.equals([
      { route: 'POST /games/:gameId/thing', n: 1, maxMs: 4100, maxIdleMs: 4100 }
    ])
    expect(after.held).to.equal(undefined)
    expect(logged.join('\n')).not.to.include(secret)
  })

  it('writes at most one line in each interval, and says so of work nobody named', async () => {
    logged.length = 0
    clock = 100_000
    const holder = await pool.connect()
    clock = 103_000
    holder.release()
    watch.check()
    clock = 104_000
    const second = await pool.connect()
    clock = 107_000
    second.release()
    watch.check()
    const lines = linesOf(logged)
    expect(lines).to.have.length(1)
    expect(lines[0].longHolds).deep.equals([
      { route: 'unattributed', n: 1, maxMs: 3000, maxIdleMs: 3000 }
    ])
    // The second hold is kept for the next line.
    clock = 113_000
    watch.check()
    expect(linesOf(logged)[1].longHolds).deep.equals([
      { route: 'unattributed', n: 1, maxMs: 3000, maxIdleMs: 3000 }
    ])
  })

  it('tells a client held by a running statement from one held idle, and counts waits given up', async () => {
    logged.length = 0
    clock = 200_000
    const short = new Pool({
      connectionString: testDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 50
    })
    const shortLogged: string[] = []
    const shortWatch = watchCheckouts(
      short,
      'worker',
      message => shortLogged.push(message),
      { now: () => clock, queueAt: 1, memory, loopDelay: null }
    )
    try {
      const running = runCheckoutsAs('GET /slow', async () => {
        await short.query('select pg_sleep(0.5) as slow_checkout')
      })
      // Running, as the server sees it, before anybody else asks.
      for (let running = false; !running;) {
        const { rows } = await pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where state = 'active' and query like '%as slow_checkout'"
        )
        running = rows[0].n > 0
      }
      const gaveUp = runCheckoutsAs('GET /impatient', async () => {
        await short.query('select 1')
      }).then(
        () => 'answered',
        (error: unknown) => String(error)
      )
      await waitFor(() => short.waitingCount === 1)
      clock = 201_500
      shortWatch.check()
      const [held] = linesOf(shortLogged)
      expect(held.loopDelayMs).to.equal(undefined)
      expect(held.held).to.have.length(1)
      expect(held.held).deep.include.members([
        { route: 'GET /slow', ms: 1500, queryMs: 1500, inQuery: true }
      ])
      expect(await gaveUp).to.match(/timeout exceeded/)
      await running
      clock = 215_000
      shortWatch.check()
      const [, later] = linesOf(shortLogged)
      expect(later.timedOut).to.equal(1)
      // A wait given up is slow whatever it lasted: it found no client.
      const [slow] = later.slowWaits as Array<Record<string, unknown>>
      expect(later.slowWaits).to.have.length(1)
      expect(slow).deep.include({ route: 'GET /impatient', n: 1 })
    } finally {
      shortWatch.stop()
      await short.end()
    }
  })
})
