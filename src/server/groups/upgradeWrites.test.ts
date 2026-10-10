import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { accountTestPicture } from '../../test/accountHarness'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'

describe('unresolved cutover gates new hierarchy writes while retained routes remain usable', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('teams')
      .values({
        id: 'tem_demo_unresolved_owner',
        name: 'Demo unresolved owner'
      })
      .execute()
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_demo_legacy_player',
        team_id: f.teamA,
        user_id: 106,
        role: 'member',
        is_player: true
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('permits retained song deletion, team logo and player headshot in production router order', async () => {
    expect(
      (
        await f.h.request(
          'DELETE',
          `/teams/${f.teamA}/players/106/walk-up-song`,
          undefined,
          101
        )
      ).status
    ).equals(204)
    for (const path of [
      `/teams/${f.teamA}/logo`,
      `/teams/${f.teamA}/players/106/avatar`
    ]) {
      const response = await f.h.request(
        'PUT',
        path,
        { image: accountTestPicture, source: 'upload' },
        101
      )
      expect(response.status, path).equals(200)
      expect(await response.json()).property('stored', true)
    }
    expect(
      (
        await f.h.db
          .selectFrom('system_settings')
          .select('value')
          .where('key', '=', 'creation.hierarchyReady')
          .executeTakeFirstOrThrow()
      ).value
    ).equals(false)
  })
  it('still blocks every new creation route, including Express case and trailing-slash variants', async () => {
    for (const path of [
      '/teams',
      '/Teams/',
      '/leagues',
      '/Leagues/',
      '/seasons',
      '/Seasons/'
    ]) {
      const response = await f.h.request(
        'POST',
        path,
        {
          name: 'Demo blocked creation',
          locality: demoLocality,
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          timezone: 'UTC',
          idempotencyKey: 'blocked-' + path
        },
        101
      )
      expect(response.status, path).equals(503)
    }
    expect(
      (
        await f.h.request(
          'POST',
          '/parent-previews',
          {
            actions: [
              {
                operation: 'detach',
                parent: { kind: 'season', id: f.seasonA },
                child: { kind: 'team', id: f.teamA }
              }
            ]
          },
          101
        )
      ).status
    ).equals(503)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/seasons/${f.seasonB}/memberships/${f.teamA}`,
          undefined,
          101
        )
      ).status
    ).equals(503)
  })
})
