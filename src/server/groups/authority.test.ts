import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { setScopeRoles } from '../invites/people'

describe('current authority and immutable relationship request terms', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  async function send(): Promise<string> {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonB,
        sender: { kind: 'season', id: f.seasonB },
        idempotencyKey: 'current-authority'
      },
      102
    )
    expect(response.status).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  it('requires replacement sender consent if the original sender loses every role path', async () => {
    const id = await send()
    await setScopeRoles(
      f.h.db,
      'season',
      f.seasonB,
      103,
      { admin: true, flags: [] },
      102
    )
    await setScopeRoles(
      f.h.db,
      'league',
      f.leagueB,
      105,
      { admin: true, flags: [] },
      105
    )
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', 102)
      .where('scope_id', 'in', [f.leagueB, f.seasonB])
      .execute()
    const formerSender = (await (
      await f.h.request('GET', `/me/notifications/${id}`, undefined, 102)
    ).json()) as {
      title: string
      description: string
      canWithdraw: boolean
      canAct: boolean
    }
    expect(formerSender.title).equals('Pending invitation you sent')
    expect(formerSender.description).not.includes('Demo Hawks')
    expect(formerSender.canWithdraw).equals(true)
    expect(formerSender.canAct).equals(false)
    const approvedTeam = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      101
    )
    expect(await approvedTeam.json()).property('status', 'pending')
    expect(
      await (
        await f.h.request('GET', '/me/notifications/summary', undefined, 103)
      ).json()
    ).property('hasPending', true)
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      103
    )
    expect(await accepted.json()).property('status', 'accepted')
    const history = (await (
      await f.h.request('GET', '/me/notifications?history=1', undefined, 102)
    ).json()) as { items: Array<{ requestId: string }> }
    expect(history.items.some(row => row.requestId === id)).equals(true)
  })
  it('new admins see old requests, revoked admins lose pending details, and resolved viewed history remains', async () => {
    const id = await send()
    await f.h.request('PUT', `/me/notifications/${id}/viewed`, {}, 101)
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      103,
      { admin: true, flags: [] },
      101
    )
    for (const ref of [
      { kind: 'league' as const, id: f.leagueA },
      { kind: 'season' as const, id: f.seasonA },
      { kind: 'season' as const, id: f.playoffs }
    ])
      await setScopeRoles(
        f.h.db,
        ref.kind,
        ref.id,
        105,
        { admin: true, flags: [] },
        105
      )
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', 101)
      .where('scope_id', 'in', [f.leagueA, f.seasonA, f.playoffs, f.teamA])
      .execute()
    expect(
      (await f.h.request('GET', `/me/notifications/${id}`, undefined, 101))
        .status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/accept`,
          {},
          101
        )
      ).status
    ).equals(403)
    const newAdmin = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      103
    )
    expect(await newAdmin.json()).property('canAct', true)
    await f.h.request('POST', `/relationship-requests/${id}/decline`, {}, 103)
    expect(
      (await f.h.request('GET', `/me/notifications/${id}`, undefined, 101))
        .status
    ).equals(200)
    const history = (await (
      await f.h.request('GET', '/me/notifications?history=1', undefined, 101)
    ).json()) as { items: Array<{ requestId: string }> }
    expect(history.items.some(row => row.requestId === id)).equals(true)
  })
  it('lets the original sender withdraw a pending request after authority loss while refusing resend', async () => {
    const id = await send()
    await setScopeRoles(
      f.h.db,
      'league',
      f.leagueB,
      105,
      { admin: true, flags: [] },
      105
    )
    await setScopeRoles(
      f.h.db,
      'season',
      f.seasonB,
      103,
      { admin: true, flags: [] },
      102
    )
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', 102)
      .where('scope_id', 'in', [f.leagueB, f.seasonB])
      .execute()
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/resend`,
          { idempotencyKey: 'cannot-resend-after-loss' },
          102
        )
      ).status
    ).equals(403)
    const withdrawn = await f.h.request(
      'POST',
      `/relationship-requests/${id}/withdraw`,
      {},
      102
    )
    expect(withdrawn.status).equals(200)
    expect(await withdrawn.json()).property('status', 'cancelled')
  })
  it('supersedes changed season terms without moving games and atomically resends a new snapshot', async () => {
    const id = await send()
    const unchanged = await f.h.request(
      'PUT',
      `/groups/season/${f.seasonB}`,
      {
        name: 'Demo Tournament Renamed',
        startsOn: '2027-03-01',
        endsOn: '2027-05-31',
        timezone: 'UTC'
      },
      102
    )
    expect(unchanged.status).equals(200)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('pending')
    await f.h.db
      .insertInto('games')
      .values({
        id: 'unchangedInstant',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date('2027-02-01T20:00:00Z')
      })
      .execute()
    const changed = await f.h.request(
      'PUT',
      `/groups/season/${f.seasonB}`,
      {
        startsOn: '2027-09-01',
        endsOn: '2027-11-30',
        timezone: 'America/Los_Angeles'
      },
      102
    )
    expect(changed.status).equals(200)
    expect(
      await (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/accept`,
          {},
          101
        )
      ).json()
    ).property('status', 'superseded')
    const resent = await f.h.request(
      'POST',
      `/relationship-requests/${id}/resend`,
      { idempotencyKey: 'new-range-snapshot' },
      102
    )
    expect(resent.status).equals(201)
    const fresh = (await resent.json()) as { id: string }
    expect(
      await (
        await f.h.request(
          'POST',
          `/relationship-requests/${fresh.id}/accept`,
          {},
          101
        )
      ).json()
    ).property('status', 'accepted')
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('start_at')
          .where('id', '=', 'unchangedInstant')
          .executeTakeFirstOrThrow()
      ).start_at.toISOString()
    ).equals('2027-02-01T20:00:00.000Z')
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/season/${f.seasonB}`,
          { endsOn: '2027-01-01' },
          102
        )
      ).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/season/${f.seasonB}`,
          { timezone: 'Bad/Zone' },
          102
        )
      ).status
    ).equals(400)
  })
  it('serializes racing acceptance, withdraw and resend, and rejects a stale parent graph', async () => {
    const id = await send()
    const results = await Promise.all([
      f.h.request('POST', `/relationship-requests/${id}/accept`, {}, 101),
      f.h.request(
        'POST',
        `/relationship-requests/${id}/resend`,
        { idempotencyKey: 'racing-replacement' },
        102
      )
    ])
    expect(results.map(row => row.status)).satisfies(
      (codes: number[]) =>
        codes[0] === 200 && (codes[1] === 201 || codes[1] === 409)
    )
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('team_id')
        .where('season_id', '=', f.seasonB)
        .where('team_id', '=', f.teamA)
        .execute()
    ).length.at.most(1)
    const body = {
      kind: 'parent',
      actions: [
        {
          operation: 'attach',
          child: { kind: 'team', id: f.standaloneTeam },
          parent: { kind: 'season', id: f.standaloneSeason }
        }
      ],
      sender: { kind: 'team', id: f.standaloneTeam },
      idempotencyKey: 'stored-parent-preview'
    }
    const proposal = await f.h.request(
      'POST',
      '/relationship-requests',
      body,
      103
    )
    const parent = (await proposal.json()) as { id: string }
    await f.h.db
      .updateTable('teams')
      .set({ league_id: f.leagueB })
      .where('id', '=', f.standaloneTeam)
      .execute()
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${parent.id}/accept`,
          {},
          103
        )
      ).status
    ).equals(409)
  })
})
