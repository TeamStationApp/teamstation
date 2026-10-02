import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { findUserByEmail } from '../auth/emails'
import { passwordMatches } from '../auth/passwords'
import { type Database, makeDatabase } from '../db/database'
import { type ChatSeed, chatSeed, describeSeed, SEED_PEOPLE } from './chatSeed'

/** U1: the chat fixture, built twice into one scratch database. */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_chat_seed_${Date.now()}_${process.pid}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const TABLES = [
  'users',
  'user_emails',
  'leagues',
  'seasons',
  'teams',
  'season_teams',
  'memberships',
  'scope_roles',
  'team_follows',
  'games',
  'videos',
  'external_ids'
] as const

describe('the chat seed', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let first: ChatSeed
  let second: ChatSeed
  let countsAfterFirst: Record<string, number>

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const table of TABLES) {
      const row = await database()
        .selectFrom(table)
        .select(eb => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
      out[table] = Number(row.n)
    }
    return out
  }

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
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    first = await chatSeed(db, { now: new Date('2027-04-10T12:00:00Z') })
    countsAfterFirst = await counts()
    second = await chatSeed(db, {
      password: 'same for all',
      now: new Date('2027-04-12T12:00:00Z')
    })
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  it('builds the same rows twice, and nothing more the second time', async function () {
    expect(await counts()).deep.equals(countsAfterFirst)
    expect(countsAfterFirst).deep.include({
      users: SEED_PEOPLE.length,
      user_emails: SEED_PEOPLE.length - 1,
      leagues: 1,
      seasons: 1,
      teams: 3,
      season_teams: 3,
      games: 3,
      videos: 1,
      team_follows: 2
    })
    expect(second.teams).deep.equals(first.teams)
    expect(second.games).deep.equals(first.games)
    expect(second.videoId).equals(first.videoId)
    for (const person of SEED_PEOPLE) {
      expect(second.people[person.key]?.userId, person.key).equals(
        first.people[person.key]?.userId
      )
    }
  })

  it('sets every password again, and moves the games with the day', async function () {
    const pat = second.people.P
    expect(pat?.password).equals('same for all')
    const found = await findUserByEmail(database(), 'p@chat.example.com')
    expect(found?.loginEnabled).equals(true)
    expect(
      await passwordMatches('same for all', found?.passwordHash ?? null)
    ).equals(true)
    expect(first.people.P?.password).not.equals('same for all')
    const final = await database()
      .selectFrom('games')
      .select(['start_at', 'status', 'home_score', 'away_score'])
      .where('id', '=', second.games.hawksOwlsFinal)
      .executeTakeFirstOrThrow()
    expect(final).deep.equals({
      start_at: new Date('2027-04-05T17:00:00Z'),
      status: 'final',
      home_score: 6,
      away_score: 3
    })
  })

  it('gives the player without an account no way to sign in', async function () {
    const quinn = second.people.Q
    expect(quinn?.email).equals(null)
    expect(quinn?.password).equals(null)
    const row = await database()
      .selectFrom('users')
      .select(['login_enabled', 'password_hash'])
      .where('id', '=', quinn?.userId ?? 0)
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({ login_enabled: false, password_hash: null })
  })

  it('puts the roles where the scenarios expect them', async function () {
    const roles = await database()
      .selectFrom('scope_roles')
      .select(['user_id', 'scope_type', 'scope_id', 'role'])
      .execute()
    const has = (
      key: string,
      scopeType: string,
      scopeId: string,
      role: string
    ): boolean =>
      roles.some(
        row =>
          row.user_id === second.people[key]?.userId &&
          row.scope_type === scopeType &&
          row.scope_id === scopeId &&
          row.role === role
      )
    expect(has('L', 'league', second.leagueId, 'admin')).equals(true)
    expect(has('S', 'season', second.seasonId, 'admin')).equals(true)
    expect(has('K', 'season', second.seasonId, 'scorekeeper')).equals(true)
    expect(has('Hc', 'team', second.teams.hawks, 'coach')).equals(true)
    expect(has('Ec', 'team', second.teams.eagles, 'coach')).equals(true)
    const owners = await database()
      .selectFrom('memberships')
      .select(['user_id', 'team_id'])
      .where('role', '=', 'owner')
      .execute()
    expect(owners).to.deep.include.members([
      { user_id: second.people.Ha?.userId, team_id: second.teams.hawks },
      { user_id: second.people.Ea?.userId, team_id: second.teams.eagles }
    ])
    const admin = await database()
      .selectFrom('users')
      .select(['is_admin'])
      .where('id', '=', second.people.Z?.userId ?? 0)
      .executeTakeFirstOrThrow()
    expect(admin.is_admin).equals(true)
  })

  it('prints every password beside its person', function () {
    const text = describeSeed(second)
    expect(text).contains('Hawks v Owls (final)')
    expect(text).match(
      /^Hc +Hank Coach +\d+ +hc@chat\.example\.com +same for all$/m
    )
    expect(text).match(/^Q +Quilvio Veras +\d+ +\(no account\)$/m)
  })

  it('refuses an address that already belongs to somebody else', async function () {
    const scratch = `${scratchName}_taken`
    await adminPool?.query(`create database ${scratch}`)
    const url = adminUrl.replace(/\/[^/]*$/, `/${scratch}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.query(
      `insert into users (id, "legacyId", display_name) values (777, 'u777', 'Someone');
       insert into user_emails (id, user_id, email) values ('uem_x', 777, 'l@chat.example.com')`
    )
    await pool.end()
    const other = makeDatabase(url)
    try {
      let refused: unknown
      await chatSeed(other, { password: 'x' }).catch((error: unknown) => {
        refused = error
      })
      expect(String(refused)).contains('l@chat.example.com already belongs')
    } finally {
      await other.destroy()
      await adminPool?.query(`drop database if exists ${scratch} with (force)`)
    }
  })
})
