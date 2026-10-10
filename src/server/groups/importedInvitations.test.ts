import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { rolesAt } from '../invites/people'

describe('proved imported email invitation eligibility', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('resolves a verified mixed-case stored address for bilateral external-team promotion without changing the recipient identity', async () => {
    await f.h.db
      .updateTable('user_emails')
      .set({ email: 'Fixture106@Example.com' })
      .where('user_id', '=', 106)
      .execute()
    const created = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Case External',
        external: true,
        custodian: { kind: 'league', id: f.leagueA },
        locality: demoLocality,
        idempotencyKey: 'case-external-create'
      },
      101
    )
    expect(created.status).equals(201)
    const team = (await created.json()) as { id: string }
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'promotion',
        teamId: team.id,
        recipientEmail: 'fixture106@example.com',
        sender: { kind: 'team', id: team.id },
        idempotencyKey: 'case-promotion-invite'
      },
      101
    )
    expect(sent.status).equals(201)
    const invite = (await sent.json()) as { id: string }
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${invite.id}/accept`,
          {},
          106
        )
      ).status
    ).equals(200)
    expect(await rolesAt(f.h.db, 'team', team.id, 106)).deep.equals(['admin'])
  })
  for (const method of ['code', 'link', 'invitation'] as const)
    it(`retains an imported identity and verifies its address through ${method}, enabling only its explicitly accepted invitation`, async () => {
      const email = 'fixture106@example.com'
      await f.h.db
        .updateTable('users')
        .set({ login_enabled: false })
        .where('id', '=', 106)
        .execute()
      await f.h.db
        .updateTable('user_emails')
        .set({
          email: 'Fixture106@Example.com',
          verified_at: null,
          source: 'import'
        })
        .where('user_id', '=', 106)
        .execute()
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: 'email_other_import',
          user_id: 106,
          email: 'other-import@example.com',
          verified_at: null,
          source: 'import'
        })
        .execute()
      const invited = await f.h.request(
        'POST',
        `/manage/team/${f.teamA}/people`,
        {
          email,
          admin: false,
          flags: ['coach'],
          idempotencyKey: `import-${method}`
        },
        101
      )
      expect(invited.status).equals(201)
      const { invited: invitation } = (await invited.json()) as {
        invited: { requestId: string; code: string }
      }
      const client = new TeamStationClient({ baseUrl: f.h.origin + '/api/v1' })
      if (method === 'invitation') {
        const request = await f.h.request(
          'POST',
          `/join/${invitation.code}/email-code`,
          { email },
          null
        )
        expect(request.status).equals(202)
      } else await client.requestEmailCode(email.toUpperCase())
      const session =
        method === 'link'
          ? await client.signInWithLink(
              new URL(f.h.links.get(email)!, f.h.origin).pathname
                .split('/')
                .at(-1)!
            )
          : await client.signInWithCode(email, f.h.mail.get(email)!)
      expect(session.user.id).equals(106)
      f.h.tokens.set(106, session.token)
      expect(
        (
          await f.h.db
            .selectFrom('user_emails')
            .select('verified_at')
            .where('email', '=', 'Fixture106@Example.com')
            .executeTakeFirstOrThrow()
        ).verified_at
      ).not.equals(null)
      expect(
        (
          await f.h.db
            .selectFrom('user_emails')
            .select('verified_at')
            .where('email', '=', 'other-import@example.com')
            .executeTakeFirstOrThrow()
        ).verified_at
      ).equals(null)
      expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals(
        method === 'invitation' ? ['coach'] : []
      )
      const inbox = (await (
        await f.h.request(
          'GET',
          method === 'invitation'
            ? '/me/notifications?history=1'
            : '/me/notifications',
          undefined,
          106
        )
      ).json()) as { items: Array<{ requestId: string }> }
      expect(
        inbox.items.some(row => row.requestId === invitation.requestId)
      ).equals(true)
      expect(
        await (
          await f.h.request(
            'POST',
            `/relationship-requests/${invitation.requestId}/accept`,
            {},
            106
          )
        ).json()
      ).property('status', 'accepted')
      expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals(['coach'])
    })
})
