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
import { findInviteByCode, redeemInvite } from '../invites/invites'
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
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_manage_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const BOSS = 'tok_boss_00000000000000000000000000'
const COACH = 'tok_coach_0000000000000000000000000'
const PARENT = 'tok_parent_000000000000000000000000'
const CHIEF = 'tok_chief_0000000000000000000000000'
const GHOST = 'tok_ghost_0000000000000000000000000'

const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => legacyOf.has(id))
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}
function legacyId(userId: number): string {
  const id = legacyOf.get(userId)
  if (id == null) throw new Error(`no legacy id for ${userId}`)
  return id
}
function exampleEmail(): string {
  return `${makeId('user').slice(4).toLowerCase()}@example.com`
}

const bossId = mintUser()
const coachId = mintUser()
const parentId = mintUser()
const ghostId = mintUser()
const chiefId = mintUser()
const bossEmail = exampleEmail()
const coachEmail = exampleEmail()
const parentEmail = exampleEmail()
const ghostEmail = exampleEmail()

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
    for (const [id, name, email] of [
      [bossId, 'Sam Boss', bossEmail],
      [coachId, 'Robin Coach', coachEmail],
      [parentId, 'Jo Parent', parentEmail],
      // No session, ever: the PeerTube import brought many of these.
      [ghostId, 'Pat Ghost', ghostEmail]
    ] as Array<[number, string, string]>) {
      await db
        .insertInto('users')
        .values({
          id,
          legacyId: legacyId(id),
          display_name: name,
          login_enabled: true,
          created_at: now,
          updated_at: now
        })
        .execute()
      await db
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: id,
          email,
          is_primary: true,
          verified_at: now
        })
        .execute()
    }
    for (const [id, user, token] of [
      ['ses_boss', bossId, BOSS],
      ['ses_coach', coachId, COACH],
      ['ses_parent', parentId, PARENT]
    ] as Array<[string, number, string]>) {
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
        .values({
          id,
          name,
          league_id: 'lea_npll',
          created_at: now,
          updated_at: now
        })
        .execute()
      await db
        .insertInto('season_teams')
        .values({ season_id: 'sea_spring', team_id: id })
        .execute()
      await db
        .insertInto('season_team_parents')
        .values({ season_id: 'sea_spring', team_id: id })
        .execute()
    }
    await db
      .insertInto('scope_roles')
      .values({
        id: 'adm_boss',
        user_id: bossId,
        scope_type: 'season',
        scope_id: 'sea_spring'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_coach',
        user_id: coachId,
        team_id: 'tem_hawks',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_parent',
        user_id: parentId,
        team_id: 'tem_hawks',
        role: 'member'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_ghost',
        user_id: ghostId,
        team_id: 'tem_hawks',
        role: 'member'
      })
      .execute()
    // The same person, again, one level up.
    await db
      .insertInto('season_members')
      .values({
        id: 'smb_parent',
        user_id: parentId,
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
    userId: number
    displayName: string
    emails: string[]
    createdAt: string
    lastSignInAt: string | null
    lastSeenAt: string | null
    teams: Array<{ id: string; name: string }>
    seasons: Array<{ id: string; name: string }>
    leagues: Array<{ id: string; name: string }>
    adminOf: Array<{ kind: string; id: string }>
    grants: Array<{ kind: string; id: string; name: string; roles: string[] }>
  }

  const peopleOf = (body: Record<string, unknown>): Person[] =>
    body.people as Person[]
  let invitationNumber = 0
  const join = async (
    kind: 'team' | 'season' | 'league',
    id: string,
    userId: number,
    email: string,
    inviter = BOSS
  ): Promise<void> => {
    const reply = await ask(`/manage/${kind}/${id}/people`, inviter, 'POST', {
      email,
      idempotencyKey: `fixture-person-${++invitationNumber}`
    })
    expect(reply.status).equals(201)
    const invite = await findInviteByCode(
      db!,
      (reply.body.invited as { code: string }).code
    )
    expect(invite).not.equals(undefined)
    await redeemInvite(db!, invite!, userId)
  }

  it('shows every level a person\u2019s access comes through', async function () {
    if (db == null) this.skip()
    const page = await ask('/manage/team/tem_hawks', COACH)
    expect(page.status).equals(200)
    const parent = peopleOf(page.body).find(
      person => person.userId === parentId
    )
    expect(parent?.emails).deep.equals([parentEmail])
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
    const coach = people.find(person => person.userId === coachId)
    // The seeded session is this suite's own, so the coach has signed in and
    // has been here; the sign-in is a real date, not the empty string.
    expect(Number.isNaN(Date.parse(coach?.createdAt ?? ''))).equals(false)
    expect(Number.isNaN(Date.parse(coach?.lastSignInAt ?? ''))).equals(false)
    expect(Number.isNaN(Date.parse(coach?.lastSeenAt ?? ''))).equals(false)

    // Somebody with no session has never signed in, which is null and not a
    // date at the beginning of time.
    const ghost = people.find(person => person.userId === ghostId)
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
      `/manage/team/tem_hawks/people/${parentId}`,
      COACH,
      'DELETE'
    )
    expect(gone.status).equals(200)
    expect(gone.body.removed).equals(true)

    const page = await ask('/manage/team/tem_hawks', COACH)
    const parent = peopleOf(page.body).find(
      person => person.userId === parentId
    )
    // Still there, still able to watch — through the season, which a team's
    // administrator has no business taking away.
    expect(parent?.teams.length).equals(0)
    expect(parent?.seasons.length).equals(1)
  })

  it('waits for an existing account to accept before adding group access', async function () {
    if (db == null) this.skip()
    const added = await ask('/manage/team/tem_hawks/people', COACH, 'POST', {
      email: parentEmail
    })
    expect(added.status).equals(201)
    expect(added.body.added).equals(false)
    expect(
      await db
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', parentId)
        .where('team_id', '=', 'tem_hawks')
        .execute()
    ).length(0)
    const invitation = await findInviteByCode(
      db,
      (added.body.invited as { code: string }).code
    )
    await redeemInvite(db, invitation!, parentId)

    const membership = await db
      .selectFrom('memberships')
      .select(['is_spectator'])
      .where('user_id', '=', parentId)
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
    await join('season', 'sea_spring', coachId, coachEmail)
    const made = await ask(
      `/manage/season/sea_spring/people/${coachId}/role`,
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
      .where('user_id', '=', coachId)
      .where('season_id', '=', 'sea_spring')
      .executeTakeFirst()
    expect(membership == null).equals(false)

    const back = await ask(
      `/manage/season/sea_spring/people/${coachId}/role`,
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
      `/manage/season/sea_spring/people/${coachId}/role`,
      COACH,
      'PUT',
      { role: 'admin' }
    )
    expect(refused.status).equals(404)

    // On their own team's page it works, and what it writes is a *team* role.
    const made = await ask(
      `/manage/team/tem_hawks/people/${parentId}/role`,
      COACH,
      'PUT',
      { role: 'admin' }
    )
    expect(made.status).equals(200)
    const roles = await db
      .selectFrom('scope_roles')
      .select(['scope_type', 'scope_id'])
      .where('user_id', '=', parentId)
      .execute()
    expect(roles.map(row => `${row.scope_type}:${row.scope_id}`)).deep.equals([
      'team:tem_hawks'
    ])
  })

  it('will not let an administrator demote themselves', async function () {
    if (db == null) this.skip()
    const refused = await ask(
      `/manage/season/sea_spring/people/${bossId}/role`,
      BOSS,
      'PUT',
      { role: 'member' }
    )
    expect(refused.status).equals(409)
    const page = await ask('/manage/season/sea_spring', BOSS)
    expect(page.status).equals(200)
  })

  it('sets and clears the fence of a season or a league its administrator runs', async function () {
    if (db == null) this.skip()
    const fenceOf = async (
      table: 'leagues' | 'seasons',
      id: string
    ): Promise<number | null> =>
      (
        await db!
          .selectFrom(table)
          .select(['fence_distance_ft'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).fence_distance_ft

    const season = await ask('/manage/season/sea_spring/field', BOSS, 'PUT', {
      fenceDistanceFt: 250
    })
    expect(season).deep.equals({
      status: 200,
      body: { scopeType: 'season', scopeId: 'sea_spring', fenceDistanceFt: 250 }
    })
    expect(await fenceOf('seasons', 'sea_spring')).equals(250)

    // A season's administrator does not run its league.
    expect(
      (
        await ask('/manage/league/lea_npll/field', BOSS, 'PUT', {
          fenceDistanceFt: 300
        })
      ).status
    ).equals(404)
    await db
      .insertInto('leagues')
      .values({ id: 'lea_field', name: 'Field League' })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'adm_boss_field',
        user_id: bossId,
        scope_type: 'league',
        scope_id: 'lea_field'
      })
      .execute()
    const league = await ask('/manage/league/lea_field/field', BOSS, 'PUT', {
      fenceDistanceFt: 300
    })
    expect(league.body).deep.equals({
      scopeType: 'league',
      scopeId: 'lea_field',
      fenceDistanceFt: 300
    })
    expect(await fenceOf('leagues', 'lea_field')).equals(300)

    const cleared = await ask('/manage/season/sea_spring/field', BOSS, 'PUT', {
      fenceDistanceFt: null
    })
    expect(cleared.body.fenceDistanceFt).equals(null)
    expect(await fenceOf('seasons', 'sea_spring')).equals(null)

    let audited: Array<{ before: unknown; after: unknown }> = []
    for (let tries = 0; tries < 50 && audited.length < 2; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      audited = await db
        .selectFrom('audit_log')
        .select(['before', 'after'])
        .where('entity_type', '=', 'season')
        .where('entity_id', '=', 'sea_spring')
        .orderBy('at')
        .execute()
    }
    expect(audited).deep.equals([
      { before: { fenceDistanceFt: null }, after: { fenceDistanceFt: 250 } },
      { before: { fenceDistanceFt: 250 }, after: { fenceDistanceFt: null } }
    ])
  })

  it('refuses a fence to a team, to a bad body and to anybody else', async function () {
    if (db == null) this.skip()
    const put = async (
      path: string,
      token: string | undefined,
      body: unknown
    ): Promise<number> => (await ask(path, token, 'PUT', body)).status
    expect(
      await put('/manage/season/sea_spring/field', undefined, {
        fenceDistanceFt: 200
      })
    ).equals(401)
    // A team plays on whatever field its games are at.
    expect(
      await put('/manage/team/tem_hawks/field', COACH, { fenceDistanceFt: 200 })
    ).equals(400)
    for (const token of [COACH, PARENT])
      expect(
        await put('/manage/season/sea_spring/field', token, {
          fenceDistanceFt: 200
        })
      ).equals(404)
    for (const body of [
      {},
      { fenceDistanceFt: -1 },
      { fenceDistanceFt: 1000 },
      { fenceDistanceFt: 'far' }
    ])
      expect(
        await put('/manage/season/sea_spring/field', BOSS, body),
        JSON.stringify(body)
      ).equals(400)
  })

  /** The roles rows one person holds on one level, oldest first. */
  const rowsOf = async (
    userId: number,
    scopeType: string,
    scopeId: string
  ): Promise<string[]> =>
    (
      await db!
        .selectFrom('scope_roles')
        .select(['role'])
        .where('user_id', '=', userId)
        .where('scope_type', '=', scopeType as 'team')
        .where('scope_id', '=', scopeId)
        .orderBy('role')
        .execute()
    ).map(row => row.role)

  it('sets, replaces and clears roles on a league, a season and a team', async function () {
    if (db == null) this.skip()
    // A league's administrator, who runs everything on this page.
    const now = new Date()
    await db
      .insertInto('users')
      .values({
        id: chiefId,
        legacyId: legacyId(chiefId),
        display_name: 'Lee Chief',
        login_enabled: true,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('auth_sessions')
      .values({
        id: 'ses_chief',
        user_id: chiefId,
        token_hash: hashToken(CHIEF),
        expires_at: new Date(now.getTime() + 3_600_000),
        created_at: now
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_chief',
        user_id: chiefId,
        scope_type: 'league',
        scope_id: 'lea_npll',
        role: 'admin'
      })
      .execute()

    await join('league', 'lea_npll', ghostId, ghostEmail, CHIEF)
    await join('season', 'sea_spring', ghostId, ghostEmail)
    const league = await ask(
      `/manage/league/lea_npll/people/${ghostId}/roles`,
      CHIEF,
      'PUT',
      { admin: false, flags: ['scorekeeper'] }
    )
    expect(league).deep.equals({
      status: 200,
      body: { userId: ghostId, roles: ['scorekeeper'] }
    })
    // And able to see what they keep score of.
    const joined = await db
      .selectFrom('league_members')
      .select(['id'])
      .where('user_id', '=', ghostId)
      .where('league_id', '=', 'lea_npll')
      .executeTakeFirst()
    expect(joined == null).equals(false)

    const season = await ask(
      `/manage/season/sea_spring/people/${ghostId}/roles`,
      BOSS,
      'PUT',
      { admin: true, flags: ['songkeeper', 'coach', 'coach'] }
    )
    expect(season.body.roles).deep.equals(['admin', 'coach', 'songkeeper'])
    const team = await ask(
      `/manage/team/tem_hawks/people/${ghostId}/roles`,
      COACH,
      'PUT',
      { admin: false, flags: ['videographer', 'assistant'] }
    )
    expect(team.body.roles).deep.equals(['assistant', 'videographer'])
    expect(await rowsOf(ghostId, 'team', 'tem_hawks')).deep.equals([
      'assistant',
      'videographer'
    ])
    expect(await rowsOf(ghostId, 'league', 'lea_npll')).deep.equals([
      'scorekeeper'
    ])
    expect(await rowsOf(ghostId, 'season', 'sea_spring')).deep.equals([
      'admin',
      'coach',
      'songkeeper'
    ])

    // The body is the whole set: what it leaves out is taken away, and what
    // it keeps keeps its row.
    const kept = await db
      .selectFrom('scope_roles')
      .select(['id'])
      .where('user_id', '=', ghostId)
      .where('scope_id', '=', 'sea_spring')
      .where('role', '=', 'songkeeper')
      .executeTakeFirstOrThrow()
    const replaced = await ask(
      `/manage/season/sea_spring/people/${ghostId}/roles`,
      BOSS,
      'PUT',
      { admin: false, flags: ['songkeeper'] }
    )
    expect(replaced.body.roles).deep.equals(['songkeeper'])
    const still = await db
      .selectFrom('scope_roles')
      .select(['id'])
      .where('user_id', '=', ghostId)
      .where('scope_id', '=', 'sea_spring')
      .executeTakeFirstOrThrow()
    expect(still.id).equals(kept.id)

    const cleared = await ask(
      `/manage/team/tem_hawks/people/${ghostId}/roles`,
      COACH,
      'PUT',
      { admin: false, flags: [] }
    )
    expect(cleared.body.roles).deep.equals([])
    expect(await rowsOf(ghostId, 'team', 'tem_hawks')).deep.equals([])

    let audited: unknown[] = []
    for (let tries = 0; tries < 50 && audited.length < 5; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      audited = await db
        .selectFrom('audit_log')
        .select(['after'])
        .where('entity_type', '=', 'scopeRoles')
        .where('entity_id', '=', String(ghostId))
        .execute()
    }
    expect(audited.length).equals(5)
  })

  it('lets only an administrator of the level or one above it set roles', async function () {
    if (db == null) this.skip()
    const put = async (
      path: string,
      token: string,
      body: unknown
    ): Promise<number> => (await ask(path, token, 'PUT', body)).status
    const body = { admin: false, flags: ['coach'] }
    // Holding flags is not administering: somebody who keeps score across the
    // league still may not hand out roles on one of its teams.
    const now = new Date()
    await db
      .insertInto('auth_sessions')
      .values({
        id: 'ses_ghost',
        user_id: ghostId,
        token_hash: hashToken(GHOST),
        expires_at: new Date(now.getTime() + 3_600_000),
        created_at: now
      })
      .execute()
    expect(
      await put(`/manage/team/tem_hawks/people/${parentId}/roles`, GHOST, body)
    ).equals(404)
    expect((await ask('/manage/team/tem_hawks', GHOST)).status).equals(404)
    // A team's manager does not run its season.
    expect(
      await put(
        `/manage/season/sea_spring/people/${ghostId}/roles`,
        COACH,
        body
      )
    ).equals(404)
    // The season's and the league's administrators run the team below them.
    expect(
      await put(`/manage/team/tem_hawks/people/${ghostId}/roles`, BOSS, body)
    ).equals(200)
    expect(
      await put(`/manage/team/tem_hawks/people/${ghostId}/roles`, CHIEF, {
        admin: false,
        flags: []
      })
    ).equals(200)
    // `admin` is not a flag, and an unknown flag is not either.
    for (const bad of [
      { admin: false, flags: ['admin'] },
      { admin: false, flags: ['umpire'] },
      { flags: [] },
      { admin: 'yes', flags: [] }
    ]) {
      expect(
        await put(`/manage/team/tem_hawks/people/${ghostId}/roles`, COACH, bad),
        JSON.stringify(bad)
      ).equals(400)
    }
    expect(
      await put(
        `/manage/team/tem_hawks/people/${mintUser()}/roles`,
        COACH,
        body
      )
    ).equals(404)
    expect(
      await put('/manage/team/tem_hawks/people/nobody/roles', COACH, body)
    ).equals(404)
  })

  it('will not let an administrator clear their own admin, and lets them add flags', async function () {
    if (db == null) this.skip()
    const refused = await ask(
      `/manage/season/sea_spring/people/${bossId}/roles`,
      BOSS,
      'PUT',
      { admin: false, flags: ['coach'] }
    )
    expect(refused.status).equals(409)
    const kept = await ask(
      `/manage/season/sea_spring/people/${bossId}/roles`,
      BOSS,
      'PUT',
      { admin: true, flags: ['coach'] }
    )
    expect(kept.body.roles).deep.equals(['admin', 'coach'])
    // A league administrator holds no row on the season, so has none here to
    // clear, and may set their own flags on it.
    await db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: chiefId,
        email: 'chief@example.com',
        is_primary: true,
        verified_at: new Date()
      })
      .execute()
    await join('season', 'sea_spring', chiefId, 'chief@example.com')
    const flags = await ask(
      `/manage/season/sea_spring/people/${chiefId}/roles`,
      CHIEF,
      'PUT',
      { admin: false, flags: ['scorekeeper'] }
    )
    expect(flags.body.roles).deep.equals(['scorekeeper'])
  })

  it('keeps the old role route, which leaves flags alone', async function () {
    if (db == null) this.skip()
    await ask(`/manage/team/tem_hawks/people/${ghostId}/roles`, COACH, 'PUT', {
      admin: false,
      flags: ['scorekeeper', 'songkeeper']
    })
    const made = await ask(
      `/manage/team/tem_hawks/people/${ghostId}/role`,
      COACH,
      'PUT',
      { role: 'admin' }
    )
    expect(made.body).deep.equals({ userId: ghostId, role: 'admin' })
    expect(await rowsOf(ghostId, 'team', 'tem_hawks')).deep.equals([
      'admin',
      'scorekeeper',
      'songkeeper'
    ])
    const back = await ask(
      `/manage/team/tem_hawks/people/${ghostId}/role`,
      COACH,
      'PUT',
      { role: 'member' }
    )
    expect(back.body.role).equals('member')
    expect(await rowsOf(ghostId, 'team', 'tem_hawks')).deep.equals([
      'scorekeeper',
      'songkeeper'
    ])
  })

  it('lists every role by the level it is set on, named', async function () {
    if (db == null) this.skip()
    const page = await ask('/manage/team/tem_hawks', COACH)
    const ghost = peopleOf(page.body).find(person => person.userId === ghostId)
    const height = { league: 0, season: 1, team: 2 }
    const byHeight = (a: { kind: string }, b: { kind: string }): number =>
      height[a.kind as keyof typeof height] -
      height[b.kind as keyof typeof height]
    expect([...(ghost?.grants ?? [])].sort(byHeight)).deep.equals([
      {
        kind: 'league',
        id: 'lea_npll',
        name: 'Demo League',
        roles: ['scorekeeper']
      },
      {
        kind: 'season',
        id: 'sea_spring',
        name: 'Demo Spring 2026',
        roles: ['songkeeper']
      },
      {
        kind: 'team',
        id: 'tem_hawks',
        name: 'Demo Hawks',
        roles: ['scorekeeper', 'songkeeper']
      }
    ])
    // An administrator's levels are still listed on their own, for the apps
    // that read nothing else.
    const boss = peopleOf(page.body).find(person => person.userId === bossId)
    expect(boss?.adminOf).deep.equals([
      { kind: 'season', id: 'sea_spring', name: 'Demo Spring 2026' }
    ])
    expect(boss?.grants).deep.equals([
      {
        kind: 'season',
        id: 'sea_spring',
        name: 'Demo Spring 2026',
        roles: ['admin', 'coach']
      }
    ])
  })
})
