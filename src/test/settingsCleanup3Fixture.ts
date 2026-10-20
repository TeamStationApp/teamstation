import { userIdOfGumbo } from '../common/userId'
import type { GroupFixture } from './groupFixtures'

/** Shared fictional identities for browser and deferred native settings checks. */
export async function seedSettingsCleanup3(f: GroupFixture): Promise<void> {
  for (const type of ['practice', 'other'] as const)
    await f.h.db
      .insertInto('team_events')
      .values({
        id: `tev_settings3_${type}`,
        team_id: f.teamA,
        event_type: type,
        title: type === 'practice' ? 'Practice' : 'Team meeting',
        start_at: new Date('2027-04-10T19:00:00Z'),
        end_at: new Date('2027-04-10T21:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field'
      })
      .execute()
  await f.h.db
    .updateTable('users')
    .set({ is_admin: true })
    .where('id', '=', userIdOfGumbo(101))
    .execute()
  await f.h.db
    .updateTable('teams')
    .set({ name: 'Winter Wolves' })
    .where('id', '=', f.teamA)
    .execute()
  await f.h.db
    .updateTable('teams')
    .set({ name: 'Orchard Owls' })
    .where('id', '=', f.teamB)
    .execute()
  await f.h.db
    .updateTable('leagues')
    .set({ name: 'Willow Woods' })
    .where('id', '=', f.leagueA)
    .execute()
  await f.h.db
    .updateTable('seasons')
    .set({ name: 'Winter Weekends', year: 2027 })
    .where('id', '=', f.seasonA)
    .execute()
  await f.h.db
    .updateTable('seasons')
    .set({
      name: 'Spring Playoffs',
      year: 2028,
      starts_on: '2028-03-01',
      ends_on: '2028-05-31'
    })
    .where('id', '=', f.playoffs)
    .execute()
  for (const season of [f.seasonA, f.playoffs])
    await f.h.db
      .insertInto('season_teams')
      .values({
        season_id: season,
        team_id: f.teamA,
        joined_at: new Date('2027-01-01T00:00:00Z'),
        active: true
      })
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
  await f.h.db
    .insertInto('memberships')
    .values({
      id: 'mem_settings3_player',
      user_id: userIdOfGumbo(104),
      team_id: f.teamA,
      is_player: true
    })
    .execute()
  for (const [id, status] of [
    ['gam_settings3_scheduled', 'scheduled'],
    ['gam_settings3_live', 'inProgress'],
    ['gam_settings3_final', 'final']
  ] as const)
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2027-04-10T19:00:00Z'),
        end_at: new Date('2027-04-10T21:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field',
        status,
        home_score: status === 'final' ? 4 : null,
        away_score: status === 'final' ? 2 : null
      })
      .execute()
}
