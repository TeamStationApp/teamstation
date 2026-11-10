import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mayEditName } from '../access'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { type ChatSeed, chatSeed } from '../dev/chatSeed'
import { findInviteByCode, redeemInvite } from '../invites/invites'
import { settleInviteSignIn } from '../invites/joining'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { guardiansOf, linkGuardian, unlinkGuardian } from '../people/guardians'
import { mintUserId } from '../users/mintUserId'
import { guardianRoutes } from './guardians'
import { inviteRoutes } from './invites'
import { manageRoutes } from './manage'
import { playerRoutes } from './players'

/**
 * U2: guardians and family, birth months and the SafeSport setting, on the
 * chat fixture (`chatSeed`) in a scratch database, through the real routes.
 *
 * Hawks: admin Ha, coach Hc, scorekeeper Hk; players P (guardians G1, G2),
 * R and T, and Q with no account; parents A, B and C. Eagles parents D and
 * D2 are on no Hawks roster. L is QPLL's admin, S Spring 2027's.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_guardians_${Date.now()}_${process.pid}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

interface Answer {
  status: number
  body: any
}

interface Sent {
  email: string
  link: string
  scopeName: string
}

describe('guardians, birth months and the SafeSport setting (U2)', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let seed: ChatSeed
  let hawks = ''
  const tokens = new Map<string, string>()
  const sent: Sent[] = []

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }
  const id = (key: string): string => {
    const person = seed.people[key]
    if (person == null) throw new Error(`nobody called ${key}`)
    return person.userId
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
    seed = await chatSeed(db, {
      password: 'pw',
      now: new Date('2027-04-10T12:00:00Z')
    })
    hawks = seed.teams.hawks

    const now = new Date()
    for (const key of Object.keys(seed.people)) {
      const token = `tok_guardians_${key}_${'0'.repeat(24)}`
      tokens.set(key, token)
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: id(key),
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        })
        .execute()
    }

    const media: MediaContext = {
      mediaRoot: '/tmp',
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const sendInvite = async (
      email: string,
      invitation: { scopeName: string; link: string }
    ): Promise<void> => {
      sent.push({
        email,
        link: invitation.link,
        scopeName: invitation.scopeName
      })
    }
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      guardianRoutes(db, { sendInvite, publicUrl: 'http://app.test' })
    )
    app.use('/api/v1', manageRoutes(db, { sendInvite }))
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', inviteRoutes(db, { sendCode: async () => undefined }))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function call(
    who: string | null,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer> {
    const token = who == null ? undefined : tokens.get(who)
    const headers: Record<string, string> = {}
    if (token != null) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  const guardiansPath = (player: string, team = hawks): string =>
    `/teams/${team}/players/${id(player)}/guardians`

  /** The player's relatives as `key kind`, by the seed's keys. */
  async function relatives(player: string): Promise<string[]> {
    const byId = new Map(
      Object.values(seed.people).map(person => [person.userId, person.key])
    )
    return (await guardiansOf(database(), id(player))).map(
      guardian =>
        `${byId.get(guardian.userId) ?? guardian.name} ${guardian.kind}`
    )
  }

  async function membership(
    userId: string,
    teamId = hawks
  ): Promise<{ id: string; granted_by_link_id: string | null } | undefined> {
    return await database()
      .selectFrom('memberships')
      .select(['id', 'granted_by_link_id'])
      .where('user_id', '=', userId)
      .where('team_id', '=', teamId)
      .executeTakeFirst()
  }

  describe('linking', function () {
    it('lists the seeded guardians of P', async function () {
      const answer = await call('Hc', 'GET', guardiansPath('P'))
      expect(answer.status).equals(200)
      expect(
        answer.body.map((g: { email: string; kind: string }) => [
          g.email,
          g.kind
        ])
      ).deep.equals([
        ['g1@chat.example.com', 'guardian'],
        ['g2@chat.example.com', 'guardian']
      ])
      expect(answer.body[0]).to.have.keys(['userId', 'name', 'email', 'kind'])
    })

    it('refuses a guardian with no account, a self-link and a non-player', async function () {
      const quinn = await call('Hc', 'POST', guardiansPath('P'), {
        userId: String(id('Q'))
      })
      expect(quinn.status).equals(400)
      expect(quinn.body.details).deep.equals({ reason: 'guardianNeedsAccount' })

      const family = await call('Hc', 'POST', guardiansPath('P'), {
        userId: String(id('Q')),
        kind: 'family'
      })
      expect(family.body.details).deep.equals({
        reason: 'guardianNeedsAccount'
      })

      const self = await call('Hc', 'POST', guardiansPath('P'), {
        userId: String(id('P'))
      })
      expect(self.status).equals(400)
      expect(self.body.details).deep.equals({ reason: 'selfLink' })

      const notAPlayer = await call('Hc', 'POST', guardiansPath('A'), {
        userId: String(id('B'))
      })
      expect(notAPlayer.status).equals(404)

      let refused: unknown
      await linkGuardian(database(), id('A'), id('B'), hawks, null).catch(
        (error: unknown) => {
          refused = error
        }
      )
      expect((refused as { code?: string }).code).equals('notFound')
      expect(await relatives('P')).deep.equals(['G1 guardian', 'G2 guardian'])
    })

    it('refuses a body with both or neither of userId and email, and a bad address', async function () {
      for (const body of [
        {},
        { userId: String(id('B')), email: 'b@chat.example.com' }
      ]) {
        const answer = await call('Hc', 'POST', guardiansPath('P'), body)
        expect(answer.status).equals(400)
      }
      const bad = await call('Hc', 'POST', guardiansPath('P'), {
        email: 'nobody'
      })
      expect(bad.status).equals(400)
    })

    it('lets only administrators and coaches link', async function () {
      for (const key of ['Hk', 'A', 'F', 'P', 'G1', 'Ec']) {
        const answer = await call(key, 'POST', guardiansPath('P'), {
          userId: String(id('B'))
        })
        expect(answer.status, key).equals(404)
      }
      expect(
        (await call(null, 'POST', guardiansPath('P'), { userId: '1' })).status
      ).equals(401)
    })

    it('needs a userId on a team the caller can see', async function () {
      const answer = await call('Hc', 'POST', guardiansPath('P'), {
        userId: String(id('D2'))
      })
      expect(answer.status).equals(404)
    })

    it('links somebody already on the team without touching their membership, and unlinking leaves it', async function () {
      const before = await membership(id('B'))
      const answer = await call('Ha', 'POST', guardiansPath('R'), {
        userId: String(id('B'))
      })
      expect(answer.status).equals(201)
      expect(
        answer.body.guardians.map((g: { userId: string }) => g.userId)
      ).deep.equals([id('B')])
      expect(await membership(id('B'))).deep.equals(before)

      const gone = await call(
        'Hc',
        'DELETE',
        `${guardiansPath('R')}/${id('B')}`
      )
      expect(gone.body).deep.equals({ removed: true })
      expect(await membership(id('B'))).deep.equals(before)
      expect(await relatives('R')).deep.equals([])
    })

    it('links an existing account by address at once, with a membership granted by the link', async function () {
      const answer = await call('Hc', 'POST', guardiansPath('T'), {
        email: ' D@Chat.Example.com '
      })
      expect(answer.status).equals(201)
      expect(answer.body.invited).equals(undefined)
      const link = await database()
        .selectFrom('user_links')
        .select(['id', 'can_manage'])
        .where('user_id', '=', id('D'))
        .where('related_user_id', '=', id('T'))
        .executeTakeFirstOrThrow()
      expect(link.can_manage).equals(true)
      expect((await membership(id('D')))?.granted_by_link_id).equals(link.id)

      // Linking again changes nothing.
      const again = await linkGuardian(
        database(),
        id('T'),
        id('D'),
        hawks,
        null
      )
      expect(again).deep.equals({ linkId: link.id, created: false })

      const gone = await call(
        'Hc',
        'DELETE',
        `${guardiansPath('T')}/${id('D')}`
      )
      expect(gone.body).deep.equals({ removed: true })
      expect(await membership(id('D'))).equals(undefined)
      const twice = await call(
        'Hc',
        'DELETE',
        `${guardiansPath('T')}/${id('D')}`
      )
      expect(twice.body).deep.equals({ removed: false })
    })

    it('links a family member with no membership, and lists them as family', async function () {
      const before = await membership(id('C'))
      const answer = await call('Hc', 'POST', guardiansPath('P'), {
        userId: String(id('C')),
        kind: 'family'
      })
      expect(answer.status).equals(201)
      expect(await membership(id('C'))).deep.equals(before)
      expect(await relatives('P')).deep.equals([
        'G1 guardian',
        'G2 guardian',
        'C family'
      ])
      const link = await database()
        .selectFrom('user_links')
        .select(['kind', 'can_manage'])
        .where('user_id', '=', id('C'))
        .where('related_user_id', '=', id('P'))
        .executeTakeFirstOrThrow()
      expect(link).deep.equals({ kind: 'family', can_manage: false })

      // A family member of D2's, off the team, is given no membership.
      await linkGuardian(database(), id('P'), id('D2'), hawks, null, 'family')
      expect(await membership(id('D2'))).equals(undefined)
      // Made a guardian instead, the family row goes and the link puts them on.
      await linkGuardian(database(), id('P'), id('D2'), hawks, null)
      expect(await relatives('P')).to.include('D2 guardian')
      expect(await relatives('P')).not.to.include('D2 family')
      expect(await membership(id('D2'))).not.equals(undefined)
      // And back to family takes that membership away again.
      await linkGuardian(database(), id('P'), id('D2'), hawks, null, 'family')
      expect(await membership(id('D2'))).equals(undefined)
      await unlinkGuardian(database(), id('P'), id('D2'))
      expect(await relatives('P')).not.to.include('D2 family')
    })

    it('moves a guardian of two siblings to the second link, and removes it with both', async function () {
      await call('Hc', 'POST', guardiansPath('R'), {
        email: 'd2@chat.example.com'
      })
      await call('Hc', 'POST', guardiansPath('T'), {
        email: 'd2@chat.example.com'
      })
      const links = await database()
        .selectFrom('user_links')
        .select(['id', 'related_user_id'])
        .where('user_id', '=', id('D2'))
        .execute()
      const toR = links.find(link => link.related_user_id === id('R'))?.id
      const toT = links.find(link => link.related_user_id === id('T'))?.id
      expect((await membership(id('D2')))?.granted_by_link_id).equals(toR)

      await call('Hc', 'DELETE', `${guardiansPath('R')}/${id('D2')}`)
      expect((await membership(id('D2')))?.granted_by_link_id).equals(toT)

      await call('Hc', 'DELETE', `${guardiansPath('T')}/${id('D2')}`)
      expect(await membership(id('D2'))).equals(undefined)
    })

    it('lets a guardian unlink themselves, and nobody else who is not staff', async function () {
      await call('Hc', 'POST', guardiansPath('R'), {
        email: 'd2@chat.example.com'
      })
      for (const key of ['A', 'P', 'G1']) {
        const refused = await call(
          key,
          'DELETE',
          `${guardiansPath('R')}/${id('D2')}`
        )
        expect(refused.status, key).equals(404)
      }
      const self = await call(
        'D2',
        'DELETE',
        `${guardiansPath('R')}/${id('D2')}`
      )
      expect(self.body).deep.equals({ removed: true })
      expect(await membership(id('D2'))).equals(undefined)
      // Not a player on the team.
      expect(
        (await call('Hc', 'DELETE', `${guardiansPath('A')}/${id('D2')}`)).status
      ).equals(404)
    })

    it('finds and removes a link made to a row since closed into the player', async function () {
      // A roster import's row for R, linked to D2 before it was merged into
      // R: a merge leaves the link on the row it was made for.
      const placeholder = mintUserId()
      await database()
        .insertInto('users')
        .values({
          id: placeholder,
          display_name: 'Riley placeholder'
        })
        .execute()
      const linkId = makeId('userLink')
      await database()
        .insertInto('user_links')
        .values({
          id: linkId,
          user_id: id('D2'),
          related_user_id: placeholder,
          kind: 'guardian',
          can_manage: true
        })
        .execute()
      await database()
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: id('D2'),
          team_id: hawks,
          role: 'member',
          granted_by_link_id: linkId
        })
        .execute()
      await database()
        .updateTable('users')
        .set({ merged_into: id('R') })
        .where('id', '=', placeholder)
        .execute()

      expect(await relatives('R')).includes('D2 guardian')
      const removed = await call(
        'Hc',
        'DELETE',
        `${guardiansPath('R')}/${id('D2')}`
      )
      expect(removed.body).deep.equals({ removed: true })
      expect(await relatives('R')).not.includes('D2 guardian')
      expect(await membership(id('D2'))).equals(undefined)
    })

    it('shows the list to staff, the player and the guardians, and 404 to others', async function () {
      for (const key of ['Hc', 'Ha', 'P', 'G1', 'S', 'L']) {
        expect((await call(key, 'GET', guardiansPath('P'))).status, key).equals(
          200
        )
      }
      for (const key of ['A', 'C', 'F', 'Hk', 'R', 'Ec']) {
        expect((await call(key, 'GET', guardiansPath('P'))).status, key).equals(
          404
        )
      }
      expect((await call('Hc', 'GET', guardiansPath('Ec'))).status).equals(404)
    })
  })

  describe('guardian invites', function () {
    it('mails an invitation to an address with no account, and only that address can use it', async function () {
      const answer = await call('Hc', 'POST', guardiansPath('P'), {
        email: 'Aunt@example.com'
      })
      expect(answer.status).equals(201)
      expect(answer.body.invited.email).equals('aunt@example.com')
      const mail = sent.at(-1)
      expect(mail?.email).equals('aunt@example.com')
      expect(mail?.scopeName).equals('Hawks')
      expect(mail?.link).equals(`http://app.test/i/${answer.body.invited.code}`)

      const invite = await findInviteByCode(
        database(),
        answer.body.invited.code
      )
      expect(invite).deep.include({
        scopeType: 'team',
        scopeId: hawks,
        forEmail: 'aunt@example.com',
        maxUses: 1,
        guardianOfUserId: id('P'),
        relativeKind: 'guardian',
        createdBy: id('Hc')
      })

      // Signing in from another address through it makes nothing.
      expect(
        await settleInviteSignIn(database(), {
          email: 'stranger@example.com',
          inviteId: invite?.id ?? ''
        })
      ).equals(undefined)
      const stranger = await database()
        .selectFrom('user_emails')
        .select(['id'])
        .where('email', '=', 'stranger@example.com')
        .executeTakeFirst()
      expect(stranger).equals(undefined)

      // The aunt signs in from it: the account is made and linked at once.
      const joined = await settleInviteSignIn(database(), {
        email: 'AUNT@example.com',
        inviteId: invite?.id ?? '',
        displayName: 'Ava Aunt'
      })
      expect(joined).deep.include({ createdAccount: true, granted: true })
      const aunt = joined!.userId
      const link = await database()
        .selectFrom('user_links')
        .select(['id', 'kind'])
        .where('user_id', '=', aunt)
        .where('related_user_id', '=', id('P'))
        .executeTakeFirstOrThrow()
      expect(link.kind).equals('guardian')
      const held = await membership(aunt)
      expect(held?.granted_by_link_id).equals(link.id)
      const user = await database()
        .selectFrom('users')
        .select(['login_enabled'])
        .where('id', '=', aunt)
        .executeTakeFirstOrThrow()
      expect(user.login_enabled).equals(true)
    })

    it('refuses a forwarded invitation with inviteForAnotherEmail, linking nothing', async function () {
      const answer = await call('Hc', 'POST', guardiansPath('P'), {
        email: 'uncle@example.com',
        kind: 'family'
      })
      const code: string = answer.body.invited.code
      const redeemed = await call('D', 'POST', `/join/${code}/redeem`)
      expect(redeemed.status).equals(403)
      expect(redeemed.body.code).equals('forbidden')
      expect(redeemed.body.details).deep.equals({
        reason: 'inviteForAnotherEmail'
      })
      const links = await database()
        .selectFrom('user_links')
        .select(['id'])
        .where('user_id', '=', id('D'))
        .execute()
      expect(links).deep.equals([])
      const invite = await findInviteByCode(database(), code)
      expect(invite?.uses).equals(0)
      expect(invite?.relativeKind).equals('family')
    })

    it('links the account that holds the address, as family without a membership', async function () {
      const answer = await call('Hc', 'POST', guardiansPath('R'), {
        email: 'cousin@example.com',
        kind: 'family'
      })
      const invite = await findInviteByCode(
        database(),
        answer.body.invited.code
      )
      if (invite == null) throw new Error('no invite')
      // B adds the address to their own account, then redeems.
      await database()
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: id('B'),
          email: 'Cousin@Example.com'
        })
        .execute()
      const before = await membership(id('B'))
      const result = await redeemInvite(database(), invite, id('B'))
      expect(result.granted).equals(true)
      expect(await relatives('R')).deep.equals(['B family'])
      expect(await membership(id('B'))).deep.equals(before)
      await unlinkGuardian(database(), id('R'), id('B'))
    })

    it('refuses a guardian invite with no address on it', async function () {
      const invite = await findInviteByCode(
        database(),
        (
          await call('Hc', 'POST', guardiansPath('R'), {
            email: 'x@example.com'
          })
        ).body.invited.code
      )
      if (invite == null) throw new Error('no invite')
      let refused: unknown
      await redeemInvite(
        database(),
        { ...invite, forEmail: null },
        id('A')
      ).catch((error: unknown) => {
        refused = error
      })
      expect((refused as { details?: unknown }).details).deep.equals({
        reason: 'inviteForAnotherEmail'
      })
    })
  })

  describe('the manage page', function () {
    it('marks the players on a team grant, and only there', async function () {
      const answer = await call('Ha', 'GET', `/manage/team/${hawks}`)
      expect(answer.status).equals(200)
      const grant = (key: string): { isPlayer?: boolean } =>
        answer.body.people.find((p: { userId: string }) => p.userId === id(key))
          .teams[0]
      expect(grant('P').isPlayer).equals(true)
      expect(grant('A').isPlayer).equals(false)
      expect(answer.body.scope).not.to.have.property('safesportLao')

      const season = await call('S', 'GET', `/manage/season/${seed.seasonId}`)
      for (const person of season.body.people) {
        for (const held of person.seasons) {
          expect(held).not.to.have.property('isPlayer')
        }
      }
    })

    it('says whether the league is a SafeSport LAO, and lets only its admins change it', async function () {
      const league = `/manage/league/${seed.leagueId}`
      expect((await call('L', 'GET', league)).body.scope.safesportLao).equals(
        false
      )

      expect(
        (await call('S', 'PUT', `${league}/safesport`, { lao: true })).status
      ).equals(404)
      expect(
        (await call('Hc', 'PUT', `${league}/safesport`, { lao: true })).status
      ).equals(404)
      expect(
        (await call('L', 'PUT', `${league}/safesport`, { lao: 'yes' })).status
      ).equals(400)
      expect(
        (
          await call('Z', 'PUT', '/manage/league/lea_none/safesport', {
            lao: true
          })
        ).status
      ).equals(404)

      const on = await call('L', 'PUT', `${league}/safesport`, { lao: true })
      expect(on.body).deep.equals({
        leagueId: seed.leagueId,
        safesportLao: true
      })
      expect((await call('L', 'GET', league)).body.scope.safesportLao).equals(
        true
      )
      const off = await call('Z', 'PUT', `${league}/safesport`, { lao: false })
      expect(off.body.safesportLao).equals(false)
    })
  })

  describe('birth months', function () {
    const path = (key: string): string => `/players/${id(key)}/birth-month`

    it('may be set by staff and guardians, and nobody else', async function () {
      const hc = await call('Hc', 'PUT', path('P'), { year: 2012, month: 3 })
      expect(hc.status).equals(200)
      expect(hc.body).deep.equals({ userId: id('P'), birthMonth: '2012-03' })
      const g1 = await call('G1', 'PUT', path('P'), { year: 2012, month: 2 })
      expect(g1.body.birthMonth).equals('2012-02')
      const site = await call('Z', 'PUT', path('P'), { year: 2012, month: 2 })
      expect(site.status).equals(200)

      for (const key of ['P', 'A', 'F', 'Hk', 'Ec']) {
        const refused = await call(key, 'PUT', path('P'), {
          year: 2012,
          month: 3
        })
        expect(refused.status, key).equals(404)
      }
      // Nobody keeps the birth month of somebody who plays nowhere.
      expect(
        (await call('Hc', 'PUT', path('A'), { year: 1990, month: 1 })).status
      ).equals(404)
      expect(
        (
          await call('Hc', 'PUT', '/players/123456789/birth-month', {
            year: 1990,
            month: 1
          })
        ).status
      ).equals(404)
    })

    it('takes a year and a month and never a day', async function () {
      for (const body of [
        { year: 2012, month: 3, day: 14 },
        { year: 2012, month: 13 },
        { year: 2012 },
        { year: 1800, month: 1 },
        { year: 2012.5, month: 1 },
        { year: '2012', month: 1 },
        [2012, 3]
      ]) {
        const answer = await call('Hc', 'PUT', path('P'), body)
        expect(answer.status, JSON.stringify(body)).equals(400)
      }
      const row = await database()
        .selectFrom('users')
        .select(['birth_year', 'birth_month'])
        .where('id', '=', id('P'))
        .executeTakeFirstOrThrow()
      expect(row).deep.equals({ birth_year: 2012, birth_month: 2 })
    })

    it('is shown on the player page only to those who may set it, and can be cleared', async function () {
      const page = async (key: string): Promise<Answer> =>
        await call(key, 'GET', `/players/${id('P')}`)
      expect((await page('Hc')).body.birthMonth).equals('2012-02')
      expect((await page('G2')).body.birthMonth).equals('2012-02')
      for (const key of ['A', 'P', 'R']) {
        const answer = await page(key)
        expect(answer.status, key).equals(200)
        expect(answer.body, key).not.to.have.property('birthMonth')
      }
      const cleared = await call('Hc', 'PUT', path('P'), {
        year: null,
        month: null
      })
      expect(cleared.body).deep.equals({ userId: id('P'), birthMonth: null })
      expect((await page('Hc')).body.birthMonth).equals(null)
    })
  })

  describe('the full name', function () {
    it('is available through guardian and family links but not to an unrelated member', async function () {
      expect(
        await mayEditName(database(), id('G1'), id('P'), { isAdmin: false })
      ).equals(true)
      expect(
        await mayEditName(database(), id('C'), id('P'), { isAdmin: false })
      ).equals(true)
      expect(
        await mayEditName(database(), id('B'), id('P'), { isAdmin: false })
      ).equals(false)
    })
  })
})
