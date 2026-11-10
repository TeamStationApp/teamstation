import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('immutable parent-season invitation time frames', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('displays the snapshotted dates/zone, supersedes changed terms and requires fresh recipient consent after resend', async () => {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        sender: { kind: 'league', id: f.leagueA },
        kind: 'parent',
        actions: [
          {
            operation: 'attach',
            child: { kind: 'season', id: f.standaloneSeason },
            parent: { kind: 'league', id: f.leagueA }
          }
        ],
        idempotencyKey: 'parent-period-original'
      },
      101
    )
    expect(response.status).equals(201)
    const { id } = (await response.json()) as { id: string }
    const before = (await (
      await f.h.request('GET', `/me/notifications/${id}`, undefined, 103)
    ).json()) as { description: string }
    expect(before.description).includes('2027')
    expect(before.description).includes('UTC')
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/season/${f.standaloneSeason}`,
          {
            startsOn: '2028-06-01',
            endsOn: '2028-08-31',
            timezone: 'America/New_York'
          },
          103
        )
      ).status
    ).equals(200)
    const old = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      103
    )
    expect(await old.json()).property('status', 'superseded')
    const resent = await f.h.request(
      'POST',
      `/relationship-requests/${id}/resend`,
      { idempotencyKey: 'parent-period-resent' },
      101
    )
    expect(resent.status).equals(201)
    const next = (await resent.json()) as { id: string }
    const current = (await (
      await f.h.request('GET', `/me/notifications/${next.id}`, undefined, 103)
    ).json()) as { description: string }
    expect(current.description).includes('2028')
    expect(current.description).includes('America/New_York')
    expect(
      (
        await f.h.db
          .selectFrom('seasons')
          .select('league_id')
          .where('id', '=', f.standaloneSeason)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(null)
    expect(
      await (
        await f.h.request(
          'POST',
          `/relationship-requests/${next.id}/accept`,
          {},
          103
        )
      ).json()
    ).property('status', 'accepted')
  })
  it('also rejects a stale parent preview when a direct writer changes the season terms without the settings endpoint', async () => {
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        sender: { kind: 'league', id: f.leagueA },
        kind: 'parent',
        actions: [
          {
            operation: 'attach',
            child: { kind: 'season', id: f.standaloneSeason },
            parent: { kind: 'league', id: f.leagueA }
          }
        ],
        idempotencyKey: 'parent-direct-period-edit'
      },
      101
    )
    const { id } = (await sent.json()) as { id: string }
    await f.h.db
      .updateTable('seasons')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', f.standaloneSeason)
      .execute()
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      103
    )
    expect(accepted.status).equals(409)
    expect(
      (
        await f.h.db
          .selectFrom('seasons')
          .select('league_id')
          .where('id', '=', f.standaloneSeason)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(null)
  })
})
