import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateDown, migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { createSession } from '../auth/sessions'
import { ownershipPreflight } from './ownershipPreflight'

describe('upgraded ownership reads and current competition projections', function () {
  this.timeout(60000)
  let h: AccountHarness | undefined
  let f: GroupFixture | undefined
  afterEach(async () => {
    await h?.close()
    await f?.h.close()
    h = undefined
    f = undefined
  })

  for (const ambiguous of [false, true])
    it(`preserves authenticated legacy access until an atomic ${ambiguous ? 'explicitly resolved' : 'ready'} ownership cutover`, async () => {
      h = await accountHarness(
        undefined,
        undefined,
        undefined,
        undefined,
        migrations.filter(migration => migration.name < '066')
      )
      await h.db
        .insertInto('users')
        .values({
          id: '103',
          legacyId: 'usr_demo_upgrade_staff',
          display_name: 'Mike Trout',
          login_enabled: true
        })
        .execute()
      h.tokens.set(
        103,
        (await createSession(h.db, '103', 'demo-upgrade')).token
      )
      const result = await sql<{
        name: string
      }>`select current_database() as name`.execute(h.db)
      const pool = new Pool({
        connectionString: testDatabaseUrl.replace(
          /\/[^/]*$/,
          '/' + result.rows[0].name
        )
      })
      try {
        await migrateDown(pool, migrations, 2)
        await h.db
          .updateTable('memberships')
          .set({ role: 'owner' })
          .where('team_id', '=', 'tem_account')
          .execute()
        await h.db
          .insertInto('seasons')
          .values([
            {
              starts_on: `2026-03-01`,
              ends_on: `2026-05-31`,
              id: 'sea_demo_upgrade_a',
              name: 'Demo Legacy Regular',
              year: 2026
            },
            ...(ambiguous
              ? [
                  {
                    starts_on: '2026-03-01',
                    ends_on: '2026-05-31',
                    id: 'sea_demo_upgrade_b',
                    name: 'Demo Legacy Other',
                    year: 2026
                  }
                ]
              : [])
          ])
          .execute()
        await h.db
          .insertInto('season_teams')
          .values([
            { season_id: 'sea_demo_upgrade_a', team_id: 'tem_account' },
            ...(ambiguous
              ? [{ season_id: 'sea_demo_upgrade_b', team_id: 'tem_account' }]
              : [])
          ])
          .execute()
        await h.db
          .insertInto('scope_roles')
          .values([
            {
              id: 'role_demo_upgrade_a',
              scope_type: 'season',
              scope_id: 'sea_demo_upgrade_a',
              user_id: '102',
              role: 'admin'
            },
            ...(ambiguous
              ? [
                  {
                    id: 'role_demo_upgrade_b',
                    scope_type: 'season' as const,
                    scope_id: 'sea_demo_upgrade_b',
                    user_id: '103',
                    role: 'admin' as const
                  }
                ]
              : [])
          ])
          .execute()
        await migrateUp(pool, migrations)
      } finally {
        await pool.end()
      }
      const reader = new TeamStationClient({
        baseUrl: h.origin + '/api/v1',
        token: h.tokens.get(102)
      })
      expect((await reader.myRoles()).teams.tem_account).includes('admin')
      expect(
        (await h.request('GET', '/teams/tem_account/roster', undefined, 102))
          .status
      ).equals(200)
      expect(
        await h.db.selectFrom('season_team_parents').selectAll().execute()
      ).length(0)
      const dry = await ownershipPreflight(h.db, { dryRun: true })
      expect(dry.ready).equals(!ambiguous)
      if (ambiguous) {
        expect(
          (await ownershipPreflight(h.db, { dryRun: false })).ready
        ).equals(false)
        expect((await reader.myRoles()).teams.tem_account).includes('admin')
        expect(
          (await h.request('GET', '/teams/tem_account/roster', undefined, 103))
            .status
        ).equals(200)
      }
      const applied = await ownershipPreflight(h.db, {
        dryRun: false,
        ...(ambiguous
          ? {
              choices: [
                {
                  teamId: 'tem_account',
                  parentSeasonIds: ['sea_demo_upgrade_a']
                }
              ]
            }
          : {})
      })
      expect(applied.ready).equals(true)
      expect((await reader.myRoles()).teams.tem_account).includes('admin')
      expect(
        (await h.request('GET', '/teams/tem_account/roster', undefined, 102))
          .status
      ).equals(200)
      // Not made a member by the cutover: what is kept for members is
      // refused them.
      if (ambiguous)
        expect(
          (await h.request('GET', '/teams/tem_account/stats', undefined, 103))
            .status
        ).equals(403)
    })

  it('never expands a visiting roster with host spectators and removes inactive membership from all current selectors while preserving games', async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('season_members')
      .values({
        id: 'membership_demo_host_spectator',
        season_id: f.seasonB,
        user_id: userIdOfGumbo(104)
      })
      .execute()
    const ownRoster = async (): Promise<unknown[]> =>
      (await (
        await f!.h.request('GET', `/teams/${f!.teamA}/roster`, undefined, 101)
      ).json()) as unknown[]
    const before = await ownRoster()
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        sender: { kind: 'season', id: f.seasonB },
        seasonId: f.seasonB,
        teamId: f.teamA,
        idempotencyKey: 'demo-reader-join'
      },
      102
    )
    expect(sent.status).equals(201)
    const request = (await sent.json()) as { id: string }
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${request.id}/accept`,
          {},
          101
        )
      ).status
    ).equals(200)
    expect(await ownRoster()).deep.equals(before)
    const host = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(102)
    })
    expect((await host.seasonTeams(f.seasonB)).map(team => team.id)).includes(
      f.teamA
    )
    // A season counts every team in it: the team it manages and the one now
    // competing.
    expect(
      (await host.seasons()).find(season => season.id === f!.seasonB)?.teams
    ).equals(2)
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_demo_retained_after_exit',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date('2027-04-01T19:00:00Z'),
        status: 'final',
        home_score: 3,
        away_score: 2
      })
      .execute()
    expect(
      (
        await f.h.request(
          'DELETE',
          `/seasons/${f.seasonB}/memberships/${f.teamA}`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    // The season's own page still lists the team, because it played there;
    // the scheduling selectors and competition below no longer do.
    expect((await host.seasonTeams(f.seasonB)).map(team => team.id)).includes(
      f.teamA
    )
    const summary = (await host.seasons()).find(
      season => season.id === f!.seasonB
    )!
    expect(summary.teams).equals(2)
    expect(summary.games).equals(1)
    expect((await host.standings(f.seasonB)).map(row => row.teamId)).includes(
      f.teamA
    )
    const selector = (await (
      await f.h.request('GET', `/teams?season=${f.seasonB}`, undefined, 102)
    ).json()) as Array<{ id: string }>
    expect(selector.map(team => team.id)).not.includes(f.teamA)
    const filtered = (await (
      await f.h.request('GET', `/seasons?team=${f.teamA}`, undefined, 101)
    ).json()) as Array<{ id: string }>
    expect(filtered.map(season => season.id)).not.includes(f.seasonB)
    expect(
      (await host.group({ kind: 'season', id: f.seasonB })).competingTeams
    ).length(0)
    expect(
      (
        await f.h.request(
          'GET',
          '/games/gam_demo_retained_after_exit',
          undefined,
          101
        )
      ).status
    ).equals(200)
  })
})
