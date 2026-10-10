import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { setScopeRoles } from '../invites/people'

describe('two-sided relationship invitations and shared inbox', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  async function participation(key: string, user = 102): Promise<string> {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonB,
        sender: { kind: 'season', id: f.seasonB },
        idempotencyKey: key
      },
      user
    )
    expect(response.status).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  it('records sending as consent, accepts once for the other side and creates only competition membership', async () => {
    const id = await participation('participation-first')
    const requests = await f.h.request(
      'GET',
      '/me/notifications',
      undefined,
      101
    )
    expect(requests.status).equals(200)
    const body = (await requests.json()) as {
      items: Array<{ requestId: string; title: string }>
      hasPending: boolean
    }
    expect(body.hasPending).equals(true)
    expect(body.items[0].requestId).equals(id)
    expect(body.items[0].title).includes('Demo Hawks')
    expect(
      (await f.h.request('GET', '/me/notifications', undefined, 106)).status
    ).equals(200)
    expect(
      (
        (await (
          await f.h.request('GET', '/me/notifications', undefined, 106)
        ).json()) as { hasPending: boolean }
      ).hasPending
    ).equals(false)
    await f.h.request('PUT', `/me/notifications/${id}/viewed`, {}, 101)
    expect(
      (
        (await (
          await f.h.request('GET', '/me/notifications/summary', undefined, 101)
        ).json()) as { hasPending: boolean }
      ).hasPending
    ).equals(true)
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      101
    )
    expect(((await accepted.json()) as { status: string }).status).equals(
      'accepted'
    )
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(1)
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(0)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/accept`,
          {},
          101
        )
      ).status
    ).equals(200)
  })
  it('enforces seven days exactly and sender withdrawal/resend invalidates old actions', async () => {
    const id = await participation('boundary-before')
    f.advance(7 * 24 * 3600 * 1000 - 1)
    expect(
      (
        (await (
          await f.h.request(
            'POST',
            `/relationship-requests/${id}/accept`,
            {},
            101
          )
        ).json()) as { status: string }
      ).status
    ).equals('accepted')
    const expired = await participation('boundary-exact')
    f.advance(7 * 24 * 3600 * 1000)
    expect(
      (
        (await (
          await f.h.request(
            'POST',
            `/relationship-requests/${expired}/accept`,
            {},
            101
          )
        ).json()) as { status: string }
      ).status
    ).equals('expired')
    const pending = await participation('withdraw-old')
    const resend = await f.h.request(
      'POST',
      `/relationship-requests/${pending}/resend`,
      { idempotencyKey: 'resend-new-key' },
      102
    )
    expect(resend.status).equals(201)
    expect(
      (
        (await (
          await f.h.request(
            'POST',
            `/relationship-requests/${pending}/accept`,
            {},
            101
          )
        ).json()) as { status: string }
      ).status
    ).equals('cancelled')
    const next = (await resend.json()) as { id: string }
    expect(next.id).not.equals(pending)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${next.id}/withdraw`,
          {},
          101
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${next.id}/withdraw`,
          {},
          102
        )
      ).status
    ).equals(200)
  })
  it('rejects plain users and conflicting parents while allowing a dual-admin explicit confirmation', async () => {
    expect(
      (
        await f.h.request(
          'POST',
          '/relationship-requests',
          {
            kind: 'participation',
            teamId: f.teamA,
            seasonId: f.seasonB,
            sender: { kind: 'team', id: f.teamA },
            idempotencyKey: 'no-rights-user'
          },
          106
        )
      ).status
    ).equals(403)
    const bad = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'parent',
        actions: [
          {
            operation: 'attach',
            child: { kind: 'team', id: f.teamA },
            parent: { kind: 'season', id: f.seasonB }
          }
        ],
        sender: { kind: 'season', id: f.seasonB },
        idempotencyKey: 'conflicting-parent'
      },
      102
    )
    expect(bad.status).equals(409)
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'parent',
        actions: [
          {
            operation: 'attach',
            child: { kind: 'team', id: f.teamA },
            parent: { kind: 'season', id: f.playoffs }
          }
        ],
        sender: { kind: 'team', id: f.teamA },
        confirmBoth: true,
        idempotencyKey: 'both-admin-confirm'
      },
      101
    )
    expect(response.status).equals(201)
    expect(((await response.json()) as { status: string }).status).equals(
      'accepted'
    )
  })
  it('declines for every admin, preserves stable paging and refuses lost authority', async () => {
    const first = await participation('ordered-first')
    const second = await participation('ordered-second')
    const page = (await (
      await f.h.request('GET', '/me/notifications?limit=1', undefined, 101)
    ).json()) as {
      items: Array<{ requestId: string }>
      nextCursor: string | null
      hasPending: boolean
    }
    expect(page.items).length(1)
    expect(page.nextCursor).not.equals(null)
    expect(page.hasPending).equals(true)
    const next = (await (
      await f.h.request(
        'GET',
        '/me/notifications?limit=1&cursor=' +
          encodeURIComponent(page.nextCursor!),
        undefined,
        101
      )
    ).json()) as { items: unknown[] }
    expect(next.items).length(1)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${first}/decline`,
          {},
          101
        )
      ).status
    ).equals(200)
    expect(
      (
        (await (
          await f.h.request('GET', `/me/notifications/${first}`, undefined, 101)
        ).json()) as { status: string }
      ).status
    ).equals('declined')
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      103,
      { admin: true, flags: [] },
      101
    )
    await f.h.db
      .deleteFrom('scope_roles')
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', f.teamA)
      .where('user_id', '=', 101)
      .execute()
    // Still inherited from the real parent league/seasons, so removing one path preserves approval.
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${second}/accept`,
          {},
          101
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/me/notifications?limit=0', undefined, 101))
        .status
    ).equals(400)
    expect(
      (await f.h.request('GET', `/me/notifications/${first}`, undefined, 106))
        .status
    ).equals(404)
  })
})
