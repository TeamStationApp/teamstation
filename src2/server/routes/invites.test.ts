import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { visibleScopes } from '../access'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { authRoutes } from './auth'
import { inviteRoutes } from './invites'

/**
 * Invites, through the real router against a real database.
 *
 * Three things are worth the cost of a live Postgres here, because each is a
 * rule that could be lost anywhere along the path and nothing smaller would
 * catch it:
 *
 * 1. **Who may make one.** A parent on a team is not an administrator of it,
 *    and a team admin has no business inviting people to somebody else's team.
 * 2. **What redeeming is worth.** A season invite must make somebody a member
 *    of the season and therefore able to see every team in it — which is a
 *    question for `visibleScopes`, not for the row that was written.
 * 3. **That a stranger can come in at all.** The account does not exist when
 *    the link is opened and does exist once the code is typed, and that spans
 *    two routers and the e-mail code table.
 */
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_invites_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const BOSS = 'tok_boss_00000000000000000000000000'
const COACH = 'tok_coach_0000000000000000000000000'
const PARENT = 'tok_parent_000000000000000000000000'

describe('invite codes', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  /** Every code the fake mailer has sent, newest last. */
  const sent: Array<{ email: string; code: string; link?: string }> = []

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
    const sendCode = async (
      email: string,
      code: string,
      link?: string
    ): Promise<void> => {
      sent.push({ email, code, link })
    }
    app.use(
      '/api/v1',
      inviteRoutes(db, { sendCode, publicUrl: 'https://gs.example' })
    )
    app.use(
      '/api/v1',
      authRoutes(db, { sendCode, publicUrl: 'https://gs.example' })
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
   * A season with two teams, the coach who runs one of them, and a parent.
   *
   * The boss administers the season, which by the ordinary inheritance makes
   * them an administrator of both teams; the coach administers only theirs.
   */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [id, name] of [
      ['usr_boss', 'Sam Boss'],
      ['usr_coach', 'Robin Coach'],
      ['usr_parent', 'Parent']
    ]) {
      await db
        .insertInto('users')
        .values({ id, display_name: name, created_at: now, updated_at: now })
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
      .insertInto('seasons')
      .values({
        id: 'sea_spring',
        name: 'Demo Spring 2026',
        year: 2026,
        created_at: now,
        updated_at: now
      })
      .execute()
    for (const [id, name] of [
      ['tem_hawks', 'Demo Hawks'],
      ['tem_rangers', 'Demo Rangers']
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

  it('lets a team’s manager make a code, and the parent none', async function () {
    if (db == null) this.skip()
    const made = await ask('/invites', COACH, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_hawks',
      code: 'hawks26',
      label: 'Parents'
    })
    expect(made.status).equals(201)
    // The same path PeerTube's links use, because those links already exist.
    expect(made.body.url).equals('https://gs.example/i/hawks26')
    expect(made.body.uses).equals(0)

    const theirs = await ask(
      '/invites?scopeType=team&scopeId=tem_hawks',
      PARENT
    )
    expect(theirs.status).equals(200)
    expect(theirs.body.canInvite).equals(false)
    expect((theirs.body.invites as unknown[]).length).equals(0)
  })

  it('refuses a coach a code for a team that is not theirs', async function () {
    if (db == null) this.skip()
    const made = await ask('/invites', COACH, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_rangers'
    })
    // 404, not 403: whether that team exists is not this coach's business.
    expect(made.status).equals(404)
  })

  it('lets a season administrator invite to the season and its teams', async function () {
    if (db == null) this.skip()
    const season = await ask('/invites', BOSS, 'POST', {
      scopeType: 'season',
      scopeId: 'sea_spring',
      code: 'spring26'
    })
    expect(season.status).equals(201)
    const team = await ask('/invites', BOSS, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_rangers'
    })
    // Rights inherit downwards: the season's administrator runs its teams.
    expect(team.status).equals(201)
    expect(String(team.body.code).length).equals(8)
  })

  it('refuses a code that is already somebody else’s', async function () {
    if (db == null) this.skip()
    const again = await ask('/invites', BOSS, 'POST', {
      scopeType: 'season',
      scopeId: 'sea_spring',
      // The same code as the team invite above, in different letters.
      code: 'HAWKS26'
    })
    expect(again.status).equals(409)
  })

  it('says nothing at all about a code that does not exist', async function () {
    if (db == null) this.skip()
    const asked = await ask('/join/nosuchcode', undefined)
    expect(asked.status).equals(404)
  })

  it('redeems for somebody already signed in, once', async function () {
    if (db == null) this.skip()
    const before = await visibleScopes(db, 'usr_parent', false)
    expect(before.seasonIds.has('sea_spring')).equals(false)

    const first = await ask('/join/spring26/redeem', PARENT, 'POST', {})
    expect(first.status).equals(200)
    expect(first.body.granted).equals(true)

    // A season member sees every team in the season, including the one they
    // are not on. That is the rule the row is there to produce.
    const after = await visibleScopes(db, 'usr_parent', false)
    expect(after.seasonIds.has('sea_spring')).equals(true)
    expect(after.teamIds.has('tem_rangers')).equals(true)

    // A link sits in a mailbox and gets opened twice. The second time is not
    // an error and must not cost the invite a use.
    const twice = await ask('/join/spring26/redeem', PARENT, 'POST', {})
    expect(twice.status).equals(200)
    expect(twice.body.granted).equals(false)
    const row = await db
      .selectFrom('invites')
      .select(['uses'])
      .where('code', '=', 'spring26')
      .executeTakeFirst()
    expect(row?.uses).equals(1)
  })

  it('tells somebody signed in that they are already in', async function () {
    if (db == null) this.skip()
    const asked = await ask('/join/spring26', PARENT)
    expect(asked.status).equals(200)
    expect(asked.body.valid).equals(true)
    expect(asked.body.alreadyIn).equals(true)
    expect((asked.body.scope as { name: string }).name).equals(
      'Demo Spring 2026'
    )
  })

  it('makes an account for a stranger, but only once they read the code', async function () {
    if (db == null) this.skip()
    const email = 'newparent@example.com'
    const asked = await ask('/join/hawks26/email-code', undefined, 'POST', {
      email,
      displayName: 'New Parent'
    })
    expect(asked.status).equals(202)

    // Nothing yet: asking is not proof that the address is theirs.
    const before = await db
      .selectFrom('user_emails')
      .select(['user_id'])
      .where('email', '=', email)
      .executeTakeFirst()
    expect(before).equals(undefined)

    const mail = sent[sent.length - 1]
    expect(mail.email).equals(email)
    // The link is the ordinary sign-in link; the invite rides on the row.
    expect(mail.link?.startsWith('https://gs.example/signin/')).equals(true)

    const session = await ask('/auth/email-code/verify', undefined, 'POST', {
      email,
      code: mail.code
    })
    expect(session.status).equals(200)
    const user = session.body.user as { id: string; displayName: string }
    expect(user.displayName).equals('New Parent')

    // Signed in, and on the team, in one step.
    const scopes = await visibleScopes(db, user.id, false)
    expect(scopes.teamIds.has('tem_hawks')).equals(true)
    const membership = await db
      .selectFrom('memberships')
      .select(['is_spectator', 'role'])
      .where('user_id', '=', user.id)
      .where('team_id', '=', 'tem_hawks')
      .executeTakeFirst()
    expect(membership?.is_spectator).equals(true)
    expect(membership?.role).equals('member')

    // And it is recorded as the redemption it was, rather than only counted.
    const redemption = await db
      .selectFrom('invite_redemptions')
      .innerJoin('invites', 'invites.id', 'invite_redemptions.invite_id')
      .select(['invite_redemptions.created_account as createdAccount'])
      .where('invites.code', '=', 'hawks26')
      .where('invite_redemptions.user_id', '=', user.id)
      .executeTakeFirst()
    expect(redemption?.createdAccount).equals(true)
  })

  it('signs an existing person in and adds the access', async function () {
    if (db == null) this.skip()
    // The parent already has an account, and is not on the Rangers.
    await db
      .insertInto('user_emails')
      .values({
        id: 'uem_parent',
        user_id: 'usr_parent',
        email: 'parent@example.com',
        is_primary: true
      })
      .execute()
    const rangers = await ask('/invites', BOSS, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_rangers',
      code: 'rangers26'
    })
    expect(rangers.status).equals(201)

    const asked = await ask('/join/rangers26/email-code', undefined, 'POST', {
      email: 'parent@example.com'
    })
    expect(asked.status).equals(202)
    const mail = sent[sent.length - 1]
    const session = await ask('/auth/email-code/verify', undefined, 'POST', {
      email: 'parent@example.com',
      code: mail.code
    })
    expect(session.status).equals(200)
    const user = session.body.user as { id: string; displayName: string }
    // The same account, not a second one, and the name they already had.
    expect(user.id).equals('usr_parent')
    expect(user.displayName).equals('Parent')

    const membership = await db
      .selectFrom('memberships')
      .select(['is_spectator'])
      .where('user_id', '=', 'usr_parent')
      .where('team_id', '=', 'tem_rangers')
      .executeTakeFirst()
    expect(membership?.is_spectator).equals(true)
  })

  it('lets a league invite carry seasons the league does not have yet', async function () {
    if (db == null) this.skip()
    const now = new Date()
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
      .insertInto('admin_roles')
      .values({
        id: 'adm_boss_league',
        user_id: 'usr_boss',
        scope_type: 'league',
        scope_id: 'lea_npll'
      })
      .execute()

    const made = await ask('/invites', BOSS, 'POST', {
      scopeType: 'league',
      scopeId: 'lea_npll',
      code: 'league26'
    })
    expect(made.status).equals(201)
    const joined = await ask('/join/league26/redeem', COACH, 'POST', {})
    expect(joined.status).equals(200)

    // Nothing to see yet: the league has no seasons.
    const before = await visibleScopes(db, 'usr_coach', false)
    expect(before.seasonIds.has('sea_autumn')).equals(false)

    // A season created afterwards is in the league from the moment it exists,
    // which is the whole reason a league membership is a row of its own
    // rather than a list of the seasons that happened to be there that day.
    await db
      .insertInto('seasons')
      .values({
        id: 'sea_autumn',
        name: 'Demo Autumn 2026',
        year: 2026,
        league_id: 'lea_npll',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('teams')
      .values({
        id: 'tem_bandits',
        name: 'Demo Bandits',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: 'sea_autumn', team_id: 'tem_bandits' })
      .execute()

    const after = await visibleScopes(db, 'usr_coach', false)
    expect(after.seasonIds.has('sea_autumn')).equals(true)
    expect(after.teamIds.has('tem_bandits')).equals(true)
  })

  it('stops a link without forgetting who came through it', async function () {
    if (db == null) this.skip()
    const made = await ask('/invites', COACH, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_hawks',
      code: 'shortlived'
    })
    const id = String(made.body.id)
    const gone = await ask(`/invites/${id}`, COACH, 'DELETE')
    expect(gone.status).equals(204)

    const asked = await ask('/join/shortlived', undefined)
    expect(asked.status).equals(200)
    expect(asked.body.valid).equals(false)
    expect(asked.body.problem).equals('revoked')

    const refused = await ask('/join/shortlived/redeem', PARENT, 'POST', {})
    expect(refused.status).equals(400)

    // Still on the list, so somebody can see why their link stopped working.
    const list = await ask('/invites?scopeType=team&scopeId=tem_hawks', COACH)
    const codes = (list.body.invites as Array<{ code: string }>).map(
      row => row.code
    )
    expect(codes).contains('shortlived')
  })

  it('runs out when it has been used as often as it may be', async function () {
    if (db == null) this.skip()
    const made = await ask('/invites', COACH, 'POST', {
      scopeType: 'team',
      scopeId: 'tem_hawks',
      code: 'onlyonce',
      maxUses: 1
    })
    expect(made.status).equals(201)
    const first = await ask('/join/onlyonce/redeem', BOSS, 'POST', {})
    expect(first.status).equals(200)

    const asked = await ask('/join/onlyonce', undefined)
    expect(asked.body.valid).equals(false)
    expect(asked.body.problem).equals('exhausted')
  })
})
