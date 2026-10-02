import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client } from 'pg'
import { base64url } from 'rfc4648'

import { verifiedPrefix } from '../../common/chatCrypto/logHash'
import { makeId } from '../../common/ids'
import { closeInto } from '../admin/people'
import {
  type Answer,
  type ChatFixture,
  openChatFixture
} from '../chat/chatTestFixture'
import { DM_MAX_MEMBERS } from '../chat/dms'
import type { Database } from '../db/database'
import { linkGuardian, unlinkGuardian } from '../people/guardians'

/**
 * U5 through the routes: every person's chats (E3's shape), members, the
 * log and reads, and the DM rules — who may name a player or a fan, the pair
 * rule, the MAAPP rule under `safesport_lao`, sizes, one-to-one reuse, adds,
 * leaves, the re-checks that close a DM, and the chat half of a merge.
 *
 * Today is 10 April 2027: P is 15, E 16, R and T 12. QPLL starts with
 * `safesport_lao` off.
 */

const ALL_STAFF = 'QPLL Spring 2027 All Staff'
const ANNOUNCEMENTS = 'QPLL Spring 2027 Announcements'
const SEASON_STAFF = 'QPLL Spring 2027 Staff'

describe('chat routes and the DM rules (U5)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>

  before(async function () {
    const opened = await openChatFixture('routes')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
  })

  after(async function () {
    await fixture?.close()
  })

  const call = async (
    who: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer> => await fixture.call(who, method, path, body)

  async function titles(who: string): Promise<string[]> {
    const answer = await call(who, 'GET', '/chat/conversations')
    expect(answer.status).equals(200)
    return (answer.body as Array<{ title: string | null }>)
      .map(chat => chat.title ?? 'DM')
      .sort()
  }

  async function chatId(who: string, title: string): Promise<string> {
    const answer = await call(who, 'GET', '/chat/conversations')
    const chat = (answer.body as Array<{ id: string; title: string }>).find(
      item => item.title === title
    )
    if (chat == null) throw new Error(`${who} has no ${title}`)
    return chat.id
  }

  /** `who` starts a DM with these people. */
  async function dm(who: string, keys: string[]): Promise<Answer> {
    return await call(who, 'POST', '/chat/dms', {
      userIds: keys.map(key => fixture.id(key))
    })
  }

  async function memberKeys(conversationId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('chat_members')
      .select(['user_id'])
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute()
    return rows.map(row => fixture.keyOf(row.user_id)).sort()
  }

  async function isClosed(conversationId: string): Promise<boolean> {
    const row = await db
      .selectFrom('chat_conversations')
      .select(['closed_at'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow()
    return row.closed_at != null
  }

  const refusedAs = (answer: Answer, reason: string): void => {
    expect(answer.status, JSON.stringify(answer.body)).equals(
      reason === 'adultRequired' ? 409 : 403
    )
    expect(answer.body.details.reason).equals(reason)
  }

  async function setLao(on: boolean): Promise<void> {
    await db
      .updateTable('leagues')
      .set({ safesport_lao: on })
      .where('id', '=', fixture.seed.leagueId)
      .execute()
    await fixture.drain()
  }

  async function addPlayer(
    key: string,
    team: 'hawks' | 'eagles' | 'owls',
    birth?: { year: number; month: number }
  ): Promise<number> {
    const userId = await fixture.person(key, { birth })
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: fixture.seed.teams[team],
        role: 'member',
        is_player: true
      })
      .execute()
    await fixture.drain()
    return userId
  }

  describe('who is in which chat (E3)', function () {
    const staff = (team: string): string[] => [
      ALL_STAFF,
      ANNOUNCEMENTS,
      `${team} Fans`,
      `${team} Members`,
      `${team} Staff`
    ]
    const member = (team: string): string[] => [
      ANNOUNCEMENTS,
      `${team} Members`
    ]
    const expected: Record<string, string[]> = {
      L: [ALL_STAFF, ANNOUNCEMENTS, 'QPLL Org', SEASON_STAFF],
      S: [ALL_STAFF, ANNOUNCEMENTS, SEASON_STAFF],
      K: [ALL_STAFF, ANNOUNCEMENTS, SEASON_STAFF],
      Z: [],
      Ha: staff('Hawks'),
      Hc: staff('Hawks'),
      Hk: staff('Hawks'),
      Hs: staff('Hawks'),
      P: member('Hawks'),
      R: [],
      T: [],
      Q: [],
      A: member('Hawks'),
      B: member('Hawks'),
      C: member('Hawks'),
      N: member('Hawks'),
      G1: member('Hawks'),
      G2: member('Hawks'),
      F: ['Hawks Fans'],
      Ea: staff('Eagles'),
      Ec: staff('Eagles'),
      Ek: staff('Eagles'),
      Es: staff('Eagles'),
      E: member('Eagles'),
      D: member('Eagles'),
      D2: member('Eagles')
    }
    for (const [who, chats] of Object.entries(expected)) {
      it(`${who}: ${chats.length === 0 ? 'no chats' : chats.join(', ')}`, async function () {
        expect(await titles(who)).deep.equals([...chats].sort())
      })
    }

    it('says who may post, moderate, and how many are in each', async function () {
      const list = async (
        who: string
      ): Promise<Record<string, Record<string, unknown>>> => {
        const answer = await call(who, 'GET', '/chat/conversations')
        return Object.fromEntries(
          (answer.body as Array<Record<string, unknown>>).map(chat => [
            chat.title,
            chat
          ])
        )
      }
      const a = await list('A')
      expect(a[ANNOUNCEMENTS]).to.include({
        kind: 'seasonAnnouncements',
        canPost: false,
        canModerate: false,
        locked: false,
        noHolder: false,
        closed: false,
        lastSeq: 0,
        unread: 0
      })
      expect(a['Hawks Members']).to.include({ canPost: true, memberCount: 11 })
      const s = await list('S')
      expect(s[ANNOUNCEMENTS]).to.include({ canPost: true, canModerate: true })
      const hc = await list('Hc')
      expect(hc['Hawks Members']).to.include({ canModerate: true })
      expect(hc[ALL_STAFF]).to.include({ canModerate: false })
      const hk = await list('Hk')
      expect(hk['Hawks Staff']).to.include({ canModerate: false })
      const l = await list('L')
      expect(l['QPLL Org']).to.include({ canModerate: true })
      expect(l['QPLL Org'].scope).deep.equals({
        type: 'league',
        id: fixture.seed.leagueId
      })
    })

    it('lists members with labels, never the player without an account', async function () {
      const id = await chatId('Hc', 'Hawks Members')
      const answer = await call(
        'Hc',
        'GET',
        `/chat/conversations/${id}/members`
      )
      expect(answer.status).equals(200)
      const byKey = Object.fromEntries(
        (answer.body as Array<{ userId: number }>).map(m => [
          fixture.keyOf(m.userId),
          m
        ])
      )
      expect(Object.keys(byKey).sort()).deep.equals(
        ['A', 'B', 'C', 'G1', 'G2', 'Ha', 'Hc', 'Hk', 'Hs', 'N', 'P'].sort()
      )
      expect(byKey.Q).equals(undefined)
      expect(byKey.Hc).to.include({
        label: 'Coach',
        isModerator: true,
        isApprover: true,
        eligible: false,
        hasIdentity: false,
        identityKey: null,
        generation: null
      })
      expect(byKey.Ha).to.include({ label: 'Admin', isModerator: true })
      expect(byKey.P).to.include({
        label: 'Player',
        isModerator: false,
        isApprover: false
      })
      expect(byKey.G1).to.include({ label: 'Guardian' })
      expect(byKey.A).to.include({ label: 'Member' })
      expect(byKey.Hk).to.include({ label: 'Scorekeeper' })

      const season = await chatId('Hc', ALL_STAFF)
      const all = await call(
        'Hc',
        'GET',
        `/chat/conversations/${season}/members`
      )
      const labels = Object.fromEntries(
        (
          all.body as Array<{
            userId: number
            label: string
            isApprover: boolean
          }>
        ).map(m => [
          fixture.keyOf(m.userId),
          `${m.label}${m.isApprover ? '' : ' (not approver)'}`
        ])
      )
      expect(labels).to.include({
        L: 'League',
        S: 'Season staff',
        Hc: 'Coach · Hawks',
        Ha: 'Admin · Hawks'
      })

      const org = await chatId('L', 'QPLL Org')
      const orgMembers = await call(
        'L',
        'GET',
        `/chat/conversations/${org}/members`
      )
      expect(orgMembers.body[0]).to.include({
        label: 'Admin',
        isModerator: true
      })

      // Q is in no chat's list at all.
      const lists = await db
        .selectFrom('chat_members')
        .select(['user_id'])
        .where('user_id', 'in', [
          fixture.id('Q'),
          fixture.id('R'),
          fixture.id('T')
        ])
        .execute()
      expect(lists).deep.equals([])
    })

    it('answers members, reads and the log to members only', async function () {
      const id = await chatId('Hc', 'Hawks Staff')
      for (const path of ['members', 'reads', 'log']) {
        const answer = await call(
          'A',
          'GET',
          `/chat/conversations/${id}/${path}`
        )
        expect(answer.status, path).equals(404)
      }
      const missing = await call(
        'Hc',
        'GET',
        '/chat/conversations/cnv_nope/log'
      )
      expect(missing.status).equals(404)
    })

    it('serves the hash-chained log, which verifies', async function () {
      const id = await chatId('Hc', 'Hawks Staff')
      const answer = await call(
        'Hc',
        'GET',
        `/chat/conversations/${id}/log?after=0`
      )
      expect(answer.status).equals(200)
      const rows = answer.body as Array<{
        seq: number
        event: 'join'
        userId: number
        actorUserId: number | null
        reason: string | null
        prevHash: string
        hash: string
        at: number
      }>
      expect(rows.map(row => row.seq)).deep.equals([1, 2, 3, 4])
      const parse = (text: string): Uint8Array =>
        base64url.parse(text, { loose: true })
      expect(
        verifiedPrefix(
          new Uint8Array(32),
          rows.map(row => ({
            conversationId: id,
            seq: row.seq,
            event: row.event,
            userId: row.userId,
            actorUserId: row.actorUserId,
            reason: row.reason,
            at: row.at,
            prevHash: parse(row.prevHash),
            hash: parse(row.hash)
          }))
        )
      ).equals(4)
      const later = await call(
        'Hc',
        'GET',
        `/chat/conversations/${id}/log?after=3`
      )
      expect(later.body.map((row: { seq: number }) => row.seq)).deep.equals([4])
      const junk = await call(
        'Hc',
        'GET',
        `/chat/conversations/${id}/log?after=x`
      )
      expect(junk.body).to.have.length(4)
    })

    it('serves every member’s read cursor', async function () {
      const id = await chatId('Hc', 'Hawks Staff')
      await db
        .insertInto('chat_read_cursors')
        .values({ conversation_id: id, user_id: fixture.id('Ha'), seq: 3 })
        .execute()
      const answer = await call('Hc', 'GET', `/chat/conversations/${id}/reads`)
      expect(answer.body).deep.equals([{ userId: fixture.id('Ha'), seq: 3 }])
    })

    it('needs a session', async function () {
      const answer = await call('nobody', 'GET', '/chat/conversations')
      expect(answer.status).equals(401)
    })
  })

  describe('naming people in a DM', function () {
    it('lets P be named by guardians, staff, season staff, the league and season-mates', async function () {
      for (const who of ['G1', 'Hc', 'S', 'K', 'L', 'E']) {
        const answer = await dm(who, ['P'])
        expect(answer.status, `${who}: ${JSON.stringify(answer.body)}`).equals(
          201
        )
        expect(answer.body).to.include({
          kind: 'dm',
          title: null,
          memberCount: 2,
          closed: false
        })
        expect(await memberKeys(answer.body.id)).deep.equals([who, 'P'].sort())
      }
    })

    it('refuses P to parents, fans, other teams’ staff and All Staff', async function () {
      for (const who of ['A', 'F', 'Ec', 'Ea']) {
        const answer = await dm(who, ['P'])
        refusedAs(answer, 'notCandidate')
        expect(answer.body.details.userIds).deep.equals([fixture.id('P')])
      }
    })

    it('lets P name their own staff, season staff and league, as they may name P', async function () {
      for (const who of ['Hc', 'Ha', 'S', 'K', 'L']) {
        // A DM P and Hc already share comes back as it is (200).
        const answer = await dm('P', [who])
        expect([200, 201], `${who}: ${JSON.stringify(answer.body)}`).includes(
          answer.status
        )
        expect(await memberKeys(answer.body.id)).deep.equals(['P', who].sort())
      }
      for (const who of ['A', 'F', 'Ec', 'Ea']) {
        refusedAs(await dm('P', [who]), 'notCandidate')
      }
    })

    it('never names a player under 13 or without an account', async function () {
      refusedAs(await dm('Hc', ['R']), 'notCandidate')
      refusedAs(await dm('Hc', ['Q']), 'notCandidate')
      refusedAs(await dm('R', ['Hc']), 'notCandidate')
    })

    it('lets fan F be named by Hawks staff, season staff, All Staff and the league', async function () {
      for (const who of ['Hc', 'S', 'Ec', 'L']) {
        const answer = await dm(who, ['F'])
        expect(answer.status, who).equals(201)
      }
      refusedAs(await dm('A', ['F']), 'notCandidate')
    })

    it('gives a follow-only user nobody to name and nothing to add', async function () {
      const candidates = await call('F', 'GET', '/chat/dm-candidates')
      expect(candidates.body).deep.equals([])
      refusedAs(await dm('F', ['Hc']), 'notCandidate')
      const hcF = (await dm('Hc', ['F'])).body.id as string
      const add = await call('F', 'POST', `/chat/dms/${hcF}/members`, {
        userIds: [fixture.id('Ha')]
      })
      refusedAs(add, 'notCandidate')
    })

    it('reuses an open one-to-one', async function () {
      const first = await dm('Hc', ['P'])
      const second = await dm('Hc', ['P'])
      expect(second.status).equals(200)
      expect(second.body.id).equals(first.body.id)
    })

    it('keeps the pair rule on adds', async function () {
      const hcP = (await dm('Hc', ['P'])).body.id as string
      refusedAs(
        await call('Hc', 'POST', `/chat/dms/${hcP}/members`, {
          userIds: [fixture.id('F')]
        }),
        'notCandidate'
      )
      refusedAs(
        await call('Hc', 'POST', `/chat/dms/${hcP}/members`, {
          userIds: [fixture.id('Ec')]
        }),
        'notCandidate'
      )
      expect(await memberKeys(hcP)).deep.equals(['Hc', 'P'])
    })

    it('lists exactly the candidates, never Fans-only or Announcements-only co-members', async function () {
      const names = async (who: string, q = ''): Promise<string[]> => {
        const answer = await call(
          who,
          'GET',
          `/chat/dm-candidates?q=${encodeURIComponent(q)}`
        )
        expect(answer.status).equals(200)
        return (answer.body as Array<{ userId: number }>)
          .map(person => fixture.keyOf(person.userId))
          .sort()
      }
      expect(await names('A')).deep.equals(
        ['B', 'C', 'G1', 'G2', 'Ha', 'Hc', 'Hk', 'Hs', 'N'].sort()
      )
      expect(await names('A', 'blair')).deep.equals(['B'])
      const hc = await names('Hc')
      expect(hc).includes('F')
      expect(hc).includes('P')
      expect(hc).includes('Ec')
      expect(hc).not.includes('R')
      expect(hc).not.includes('D')
      // Parents share Hawks Members with P but the pair rule keeps them
      // out; P's staff (team, season and league) may name P, so P may name
      // them back.
      expect(await names('P')).deep.equals(
        ['E', 'G1', 'G2', 'Ha', 'Hc', 'Hk', 'Hs', 'K', 'L', 'S'].sort()
      )
      expect(await names('R')).deep.equals([])
    })
  })

  describe('sizes, adds and leaves', function () {
    it('refuses a DM of fewer than 2 or more than 20', async function () {
      const none = await dm('Hc', [])
      expect(none.status).equals(400)
      expect(none.body.details.reason).equals('dmSize')
      const self = await dm('Hc', ['Hc'])
      expect(self.status).equals(400)
      const extra: string[] = []
      for (let i = 0; i < DM_MAX_MEMBERS - 2; i += 1) {
        const key = `M${i}`
        const userId = await fixture.person(key)
        await db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: userId,
            team_id: fixture.seed.teams.hawks,
            role: 'member'
          })
          .execute()
        extra.push(key)
      }
      await fixture.drain()
      const tooMany = await dm('Hc', [...extra, 'A', 'B'])
      expect(tooMany.status).equals(400)
      const full = await dm('Hc', [...extra, 'A'])
      expect(full.status).equals(201)
      expect(full.body.memberCount).equals(DM_MAX_MEMBERS)
      const over = await call(
        'Hc',
        'POST',
        `/chat/dms/${full.body.id}/members`,
        {
          userIds: [fixture.id('B')]
        }
      )
      expect(over.status).equals(400)
      expect(over.body.details.reason).equals('dmSize')
    })

    it('writes a join on an add, opens a grant request, notifies, and a leave flags rotation', async function () {
      const group = await dm('Ha', ['A'])
      expect(group.status).equals(201)
      const id = group.body.id as string
      // An epoch, and B with an identity.
      const identity = async (key: string): Promise<string> => {
        const identityId = makeId('chatIdentity')
        await db
          .insertInto('chat_identities')
          .values({
            id: identityId,
            user_id: fixture.id(key),
            identity_public_key: new Uint8Array(32).fill(1)
          })
          .execute()
        await db
          .insertInto('chat_user_keys')
          .values({
            user_id: fixture.id(key),
            identity_id: identityId,
            generation: 1,
            public_key: new Uint8Array(32),
            signature: new Uint8Array(64)
          })
          .execute()
        return identityId
      }
      const ha = await identity('Ha')
      await identity('B')
      await db
        .insertInto('chat_epochs')
        .values({
          conversation_id: id,
          epoch: 1,
          created_by_user_id: fixture.id('Ha'),
          identity_id: ha,
          signature: new Uint8Array(64)
        })
        .execute()
      await db
        .insertInto('chat_epoch_boxes')
        .values({
          conversation_id: id,
          epoch: 1,
          user_id: fixture.id('Ha'),
          identity_id: ha,
          generation: 1,
          box: new Uint8Array(48)
        })
        .execute()

      const listener = new Client({ connectionString: fixture.url })
      await listener.connect()
      const heard: string[] = []
      listener.on('notification', message => {
        if (message.payload != null) heard.push(message.payload)
      })
      await listener.query('listen chat_changes')
      const add = await call('Ha', 'POST', `/chat/dms/${id}/members`, {
        userIds: [fixture.id('B'), fixture.id('A')]
      })
      expect(add.status).equals(200)
      expect(add.body.added).deep.equals([fixture.id('B')])
      const again = await call('Ha', 'POST', `/chat/dms/${id}/members`, {
        userIds: [fixture.id('B')]
      })
      expect(again.body.added).deep.equals([])
      await new Promise(resolve => setTimeout(resolve, 200))
      await listener.end()
      expect(heard).includes(JSON.stringify({ c: id, k: 'members' }))
      expect(heard).includes(JSON.stringify({ c: id, k: 'grant' }))

      const lastLog = async (): Promise<Record<string, unknown>> =>
        await db
          .selectFrom('chat_membership_log')
          .select(['event', 'user_id', 'actor_user_id', 'reason'])
          .where('conversation_id', '=', id)
          .orderBy('seq', 'desc')
          .executeTakeFirstOrThrow()
      expect(await lastLog()).deep.equals({
        event: 'join',
        user_id: fixture.id('B'),
        actor_user_id: fixture.id('Ha'),
        reason: 'added'
      })
      const requests = await db
        .selectFrom('chat_grant_requests')
        .select(['user_id'])
        .where('conversation_id', '=', id)
        .execute()
      expect(requests).deep.equals([{ user_id: fixture.id('B') }])

      // As the list shows it to Ha (holder) and B (not yet).
      const listed = async (who: string): Promise<Record<string, unknown>> =>
        (
          (await call(who, 'GET', '/chat/conversations')).body as Array<{
            id: string
          }>
        ).find(chat => chat.id === id) as Record<string, unknown>
      expect(await listed('Ha')).to.include({ locked: false, noHolder: false })
      expect(await listed('B')).to.include({ locked: true, noHolder: false })
      const members = await call(
        'B',
        'GET',
        `/chat/conversations/${id}/members`
      )
      const ha2 = (members.body as Array<{ userId: number }>).find(
        m => m.userId === fixture.id('Ha')
      )
      expect(ha2).to.include({
        hasIdentity: true,
        eligible: true,
        generation: 1,
        label: 'Member',
        isModerator: false,
        isApprover: true
      })

      const leave = await call('Ha', 'DELETE', `/chat/dms/${id}/members/me`)
      expect(leave.body).deep.equals({ left: true, closed: false })
      expect(await lastLog()).deep.equals({
        event: 'leave',
        user_id: fixture.id('Ha'),
        actor_user_id: fixture.id('Ha'),
        reason: 'left'
      })
      const row = await db
        .selectFrom('chat_conversations')
        .select(['needs_rotation'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.needs_rotation).equals(true)
      expect(await listed('B')).to.include({ noHolder: true })
      // Gone: no more reads, no second leave, no adds.
      expect(
        (await call('Ha', 'GET', `/chat/conversations/${id}/members`)).status
      ).equals(404)
      expect(
        (await call('Ha', 'DELETE', `/chat/dms/${id}/members/me`)).status
      ).equals(404)
      expect(
        (
          await call('Ha', 'POST', `/chat/dms/${id}/members`, {
            userIds: [fixture.id('C')]
          })
        ).status
      ).equals(404)
      // The reconciler leaves DM membership alone.
      await fixture.drain()
      expect(await memberKeys(id)).deep.equals(['A', 'B'])
    })

    it('names a DM’s people, current and former, only to those who were in it with them', async function () {
      const start = fixture.now
      const later = (): void => {
        fixture.now = new Date(fixture.now.getTime() + 1000)
      }
      type Listed = Array<{
        id: string
        kind: string
        memberCount: number
        people: Array<{ userId: number; shortName: string; left: boolean }>
      }>
      const peopleOf = async (
        who: string,
        id: string
      ): Promise<Array<[string, boolean]> | undefined> =>
        ((await call(who, 'GET', '/chat/conversations')).body as Listed)
          .find(chat => chat.id === id)
          ?.people.map(person => [fixture.keyOf(person.userId), person.left])
      try {
        const created = await dm('Ha', ['A', 'Hc'])
        expect(created.status, JSON.stringify(created.body)).equals(201)
        const id = created.body.id as string
        expect(
          (created.body.people as Array<{ userId: number }>)
            .map(person => fixture.keyOf(person.userId))
            .sort()
        ).deep.equals(['A', 'Hc'])
        later()
        expect(
          (await call('Hc', 'DELETE', `/chat/dms/${id}/members/me`)).status
        ).equals(200)
        later()
        const add = await call('Ha', 'POST', `/chat/dms/${id}/members`, {
          userIds: [fixture.id('B')]
        })
        expect(add.body.added).deep.equals([fixture.id('B')])
        later()

        // A was there throughout; B came after Hc had gone, so never sees Hc.
        expect(new Map(await peopleOf('A', id))).deep.equals(
          new Map([
            ['B', false],
            ['Ha', false],
            ['Hc', true]
          ])
        )
        expect(new Map(await peopleOf('B', id))).deep.equals(
          new Map([
            ['A', false],
            ['Ha', false]
          ])
        )
        // Hc is gone, so the DM is not theirs to list.
        expect(await peopleOf('Hc', id)).equals(undefined)

        // Everybody else leaves: A still has the names, each marked.
        await call('Ha', 'DELETE', `/chat/dms/${id}/members/me`)
        await call('B', 'DELETE', `/chat/dms/${id}/members/me`)
        const alone = (
          (await call('A', 'GET', '/chat/conversations')).body as Listed
        ).find(chat => chat.id === id)
        expect(alone?.memberCount).equals(1)
        expect(new Map(await peopleOf('A', id))).deep.equals(
          new Map([
            ['B', true],
            ['Ha', true],
            ['Hc', true]
          ])
        )
        // Short names, as the members list gives them.
        const names = alone?.people.map(person => person.shortName) ?? []
        expect(names).deep.equals([...names].sort((a, b) => a.localeCompare(b)))
        expect(names.every(name => name.length > 0)).equals(true)

        // A scope chat names nobody this way.
        const scoped = (
          (await call('A', 'GET', '/chat/conversations')).body as Listed
        ).filter(chat => chat.kind !== 'dm')
        expect(scoped.length).to.be.greaterThan(0)
        for (const chat of scoped) expect(chat.people).deep.equals([])
      } finally {
        fixture.now = start
      }
    })

    it('refuses a bad body and a scope chat as a DM', async function () {
      const bad = await call('Hc', 'POST', '/chat/dms', { userIds: ['x'] })
      expect(bad.status).equals(400)
      const team = await chatId('Hc', 'Hawks Staff')
      const add = await call('Hc', 'POST', `/chat/dms/${team}/members`, {
        userIds: [fixture.id('A')]
      })
      expect(add.status).equals(404)
    })
  })

  describe('the MAAPP rule', function () {
    let hcP = ''

    it('closes an open coach–player DM when the league turns SafeSport on', async function () {
      hcP = (await dm('Hc', ['P'])).body.id as string
      await setLao(true)
      expect(await isClosed(hcP)).equals(true)
      const last = await db
        .selectFrom('chat_membership_log')
        .select(['event', 'user_id', 'actor_user_id', 'reason'])
        .where('conversation_id', '=', hcP)
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow()
      expect(last).deep.equals({
        event: 'closed',
        user_id: fixture.id('P'),
        actor_user_id: null,
        reason: 'adultRequired'
      })
      const listed = (
        (await call('P', 'GET', '/chat/conversations')).body as Array<{
          id: string
          closed: boolean
          canPost: boolean
        }>
      ).find(chat => chat.id === hcP)
      expect(listed).to.include({ closed: true, canPost: false })
      // A closed one is never reused, and adding to it is refused.
      const add = await call('Hc', 'POST', `/chat/dms/${hcP}/members`, {
        userIds: [fixture.id('G1')]
      })
      expect(add.status).equals(409)
      expect(add.body.details.reason).equals('closed')
    })

    it('asks a coach for another adult, and takes a guardian, family or staff', async function () {
      const alone = await dm('Hc', ['P'])
      refusedAs(alone, 'adultRequired')
      expect(alone.body.details.playerIds).deep.equals([fixture.id('P')])

      const withGuardian = await dm('Hc', ['P', 'G1'])
      expect(withGuardian.status).equals(201)
      expect(await memberKeys(withGuardian.body.id)).deep.equals(
        ['G1', 'Hc', 'P'].sort()
      )

      await linkGuardian(
        db,
        fixture.id('P'),
        fixture.id('B'),
        fixture.seed.teams.hawks,
        null,
        'family'
      )
      await fixture.drain()
      const withFamily = await dm('Hc', ['P', 'B'])
      expect(withFamily.status).equals(201)
      expect(withFamily.body.memberCount).equals(3)

      const withStaff = await dm('Hc', ['P', 'K'])
      expect(withStaff.status).equals(201)
      expect(withStaff.body.memberCount).equals(3)
    })

    it('needs nobody for two young players, or a guardian and child', async function () {
      const pe = await dm('E', ['P'])
      expect([200, 201]).includes(pe.status)
      const g1 = await dm('G1', ['P'])
      expect([200, 201]).includes(g1.status)
      const p = await dm('P', ['G2'])
      expect(p.status).equals(201)
    })

    it('counts a player of 21 as an adult beside P', async function () {
      await addPlayer('X21', 'eagles', { year: 2006, month: 1 })
      refusedAs(await dm('X21', ['P']), 'adultRequired')
    })

    it('takes coach, player and season staff for a player with no guardian', async function () {
      await addPlayer('P2', 'hawks', { year: 2012, month: 1 })
      expect((await dm('Hc', ['P2', 'K'])).status).equals(201)
    })

    it('treats a player with no birth month as under 18', async function () {
      await addPlayer('P3', 'hawks')
      refusedAs(await dm('Hc', ['P3']), 'adultRequired')
    })

    it('suggests guardians, family and immediate coaches, and finds staff by name', async function () {
      const adults = async (who: string, q = ''): Promise<string[]> => {
        const answer = await call(
          who,
          'GET',
          `/chat/included-adults?playerIds=${fixture.id('P')}&q=${encodeURIComponent(q)}`
        )
        expect(answer.status, JSON.stringify(answer.body)).equals(200)
        return (answer.body as Array<{ userId: number; label: string }>)
          .map(adult => `${fixture.keyOf(adult.userId)} ${adult.label}`)
          .sort()
      }
      expect(await adults('Hc')).deep.equals(
        ['B Family', 'G1 Guardian', 'G2 Guardian', 'Ha Admin · Hawks'].sort()
      )
      expect(await adults('K')).deep.equals(
        [
          'B Family',
          'G1 Guardian',
          'G2 Guardian',
          'Ha Admin · Hawks',
          'Hc Coach · Hawks'
        ].sort()
      )
      expect(await adults('Hc', 'keeper')).deep.equals(['K Season staff'])
      expect(await adults('Hc', 'sam')).deep.equals(['S Season staff'])
      expect(await adults('Hc', 'lena')).deep.equals(['L League'])
      expect(await adults('Hc', 'scorer')).deep.equals([
        'Hk Scorekeeper · Hawks'
      ])
      expect(await adults('K', 'coach')).deep.equals(['Hc Coach · Hawks'])
      expect(await adults('Hc', 'coach')).deep.equals([])
      expect(await adults('Hc', 'fan')).deep.equals([])
      expect(await adults('Hc', 'ashby')).deep.equals([])
      refusedAs(
        await call(
          'A',
          'GET',
          `/chat/included-adults?playerIds=${fixture.id('P')}`
        ),
        'notCandidate'
      )
      expect(
        (await call('Hc', 'GET', '/chat/included-adults?playerIds=')).status
      ).equals(404)
      expect(
        (await call('Hc', 'GET', '/chat/included-adults?playerIds=junk')).status
      ).equals(404)
    })

    it('lets the included adult leave, and closes the DM', async function () {
      const three = await dm('Hc', ['P', 'K'])
      const id = three.body.id as string
      const leave = await call('K', 'DELETE', `/chat/dms/${id}/members/me`)
      expect(leave.body).deep.equals({ left: true, closed: true })
      expect(await isClosed(id)).equals(true)
      const last = await db
        .selectFrom('chat_membership_log')
        .select(['event', 'user_id', 'actor_user_id', 'reason'])
        .where('conversation_id', '=', id)
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow()
      expect(last).deep.equals({
        event: 'closed',
        user_id: fixture.id('P'),
        actor_user_id: fixture.id('K'),
        reason: 'adultRequired'
      })
      // Leaving a closed DM is still allowed.
      const hc = await call('Hc', 'DELETE', `/chat/dms/${id}/members/me`)
      expect(hc.body).deep.equals({ left: true, closed: true })
    })

    it('closes a DM when a birth month makes a member an adult', async function () {
      const pe = (await dm('E', ['P'])).body.id as string
      expect(await isClosed(pe)).equals(false)
      await db
        .updateTable('users')
        .set({ birth_year: 2005, birth_month: 1 })
        .where('id', '=', fixture.id('E'))
        .execute()
      await fixture.drain()
      expect(await isClosed(pe)).equals(true)
      await db
        .updateTable('users')
        .set({ birth_year: 2011, birth_month: 2 })
        .where('id', '=', fixture.id('E'))
        .execute()
      await fixture.drain()
    })

    it('closes a DM when a guardian is unlinked', async function () {
      const g1p = (await dm('G1', ['P'])).body.id as string
      expect(await isClosed(g1p)).equals(false)
      await unlinkGuardian(db, fixture.id('P'), fixture.id('G1'))
      await fixture.drain()
      expect(await isClosed(g1p)).equals(true)
    })

    it('closes a DM when a staff role goes', async function () {
      const hk = (await dm('Hk', ['P', 'G2'])).body.id as string
      expect(await isClosed(hk)).equals(false)
      await db
        .deleteFrom('scope_roles')
        .where('user_id', '=', fixture.id('Hk'))
        .where('scope_id', '=', fixture.seed.teams.hawks)
        .execute()
      await fixture.drain()
      expect(await isClosed(hk)).equals(true)
    })

    it('closes a DM when the player leaves the team', async function () {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: fixture.id('P'),
          team_id: fixture.seed.teams.owls,
          role: 'member',
          is_player: true
        })
        .execute()
      await fixture.drain()
      const id = (await dm('Hc', ['P', 'K'])).body.id as string
      expect(await isClosed(id)).equals(false)
      await db
        .deleteFrom('memberships')
        .where('user_id', '=', fixture.id('P'))
        .where('team_id', '=', fixture.seed.teams.hawks)
        .execute()
      await fixture.drain()
      expect(await isClosed(id)).equals(true)
    })

    it('turns off again, and never reuses a closed one-to-one', async function () {
      await setLao(false)
      const p2 = await dm('Hc', ['P2'])
      expect(p2.status).equals(201)
      expect(p2.body.memberCount).equals(2)
      await db
        .updateTable('chat_conversations')
        .set({ closed_at: new Date() })
        .where('id', '=', p2.body.id)
        .execute()
      const again = await dm('Hc', ['P2'])
      expect(again.status).equals(201)
      expect(again.body.id).not.equals(p2.body.id)
    })
  })

  describe('merges and chat', function () {
    it('moves the closed row’s DMs to the survivor, then re-checks them', async function () {
      // B and C, two Hawks parents, share a DM with an epoch.
      const bc = (await dm('B', ['C'])).body.id as string
      const c = fixture.id('C')
      const cIdentity = makeId('chatIdentity')
      await db
        .insertInto('chat_identities')
        .values({
          id: cIdentity,
          user_id: c,
          identity_public_key: new Uint8Array(32).fill(3)
        })
        .execute()
      await db
        .insertInto('chat_user_keys')
        .values({
          user_id: c,
          identity_id: cIdentity,
          generation: 1,
          public_key: new Uint8Array(32),
          signature: new Uint8Array(64)
        })
        .execute()
      await db
        .insertInto('chat_epochs')
        .values({
          conversation_id: bc,
          epoch: 1,
          created_by_user_id: c,
          identity_id: cIdentity,
          signature: new Uint8Array(64)
        })
        .execute()
      await db
        .insertInto('chat_devices')
        .values({
          id: makeId('chatDevice'),
          user_id: c,
          name: 'phone',
          platform: 'ios',
          box_public_key: new Uint8Array(32),
          sign_public_key: new Uint8Array(32)
        })
        .execute()

      // C is merged into P4, a Hawks player of 15 with an identity.
      const p4 = await addPlayer('P4', 'hawks', { year: 2012, month: 1 })
      const p4Identity = makeId('chatIdentity')
      await db
        .insertInto('chat_identities')
        .values({
          id: p4Identity,
          user_id: p4,
          identity_public_key: new Uint8Array(32).fill(4)
        })
        .execute()
      await db
        .insertInto('chat_user_keys')
        .values({
          user_id: p4,
          identity_id: p4Identity,
          generation: 1,
          public_key: new Uint8Array(32),
          signature: new Uint8Array(64)
        })
        .execute()
      await closeInto(db, c, p4)

      const sessions = await db
        .selectFrom('auth_sessions')
        .select(['revoked_at'])
        .where('user_id', '=', c)
        .execute()
      expect(sessions.every(row => row.revoked_at != null)).equals(true)
      expect((await call('C', 'GET', '/chat/conversations')).status).equals(401)
      const devices = await db
        .selectFrom('chat_devices')
        .select(['revoked_at'])
        .where('user_id', '=', c)
        .execute()
      expect(devices.every(row => row.revoked_at != null)).equals(true)

      const rows = await db
        .selectFrom('chat_membership_log')
        .select(['event', 'user_id', 'reason'])
        .where('conversation_id', '=', bc)
        .orderBy('seq')
        .execute()
      expect(rows.slice(-2)).deep.equals([
        { event: 'join', user_id: p4, reason: 'merged' },
        { event: 'leave', user_id: c, reason: 'merged' }
      ])
      const requests = await db
        .selectFrom('chat_grant_requests')
        .select(['user_id'])
        .where('conversation_id', '=', bc)
        .execute()
      expect(requests).deep.equals([{ user_id: p4 }])
      const conversation = await db
        .selectFrom('chat_conversations')
        .select(['needs_rotation'])
        .where('id', '=', bc)
        .executeTakeFirstOrThrow()
      expect(conversation.needs_rotation).equals(true)
      // The survivor's DM names B, never the account merged into them.
      const p4Listed = (
        (await call('P4', 'GET', '/chat/conversations')).body as Array<{
          id: string
          people: Array<{ userId: number; left: boolean }>
        }>
      ).find(chat => chat.id === bc)
      expect(p4Listed?.people.map(person => person.userId)).deep.equals([
        fixture.id('B')
      ])

      // A parent and a player of 15 who is not theirs: the pair rule closes it.
      expect(await isClosed(bc)).equals(false)
      await fixture.drain()
      expect(await isClosed(bc)).equals(true)
    })
  })
})
