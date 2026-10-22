import { userIdOfGumbo } from '../common/userId'
import { umpireRoutes } from '../server/routes/umpires'
import { type GroupFixture, groupFixture } from './groupFixtures'
import { seedUmpireCounts, seedUmpireTypes } from './umpireTypes'
export const UMPIRE_BROWSER_NOW = '2027-04-01T12:00:00Z'
export async function umpireBrowserFixture(web: string): Promise<GroupFixture> {
  const f = await groupFixture(web, undefined, (app, { db, media }) => {
    app.use('/api/v1', umpireRoutes(db, media))
  })
  const db = f.h.db
  for (const [id, first, last] of [
    [101, 'Ada', 'Lee'],
    [103, 'Uma', 'Lee'],
    [104, 'Billy', 'Lee'],
    [106, 'Bobby', 'Lee']
  ] as const)
    await db
      .updateTable('users')
      .set({
        first_name: first,
        last_name: last,
        display_name: `${first} ${last}`
      })
      .where('id', '=', userIdOfGumbo(id))
      .execute()
  await db
    .updateTable('leagues')
    .set({ name: 'Demo League' })
    .where('id', '=', f.leagueA)
    .execute()
  await db
    .updateTable('leagues')
    .set({ name: 'Demo Visitors' })
    .where('id', '=', f.leagueB)
    .execute()
  await db
    .updateTable('seasons')
    .set({
      starts_on: '2027-03-02',
      ends_on: '2027-06-30',
      timezone: 'America/Los_Angeles'
    })
    .where('id', '=', f.seasonA)
    .execute()
  await db
    .updateTable('seasons')
    .set({ starts_on: '2026-09-01', ends_on: '2026-12-22' })
    .where('id', '=', f.playoffs)
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: 'lmb_umpire_browser',
      league_id: f.leagueA,
      user_id: userIdOfGumbo(103),
      role: 'member'
    })
    .execute()
  await db
    .insertInto('user_links')
    .values(
      [104, 106].map(id => ({
        id: `lnk_umpire_browser_${id}`,
        user_id: userIdOfGumbo(103),
        related_user_id: userIdOfGumbo(id),
        kind: 'guardian' as const
      }))
    )
    .execute()
  await db
    .insertInto('memberships')
    .values({
      id: 'mem_umpire_browser',
      team_id: f.teamA,
      user_id: userIdOfGumbo(104),
      is_player: true,
      role: 'member'
    })
    .execute()
  await db
    .insertInto('season_teams')
    .values(
      [f.teamA, f.teamB].flatMap(teamId =>
        [f.seasonA, f.playoffs].map(seasonId => ({
          season_id: seasonId,
          team_id: teamId,
          active: true
        }))
      )
    )
    .onConflict(oc => oc.doNothing())
    .execute()
  await db
    .insertInto('games')
    .values({
      id: 'gam_umpire_g1',
      season_id: f.seasonA,
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      start_at: new Date('2027-04-04T00:00:00Z'),
      end_at: new Date('2027-04-04T02:00:00Z'),
      timezone: 'America/Los_Angeles',
      venue: 'Field 1',
      notes: 'North diamond entrance',
      status: 'scheduled'
    })
    .execute()
  return f
}
export async function readyUmpireBrowser(f: GroupFixture): Promise<void> {
  const db = f.h.db
  await seedUmpireTypes(db, f.leagueA)
  await db
    .updateTable('leagues')
    .set({ umpire_management: true, umpire_credits: true })
    .where('id', '=', f.leagueA)
    .execute()
  await db
    .insertInto('umpire_levels')
    .values({
      id: 'ulv_browser_majors',
      league_id: f.leagueA,
      name: 'majors',
      position: 0
    })
    .execute()
  await db
    .insertInto('season_umpire_requirements')
    .values({
      season_id: f.seasonA,
      level_id: 'ulv_browser_majors'
    })
    .execute()
  await seedUmpireCounts(db, f.seasonA)
  await db
    .insertInto('league_umpires')
    .values({
      league_id: f.leagueA,
      user_id: userIdOfGumbo(103),
      granted_by: userIdOfGumbo(101)
    })
    .execute()
  await db
    .insertInto('umpire_certifications')
    .values({
      user_id: userIdOfGumbo(103),
      level_id: 'ulv_browser_majors',
      type_id: 'uty_plate',
      enabled: true
    })
    .execute()
}
