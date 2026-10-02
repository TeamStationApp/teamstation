import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asMyRoles } from '../../common/api'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { ROLES } from '../../common/roles'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { meRoutes } from './me'

/**
 * `GET /me/roles`: the roles the signed-in person holds, team by team, which
 * the app reads for the buttons no other answer carries.
 */
const scratchName = `teamstation_me_${Date.now()}`
const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const PEOPLE = ['keeper', 'manager', 'site', 'nobody'] as const
type Person = (typeof PEOPLE)[number]
const token = (person: Person): string => `tok_me_${person}`.padEnd(35, '0')

describe('what the signed-in person may do', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const users = new Map<Person, number>()

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
    for (const person of PEOPLE) {
      const made = mintUserId(id => [...users.values()].includes(id))
      users.set(person, made.userId)
      await db
        .insertInto('users')
        .values({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: person,
          is_admin: person === 'site'
        })
        .execute()
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: made.userId,
          token_hash: hashToken(token(person)),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        })
        .execute()
    }
    const user = (person: Person): number => users.get(person) ?? 0

    // League `lea_me` holds season `sea_me`, which holds `tem_a` and `tem_b`;
    // `tem_c` is in no season at all.
    await db.insertInto('leagues').values({ id: 'lea_me', name: 'L' }).execute()
    await db
      .insertInto('seasons')
      .values({ id: 'sea_me', name: 'S', year: 2026, league_id: 'lea_me' })
      .execute()
    await db
      .insertInto('teams')
      .values(['tem_a', 'tem_b', 'tem_c'].map(id => ({ id, name: id })))
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: 'sea_me', team_id: 'tem_a' },
        { season_id: 'sea_me', team_id: 'tem_b' }
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: user('keeper'),
          scope_type: 'league',
          scope_id: 'lea_me',
          role: 'scorekeeper'
        },
        {
          id: makeId('scopeRole'),
          user_id: user('keeper'),
          scope_type: 'team',
          scope_id: 'tem_b',
          role: 'coach'
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: user('manager'),
        team_id: 'tem_c',
        role: 'manager'
      })
      .execute()

    const app = express()
    app.use(withActor(db))
    app.use('/api/v1', meRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const rolesOf = async (person: Person): Promise<Record<string, string[]>> => {
    const response = await fetch(`${base}/me/roles`, {
      headers: { authorization: `Bearer ${token(person)}` }
    })
    expect(response.status).equals(200)
    return asMyRoles(await response.json()).teams
  }

  it('lists the roles each team inherits, and what is set on the team itself', async function () {
    if (db == null) this.skip()
    expect(await rolesOf('keeper')).deep.equals({
      tem_a: ['scorekeeper'],
      tem_b: ['coach', 'scorekeeper']
    })
  })

  it('gives an administrator every role on the team they run', async function () {
    if (db == null) this.skip()
    expect(await rolesOf('manager')).deep.equals({ tem_c: [...ROLES] })
  })

  it('gives a site administrator every role on every team', async function () {
    if (db == null) this.skip()
    expect(await rolesOf('site')).deep.equals({
      tem_a: [...ROLES],
      tem_b: [...ROLES],
      tem_c: [...ROLES]
    })
  })

  it('lists nothing for somebody with no role, and needs a session', async function () {
    if (db == null) this.skip()
    expect(await rolesOf('nobody')).deep.equals({})
    const response = await fetch(`${base}/me/roles`)
    expect(response.status).equals(401)
  })
})
