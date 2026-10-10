import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  asCreateGroup,
  asGroupKind,
  asGroupRef
} from '../../common/groupCreation'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'

describe('minimal group creation HTTP service', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('creates parent-only context, creator administration and independent locality', async () => {
    const { h, teamA, seasonA, leagueA } = f
    expect(
      await h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', teamA)
        .execute()
    ).length(0)
    expect(
      await h.db
        .selectFrom('teams')
        .select(['league_id', 'locality'])
        .where('id', '=', teamA)
        .executeTakeFirstOrThrow()
    ).deep.equals({ league_id: leagueA, locality: demoLocality })
    expect(
      await h.db
        .selectFrom('season_team_parents')
        .selectAll()
        .where('team_id', '=', teamA)
        .where('season_id', '=', seasonA)
        .execute()
    ).length(1)
    expect(
      await h.db
        .selectFrom('scope_roles')
        .selectAll()
        .where('scope_id', '=', teamA)
        .where('role', '=', 'admin')
        .execute()
    ).length(1)
  })
  it('preserves retry identity and rejects changed details, missing locality and unauthorized context', async () => {
    const body = {
      name: 'Demo Retry',
      locality: demoLocality,
      idempotencyKey: 'repeat-create'
    }
    const first = await f.h.request('POST', '/teams', body)
    const again = await f.h.request('POST', '/teams', body)
    expect(await again.json()).deep.equals(await first.json())
    expect(
      (await f.h.request('POST', '/teams', { ...body, name: 'Other' })).status
    ).equals(409)
    expect(
      (
        await f.h.request('POST', '/teams', {
          name: 'Missing',
          idempotencyKey: 'missing-locality'
        })
      ).status
    ).equals(400)
    expect(
      (
        await f.h.request('POST', '/teams', {
          ...body,
          idempotencyKey: 'forbidden-parent',
          parent: { kind: 'season', id: f.seasonB }
        })
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'POST',
          '/leagues',
          { ...body, idempotencyKey: 'no-session' },
          null
        )
      ).status
    ).equals(401)
  })
  it('validates kind, names, dates, timezone, picture and permitted parent kinds', () => {
    expect(() => asGroupKind('player')).throws(TypeError)
    expect(() => asGroupRef({ kind: 'team', id: '' })).throws(TypeError)
    expect(() => asCreateGroup(null)).throws(TypeError)
    const season = {
      kind: 'season',
      name: 'Demo One Day',
      startsOn: '2027-05-01',
      endsOn: '2027-05-01',
      timezone: 'UTC',
      idempotencyKey: 'one-day-season'
    }
    expect(asCreateGroup(season).startsOn).equals('2027-05-01')
    for (const raw of [
      { ...season, startsOn: 'bad' },
      { ...season, startsOn: '2027-02-30' },
      { ...season, endsOn: '2027-04-30' },
      { ...season, timezone: 'Bad/Time' },
      { ...season, parent: { kind: 'season', id: 's' } },
      { ...season, picture: { catalogId: 'baseball', image: {} } },
      { ...season, idempotencyKey: 'x' }
    ])
      expect(() => asCreateGroup(raw)).throws(TypeError)
  })
})
