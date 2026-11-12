import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import type { Pool, PoolClient } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { makePool } from '../db/database'
import { checkoutOwners } from './checkoutOwners'
import { errorHandler, withAsync } from './withErrors'

async function waitFor(done: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('a request whose caller has gone', function () {
  this.timeout(15_000)
  let pool: Pool
  let db: Kysely<unknown>
  let server: ReturnType<express.Express['listen']>
  let base = ''
  /** Statements each route got as far as running. */
  const ran = { read: 0, write: 0 }
  const logged: string[] = []
  /** What stopped the reads of a route short. */
  const stopped: string[] = []

  before(async () => {
    pool = makePool(testDatabaseUrl, message => logged.push(message))
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    const app = express()
    app.use(checkoutOwners)
    // Three reads one after another, as a route that checks access, reads its
    // row and then its detail does.
    app.get(
      '/read',
      withAsync(async (req, res) => {
        try {
          for (let i = 0; i < 3; i++) {
            await sql`select 1`.execute(db)
            ran.read++
          }
        } catch (error) {
          stopped.push(String(error))
          throw error
        }
        res.json({ ok: true })
      })
    )
    app.post(
      '/write',
      withAsync(async (req, res) => {
        await sql`select 1`.execute(db)
        ran.write++
        res.json({ ok: true })
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
    await db.destroy()
  })

  /** Every client of the pool, held until let go. */
  const holdEveryClient = async (): Promise<PoolClient[]> =>
    await Promise.all(
      Array.from(
        { length: pool.options.max ?? 0 },
        async () => await pool.connect()
      )
    )

  /** A request sent, then given up on once it is waiting for a client. */
  const abandon = async (
    path: string,
    init: RequestInit = {}
  ): Promise<void> => {
    const caller = new AbortController()
    const sent = fetch(`${base}${path}`, {
      ...init,
      signal: caller.signal
    }).catch(() => undefined)
    await waitFor(() => pool.waitingCount === 1)
    caller.abort()
    await sent
  }

  it('stops waiting for a client, and reads nothing more, once its GET is given up', async () => {
    const held = await holdEveryClient()
    try {
      await abandon('/read')
      // It stops waiting as soon as the server hears the caller went, rather
      // than when a client comes free or the wait times out.
      await waitFor(() => stopped.length === 1, 1000)
      expect(stopped[0]).to.match(/RequestAbandoned/)
    } finally {
      for (const client of held) client.release()
    }
    // The client it would have had goes straight back, with nothing run.
    await waitFor(() => pool.waitingCount === 0 && pool.idleCount === 10)
    await pause(300)
    expect(ran.read).to.equal(0)
    // Nothing went wrong that is worth a line.
    expect(logged).deep.equals([])
    // The next caller who stays is answered in full.
    const answer = await fetch(`${base}/read`)
    expect(answer.status).to.equal(200)
    expect(ran.read).to.equal(3)
  })

  it('finishes a write whose caller has gone', async () => {
    const held = await holdEveryClient()
    try {
      await abandon('/write', { method: 'POST' })
      await pause(200)
      expect(pool.waitingCount).to.equal(1)
    } finally {
      for (const client of held) client.release()
    }
    await waitFor(() => ran.write === 1)
  })
})
