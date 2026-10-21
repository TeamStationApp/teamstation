import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { Notification } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import { createSession } from '../auth/sessions'
import { createRelationshipRequest } from './requests'

const DAY = 24 * 3600 * 1000

describe('guardian invitations and requests', function () {
  this.timeout(60000)
  let f: GuardianFixture
  let key = 0
  beforeEach(async () => {
    f = await guardianFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  interface Answer {
    status: number
    body: any
  }
  const call = async (
    method: string,
    route: string,
    body: unknown,
    user: number
  ): Promise<Answer> => {
    const response = await f.h.request(method, route, body, user)
    return { status: response.status, body: await response.json() }
  }
  /** A team's invitation, from Demo Hawks unless told otherwise. */
  const invite = async (
    playerUserId: number,
    guardian: { userId: string } | { email: string },
    user: number = f.people.teamCoach,
    team: string = f.teamA
  ): Promise<Answer> =>
    await call(
      'POST',
      '/relationship-requests',
      {
        kind: 'guardian',
        playerUserId: userIdOfGumbo(playerUserId),
        guardian,
        sender: { kind: 'team', id: team },
        idempotencyKey: `guardian-invite-${++key}`
      },
      user
    )
  /** Somebody asking to be a player's guardian themselves. */
  const ask = async (playerUserId: number, user: number): Promise<Answer> =>
    await call(
      'POST',
      '/relationship-requests',
      {
        kind: 'guardian',
        playerUserId: userIdOfGumbo(playerUserId),
        guardian: { userId: userIdOfGumbo(user) },
        idempotencyKey: `guardian-ask-${++key}`
      },
      user
    )
  const decide = async (
    id: string,
    decision: 'accept' | 'decline' | 'withdraw' | 'resend',
    user: number
  ): Promise<Answer> =>
    await call(
      'POST',
      `/relationship-requests/${id}/${decision}`,
      { idempotencyKey: `guardian-decide-${++key}` },
      user
    )
  const inbox = async (
    user: number,
    query = ''
  ): Promise<{ items: Notification[]; hasPending: boolean }> => {
    const answer = await call(
      'GET',
      `/me/notifications${query}`,
      undefined,
      user
    )
    expect(answer.status).equals(200)
    return answer.body
  }
  const guardians = async (playerUserId: number): Promise<string[]> =>
    (
      await f.h.db
        .selectFrom('user_links')
        .select('user_id')
        .where('related_user_id', '=', userIdOfGumbo(playerUserId))
        .where('kind', '=', 'guardian')
        .where('can_manage', '=', true)
        .orderBy('user_id')
        .execute()
    ).map(row => row.user_id)
  /** A new account that signs in with this address. */
  const person = async (
    id: number,
    name: string,
    email: string | null
  ): Promise<void> => {
    await insertFixtureUsers(f.h.db, {
      id,
      legacyId: `usr_guardian_request_${id}`,
      display_name: name,
      first_name: name.split(' ')[0],
      last_name: name.split(' ')[1],
      login_enabled: true
    })
    if (email != null) await verify(id, email)
    f.h.tokens.set(
      id,
      (await createSession(f.h.db, userIdOfGumbo(id), 'guardian')).token
    )
  }
  const verify = async (id: number, email: string): Promise<void> => {
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: `email_guardian_request_${++key}`,
        user_id: userIdOfGumbo(id),
        email,
        is_primary: false,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
  }
  /** Lets a player's own account sign in. */
  const signsIn = async (id: number, email: string): Promise<void> => {
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', userIdOfGumbo(id))
      .execute()
    await verify(id, email)
    f.h.tokens.set(
      id,
      (await createSession(f.h.db, userIdOfGumbo(id), 'guardian')).token
    )
  }
  /** Somebody already a guardian of a player, as an import or an admin made them. */
  const link = async (userId: number, playerUserId: number): Promise<void> => {
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(userId),
        related_user_id: userIdOfGumbo(playerUserId),
        kind: 'guardian',
        can_manage: true,
        created_at: new Date()
      })
      .execute()
  }
  /** One of a player's guardians inviting somebody else, with no team. */
  const byGuardian = async (
    playerUserId: number,
    guardian: { userId: string } | { email: string },
    user: number = f.people.guardian,
    idempotencyKey = `guardian-by-guardian-${++key}`
  ): Promise<Answer> =>
    await call(
      'POST',
      '/relationship-requests',
      {
        kind: 'guardian',
        playerUserId: userIdOfGumbo(playerUserId),
        guardian,
        idempotencyKey
      },
      user
    )
  /** How `GET /players/:userId` says this user may invite a guardian. */
  const inviteAs = async (
    playerUserId: number,
    user: number
  ): Promise<unknown> => {
    const answer = await call(
      'GET',
      `/players/${userIdOfGumbo(playerUserId)}`,
      undefined,
      user
    )
    expect(answer.status, `player ${playerUserId} as ${user}`).equals(200)
    return answer.body.guardianInviteAs
  }
  const role = async (
    userId: number,
    scopeType: 'season' | 'team',
    scopeId: string,
    name: 'assistant' | 'songkeeper'
  ): Promise<void> => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(userId),
        scope_type: scopeType,
        scope_id: scopeId,
        role: name,
        granted_by: userIdOfGumbo(101),
        granted_at: new Date()
      })
      .execute()
  }

  describe('invitations', () => {
    it('lets a coach invite an address, mails it, and makes whoever verifies it and accepts the guardian', async () => {
      const sent = await invite(202, { email: 'New.Parent@example.com' })
      expect(sent.status).equals(201)
      expect(sent.body.status).equals('pending')
      const id: string = sent.body.id
      expect(f.h.invitations.get('new.parent@example.com')).deep.equals({
        playerName: 'Ben C',
        teamName: 'Demo Hawks',
        invitedBy: 'Ichiro',
        link: `/notifications/${id}`
      })
      expect(
        (await inbox(f.people.teamCoach, '?sent=1')).items.map(item => [
          item.requestId,
          item.canWithdraw,
          item.canResend
        ])
      ).deep.equals([[id, true, false]])

      await person(301, 'Pat Neshek', 'new.parent@example.com')
      const waiting = await inbox(301)
      expect(waiting.hasPending).equals(true)
      expect(
        waiting.items.map(({ requestId, type, title, description }) => ({
          requestId,
          type,
          title,
          description
        }))
      ).deep.equals([
        {
          requestId: id,
          type: 'guardian',
          title: 'Be a guardian of Ben C',
          description:
            "Ichiro from Demo Hawks invited you to be Ben C's guardian."
        }
      ])
      const accepted = await decide(id, 'accept', 301)
      expect(accepted.body).deep.equals({ id, status: 'accepted' })
      expect(await guardians(202)).deep.equals([301].map(userIdOfGumbo))
      const request = await f.h.db
        .selectFrom('group_requests')
        .select('terms')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(request.terms).deep.equals({
        kind: 'guardian',
        playerUserId: userIdOfGumbo(202),
        guardian: {
          userId: userIdOfGumbo(301),
          email: 'new.parent@example.com'
        }
      })
      expect(
        (await call('GET', '/me/roles', undefined, 301)).body.guardianOf
      ).deep.equals([userIdOfGumbo(202)])
    })

    it('lets an assistant invite an account, by its address or by id, which accepts from its inbox', async () => {
      const byAddress = await invite(
        203,
        { email: 'follower@example.com' },
        f.people.assistant
      )
      expect(byAddress.status).equals(201)
      expect(f.h.invitations.get('follower@example.com')).deep.include({
        playerName: 'Cody D',
        invitedBy: 'Owen Miller'
      })
      const sides = await f.h.db
        .selectFrom('group_request_sides')
        .select(['scope_type', 'scope_id', 'approved_by'])
        .where('request_id', '=', byAddress.body.id)
        .orderBy('scope_type')
        .execute()
      expect(sides).deep.equals([
        {
          scope_type: 'team',
          scope_id: f.teamA,
          approved_by: userIdOfGumbo(f.people.assistant)
        },
        { scope_type: 'user', scope_id: userIdOfGumbo(207), approved_by: null }
      ])
      expect(
        (await decide(byAddress.body.id, 'accept', f.people.follower)).body
          .status
      ).equals('accepted')
      expect(await guardians(203)).deep.equals(
        [f.people.follower].map(userIdOfGumbo)
      )

      const byId = await invite(204, {
        userId: userIdOfGumbo(f.people.oneTeam)
      })
      expect(byId.status).equals(201)
      expect(f.h.invitations.has('oneteam@example.com')).equals(false)
      expect(
        (await inbox(f.people.oneTeam)).items.map(item => item.requestId)
      ).deep.equals([byId.body.id])
      expect(
        (await decide(byId.body.id, 'accept', f.people.oneTeam)).body.status
      ).equals('accepted')
      expect(await guardians(204)).deep.equals(
        [f.people.oneTeam].map(userIdOfGumbo)
      )
    })

    it('refuses a scorekeeper, a team the player is not on, a season, and a body without a guardian', async () => {
      const scorekeeper = await invite(
        202,
        { email: 'someone@example.com' },
        f.people.scorekeeper
      )
      expect(scorekeeper.status).equals(403)
      expect(scorekeeper.body.message).equals(
        'Only an administrator, coach or assistant of the team can invite a guardian'
      )
      expect(
        (await invite(202, { email: 'someone@example.com' }, 101, f.secondTeam))
          .status
      ).equals(404)
      expect(
        (
          await call(
            'POST',
            '/relationship-requests',
            {
              kind: 'guardian',
              playerUserId: userIdOfGumbo(202),
              guardian: { email: 'someone@example.com' },
              sender: { kind: 'season', id: f.seasonA },
              idempotencyKey: 'guardian-season'
            },
            101
          )
        ).body.message
      ).equals('A guardian invitation comes from a team')
      for (const body of [
        { playerUserId: userIdOfGumbo(202) },
        {
          playerUserId: userIdOfGumbo(202),
          guardian: { email: 'not an address' }
        },
        { playerUserId: 'nobody', guardian: { userId: userIdOfGumbo(207) } }
      ])
        expect(
          (
            await call(
              'POST',
              '/relationship-requests',
              {
                kind: 'guardian',
                ...body,
                sender: { kind: 'team', id: f.teamA },
                idempotencyKey: 'guardian-bad-body'
              },
              f.people.teamCoach
            )
          ).status
        ).equals(400)
      expect(
        (await invite(999999, { email: 'someone@example.com' })).status
      ).equals(404)
      expect(
        await f.h.db.selectFrom('group_requests').select('id').execute()
      ).deep.equals([])
    })

    it('answers a retry with the same invitation, and refuses a different one under its key', async () => {
      const body = {
        kind: 'guardian',
        playerUserId: userIdOfGumbo(202),
        guardian: { email: 'retry@example.com' },
        sender: { kind: 'team', id: f.teamA },
        idempotencyKey: 'guardian-retry'
      }
      const first = await call(
        'POST',
        '/relationship-requests',
        body,
        f.people.teamCoach
      )
      const again = await call(
        'POST',
        '/relationship-requests',
        body,
        f.people.teamCoach
      )
      expect(again.body.id).equals(first.body.id)
      const changed = await call(
        'POST',
        '/relationship-requests',
        { ...body, playerUserId: userIdOfGumbo(203) },
        f.people.teamCoach
      )
      expect(changed.status).equals(409)
      expect(
        (
          await call(
            'POST',
            '/relationship-requests',
            { ...body, idempotencyKey: 'short' },
            f.people.teamCoach
          )
        ).status
      ).equals(400)
    })

    it('is withdrawn by any coach of the team, and never resent', async () => {
      const sent = await invite(202, { email: 'withdrawn@example.com' })
      expect(
        (await decide(sent.body.id, 'resend', f.people.teamCoach)).status
      ).equals(409)
      expect(
        (await decide(sent.body.id, 'withdraw', f.people.scorekeeper)).status
      ).equals(403)
      expect(
        (await decide(sent.body.id, 'withdraw', f.people.assistant)).body.status
      ).equals('cancelled')
    })
  })

  describe('requests', () => {
    it('is approved by the player, when their account signs in', async () => {
      await signsIn(203, 'cody@example.com')
      const sent = await ask(203, f.people.scorekeeper)
      expect(sent.status).equals(201)
      const notification = (await inbox(203)).items.find(
        item => item.requestId === sent.body.id
      )!
      expect(notification).deep.include({
        type: 'guardian',
        title: "Nick Punto asks to be Cody D's guardian",
        description:
          "Approving lets them see Cody D's teams and manage Cody D's details.",
        canAct: true
      })
      const own = (await inbox(f.people.scorekeeper, '?sent=1')).items
      expect(own.map(item => [item.requestId, item.canResend])).deep.equals([
        [sent.body.id, false]
      ])
      expect((await decide(sent.body.id, 'accept', 203)).body.status).equals(
        'accepted'
      )
      expect(await guardians(203)).deep.equals(
        [f.people.scorekeeper].map(userIdOfGumbo)
      )
    })

    it('tells the guardian’s home and the player’s of the link it makes', async () => {
      const notices = await listenScreenScopes(f.h.db)
      try {
        await signsIn(203, 'cody@example.com')
        const sent = await ask(203, f.people.scorekeeper)
        const mark = notices.mark()
        expect((await decide(sent.body.id, 'accept', 203)).body.status).equals(
          'accepted'
        )
        await notices.named(mark, {
          userId: userIdOfGumbo(f.people.scorekeeper)
        })
        await notices.named(mark, { userId: userIdOfGumbo(203) })
      } finally {
        await notices.close()
      }
    })

    it('is approved by a coach, an assistant, and an assistant inherited from the season', async () => {
      await person(302, 'Sam Fuld', null)
      await role(302, 'season', f.seasonA, 'assistant')
      for (const [player, approver] of [
        [202, f.people.teamCoach],
        [203, f.people.assistant],
        [204, 302],
        [205, f.people.seasonCoach]
      ]) {
        const sent = await ask(player, f.people.scorekeeper)
        const waiting = await inbox(approver)
        expect(waiting.items.map(item => item.requestId)).includes(sent.body.id)
        expect(waiting.hasPending).equals(true)
        expect(
          (await decide(sent.body.id, 'accept', approver)).body.status
        ).equals('accepted')
        expect(await guardians(player)).deep.equals(
          [f.people.scorekeeper].map(userIdOfGumbo)
        )
      }
    })

    it('reaches the coach of a team the player plays on under a closed row, and no coach of another team', async () => {
      // Elijah's place on the Hawks is held by an older row, closed into him.
      await insertFixtureUsers(f.h.db, {
        id: userIdOfGumbo(307),
        legacyId: 'usr_guardian_request_307',
        display_name: 'Elijah Dukes',
        merged_into: userIdOfGumbo(205)
      })
      await f.h.db
        .updateTable('memberships')
        .set({ user_id: userIdOfGumbo(307) })
        .where('user_id', '=', userIdOfGumbo(205))
        .where('team_id', '=', f.teamA)
        .execute()
      const sent = await ask(205, f.people.scorekeeper)
      expect(sent.status).equals(201)
      expect(
        (await inbox(f.people.teamCoach)).items.map(item => item.requestId)
      ).includes(sent.body.id)
      // Hank coaches only his own Demo Rookies.
      expect(
        (await inbox(f.people.oneTeam)).items.map(item => item.requestId)
      ).not.includes(sent.body.id)
    })

    it('is not approved by a songkeeper, or a player whose account cannot sign in', async () => {
      await person(303, 'Sid Fernandez', null)
      await role(303, 'team', f.teamA, 'songkeeper')
      const sent = await ask(203, f.people.scorekeeper)
      expect(sent.status).equals(201)
      const refused = await decide(sent.body.id, 'accept', 303)
      expect(refused.status).equals(403)
      expect((await inbox(303)).items).deep.equals([])
      expect((await inbox(303, '?history=1')).items).deep.equals([])
      f.h.tokens.set(
        202,
        (await createSession(f.h.db, userIdOfGumbo(202), 'guardian')).token
      )
      const other = await ask(202, f.people.scorekeeper)
      expect((await decide(other.body.id, 'accept', 202)).status).equals(401)
      expect(await guardians(203)).deep.equals([])
      expect(await guardians(202)).deep.equals([])
      const pending = await f.h.db
        .selectFrom('group_requests')
        .select('status')
        .where('kind', '=', 'guardian')
        .execute()
      expect(pending.map(row => row.status)).deep.equals(['pending', 'pending'])
    })

    it('needs a player the sender can see, and the sender as the guardian', async () => {
      expect((await ask(202, f.people.follower)).status).equals(404)
      expect((await ask(202, f.people.oneTeam)).status).equals(404)
      const forSomebodyElse = await call(
        'POST',
        '/relationship-requests',
        {
          kind: 'guardian',
          playerUserId: userIdOfGumbo(202),
          guardian: { userId: userIdOfGumbo(f.people.follower) },
          idempotencyKey: 'guardian-for-another'
        },
        f.people.scorekeeper
      )
      expect(forSomebodyElse.status).equals(403)
      expect(forSomebodyElse.body.message).equals(
        'Only a guardian of the player can invite a guardian without a team'
      )
      await f.h.db
        .updateTable('users')
        .set({ disabled_at: new Date() })
        .where('id', '=', userIdOfGumbo(205))
        .execute()
      expect((await ask(205, f.people.scorekeeper)).status).equals(404)
    })

    it('is withdrawn only by its sender, and never resent', async () => {
      const sent = await ask(202, f.people.scorekeeper)
      expect(
        (await decide(sent.body.id, 'resend', f.people.scorekeeper)).status
      ).equals(409)
      for (const user of [f.people.teamCoach, 101])
        expect((await decide(sent.body.id, 'withdraw', user)).status).equals(
          403
        )
      expect(
        (await inbox(f.people.scorekeeper, '?sent=1')).items[0].canWithdraw
      ).equals(true)
      expect(
        (await decide(sent.body.id, 'withdraw', f.people.scorekeeper)).body
          .status
      ).equals('cancelled')
    })
  })

  describe('once a player has a guardian', () => {
    it('refuses a team’s invitation, which a site administrator may still send', async () => {
      for (const user of [f.people.teamCoach, f.people.assistant, 101]) {
        const refused = await invite(201, { email: 'more@example.com' }, user)
        expect(refused.status, String(user)).equals(403)
        expect(refused.body.message).equals(
          'Alfonso S has a guardian already. Ask them to invite another guardian.'
        )
      }
      expect(f.h.invitations.has('more@example.com')).equals(false)
      const admin = await invite(
        201,
        { email: 'more@example.com' },
        f.people.siteAdmin
      )
      expect(admin.status).equals(201)
      expect(f.h.invitations.get('more@example.com')).deep.include({
        playerName: 'Alfonso S',
        teamName: 'Demo Hawks'
      })
    })

    it('refuses accepting a team’s invitation sent before the player had a guardian', async () => {
      const sent = await invite(202, { email: 'late@example.com' })
      expect(sent.status).equals(201)
      await link(f.people.follower, 202)
      await person(311, 'Lee Smith', 'late@example.com')
      expect((await inbox(311)).items.map(item => item.requestId)).deep.equals([
        sent.body.id
      ])
      const accepted = await decide(sent.body.id, 'accept', 311)
      expect(accepted.status).equals(403)
      expect(accepted.body.message).equals(
        'Ben C has a guardian already. Ask them to invite another guardian.'
      )
      expect(await guardians(202)).deep.equals(
        [f.people.follower].map(userIdOfGumbo)
      )
      // Its coach still sees it, and may withdraw it.
      expect(
        (await inbox(f.people.teamCoach, '?sent=1')).items.map(item => [
          item.requestId,
          item.title,
          item.canWithdraw
        ])
      ).deep.equals([[sent.body.id, 'Be a guardian of Ben C', true]])
      expect(
        (await decide(sent.body.id, 'withdraw', f.people.teamCoach)).body.status
      ).equals('cancelled')
    })

    it('asks the guardian to approve a request, and no longer the team’s staff', async () => {
      const sent = await ask(201, f.people.scorekeeper)
      expect(sent.status).equals(201)
      for (const user of [
        f.people.teamCoach,
        f.people.assistant,
        f.people.seasonCoach,
        101
      ]) {
        expect(
          (await inbox(user)).items.map(item => item.requestId),
          String(user)
        ).not.includes(sent.body.id)
        expect(
          (await decide(sent.body.id, 'accept', user)).status,
          String(user)
        ).equals(403)
        expect(
          (await decide(sent.body.id, 'decline', user)).status,
          String(user)
        ).equals(403)
      }
      const waiting = await inbox(f.people.guardian)
      expect(waiting.hasPending).equals(true)
      expect(
        waiting.items.find(item => item.requestId === sent.body.id)
      ).deep.include({
        title: "Nick Punto asks to be Alfonso S's guardian",
        canAct: true
      })
      expect(
        (await decide(sent.body.id, 'accept', f.people.guardian)).body.status
      ).equals('accepted')
      expect(await guardians(201)).deep.equals(
        [f.people.guardian, f.people.scorekeeper].map(userIdOfGumbo)
      )

      // The player still approves one themselves.
      await signsIn(201, 'avery@example.com')
      const toPlayer = await ask(201, f.people.assistant)
      expect((await inbox(201)).items.map(item => item.requestId)).includes(
        toPlayer.body.id
      )
      expect(
        (await decide(toPlayer.body.id, 'accept', 201)).body.status
      ).equals('accepted')
      expect(await guardians(201)).deep.equals(
        [f.people.guardian, f.people.scorekeeper, f.people.assistant].map(
          userIdOfGumbo
        )
      )
    })

    it('reads whether the player has a guardian when the request is decided', async () => {
      const sent = await ask(202, f.people.scorekeeper)
      const before = await inbox(f.people.teamCoach)
      expect(
        before.items.find(item => item.requestId === sent.body.id)
      ).deep.include({ canAct: true })
      // Hank becomes Ben's guardian before the coach answers.
      await link(f.people.oneTeam, 202)
      const after = await inbox(f.people.teamCoach)
      expect(after.items.map(item => item.requestId)).not.includes(sent.body.id)
      expect(after.hasPending).equals(false)
      expect(
        (await decide(sent.body.id, 'accept', f.people.teamCoach)).status
      ).equals(403)
      expect(
        (await inbox(f.people.oneTeam)).items.map(item => item.requestId)
      ).deep.equals([sent.body.id])
      expect(
        (await decide(sent.body.id, 'accept', f.people.oneTeam)).body.status
      ).equals('accepted')
      expect(await guardians(202)).deep.equals(
        [f.people.oneTeam, f.people.scorekeeper].map(userIdOfGumbo)
      )
    })

    it('gives a stranger’s team, which the child was only just added to, no say', async () => {
      // Hank runs Demo Rookies, and adds Alfonso to it as a player.
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.rookies,
          user_id: userIdOfGumbo(201),
          is_player: true,
          jersey: null
        })
        .execute()
      const invited = await invite(
        201,
        { email: 'hanks.friend@example.com' },
        f.people.oneTeam,
        f.rookies
      )
      expect(invited.status).equals(403)
      expect(invited.body.message).equals(
        'Alfonso S has a guardian already. Ask them to invite another guardian.'
      )
      expect(await inviteAs(201, f.people.oneTeam)).equals(null)
      const asked = await ask(201, f.people.follower)
      expect(asked.status).equals(404)
      const sent = await ask(201, f.people.scorekeeper)
      expect(sent.status).equals(201)
      expect(
        (await inbox(f.people.oneTeam)).items.map(item => item.requestId)
      ).not.includes(sent.body.id)
      expect(
        (await decide(sent.body.id, 'accept', f.people.oneTeam)).status
      ).equals(403)
      expect(await guardians(201)).deep.equals(
        [f.people.guardian].map(userIdOfGumbo)
      )
    })
  })

  describe('a guardian who cannot sign in', () => {
    it('leaves the say with the team’s staff until a guardian who can sign in is added', async () => {
      // A roster import made Ben's parent with no address: an account that
      // can never sign in, linked as his guardian.
      await insertFixtureUsers(f.h.db, {
        id: userIdOfGumbo(320),
        legacyId: 'usr_guardian_request_320',
        display_name: 'Pat Neshek',
        first_name: 'Pat',
        last_name: 'Neshek',
        login_enabled: false
      })
      await link(320, 202)

      expect(await inviteAs(202, f.people.teamCoach)).equals('team')
      const sent = await invite(202, { email: 'first@example.com' })
      expect(sent.status).equals(201)
      const asked = await ask(202, f.people.scorekeeper)
      expect(asked.status).equals(201)
      expect(
        (await inbox(f.people.teamCoach)).items.find(
          item => item.requestId === asked.body.id
        )
      ).deep.include({ canAct: true })
      expect(
        (await decide(asked.body.id, 'accept', f.people.teamCoach)).body.status
      ).equals('accepted')
      expect(await guardians(202)).deep.equals(
        [f.people.scorekeeper, 320].map(userIdOfGumbo)
      )

      // Nick can sign in, so the say is his now, not the staff's.
      expect(await inviteAs(202, f.people.teamCoach)).equals(null)
      expect(await inviteAs(202, f.people.scorekeeper)).equals('guardian')
      const refused = await invite(202, { email: 'more@example.com' })
      expect(refused.status).equals(403)
      expect(refused.body.message).equals(
        'Ben C has a guardian already. Ask them to invite another guardian.'
      )
      await person(312, 'Freddie Freeman', 'first@example.com')
      expect((await decide(sent.body.id, 'accept', 312)).status).equals(403)
      const again = await ask(202, f.people.assistant)
      expect(again.status).equals(201)
      expect(
        (await inbox(f.people.teamCoach)).items.map(item => item.requestId)
      ).not.includes(again.body.id)
      expect(
        (await decide(again.body.id, 'accept', f.people.teamCoach)).status
      ).equals(403)
      expect(
        (await inbox(f.people.scorekeeper)).items.map(item => item.requestId)
      ).includes(again.body.id)
    })
  })

  describe('a guardian’s invitation', () => {
    it('lets a guardian invite another by address, mailed in their own name, who accepts', async () => {
      const sent = await byGuardian(201, { email: 'Second@example.com' })
      expect(sent.status).equals(201)
      const id: string = sent.body.id
      expect(f.h.invitations.get('second@example.com')).deep.equals({
        playerName: 'Alfonso S',
        invitedBy: 'Tim Raines',
        link: `/notifications/${id}`
      })
      const stored = await f.h.db
        .selectFrom('group_requests')
        .select(['sender_id', 'sender_scope_type', 'sender_scope_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(stored).deep.equals({
        sender_id: userIdOfGumbo(f.people.guardian),
        sender_scope_type: null,
        sender_scope_id: null
      })
      const sides = await f.h.db
        .selectFrom('group_request_sides')
        .select(['scope_type', 'scope_id', 'approved_by'])
        .where('request_id', '=', id)
        .orderBy('scope_id')
        .execute()
      expect(sides).deep.equals([
        {
          scope_type: 'user',
          scope_id: 'email:second@example.com',
          approved_by: null
        },
        {
          scope_type: 'user',
          scope_id: userIdOfGumbo(f.people.guardian),
          approved_by: userIdOfGumbo(f.people.guardian)
        }
      ])
      expect(
        (await inbox(f.people.guardian, '?sent=1')).items.map(item => [
          item.requestId,
          item.canAct,
          item.canWithdraw,
          item.canResend
        ])
      ).deep.equals([[id, false, true, false]])
      // The team's staff have no part in it.
      expect(
        (await inbox(f.people.teamCoach, '?sent=1')).items.map(
          item => item.requestId
        )
      ).not.includes(id)

      await person(312, 'Sammy Sosa', 'second@example.com')
      const waiting = await inbox(312)
      expect(
        waiting.items.map(({ requestId, title, description }) => ({
          requestId,
          title,
          description
        }))
      ).deep.equals([
        {
          requestId: id,
          title: 'Be a guardian of Alfonso S',
          description: "Tim Raines invited you to be Alfonso S's guardian."
        }
      ])
      expect((await decide(id, 'accept', 312)).body.status).equals('accepted')
      expect(await guardians(201)).deep.equals(
        [f.people.guardian, 312].map(userIdOfGumbo)
      )

      // By account, it waits in the invitee's inbox and is mailed to nobody.
      const byId = await byGuardian(
        201,
        { userId: userIdOfGumbo(f.people.follower) },
        312
      )
      expect(byId.status).equals(201)
      expect(f.h.invitations.has('follower@example.com')).equals(false)
      expect(
        (await decide(byId.body.id, 'accept', f.people.follower)).body.status
      ).equals('accepted')
      expect(await guardians(201)).deep.equals(
        [f.people.guardian, f.people.follower, 312].map(userIdOfGumbo)
      )
    })

    it('comes only from a guardian, and keeps the rules of every guardian invitation', async () => {
      // Nobody else may send one: not a stranger, not the team's coach
      // without the team, not the player.
      await signsIn(201, 'avery@example.com')
      for (const user of [f.people.follower, f.people.teamCoach, 201]) {
        const refused = await byGuardian(
          201,
          { email: 'someone@example.com' },
          user
        )
        expect(refused.status, String(user)).equals(403)
        expect(refused.body.message).equals(
          'Only a guardian of the player can invite a guardian without a team'
        )
      }
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: `email_guardian_request_${++key}`,
          user_id: userIdOfGumbo(f.people.guardian),
          email: 'tim.unverified@example.com',
          is_primary: false,
          verified_at: null,
          source: 'manual'
        })
        .execute()
      const self = await byGuardian(201, {
        email: 'tim.unverified@example.com'
      })
      expect(self.status).equals(400)
      expect(self.body.message).equals(
        "You can't invite yourself to be a guardian"
      )
      const player = await byGuardian(201, { email: 'avery@example.com' })
      expect(player.status).equals(400)
      expect(player.body.message).equals("A player can't be their own guardian")

      // The same invitation again is the one waiting; its key replays it.
      const sent = await byGuardian(
        201,
        { email: 'again@example.com' },
        undefined,
        'guardian-by-guardian-replay'
      )
      expect(sent.status).equals(201)
      expect(f.h.invitations.delete('again@example.com')).equals(true)
      const repeat = await byGuardian(201, { email: 'Again@example.com' })
      expect(repeat.status).equals(200)
      expect(repeat.body).deep.equals(sent.body)
      const replay = await byGuardian(
        201,
        { email: 'again@example.com' },
        undefined,
        'guardian-by-guardian-replay'
      )
      expect(replay.status).equals(201)
      expect(replay.body).deep.equals(sent.body)
      expect(f.h.invitations.has('again@example.com')).equals(false)

      // An existing guardian is not invited again.
      await link(f.people.oneTeam, 201)
      const existing = await byGuardian(201, {
        userId: userIdOfGumbo(f.people.oneTeam)
      })
      expect(existing.status).equals(409)
      expect(existing.body.message).equals(
        "Hank M is already Alfonso S's guardian"
      )

      // Nobody accepts one whose sender is no longer a guardian.
      await person(313, 'Orlando Cepeda', 'orphan@example.com')
      const orphan = await byGuardian(
        201,
        { userId: userIdOfGumbo(313) },
        f.people.oneTeam
      )
      expect(orphan.status).equals(201)
      await f.h.db
        .deleteFrom('user_links')
        .where('user_id', '=', userIdOfGumbo(f.people.oneTeam))
        .execute()
      expect((await decide(orphan.body.id, 'accept', 313)).body.status).equals(
        'pending'
      )
      expect(await guardians(201)).deep.equals(
        [f.people.guardian].map(userIdOfGumbo)
      )
    })

    it('counts toward the guardian’s five waiting, and its declines never block them', async () => {
      await person(306, 'Frank Thomas', null)
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.teamA,
          user_id: userIdOfGumbo(306),
          is_player: true,
          jersey: null
        })
        .execute()
      for (const player of [202, 203, 204, 205])
        expect((await ask(player, f.people.guardian)).status).equals(201)
      const fifth = await byGuardian(201, { email: 'fifth@example.com' })
      expect(fifth.status).equals(201)
      for (const sixth of [
        await byGuardian(201, { email: 'sixth@example.com' }),
        await ask(306, f.people.guardian)
      ]) {
        expect(sixth.status).equals(429)
        expect(sixth.body.message).equals(
          'You have 5 guardian requests waiting. Wait for an answer before asking again.'
        )
      }
      await f.h.db
        .updateTable('group_requests')
        .set({ status: 'cancelled' })
        .where('sender_id', '=', userIdOfGumbo(f.people.guardian))
        .execute()

      // Three of Tim's invitations declined are no three declined requests.
      for (const [user, email] of [
        [f.people.follower, 'follower@example.com'],
        [f.people.assistant, 'assistant@example.com'],
        [f.people.scorekeeper, 'scorekeeper@example.com']
      ] as const) {
        const sent = await byGuardian(201, { email })
        expect(sent.status).equals(201)
        expect(
          (await decide(sent.body.id, 'decline', user)).body.status
        ).equals('declined')
      }
      expect((await ask(202, f.people.guardian)).status).equals(201)
      expect(
        (await byGuardian(201, { email: 'after@example.com' })).status
      ).equals(201)
    })
  })

  describe('GET /players/:userId guardianInviteAs', () => {
    it('says how each viewer may invite a guardian', async () => {
      // Alfonso has a guardian; Ben has none.
      for (const [player, user, expected] of [
        [201, f.people.guardian, 'guardian'],
        [201, f.people.teamCoach, null],
        [201, f.people.assistant, null],
        [201, f.people.scorekeeper, null],
        [201, f.people.siteAdmin, 'team'],
        [202, f.people.teamCoach, 'team'],
        [202, f.people.assistant, 'team'],
        [202, 101, 'team'],
        [202, f.people.seasonCoach, 'team'],
        [202, f.people.scorekeeper, null],
        [202, f.people.guardian, null],
        [202, f.people.siteAdmin, 'team']
      ] as const)
        expect(
          await inviteAs(player, user),
          `player ${player} as ${user}`
        ).equals(expected)

      // A guardian is one wherever the child plays, and a coach of a team
      // the child has left is nobody's.
      await f.h.db
        .deleteFrom('memberships')
        .where('user_id', '=', userIdOfGumbo(202))
        .where('team_id', '=', f.teamA)
        .execute()
      await link(f.people.oneTeam, 202)
      expect(await inviteAs(202, f.people.oneTeam)).equals('guardian')
    })
  })

  describe('a player is not their own guardian', () => {
    it('refuses the player asking, an invitation to their address, and accepting one sent before the address was theirs', async () => {
      await signsIn(203, 'cody@example.com')
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: `email_guardian_request_${++key}`,
          user_id: userIdOfGumbo(205),
          email: 'eli@example.com',
          is_primary: true,
          verified_at: null,
          source: 'manual'
        })
        .execute()
      for (const refused of [
        await ask(203, 203),
        await invite(203, { email: 'cody@example.com' }),
        await invite(203, { userId: userIdOfGumbo(203) }),
        await invite(205, { email: 'eli@example.com' })
      ]) {
        expect(refused.status).equals(400)
        expect(refused.body.message).equals(
          "A player can't be their own guardian"
        )
      }
      const sent = await invite(204, { email: 'later@example.com' })
      expect(sent.status).equals(201)
      await signsIn(204, 'later@example.com')
      const accepted = await decide(sent.body.id, 'accept', 204)
      expect(accepted.status).equals(409)
      expect(accepted.body.message).equals(
        "A player can't be their own guardian"
      )
      expect(await guardians(204)).deep.equals([])
    })
  })

  describe('nobody approves their own request or invitation', () => {
    it('leaves a coach’s own request to another coach or the player', async () => {
      const sent = await ask(202, f.people.teamCoach)
      expect(sent.status).equals(201)
      const own = await inbox(f.people.teamCoach)
      expect(own.items).deep.equals([])
      expect(own.hasPending).equals(false)
      expect(
        (await inbox(f.people.teamCoach, '?sent=1')).items.map(item => [
          item.requestId,
          item.canAct,
          item.canWithdraw
        ])
      ).deep.equals([[sent.body.id, false, true]])
      const tried = await decide(sent.body.id, 'accept', f.people.teamCoach)
      expect(tried.body).deep.equals({ id: sent.body.id, status: 'pending' })
      expect(await guardians(202)).deep.equals([])
      expect(
        (await inbox(f.people.assistant)).items.map(item => item.requestId)
      ).deep.equals([sent.body.id])
      expect(
        (await decide(sent.body.id, 'accept', f.people.assistant)).body.status
      ).equals('accepted')
      expect(await guardians(202)).deep.equals(
        [f.people.teamCoach].map(userIdOfGumbo)
      )

      await signsIn(203, 'cody@example.com')
      const toPlayer = await ask(203, f.people.teamCoach)
      expect(
        (await decide(toPlayer.body.id, 'accept', 203)).body.status
      ).equals('accepted')
      expect(await guardians(203)).deep.equals(
        [f.people.teamCoach].map(userIdOfGumbo)
      )
    })

    it('does not let a coach’s confirmation of both sides stand for the player', async () => {
      const made = await createRelationshipRequest(
        f.h.db,
        {
          userId: userIdOfGumbo(f.people.teamCoach),
          isAdmin: false,
          scopes: []
        },
        {
          terms: {
            kind: 'guardian',
            playerUserId: userIdOfGumbo(204),
            guardian: { userId: userIdOfGumbo(f.people.teamCoach) }
          },
          confirmBoth: true,
          idempotencyKey: 'guardian-confirm-both'
        },
        f.clock
      )
      expect(made.status).equals('pending')
      expect(await guardians(204)).deep.equals([])
    })

    it('refuses an invitation naming its sender, by id or address, and its sender accepting one', async () => {
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: `email_guardian_request_${++key}`,
          user_id: userIdOfGumbo(f.people.teamCoach),
          email: 'unverified.coach@example.com',
          is_primary: false,
          verified_at: null,
          source: 'manual'
        })
        .execute()
      for (const refused of [
        await invite(202, { userId: userIdOfGumbo(f.people.teamCoach) }),
        await invite(202, { email: f.emails[f.people.teamCoach] }),
        await invite(202, { email: 'Unverified.Coach@example.com' })
      ]) {
        expect(refused.status).equals(400)
        expect(refused.body.message).equals(
          "You can't invite yourself to be a guardian"
        )
      }
      expect(
        await f.h.db.selectFrom('group_requests').select('id').execute()
      ).deep.equals([])

      const sent = await invite(202, { email: 'later.coach@example.com' })
      expect(sent.status).equals(201)
      await verify(f.people.teamCoach, 'later.coach@example.com')
      const accepted = await decide(sent.body.id, 'accept', f.people.teamCoach)
      expect(accepted.status).equals(409)
      expect(accepted.body.message).equals(
        "You can't invite yourself to be a guardian"
      )
      expect(await guardians(202)).deep.equals([])
    })
  })

  describe('the same request again', () => {
    const waiting = async (): Promise<{
      requests: number
      events: number
    }> => ({
      requests: (
        await f.h.db
          .selectFrom('group_requests')
          .select('id')
          .where('kind', '=', 'guardian')
          .execute()
      ).length,
      events: (
        await f.h.db
          .selectFrom('notification_events')
          .select('id')
          .where('source_type', '=', 'groupRequest')
          .execute()
      ).length
    })

    it('answers a second request for the same player with the one waiting, telling nobody again and counting it once', async () => {
      const sent = await ask(202, f.people.scorekeeper)
      expect(sent.status).equals(201)
      const before = await waiting()
      const again = await ask(202, f.people.scorekeeper)
      expect(again.status).equals(200)
      expect(again.body).deep.equals({ id: sent.body.id, status: 'pending' })
      expect(await waiting()).deep.equals(before)
      expect(
        (await inbox(f.people.teamCoach)).items.filter(
          item => item.type === 'guardian'
        )
      ).to.have.length(1)

      // Four more players make five waiting; the repeat was not a sixth.
      for (const player of [201, 203, 204, 205])
        expect((await ask(player, f.people.scorekeeper)).status).equals(201)
      expect((await ask(202, f.people.scorekeeper)).body).deep.equals({
        id: sent.body.id,
        status: 'pending'
      })

      // Another asker's request is their own; an answered one is asked anew.
      expect((await ask(202, f.people.assistant)).status).equals(201)
      await decide(sent.body.id, 'withdraw', f.people.scorekeeper)
      const fresh = await ask(202, f.people.scorekeeper)
      expect(fresh.status).equals(201)
      expect(fresh.body.id).not.equals(sent.body.id)
    })

    it('answers the same team inviting the same account or address with the one waiting, mailing nobody again', async () => {
      const sent = await invite(203, { email: 'Twice@example.com' })
      expect(sent.status).equals(201)
      expect(f.h.invitations.delete('twice@example.com')).equals(true)
      const before = await waiting()
      const again = await invite(
        203,
        { email: 'twice@EXAMPLE.com' },
        f.people.assistant
      )
      expect(again.status).equals(200)
      expect(again.body).deep.equals({ id: sent.body.id, status: 'pending' })
      expect(f.h.invitations.has('twice@example.com')).equals(false)
      expect(await waiting()).deep.equals(before)

      // An account invited by its address is the same account by id.
      const byAddress = await invite(204, { email: 'follower@example.com' })
      const byId = await invite(204, {
        userId: userIdOfGumbo(f.people.follower)
      })
      expect(byId.status).equals(200)
      expect(byId.body.id).equals(byAddress.body.id)

      // Another team, or another player, is another invitation.
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.secondTeam,
          user_id: userIdOfGumbo(205),
          is_player: true,
          jersey: null
        })
        .execute()
      expect((await invite(205, { email: 'twice@example.com' })).status).equals(
        201
      )
      expect(
        (await invite(205, { email: 'twice@example.com' }, 101, f.secondTeam))
          .status
      ).equals(201)
    })

    it('answers a replayed retry key exactly as it was first answered, mailing and telling nobody again', async () => {
      const send = async (key: string): Promise<Answer> =>
        await call(
          'POST',
          '/relationship-requests',
          {
            kind: 'guardian',
            playerUserId: userIdOfGumbo(202),
            guardian: { email: 'replay@example.com' },
            sender: { kind: 'team', id: f.teamA },
            idempotencyKey: key
          },
          f.people.teamCoach
        )
      const mailed = (): boolean => f.h.invitations.delete('replay@example.com')

      const sent = await send('guardian-replay-1')
      expect(sent.status).equals(201)
      expect(mailed()).equals(true)
      const before = await waiting()
      const repeat = await send('guardian-replay-2')
      expect(repeat.status).equals(200)
      expect(repeat.body).deep.equals(sent.body)
      expect(mailed()).equals(false)
      for (const [key, status] of [
        ['guardian-replay-2', 200],
        ['guardian-replay-2', 200],
        ['guardian-replay-1', 201]
      ] as const) {
        const replay = await send(key)
        expect(replay.status).equals(status)
        expect(replay.body).deep.equals(sent.body)
        expect(mailed()).equals(false)
      }
      expect(await waiting()).deep.equals(before)

      // A replay answers as first answered, though the request has moved on.
      await decide(sent.body.id, 'withdraw', f.people.teamCoach)
      const late = await send('guardian-replay-1')
      expect(late.status).equals(201)
      expect(late.body).deep.equals({ id: sent.body.id, status: 'pending' })
      expect(mailed()).equals(false)

      // A request answers its replays the same way.
      const asked = await ask(203, f.people.scorekeeper)
      const askAgain = async (): Promise<Answer> =>
        await call(
          'POST',
          '/relationship-requests',
          {
            kind: 'guardian',
            playerUserId: userIdOfGumbo(203),
            guardian: { userId: userIdOfGumbo(f.people.scorekeeper) },
            idempotencyKey: 'guardian-replay-ask'
          },
          f.people.scorekeeper
        )
      for (let replays = 0; replays < 2; ++replays) {
        const again = await askAgain()
        expect(again.status).equals(200)
        expect(again.body).deep.equals(asked.body)
      }
    })

    it('mails an invitation whose mail failed once, when its retry key is replayed', async () => {
      const send = async (): Promise<Answer> =>
        await call(
          'POST',
          '/relationship-requests',
          {
            kind: 'guardian',
            playerUserId: userIdOfGumbo(204),
            guardian: { email: 'unmailed@example.com' },
            sender: { kind: 'team', id: f.teamA },
            idempotencyKey: 'guardian-unmailed'
          },
          f.people.teamCoach
        )
      f.h.controls.failMail = true
      expect((await send()).status).equals(500)
      expect(f.h.invitations.has('unmailed@example.com')).equals(false)
      const replay = await send()
      expect(replay.status).equals(500)
      f.h.controls.failMail = false
      const retried = await send()
      expect(retried.status).equals(201)
      expect(retried.body.status).equals('pending')
      expect(f.h.invitations.delete('unmailed@example.com')).equals(true)
      const again = await send()
      expect(again.status).equals(201)
      expect(again.body).deep.equals(retried.body)
      expect(f.h.invitations.has('unmailed@example.com')).equals(false)
    })
  })

  describe('a replay after the sender lost the team', () => {
    const send = async (
      key: string,
      user: number = f.people.teamCoach,
      playerUserId = 204
    ): Promise<Answer> =>
      await call(
        'POST',
        '/relationship-requests',
        {
          kind: 'guardian',
          playerUserId: userIdOfGumbo(playerUserId),
          guardian: { email: 'owed@example.com' },
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: key
        },
        user
      )

    it('gives the stored answer and mails the owed invitation once, after the coach lost the role', async () => {
      f.h.controls.failMail = true
      expect((await send('guardian-owed-role')).status).equals(500)
      f.h.controls.failMail = false
      expect(f.h.invitations.has('owed@example.com')).equals(false)
      const stored = await f.h.db
        .selectFrom('group_requests')
        .select(['id', 'status'])
        .where('kind', '=', 'guardian')
        .executeTakeFirstOrThrow()
      await f.h.db
        .deleteFrom('scope_roles')
        .where('user_id', '=', userIdOfGumbo(f.people.teamCoach))
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', f.teamA)
        .execute()
      // A fresh send is refused: the coach no longer speaks for the team.
      const fresh = await send('guardian-owed-fresh')
      expect(fresh.status).oneOf([403, 404])

      const replay = await send('guardian-owed-role')
      expect(replay.status).equals(201)
      expect(replay.body).deep.equals({ id: stored.id, status: 'pending' })
      expect(f.h.invitations.delete('owed@example.com')).equals(true)
      const again = await send('guardian-owed-role')
      expect(again.status).equals(201)
      expect(again.body).deep.equals(replay.body)
      expect(f.h.invitations.has('owed@example.com')).equals(false)

      // The key is the coach's own: anybody else sending under it is a fresh
      // send, authorized as one.
      expect(
        (await send('guardian-owed-role', f.people.follower)).status
      ).oneOf([403, 404])
      expect(f.h.invitations.has('owed@example.com')).equals(false)
    })

    it('gives the stored answer and mails the owed invitation once, after the player left the team', async () => {
      f.h.controls.failMail = true
      expect((await send('guardian-owed-left', undefined, 205)).status).equals(
        500
      )
      f.h.controls.failMail = false
      await f.h.db
        .deleteFrom('memberships')
        .where('user_id', '=', userIdOfGumbo(205))
        .where('team_id', '=', f.teamA)
        .execute()
      expect(
        (await send('guardian-owed-left-fresh', undefined, 205)).status
      ).oneOf([403, 404])
      const replay = await send('guardian-owed-left', undefined, 205)
      expect(replay.status).equals(201)
      expect(replay.body.status).equals('pending')
      expect(f.h.invitations.delete('owed@example.com')).equals(true)
      expect(
        (await send('guardian-owed-left', undefined, 205)).body
      ).deep.equals(replay.body)
      expect(f.h.invitations.has('owed@example.com')).equals(false)
    })
  })

  describe('an existing guardian', () => {
    it('is not asked again, by their own request or a team’s invitation, by any of their rows', async () => {
      const asked = await ask(201, f.people.guardian)
      expect(asked.status).equals(409)
      expect(asked.body.message).equals("You are already Alfonso S's guardian")
      // A site administrator may still invite from a team, as nobody else
      // may once the player has a guardian.
      const invited = await invite(
        201,
        { userId: userIdOfGumbo(f.people.guardian) },
        f.people.siteAdmin
      )
      expect(invited.status).equals(409)
      expect(invited.body.message).equals(
        "Tim R is already Alfonso S's guardian"
      )

      // A link to a closed row of Ben is a link to Ben.
      await insertFixtureUsers(f.h.db, {
        id: userIdOfGumbo(305),
        legacyId: 'usr_guardian_request_305',
        display_name: 'Ben Chapman',
        merged_into: userIdOfGumbo(202)
      })
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(f.people.guardian),
          related_user_id: userIdOfGumbo(305),
          kind: 'guardian',
          can_manage: true,
          created_at: new Date()
        })
        .execute()
      expect((await ask(202, f.people.guardian)).status).equals(409)
      expect(
        (
          await invite(
            202,
            { email: 'fixture106@example.com' },
            f.people.siteAdmin
          )
        ).body.message
      ).equals("Tim R is already Ben C's guardian")
      expect(
        (
          await f.h.db
            .selectFrom('group_requests')
            .select('id')
            .where('kind', '=', 'guardian')
            .execute()
        ).length
      ).equals(0)
    })
  })

  describe('the other kinds', () => {
    it('still need a sending group, and a kind the route knows', async () => {
      let refused: unknown
      await createRelationshipRequest(
        f.h.db,
        { userId: userIdOfGumbo(101), isAdmin: false, scopes: [] },
        {
          terms: {
            kind: 'promotion',
            teamId: f.teamA,
            recipientUserId: userIdOfGumbo(103)
          },
          idempotencyKey: 'guardian-no-sender'
        },
        f.clock
      ).catch((error: unknown) => {
        refused = error
      })
      expect(refused).property('message', 'Choose the sending organization')
      const unknown = await call(
        'POST',
        '/relationship-requests',
        {
          kind: 'adoption',
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: 'guardian-unknown-kind'
        },
        101
      )
      expect(unknown.status).equals(400)
      expect(unknown.body.message).equals(
        'Choose parent, participation, promotion, person or guardian invitation'
      )
    })
  })

  describe('limits', () => {
    it('refuses a sixth waiting request, counting neither withdrawn nor expired ones, nor a coach’s invitations', async () => {
      const ids: string[] = []
      for (const player of [201, 202, 203, 204, 205]) {
        const sent = await ask(player, f.people.scorekeeper)
        expect(sent.status).equals(201)
        ids.push(sent.body.id)
      }
      await person(306, 'Frank Thomas', null)
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.teamA,
          user_id: userIdOfGumbo(306),
          is_player: true,
          jersey: null
        })
        .execute()
      const sixth = await ask(306, f.people.scorekeeper)
      expect(sixth.status).equals(429)
      expect(sixth.body).deep.equals({
        code: 'rateLimited',
        message:
          'You have 5 guardian requests waiting. Wait for an answer before asking again.',
        details: { retryAfterSec: 7 * 24 * 3600 }
      })
      await decide(ids[0], 'withdraw', f.people.scorekeeper)
      expect((await ask(306, f.people.scorekeeper)).status).equals(201)
      expect((await ask(201, f.people.scorekeeper)).status).equals(429)
      f.advance(7 * DAY)
      expect((await ask(201, f.people.scorekeeper)).status).equals(201)

      for (const player of [202, 203, 204, 205])
        expect(
          (await invite(player, { email: `p${player}@example.com` })).status
        ).equals(201)
      expect((await ask(202, f.people.teamCoach)).status).equals(201)
    })

    it('blocks asking for seven days after the third decline, then allows it', async () => {
      for (const player of [202, 203]) {
        const sent = await ask(player, f.people.scorekeeper)
        await decide(sent.body.id, 'decline', f.people.teamCoach)
      }
      // A withdrawal, even one made by declining your own request, is no decline.
      const withdrawn = await ask(204, f.people.scorekeeper)
      await decide(withdrawn.body.id, 'decline', f.people.scorekeeper)
      const third = await ask(205, f.people.scorekeeper)
      expect(third.status).equals(201)
      f.advance(3600 * 1000)
      await decide(third.body.id, 'decline', f.people.teamCoach)

      const retryOn = new Date(
        f.clock.now().getTime() + 7 * DAY
      ).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
      const fourth = await ask(201, f.people.scorekeeper)
      expect(fourth.status).equals(429)
      expect(fourth.body).deep.equals({
        code: 'rateLimited',
        message: `Three guardian requests were declined. You can ask again on ${retryOn}.`,
        details: { retryAfterSec: 7 * 24 * 3600 }
      })
      f.advance(7 * DAY - 1000)
      expect((await ask(201, f.people.scorekeeper)).status).equals(429)
      f.advance(1000)
      expect((await ask(201, f.people.scorekeeper)).status).equals(201)
    })

    it('never counts the declines of a coach’s invitations against the coach', async () => {
      for (const [player, user, email] of [
        [202, f.people.follower, 'follower@example.com'],
        [203, f.people.oneTeam, 'oneteam@example.com'],
        [204, f.people.assistant, 'assistant@example.com']
      ] as const) {
        const sent = await invite(player, { email })
        expect(
          (await decide(sent.body.id, 'decline', user)).body.status
        ).equals('declined')
      }
      expect((await ask(205, f.people.teamCoach)).status).equals(201)
    })
  })
})
