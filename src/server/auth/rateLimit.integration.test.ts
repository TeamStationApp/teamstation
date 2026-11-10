import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import type { Request } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { limitGoogleLookup } from '../location/googleLookupLimits'
import { serverConfig } from '../serverConfig'
import {
  checkLimits,
  clientIp,
  type LimitRule,
  recordAttempts
} from './rateLimit'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_ratelimit_${Date.now()}`
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
   * The important one. If `trust proxy` ever stops resolving the proxy's
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
  describe('the test scale', function () {
    const the = (): Kysely<Database> => {
      if (db == null) throw new Error('no database')
      return db
    }

    const rule = (scope: string, limit: number, fixed = false): LimitRule => ({
      scope,
      key: 'k',
      limit,
      windowSec: 60,
      ...(fixed ? { fixed } : {})
    })

    /** How many attempts the rule allows before refusing. */
    async function allowed(target: LimitRule): Promise<number> {
      for (let count = 0; count < 200; count++) {
        try {
          await checkLimits(the(), [target])
        } catch (error) {
          expect(error).instanceOf(HttpError)
          return count
        }
        await recordAttempts(the(), [target])
      }
      return 200
    }

    async function setScale(value: unknown): Promise<void> {
      await the()
        .insertInto('system_settings')
        .values({ key: 'test.rateLimitScale', value: JSON.stringify(value) })
        .onConflict(oc =>
          oc.column('key').doUpdateSet({ value: JSON.stringify(value) })
        )
        .execute()
    }

    const saved = serverConfig.testSettings
    afterEach(async function () {
      serverConfig.testSettings = saved
      await the()
        .deleteFrom('system_settings')
        .where('key', '=', 'test.rateLimitScale')
        .execute()
    })

    it('with testSettings off, ignores the row and runs no query', async function () {
      serverConfig.testSettings = false
      await setScale(0.2)
      expect(await allowed(rule('off.row', 5))).equals(5)
      const queries: string[] = []
      const watched = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: scratchUrl })
        }),
        log: event => {
          if (event.level === 'query') queries.push(event.query.sql)
        }
      })
      await checkLimits(watched, [rule('off.query', 5)])
      await watched.destroy()
      expect(queries.join()).not.includes('system_settings')
    })

    it('with no row, refuses at exactly the rule’s own limit', async function () {
      serverConfig.testSettings = true
      expect(await allowed(rule('none', 5))).equals(5)
    })

    it('scales every rule, up and down, rounding up and never to nothing', async function () {
      serverConfig.testSettings = true
      await setScale(0.2)
      expect(await allowed(rule('low.five', 5))).equals(1)
      expect(await allowed(rule('low.ten', 10))).equals(2)
      expect(await allowed(rule('low.one', 1))).equals(1)
      expect(await allowed(rule('low.seven', 7))).equals(2)
      await setScale(10)
      expect(await allowed(rule('high', 5))).equals(50)
    })

    it('takes a change at once, with no restart', async function () {
      serverConfig.testSettings = true
      await setScale(0.2)
      const target = rule('live', 5)
      await recordAttempts(the(), [target])
      let refused = false
      try {
        await checkLimits(the(), [target])
      } catch {
        refused = true
      }
      expect(refused).equals(true)
      await setScale(100)
      await checkLimits(the(), [target])
    })

    it('leaves a fixed rule alone', async function () {
      serverConfig.testSettings = true
      await setScale(100)
      expect(await allowed(rule('fixed.high', 3, true))).equals(3)
      await setScale(0.2)
      expect(await allowed(rule('fixed.low', 3, true))).equals(3)
    })

    it('never loosens a paid provider’s budget', async function () {
      serverConfig.testSettings = true
      await setScale(100)
      const userId = 'usr_budget'
      let count = 0
      try {
        for (; count < 60; count++) {
          await limitGoogleLookup(the(), userId, true)
        }
      } catch (error) {
        expect(error).instanceOf(HttpError)
      }
      expect(count).equals(30)
    })

    it('falls back to 1 on a bad value', async function () {
      serverConfig.testSettings = true
      for (const [name, value] of Object.entries({
        zero: 0,
        negative: -1,
        text: 'many',
        nothing: false
      })) {
        await setScale(value)
        expect(await allowed(rule(`bad.${name}`, 3)), name).equals(3)
      }
    })
  })

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

describe('production’s limits', function () {
  /** Every rule's number as the route declares it, so a change is deliberate. */
  function declared(file: string): Record<string, number> {
    const text = readFileSync(file, 'utf8')
    return Object.fromEntries(
      [...text.matchAll(/scope: '([a-zA-Z.]+)',\s*limit: (\d+)/g)].map(row => [
        row[1],
        Number(row[2])
      ])
    )
  }

  it('are locked for each sign-in and invitation rule', function () {
    expect(declared('src/server/routes/auth.ts')).to.include({
      'emailCode.address': 5,
      'emailCode.ip': 20,
      'password.address': 10,
      'password.ip': 50,
      'verify.address': 10,
      'verify.ip': 50,
      'link.token': 10,
      'link.ip': 50
    })
    expect(declared('src/server/routes/invites.ts')).to.include({
      'invite.address': 5,
      'invite.ip': 20,
      'invite.code': 30
    })
  })
})
