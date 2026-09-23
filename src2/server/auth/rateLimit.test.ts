import { expect } from 'chai'
import type { Request } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { checkLimits, clientIp, recordAttempts } from './rateLimit'

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_ratelimit_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** Enough of a request for `clientIp`; nothing else is read. */
function asRequest(ip: string | undefined): Request {
  return { ip } as unknown as Request
}

describe('clientIp', function () {
  it('reads a real address', function () {
    expect(clientIp(asRequest('203.0.113.7'))).equals('203.0.113.7')
  })

  it('unwraps an IPv4 address written as IPv6', function () {
    expect(clientIp(asRequest('::ffff:203.0.113.7'))).equals('203.0.113.7')
  })

  /**
   * The important one. If `trust proxy` ever stops resolving Caddy's
   * `X-Forwarded-For`, every request arrives as the loopback — and a per-client
   * limit keyed on that would count the whole world as one person and refuse
   * everybody. Reading it as "unknown" turns that misconfiguration into a limit
   * that is too loose rather than a site nobody can sign in to.
   */
  it('refuses to identify a client by the loopback address', function () {
    expect(clientIp(asRequest('127.0.0.1'))).equals(null)
    expect(clientIp(asRequest('::1'))).equals(null)
    expect(clientIp(asRequest('::ffff:127.0.0.1'))).equals(null)
    expect(clientIp(asRequest(undefined))).equals(null)
  })
})

describe('rate limits', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined

  const rule = (
    key: string,
    limit = 3,
    windowSec = 900
  ): [{ scope: string; key: string; limit: number; windowSec: number }] => [
    { scope: 'test.address', key, limit, windowSec }
  ]

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('allows attempts up to the limit and refuses the next', async function () {
    if (db == null) this.skip()
    const rules = rule('up-to-the-limit@example.com')

    for (let i = 0; i < 3; i++) {
      await checkLimits(db, rules)
      await recordAttempts(db, rules)
    }

    let refused: unknown
    try {
      await checkLimits(db, rules)
    } catch (error) {
      refused = error
    }
    expect(refused).instanceOf(HttpError)
    expect((refused as HttpError).code).equals('rateLimited')
    expect((refused as HttpError).status).equals(429)
  })

  it('says how long to wait, and does not invent a negative wait', async function () {
    if (db == null) this.skip()
    const rules = rule('how-long@example.com', 1, 900)
    await recordAttempts(db, rules)

    try {
      await checkLimits(db, rules)
      expect.fail('should have been refused')
    } catch (error) {
      const wait = (error as HttpError).details as { retryAfterSec: number }
      expect(wait.retryAfterSec).greaterThan(0)
      expect(wait.retryAfterSec).at.most(900)
      expect((error as HttpError).message).contains('minutes')
    }
  })

  /** An attempt that has fallen out of the window does not count any more. */
  it('lets the window pass', async function () {
    if (db == null) this.skip()
    const key = 'window@example.com'
    const rules = rule(key, 2, 60)

    // Two attempts, both older than the window.
    const old = new Date(Date.now() - 120 * 1000)
    await db
      .insertInto('rate_events')
      .values([
        { id: makeId('rateEvent'), scope: 'test.address', key, at: old },
        { id: makeId('rateEvent'), scope: 'test.address', key, at: old }
      ])
      .execute()

    await checkLimits(db, rules)
  })

  it('counts each key and each scope on its own', async function () {
    if (db == null) this.skip()
    const mine = rule('mine@example.com', 1)
    await recordAttempts(db, mine)

    // Somebody else's address is unaffected.
    await checkLimits(db, rule('yours@example.com', 1))

    // And the same address under a different scope is a different budget.
    await checkLimits(db, [
      {
        scope: 'test.other',
        key: 'mine@example.com',
        limit: 1,
        windowSec: 900
      }
    ])
  })

  /**
   * Rows are dropped as they age, by the limiter itself, so the table stays
   * proportional to recent traffic and no sweeper has to exist.
   */
  it('prunes attempts that have left the window', async function () {
    if (db == null) this.skip()
    const key = 'pruned@example.com'
    await db
      .insertInto('rate_events')
      .values({
        id: makeId('rateEvent'),
        scope: 'test.address',
        key,
        at: new Date(Date.now() - 3600 * 1000)
      })
      .execute()

    await recordAttempts(db, rule(key, 5, 60))

    const rows = await db
      .selectFrom('rate_events')
      .select('id')
      .where('scope', '=', 'test.address')
      .where('key', '=', key)
      .execute()
    expect(rows.length).equals(1)
  })
})
