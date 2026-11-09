import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  asCreateGroup,
  asGroupKind,
  asGroupRef
} from '../../common/groupCreation'
import { userIdOfGumbo } from '../../common/userId'
import { accountTestPicture } from '../../test/accountHarness'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { afterCommitsSettled } from '../db/atomic'

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
  it('releases the picture it uploaded when the creation does not commit', async () => {
    for (const route of ['/leagues', '/teams'] as const) {
      const key = `rolled-back-picture${route.replace('/', '-')}`
      const name = `Demo Rolled Back ${route.slice(1)}`
      const before = new Set(f.h.objects.keys())
      // The same retry key is taken while the picture is uploaded: the
      // creation's last statement fails, and its transaction rolls back.
      f.h.controls.beforePut = async () => {
        await f.h.db
          .insertInto('creation_idempotency')
          .values({
            user_id: userIdOfGumbo(101),
            key,
            body_hash: 'taken',
            response: {}
          })
          .execute()
      }
      const failed = await f.h.request('POST', route, {
        name,
        locality: demoLocality,
        picture: { image: accountTestPicture },
        idempotencyKey: key
      })
      expect(failed.status, await failed.text()).not.lessThan(400)
      expect(f.h.controls.beforePut).equals(undefined)
      await afterCommitsSettled()
      expect(
        [...f.h.objects.keys()].filter(held => !before.has(held))
      ).deep.equals([])
      const table = route === '/leagues' ? 'leagues' : 'teams'
      expect(
        await f.h.db
          .selectFrom(table)
          .select('id')
          .where('name', '=', name)
          .execute()
      ).deep.equals([])
    }
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
  it('lets a placeholder team be created without a location, and nothing else', async () => {
    const placeholder = async (
      name: string,
      locality?: typeof demoLocality
    ): Promise<string> => {
      const response = await f.h.request('POST', '/teams', {
        name,
        idempotencyKey: `placeholder-${name}`,
        external: true,
        custodian: { kind: 'team', id: f.teamA },
        ...(locality == null ? {} : { locality })
      })
      expect(response.status, await response.clone().text()).equals(201)
      return ((await response.json()) as { id: string }).id
    }
    const unplaced = await placeholder('Demo Unplaced')
    const placed = await placeholder('Demo Placed', demoLocality)
    const stored = await f.h.db
      .selectFrom('teams')
      .select(['id', 'locality', 'kind'])
      .where('id', 'in', [unplaced, placed])
      .orderBy('name', 'desc')
      .execute()
    expect(stored).deep.equals([
      { id: unplaced, locality: null, kind: 'external' },
      { id: placed, locality: demoLocality, kind: 'external' }
    ])
    for (const body of [
      { kind: 'team', name: 'Demo Full', idempotencyKey: 'full-no-place' },
      { kind: 'league', name: 'Demo League', idempotencyKey: 'league-no-place' }
    ])
      expect(() => asCreateGroup(body)).throws(TypeError)
    expect(
      asCreateGroup({
        kind: 'team',
        name: 'Demo Unplaced',
        idempotencyKey: 'unplaced-key',
        external: true,
        custodian: { kind: 'team', id: f.teamA }
      })
    ).not.have.property('locality')
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
