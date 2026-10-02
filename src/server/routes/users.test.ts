import type { AddressInfo } from 'node:net'

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
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { userRoutes } from './users'

/**
 * `GET /users?externalId=`, through the real router.
 *
 * Ada plays for Home and is known by two ids of different kinds. Bea plays
 * for nobody, and Bee was merged into her. Cal is on Home without playing,
 * and is the one asking when the asker is not the site administrator.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_users_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_users_admin_00000000000000000000'
const CAL = 'tok_users_cal_0000000000000000000000'

const minted = new Set<number>()
function mint(): ReturnType<typeof mintUserId> {
  const made = mintUserId(id => minted.has(id))
  minted.add(made.userId)
  return made
}
const admin = mint()
const ada = mint()
const bea = mint()
const bee = mint()
const cal = mint()

describe('the users route', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const home = makeId('team')

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    await seed(db)

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', userRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null) {
      await new Promise(resolve => listening.close(resolve))
    }
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function ask(
    token: string,
    ...externalIds: string[]
  ): Promise<{ status: number; body: any }> {
    const query = externalIds
      .map(id => `externalId=${encodeURIComponent(id)}`)
      .join('&')
    const response = await fetch(
      `${base}/users${query === '' ? '' : `?${query}`}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    return { status: response.status, body: await response.json() }
  }

  const byUserId = (a: { userId: number }, b: { userId: number }): number =>
    a.userId - b.userId

  it('answers a site administrator for everybody, a merged row as its survivor', async function () {
    const answer = await ask(
      ADMIN,
      'ext-ada',
      'ext-ada-login',
      'ext-bea',
      'ext-bee'
    )
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals(
      [
        { userId: ada.userId, externalIds: ['ext-ada', 'ext-ada-login'] },
        { userId: bea.userId, externalIds: ['ext-bea', 'ext-bee'] }
      ].sort(byUserId)
    )
  })

  it('answers only the people the asker could see', async function () {
    const answer = await ask(CAL, 'ext-ada', 'ext-bea', 'ext-bee', 'ext-cal')
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals(
      [
        { userId: ada.userId, externalIds: ['ext-ada'] },
        { userId: cal.userId, externalIds: ['ext-cal'] }
      ].sort(byUserId)
    )
  })

  it('answers nobody for an id no user holds', async function () {
    const answer = await ask(ADMIN, 'ext-home', 'ext-nobody')
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals([])
  })

  it('refuses an empty or a missing externalId', async function () {
    expect((await ask(ADMIN, '')).status).equals(400)
    expect((await ask(ADMIN, 'ext-ada', '')).status).equals(400)
    expect((await ask(ADMIN)).status).equals(400)
  })

  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    await db
      .insertInto('users')
      .values(
        [
          { made: admin, name: 'An Admin', isAdmin: true },
          { made: ada, name: 'Ada Lovelace', isAdmin: false },
          { made: bea, name: 'Bea Brown', isAdmin: false },
          { made: bee, name: 'Bea B', isAdmin: false },
          { made: cal, name: 'Cal Carter', isAdmin: false }
        ].map(person => ({
          id: person.made.userId,
          legacyId: person.made.legacyId,
          display_name: person.name,
          is_admin: person.isAdmin,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: bea.userId })
      .where('id', '=', bee.userId)
      .execute()
    await db
      .insertInto('auth_sessions')
      .values(
        [
          { token: ADMIN, userId: admin.userId },
          { token: CAL, userId: cal.userId }
        ].map(session => ({
          id: makeId('authSession'),
          user_id: session.userId,
          token_hash: hashToken(session.token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db.insertInto('teams').values({ id: home, name: 'Home' }).execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: ada.userId,
          team_id: home,
          is_player: true
        },
        { id: makeId('membership'), user_id: cal.userId, team_id: home }
      ])
      .execute()
    await db
      .insertInto('external_ids')
      .values(
        (
          [
            ['user', String(ada.userId), 'player', 'ext-ada'],
            ['user', String(ada.userId), 'account', 'ext-ada-login'],
            ['user', String(bea.userId), 'player', 'ext-bea'],
            ['user', String(bee.userId), 'player', 'ext-bee'],
            ['user', String(cal.userId), 'user', 'ext-cal'],
            ['team', home, 'team', 'ext-home']
          ] as const
        ).map(([entityType, entityId, kind, externalId]) => ({
          id: makeId('externalId'),
          entity_type: entityType,
          entity_id: entityId,
          system: 'acme',
          kind,
          external_id: externalId
        }))
      )
      .execute()
  }
})
