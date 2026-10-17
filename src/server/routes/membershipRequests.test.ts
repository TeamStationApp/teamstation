import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('team membership requests', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  const request = async (
    key: string,
    user: number | null = 103,
    teamId?: string
  ): Promise<Response> =>
    await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'membership',
        teamId: teamId ?? f.teamA,
        idempotencyKey: key,
        // A client cannot name a different requester or grant itself staff rights.
        userId: 104,
        admin: true,
        flags: ['coach'],
        confirmBoth: true
      },
      user
    )
  it('requires authentication and a real team', async () => {
    expect((await request('membership-guest', null)).status).equals(401)
    expect(
      (await request('membership-missing', 103, 'tem_missing')).status
    ).equals(404)
  })
  it('deduplicates requests, keeps access locked, and grants only membership after administrator approval', async () => {
    const response = await request('membership-first')
    expect(response.status, await response.clone().text()).equals(201)
    const first = await response.json()
    expect(first.status).equals('pending')
    const sent = await (
      await f.h.request('GET', '/me/notifications?sent=1', undefined, 103)
    ).json()
    expect(
      sent.items.find(
        (item: { requestId: string }) => item.requestId === first.id
      ).canResend
    ).equals(false)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${first.id}/resend`,
          { idempotencyKey: 'membership-resend' },
          103
        )
      ).status
    ).equals(409)

    const duplicate = await (await request('membership-again')).json()
    expect(duplicate.id).equals(first.id)
    expect((await (await request('membership-first')).json()).id).equals(
      first.id
    )
    const row = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    expect(row.terms).deep.equals({
      kind: 'membership',
      teamId: f.teamA,
      userId: 103
    })
    expect(
      (
        await (
          await f.h.request('GET', `/teams/${f.teamA}`, undefined, 103)
        ).json()
      ).canViewPrivate
    ).equals(false)
    const ownApproval = await f.h.request(
      'POST',
      `/relationship-requests/${first.id}/accept`,
      {},
      103
    )
    expect(ownApproval.status).equals(200)
    expect((await ownApproval.json()).status).equals('pending')
    const unrelated = await f.h.request(
      'POST',
      `/relationship-requests/${first.id}/accept`,
      {},
      104
    )
    expect(unrelated.status).oneOf([403, 404])

    const inbox = await (
      await f.h.request('GET', '/me/notifications', undefined, 101)
    ).json()
    expect(
      inbox.items.some(
        (item: { requestId: string; canAct: boolean }) =>
          item.requestId === first.id && item.canAct
      )
    ).equals(true)
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${first.id}/accept`,
      {},
      101
    )
    expect(accepted.status, await accepted.clone().text()).equals(200)
    expect(
      (
        await (
          await f.h.request('GET', `/teams/${f.teamA}`, undefined, 103)
        ).json()
      ).canViewPrivate
    ).equals(true)
    const roles = await f.h.db
      .selectFrom('scope_roles')
      .select('role')
      .where('user_id', '=', 103)
      .where('scope_id', '=', f.teamA)
      .execute()
    expect(roles).deep.equals([])
    const membership = await f.h.db
      .selectFrom('memberships')
      .select(['role', 'is_player'])
      .where('team_id', '=', f.teamA)
      .where('user_id', '=', 103)
      .executeTakeFirstOrThrow()
    expect(membership).deep.equals({ role: 'member', is_player: false })
  })
})
