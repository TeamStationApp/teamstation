import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  deviceEventControlGrant,
  deviceEventControlKeyId,
  deviceEventControlSecretProblem,
  lengthPrefixed
} from '../auth/deviceEventControl'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { deviceEventControlRoutes } from './deviceEventControl'

/**
 * `GET /device-event-control/key`: a device's own key for the local
 * event-control protocol, fetched with its own session.
 */
const scratchName = `teamstation_devctl_${Date.now()}`
const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const SECRET =
  '00000000000000000000000000000000000000000000000000000000000000a1'
const ROTATED =
  '00000000000000000000000000000000000000000000000000000000000000b2'
const ISSUER = 'https://app.example.test'
const OTHER_ISSUER = 'https://develop9.example.test'

const token = (name: string): string => `tok_devctl_${name}`.padEnd(35, '0')

interface KeyVector {
  name: string
  secret: string
  issuer: string
  userId: string
  key: string
  keyId: string
  accountTag: string
}

const fixtures = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../mobile/apps/common/EventControl/Tests/Fixtures/keys.json'
    ),
    'utf8'
  )
) as { vectors: KeyVector[] }

describe('device event-control key derivation', function () {
  it('matches every shared fixture byte for byte', function () {
    expect(fixtures.vectors.length).greaterThan(3)
    for (const vector of fixtures.vectors) {
      const grant = deviceEventControlGrant(
        vector.secret,
        vector.issuer,
        vector.userId
      )
      expect(grant, vector.name).deep.equals({
        version: 1,
        issuer: vector.issuer,
        userId: vector.userId,
        accountTag: vector.accountTag,
        keyId: vector.keyId,
        key: vector.key
      })
    }
  })

  it('binds the key to the account and the server, and the ID to the secret', function () {
    const one = deviceEventControlGrant(SECRET, ISSUER, 101)
    expect(deviceEventControlGrant(SECRET, ISSUER, '101')).deep.equals(one)
    expect(deviceEventControlGrant(SECRET, ISSUER, 102).key).not.equals(one.key)
    expect(deviceEventControlGrant(SECRET, ISSUER, 102).accountTag).not.equals(
      one.accountTag
    )
    const elsewhere = deviceEventControlGrant(SECRET, OTHER_ISSUER, 101)
    expect(elsewhere.key).not.equals(one.key)
    expect(elsewhere.keyId).equals(one.keyId)
    const rotated = deviceEventControlGrant(ROTATED, ISSUER, 101)
    expect(rotated.key).not.equals(one.key)
    expect(rotated.keyId).not.equals(one.keyId)
    expect(one.keyId).matches(/^[0-9a-f]{16}$/)
    expect(one.accountTag).matches(/^[0-9a-f]{32}$/)
    expect(one.key).matches(/^[0-9a-f]{64}$/)
    expect(deviceEventControlKeyId(SECRET)).equals(one.keyId)
  })

  it('length-prefixes every part so no two inputs run together', function () {
    expect(lengthPrefixed('ab', Buffer.from([1])).toString('hex')).equals(
      '0002616200' + '0101'
    )
    expect(lengthPrefixed('a', 'bc')).not.deep.equals(lengthPrefixed('ab', 'c'))
    expect(() => lengthPrefixed(Buffer.alloc(0x10000))).throws(/65535/)
    expect(() => deviceEventControlGrant('', ISSUER, 1)).throws(/not set/)
  })

  it('refuses a secret shorter than 32 bytes', function () {
    expect(deviceEventControlSecretProblem(SECRET)).equals(undefined)
    expect(deviceEventControlSecretProblem('a'.repeat(32))).equals(undefined)
    expect(deviceEventControlSecretProblem('a'.repeat(31))).equals(
      'deviceEventControlSecret is shorter than 32 bytes'
    )
    expect(deviceEventControlSecretProblem('')).equals(
      'deviceEventControlSecret is not set'
    )
    expect(() => deviceEventControlGrant('a'.repeat(31), ISSUER, 1)).throws(
      /shorter than 32 bytes/
    )
  })
})

