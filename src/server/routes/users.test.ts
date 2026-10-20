import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { TeamStationClient } from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo, userIdOfValue } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
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
 * Adam plays for Home and is known by two ids of different kinds, and has a
 * picture. Brett plays for nobody, and his duplicate was merged into him. Cal is on Home
 * without playing, and is the one asking when the asker is not the site
 * administrator. Cal is Adam's guardian, and family of Brett's duplicate; Don plays for
 * nobody and is Cal's link of kind `other`.
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
const dot = mint()
const space = {
  endpoint: 'https://sfo3.example.test',
  region: 'sfo3',
  bucket: 'demo',
  accessKeyId: 'AKIAEXAMPLE000000000',
  secretAccessKey: 'secret',
  pathStyle: false
}

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
    app.use('/api/v1', userRoutes(db, space))
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
    return await askWith(token, query)
  }
  async function askWith(
    token: string | null,
    query: string
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(
      `${base}/users${query === '' ? '' : `?${query}`}`,
      {
        headers: token == null ? {} : { authorization: `Bearer ${token}` }
      }
    )
    return { status: response.status, body: await response.json() }
  }
  /** Adam's picture, signed, as every answer carries it. */
  const picture = (body: any[]): string | null =>
    body.find(person => person.userId === userIdOfGumbo(ada.userId))
      ?.avatarUrl ?? null

  const byUserId = (a: { userId: string }, b: { userId: string }): number =>
    a.userId.localeCompare(b.userId)

  it('answers a site administrator for everybody, a merged row as its survivor', async function () {
    const answer = await ask(
      ADMIN,
      'ext-ada',
      'ext-ada-login',
      'ext-bea',
      'ext-bee'
    )
    expect(answer.status).equals(200)
    expect(picture(answer.body)).includes('/avatars/ada/')
    expect(answer.body).deep.equals(
      [
        {
          userId: userIdOfGumbo(ada.userId),
          gumboId: ada.userId,
          externalIds: ['ext-ada', 'ext-ada-login'],
          shortName: 'Adam L',
          avatarUrl: picture(answer.body)
        },
        {
          userId: userIdOfGumbo(bea.userId),
          gumboId: bea.userId,
          externalIds: ['ext-bea', 'ext-bee'],
          shortName: 'Brett B',
          avatarUrl: null
        }
      ].sort(byUserId)
    )
  })

  it('ignores orphaned external references without losing valid matches', async function () {
    await db!
      .insertInto('external_ids')
      .values(
        ['not-a-user', userIdOfValue(1n << 100n)].map((entityId, index) => ({
          id: makeId('externalId'),
          entity_type: 'user',
          entity_id: entityId,
          system: 'acme',
          kind: 'player',
          external_id: `orphan-${index}`
        }))
      )
      .execute()
    const answer = await ask(ADMIN, 'orphan-0', 'orphan-1', 'ext-ada')
    expect(answer.status).equals(200)
    expect(
      answer.body.map((row: { userId: string }) => row.userId)
    ).deep.equals([userIdOfGumbo(ada.userId)])
  })

  it('answers only the people the asker could see', async function () {
    const answer = await ask(CAL, 'ext-ada', 'ext-bea', 'ext-bee', 'ext-cal')
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals(
      [
        {
          userId: userIdOfGumbo(ada.userId),
          gumboId: ada.userId,
          externalIds: ['ext-ada'],
          shortName: 'Adam L',
          avatarUrl: picture(answer.body)
        },
        {
          userId: userIdOfGumbo(cal.userId),
          gumboId: cal.userId,
          externalIds: ['ext-cal'],
          shortName: 'Cal R',
          avatarUrl: null
        }
      ].sort(byUserId)
    )
  })

  it('lists the players the asker is a guardian of, by short name', async function () {
    const answer = await askWith(CAL, 'guardedBy=me')
    expect(answer.status).equals(200)
    // A `guardian` link and a `family` one, the latter to a row since merged,
    // which answers as the row it was merged into; never the `other` link.
    expect(answer.body).deep.equals(
      [
        {
          userId: userIdOfGumbo(ada.userId),
          gumboId: ada.userId,
          externalIds: [],
          shortName: 'Adam L',
          avatarUrl: picture(answer.body)
        },
        {
          userId: userIdOfGumbo(bea.userId),
          gumboId: bea.userId,
          externalIds: [],
          shortName: 'Brett B',
          avatarUrl: null
        }
      ].sort((a, b) => a.shortName.localeCompare(b.shortName))
    )
    expect(picture(answer.body)).includes('/avatars/ada/')
    expect((await askWith(ADMIN, 'guardedBy=me')).body).deep.equals([])
    // The app's client reads the same list.
    const client = new TeamStationClient({ baseUrl: base, token: CAL })
    const read = await client.guardedPlayers()
    expect(read.map(({ avatarUrl: _, ...rest }) => rest)).deep.equals(
      answer.body.map(({ avatarUrl: _, ...rest }: any) => rest)
    )
    expect(picture(read)).includes('/avatars/ada/')
  })

  it('refuses guardedBy anybody but me, beside externalId, or for nobody', async function () {
    for (const query of [
      'guardedBy=you',
      'guardedBy=',
      'guardedBy=me&guardedBy=me',
      'guardedBy=me&externalId=ext-ada'
    ]) {
      expect((await askWith(CAL, query)).status, query).equals(400)
    }
    expect((await askWith(null, 'guardedBy=me')).status).equals(401)
  })

  it('answers nobody for an id no user holds', async function () {
    const answer = await ask(ADMIN, 'ext-home', 'ext-nobody')
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals([])
  })

  it('scopes external ids by system and reports an adult without a scoring identity', async function () {
    const id = userIdOfValue(1n << 80n)
    // A new account has no historical derivation or mapping.
    await db!
      .insertInto('users')
      .values({ id, display_name: 'Hank Aaron' })
      .execute()
    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'user',
        entity_id: id,
        system: 'gamechanger',
        kind: 'player',
        external_id: 'ext-ada'
      })
      .execute()
    const client = new TeamStationClient({ baseUrl: base, token: ADMIN })
    const scoped = await client.users({
      externalIds: ['ext-ada'],
      system: 'gamechanger'
    })
    expect(
      scoped.map(({ userId, gumboId }) => ({ userId, gumboId }))
    ).deep.equals([{ userId: id, gumboId: null }])
    expect((await ask(ADMIN, 'ext-ada')).body).length(2)
    expect(
      (await askWith(ADMIN, 'externalId=ext-ada&system=acme')).body[0].userId
    ).equals(userIdOfGumbo(ada.userId))
    expect(
      (await askWith(ADMIN, 'externalId=ext-ada&system=missing')).body
    ).deep.equals([])
    for (const query of ['system=', 'system=acme&system=gamechanger']) {
      expect(
        (await askWith(ADMIN, `externalId=ext-ada&${query}`)).status
      ).equals(400)
    }
  })

  it('refuses an empty or a missing externalId', async function () {
    expect((await ask(ADMIN, '')).status).equals(400)
    expect((await ask(ADMIN, 'ext-ada', '')).status).equals(400)
    expect((await ask(ADMIN)).status).equals(400)
  })

  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    await insertFixtureUsers(
      db,
      [
        { made: admin, name: 'An Admin', isAdmin: true },
        { made: ada, name: 'Adam LaRoche', isAdmin: false },
        { made: bea, name: 'Brett Butler', isAdmin: false },
        { made: bee, name: 'Brett B', isAdmin: false },
        { made: cal, name: 'Cal Ripken', isAdmin: false },
        { made: dot, name: 'Don Drysdale', isAdmin: false }
      ].map(person => ({
        id: person.made.userId,
        legacyId: person.made.legacyId,
        display_name: person.name,
        is_admin: person.isAdmin,
        created_at: now,
        updated_at: now
      }))
    )
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(bea.userId) })
      .where('id', '=', userIdOfGumbo(bee.userId))
      .execute()
    await db
      .updateTable('users')
      .set({ avatar_path: 'avatars/ada/1' })
      .where('id', '=', userIdOfGumbo(ada.userId))
      .execute()
    await db
      .insertInto('user_links')
      .values(
        (
          [
            [ada, 'guardian'],
            [bee, 'family'],
            [dot, 'other']
          ] as const
        ).map(([child, kind]) => ({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(cal.userId),
          related_user_id: userIdOfGumbo(child.userId),
          kind
        }))
      )
      .execute()
    await db
      .insertInto('auth_sessions')
      .values(
        [
          { token: ADMIN, userId: userIdOfGumbo(admin.userId) },
          { token: CAL, userId: userIdOfGumbo(cal.userId) }
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
          user_id: userIdOfGumbo(ada.userId),
          team_id: home,
          is_player: true
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(cal.userId),
          team_id: home
        }
      ])
      .execute()
    await db
      .insertInto('external_ids')
      .values(
        (
          [
            ['user', userIdOfGumbo(ada.userId), 'player', 'ext-ada'],
            ['user', userIdOfGumbo(ada.userId), 'account', 'ext-ada-login'],
            ['user', userIdOfGumbo(bea.userId), 'player', 'ext-bea'],
            ['user', userIdOfGumbo(bee.userId), 'player', 'ext-bee'],
            ['user', userIdOfGumbo(cal.userId), 'user', 'ext-cal'],
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
