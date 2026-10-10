import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { setScopeRoles } from '../invites/people'
import { directAdminIds } from './adminGuard'

describe('legacy creation and person reads respect current authority', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  it('serializes legacy team and named-season creation with suspension while external identity resolution waits', async () => {
    let release!: () => void
    let ready!: () => void
    const locked = new Promise<void>(resolve => {
      ready = resolve
    })
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    const holder = f.h.db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended('extid:demo:team:pending', 0))`.execute(
        trx
      )
      ready()
      await released
    })
    await locked
    let creation: Promise<Response> | undefined
    let suspension: Promise<Response> | undefined
    try {
      creation = f.h.request(
        'POST',
        '/teams',
        {
          name: 'Demo Pending Team',
          season: { name: 'Demo Pending Season', year: 2027 },
          externalIds: [{ system: 'demo', kind: 'team', id: 'pending' }]
        },
        104
      )
      const deadline = Date.now() + 4000
      while (true) {
        const result = await sql<{
          n: number
        }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory'`.execute(
          f.h.db
        )
        if (result.rows[0].n > 0) break
        if (Date.now() > deadline)
          throw new Error('Creation did not reach its identity lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      let resolved = false
      suspension = f.h.request(
        'PATCH',
        '/users/104/administration',
        { suspended: true },
        105
      )
      suspension
        .then(() => {
          resolved = true
        })
        .catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(resolved).equals(false)
      release()
      await holder
      const response = await creation
      expect(response.status).equals(201)
      const made = (await response.json()) as {
        id: string
        season: { id: string }
      }
      expect((await suspension).status).equals(409)
      for (const ref of [
        { kind: 'team' as const, id: made.id },
        { kind: 'season' as const, id: made.season.id }
      ])
        expect(await directAdminIds(f.h.db, ref)).deep.equals([104])
    } finally {
      release()
      await holder
      await creation
      await suspension
    }
  })

  it('rejects a suspended creator even when an earlier request supplied stale administrator authority', async () => {
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/104/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(200)
    const { createTeam } = await import('../teams/createTeam')
    const result = await createTeam(
      f.h.db,
      { name: 'Demo Refused', externalIds: [] },
      { userId: 104, isAdmin: true }
    ).then(
      () => null,
      (error: unknown) => error
    )
    expect(result).property('code', 'unauthorized')
    expect(
      await f.h.db
        .selectFrom('teams')
        .select('id')
        .where('name', '=', 'Demo Refused')
        .execute()
    ).length(0)
  })

  it('keeps competition and game viewing from revealing private player profiles or external identities', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'membership_demo_player',
        user_id: 106,
        team_id: f.teamA,
        role: 'member',
        is_player: true
      })
      .execute()
    await f.h.db
      .insertInto('external_ids')
      .values({
        id: 'ext_demo_player',
        entity_type: 'user',
        entity_id: '106',
        system: 'demo',
        kind: 'player',
        external_id: 'demo-player'
      })
      .execute()
    const profile = async (user: number): Promise<number> =>
      (await f.h.request('GET', '/players/106', undefined, user)).status
    const lookup = async (user: number): Promise<unknown> =>
      await (
        await f.h.request(
          'GET',
          '/users?externalId=demo-player',
          undefined,
          user
        )
      ).json()
    expect(await profile(102)).equals(404)
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonB, team_id: f.teamA })
      .execute()
    expect(await profile(102)).equals(404)
    expect(await lookup(102)).deep.equals([])
    await f.h.db
      .insertInto('season_members')
      .values({
        id: 'membership_demo_spectator',
        user_id: 104,
        season_id: f.seasonB
      })
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_demo_profile_boundary',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date('2027-04-01T19:00:00Z'),
        status: 'final'
      })
      .execute()
    await f.h.db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_demo_profile_boundary',
        game_id: 'gam_demo_profile_boundary',
        team_id: f.teamA,
        user_id: 106
      })
      .execute()
    for (const user of [102, 104]) {
      expect(await profile(user)).equals(404)
      expect(await lookup(user)).deep.equals([])
    }
    await f.h.db
      .deleteFrom('memberships')
      .where('id', '=', 'membership_demo_player')
      .execute()
    expect(await profile(102)).equals(404)
    expect(await lookup(102)).deep.equals([])
    await f.h.db
      .insertInto('season_members')
      .values({
        id: 'membership_demo_parent_coach',
        user_id: 103,
        season_id: f.seasonA
      })
      .execute()
    await setScopeRoles(
      f.h.db,
      'season',
      f.seasonA,
      103,
      { admin: false, flags: ['coach'] },
      101
    )
    for (const user of [101, 103, 105, 106])
      expect(await profile(user)).equals(200)
    expect(await lookup(103)).deep.equals([
      { userId: 106, externalIds: ['demo-player'] }
    ])
  })
})
