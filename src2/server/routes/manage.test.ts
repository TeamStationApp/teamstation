import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { manageRoutes } from './manage'

/**
 * The page behind the gear, through the real router.
 *
 * The case that matters most is the table: one person holding access at two
 * heights has to show both, and a team's administrator has to be able to
 * remove the team's grant and *not* the season's. Everything else on the page
 * is a list; that is a rule, and a rule with a database behind it.
 */
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_manage_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const BOSS = 'tok_boss_00000000000000000000000000'
const COACH = 'tok_coach_0000000000000000000000000'
const PARENT = 'tok_parent_000000000000000000000000'

describe('the manage page', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const posted: Array<{ email: string; link: string }> = []

  before(async function () {
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
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await seed(db)

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      manageRoutes(db, {
        sendInvite: async (email, invitation) => {
          posted.push({ email, link: invitation.link })
        },
        publicUrl: 'https://gs.example'
      })
    )
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

  /**
   * A league, a season in it, two teams, and three people.
   *
   * The parent is the interesting one: on the Hawks *and* a member of the
   * season, which is the pair of grants the table exists to show.
   */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [id, name] of [
      ['usr_boss', 'Sam Boss'],
      ['usr_coach', 'Robin Coach'],
      ['usr_parent', 'Jo Parent'],
      // No session, ever: the PeerTube import brought many of these.
      ['usr_ghost', 'Pat Ghost']
    ]) {
      await db
        .insertInto('users')
        .values({ id, display_name: name, created_at: now, updated_at: now })
        .execute()
      await db
        .insertInto('user_emails')
        .values({
          id: `uem_${id}`,
          user_id: id,
          email: `${id.replace('usr_', '')}@example.com`,
          is_primary: true
        })
        .execute()
    }
    for (const [id, user, token] of [
      ['ses_boss', 'usr_boss', BOSS],
      ['ses_coach', 'usr_coach', COACH],
      ['ses_parent', 'usr_parent', PARENT]
    ]) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: user,
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + 3_600_000),
          created_at: now
        })
        .execute()
    }
    await db
      .insertInto('leagues')
      .values({
        id: 'lea_npll',
        name: 'Demo League',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: 'sea_spring',
        name: 'Demo Spring 2026',
        year: 2026,
        league_id: 'lea_npll',
        created_at: now,
        updated_at: now
      })
      .execute()
    for (const [id, name] of [
      ['tem_hawks', 'Demo Hawks'],
      ['tem_ravens', 'Demo Ravens']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
      await db
        .insertInto('season_teams')
        .values({ season_id: 'sea_spring', team_id: id })
        .execute()
    }
    await db
      .insertInto('admin_roles')
      .values({
        id: 'adm_boss',
        user_id: 'usr_boss',
        scope_type: 'season',
        scope_id: 'sea_spring'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_coach',
        user_id: 'usr_coach',
        team_id: 'tem_hawks',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_parent',
        user_id: 'usr_parent',
        team_id: 'tem_hawks',
        role: 'member'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_ghost',
        user_id: 'usr_ghost',
        team_id: 'tem_hawks',
        role: 'member'
      })
      .execute()
    // The same person, again, one level up.
    await db
      .insertInto('season_members')
      .values({
        id: 'smb_parent',
        user_id: 'usr_parent',
        season_id: 'sea_spring',
        role: 'spectator',
        source: 'peertube'
      })
      .execute()
  }

  async function ask(
    path: string,
    token: string | undefined,
    method = 'GET',
    body?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    }
    if (token != null) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  interface Person {
    userId: string
    displayName: string
    emails: string[]
    createdAt: string
    lastSignInAt: string | null
    lastSeenAt: string | null
    teams: Array<{ id: string; name: string }>
    seasons: Array<{ id: string; name: string }>
    leagues: Array<{ id: string; name: string }>
    adminOf: Array<{ kind: string; id: string }>
  }

  const peopleOf = (body: Record<string, unknown>): Person[] =>
    body.people as Person[]

  it('shows every level a person\u2019s access comes through', async function () {
    if (db == null) this.skip()
    const page = await ask('/manage/team/tem_hawks', COACH)
    expect(page.status).equals(200)
    const parent = peopleOf(page.body).find(
      person => person.userId === 'usr_parent'
    )
    expect(parent?.emails).deep.equals(['parent@example.com'])
    // Both grants, not the strongest of the two.
    expect(parent?.teams.map(team => team.name)).deep.equals(['Demo Hawks'])
    expect(parent?.seasons.map(season => season.name)).deep.equals([
      'Demo Spring 2026'
    ])
    // And the levels around this team are named, so a tick can say which.
    const tree = page.body.tree as { seasons: unknown[]; leagues: unknown[] }
    expect(tree.seasons.length).equals(1)
    expect(tree.leagues.length).equals(1)
  })

  it('says when each account was made and last used', async function () {
    if (db == null) this.skip()
    const page = await ask('/manage/team/tem_hawks', COACH)
    const people = peopleOf(page.body)
    const coach = people.find(person => person.userId === 'usr_coach')
    // The seeded session is this suite's own, so the coach has signed in and
    // has been here; the sign-in is a real date, not the empty string.
    expect(Number.isNaN(Date.parse(coach?.createdAt ?? ''))).equals(false)
    expect(Number.isNaN(Date.parse(coach?.lastSignInAt ?? ''))).equals(false)
    expect(Number.isNaN(Date.parse(coach?.lastSeenAt ?? ''))).equals(false)

    // Somebody with no session has never signed in, which is null and not a
    // date at the beginning of time.
    const ghost = people.find(person => person.userId === 'usr_ghost')
    expect(Number.isNaN(Date.parse(ghost?.createdAt ?? ''))).equals(false)
    expect(ghost?.lastSignInAt).equals(null)
    expect(ghost?.lastSeenAt).equals(null)
  })

  it('turns away somebody who does not administer it', async function () {
    if (db == null) this.skip()
    const page = await ask('/manage/team/tem_hawks', PARENT)
    expect(page.status).equals(404)
  })

  it('removes what this level grants and leaves the level above', async function () {
    if (db == null) this.skip()
    const gone = await ask(
      '/manage/team/tem_hawks/people/usr_parent',
      COACH,
      'DELETE'
    )
    expect(gone.status).equals(200)
    expect(gone.body.removed).equals(true)

    const page = await ask('/manage/team/tem_hawks', COACH)
    const parent = peopleOf(page.body).find(
      person => person.userId === 'usr_parent'
    )
    // Still there, still able to watch — through the season, which a team's
    // administrator has no business taking away.
    expect(parent?.teams.length).equals(0)
    expect(parent?.seasons.length).equals(1)
  })

  it('adds somebody who already has an account at once', async function () {
    if (db == null) this.skip()
    const added = await ask('/manage/team/tem_hawks/people', COACH, 'POST', {
      email: 'parent@example.com'
    })
    expect(added.status).equals(201)
    expect(added.body.added).equals(true)

    const membership = await db
      .selectFrom('memberships')
      .select(['is_spectator'])
      .where('user_id', '=', 'usr_parent')
      .where('team_id', '=', 'tem_hawks')
      .executeTakeFirst()
    expect(membership?.is_spectator).equals(true)
  })

  it('posts an invitation to an address nobody here holds', async function () {
    if (db == null) this.skip()
    const invited = await ask('/manage/team/tem_hawks/people', COACH, 'POST', {
      email: 'newcomer@example.com'
    })
    expect(invited.status).equals(201)
    expect(invited.body.added).equals(false)
    const mail = posted[posted.length - 1]
    expect(mail.email).equals('newcomer@example.com')
    expect(mail.link.startsWith('https://gs.example/i/')).equals(true)

    // No account was made by asking, and the page says they are waiting.
    const account = await db
      .selectFrom('user_emails')
      .select(['user_id'])
      .where('email', '=', 'newcomer@example.com')
      .executeTakeFirst()
    expect(account).equals(undefined)
    const page = await ask('/manage/team/tem_hawks', COACH)
    const pending = page.body.pending as Array<{ email: string }>
    expect(pending.map(row => row.email)).contains('newcomer@example.com')
  })

  it('makes somebody an administrator of this level, and unmakes them', async function () {
    if (db == null) this.skip()
    const made = await ask(
      '/manage/season/sea_spring/people/usr_coach/role',
      BOSS,
      'PUT',
      { role: 'admin' }
    )
    expect(made.status).equals(200)
    expect(made.body.role).equals('admin')

    // Which is the whole point: the coach can now manage the season.
    const page = await ask('/manage/season/sea_spring', COACH)
    expect(page.status).equals(200)
    // And can see it. An administrator with no membership administers
    // something they cannot watch, which is nobody's intention.
    const membership = await db
      .selectFrom('season_members')
      .select(['id'])
      .where('user_id', '=', 'usr_coach')
      .where('season_id', '=', 'sea_spring')
      .executeTakeFirst()
    expect(membership == null).equals(false)

    const back = await ask(
      '/manage/season/sea_spring/people/usr_coach/role',
      BOSS,
      'PUT',
      { role: 'member' }
    )
    expect(back.status).equals(200)
    const after = await ask('/manage/season/sea_spring', COACH)
    expect(after.status).equals(404)
  })

  it('only ever changes the level whose page it is', async function () {
    if (db == null) this.skip()
    // The coach administers their own team and nothing above it, so the
    // season's page is the door they might try.
    const refused = await ask(
      '/manage/season/sea_spring/people/usr_coach/role',
      COACH,
      'PUT',
      { role: 'admin' }
    )
    expect(refused.status).equals(404)

    // On their own team's page it works, and what it writes is a *team* role.
    const made = await ask(
      '/manage/team/tem_hawks/people/usr_parent/role',
      COACH,
      'PUT',
      { role: 'admin' }
    )
    expect(made.status).equals(200)
    const roles = await db
      .selectFrom('admin_roles')
      .select(['scope_type', 'scope_id'])
      .where('user_id', '=', 'usr_parent')
      .execute()
    expect(roles.map(row => `${row.scope_type}:${row.scope_id}`)).deep.equals([
      'team:tem_hawks'
    ])
  })

  it('will not let an administrator demote themselves', async function () {
    if (db == null) this.skip()
    const refused = await ask(
      '/manage/season/sea_spring/people/usr_boss/role',
      BOSS,
      'PUT',
      { role: 'member' }
    )
    expect(refused.status).equals(400)
    const page = await ask('/manage/season/sea_spring', BOSS)
    expect(page.status).equals(200)
  })
})