describe('GET /device-event-control/key', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const servers: Array<ReturnType<express.Express['listen']>> = []
  const bases = new Map<string, string>()
  const users = new Map<string, number>()

  const listen = async (
    name: string,
    secret: string,
    issuer: string
  ): Promise<void> => {
    if (db == null) return
    const app = express()
    app.use(withActor(db))
    app.use('/api/v1', deviceEventControlRoutes(db, { secret, issuer }))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    bases.set(name, `http://127.0.0.1:${address.port}/api/v1`)
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    const later = new Date(now.getTime() + 3_600_000)
    for (const person of ['one', 'two', 'locked']) {
      const made = mintUserId(id => [...users.values()].includes(id))
      users.set(person, made.userId)
      await db
        .insertInto('users')
        .values({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: person,
          is_admin: false,
          login_enabled: person !== 'locked'
        })
        .execute()
    }
    const session = async (
      name: string,
      person: string,
      expiresAt = later,
      revokedAt: Date | null = null
    ): Promise<void> => {
      await db
        ?.insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: users.get(person) ?? 0,
          token_hash: hashToken(token(name)),
          created_at: now,
          expires_at: expiresAt,
          revoked_at: revokedAt
        })
        .execute()
    }
    // Two devices of account One, each with its own session.
    await session('oneIpad', 'one')
    await session('onePhone', 'one')
    await session('two', 'two')
    await session('locked', 'locked')
    await session('revoked', 'one', later, now)
    await db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: users.get('one') ?? 0,
        token_hash: hashToken(token('machine')),
        label: 'fixture',
        scopes: []
      })
      .execute()

    await listen('main', SECRET, ISSUER)
    await listen('rotated', ROTATED, ISSUER)
    await listen('elsewhere', SECRET, OTHER_ISSUER)
    await listen('off', '', ISSUER)
    await listen('short', 'a'.repeat(31), ISSUER)
  })

  after(async function () {
    for (const server of servers) server.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const ask = async (
    server: string,
    name?: string
  ): Promise<{
    status: number
    body: Record<string, unknown>
    cache: string
  }> => {
    const response = await fetch(
      `${bases.get(server)}/device-event-control/key`,
      {
        headers: name == null ? {} : { authorization: `Bearer ${token(name)}` }
      }
    )
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      cache: response.headers.get('cache-control') ?? ''
    }
  }

  it("answers the caller's own scope and key, the same on each of their devices", async function () {
    if (db == null) this.skip()
    const ipad = await ask('main', 'oneIpad')
    const phone = await ask('main', 'onePhone')
    expect(ipad.status).equals(200)
    expect(ipad.cache).equals('no-store')
    expect(ipad.body).deep.equals(
      deviceEventControlGrant(SECRET, ISSUER, users.get('one') ?? 0)
    )
    expect(ipad.body.userId).equals(String(users.get('one')))
    expect(ipad.body.issuer).equals(ISSUER)
    expect(phone.body).deep.equals(ipad.body)
    // Nothing of the session that asked comes back.
    expect(JSON.stringify(ipad.body)).not.includes(token('oneIpad'))
  })

  it('gives another account, and another server, a different key', async function () {
    if (db == null) this.skip()
    const one = (await ask('main', 'oneIpad')).body
    const two = (await ask('main', 'two')).body
    expect(two.userId).equals(String(users.get('two')))
    expect(two.key).not.equals(one.key)
    expect(two.accountTag).not.equals(one.accountTag)
    expect(two.keyId).equals(one.keyId)
    const elsewhere = (await ask('elsewhere', 'oneIpad')).body
    expect(elsewhere.issuer).equals(OTHER_ISSUER)
    expect(elsewhere.key).not.equals(one.key)
    expect(elsewhere.accountTag).not.equals(one.accountTag)
  })

  it('changes the key ID when the secret is rotated', async function () {
    if (db == null) this.skip()
    const one = (await ask('main', 'oneIpad')).body
    const rotated = (await ask('rotated', 'oneIpad')).body
    expect(rotated.keyId).not.equals(one.keyId)
    expect(rotated.key).not.equals(one.key)
  })

  it('refuses a machine token for the same person, as /me/builds does', async function () {
    if (db == null) this.skip()
    const machine = await ask('main', 'machine')
    expect(machine.status).equals(401)
    expect(machine.body.code).equals('unauthorized')
    expect(machine.body).not.has.property('key')
  })

  it('refuses the signed-out, revoked sessions and disabled logins', async function () {
    if (db == null) this.skip()
    expect((await ask('main')).status).equals(401)
    expect((await ask('main', 'revoked')).status).equals(401)
    expect((await ask('main', 'locked')).status).equals(401)
    expect((await ask('main', 'nobody')).status).equals(401)
  })

  it('answers 503 deviceEventControlUnavailable when the secret is not set', async function () {
    if (db == null) this.skip()
    const off = await ask('off', 'oneIpad')
    expect(off.status).equals(503)
    expect(off.body).deep.equals({
      code: 'unavailable',
      message: 'Device event control is not set up on this server',
      error: 'deviceEventControlUnavailable'
    })
    // Signed out is still 401, not a hint about how the server is set up.
    expect((await ask('off')).status).equals(401)
  })

  it('answers 503 when the secret is shorter than 32 bytes', async function () {
    if (db == null) this.skip()
    const short = await ask('short', 'oneIpad')
    expect(short.status).equals(503)
    expect(short.body.error).equals('deviceEventControlUnavailable')
  })
})
