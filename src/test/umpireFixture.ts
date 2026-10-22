import { userIdOfGumbo } from '../common/userId'
import { umpireRoutes } from '../server/routes/umpires'
import { type GroupFixture, groupFixture } from './groupFixtures'
import { seedUmpireCounts, seedUmpireTypes } from './umpireTypes'

export const UMPIRE_TEST_NOW = '2027-04-01T12:00:00Z'
export async function umpireFixture(): Promise<GroupFixture> {
  const f = await groupFixture(undefined, undefined, (app, { db, media }) => {
    app.use('/api/v1', umpireRoutes(db, media))
  })
  await seedUmpireTypes(f.h.db, f.leagueA)
  const user = userIdOfGumbo(101)
  const child = userIdOfGumbo(104)
  await f.h.db
    .updateTable('leagues')
    .set({ umpire_management: true, umpire_credits: true })
    .where('id', '=', f.leagueA)
    .execute()
  await f.h.db
    .insertInto('league_members')
    .values({
      id: 'lmb_umpire',
      league_id: f.leagueA,
      user_id: user,
      role: 'member'
    })
    .execute()
  await f.h.db
    .insertInto('league_umpires')
    .values(
      [101, 104].map(id => ({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(id),
        granted_by: user
      }))
    )
    .execute()
  await f.h.db
    .insertInto('user_links')
    .values({
      id: 'lnk_umpire',
      user_id: user,
      related_user_id: child,
      kind: 'guardian'
    })
    .execute()
  await f.h.db
    .insertInto('memberships')
    .values({
      id: 'mem_umpire',
      team_id: f.teamA,
      user_id: child,
      is_player: true,
      role: 'member'
    })
    .execute()
  await f.h.db
    .insertInto('season_teams')
    .values({ season_id: f.seasonA, team_id: f.teamA, active: true })
    .onConflict(oc => oc.doNothing())
    .execute()
  await f.h.db
    .insertInto('umpire_levels')
    .values({
      id: 'ulv_majors',
      league_id: f.leagueA,
      name: 'majors',
      position: 0
    })
    .execute()
  await f.h.db
    .insertInto('season_umpire_requirements')
    .values({
      season_id: f.seasonA,
      level_id: 'ulv_majors'
    })
    .execute()
  await seedUmpireCounts(f.h.db, f.seasonA)
  await f.h.db
    .insertInto('umpire_certifications')
    .values(
      [101, 104].flatMap(id =>
        ['uty_plate', 'uty_field'].map(typeId => ({
          user_id: userIdOfGumbo(id),
          level_id: 'ulv_majors',
          type_id: typeId,
          enabled: true
        }))
      )
    )
    .execute()
  await f.h.db
    .insertInto('games')
    .values({
      id: 'gam_umpire',
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: new Date('2027-04-03T00:00:00Z'),
      end_at: new Date('2027-04-03T02:00:00Z'),
      timezone: 'America/Los_Angeles',
      venue: 'Demo Field',
      notes: 'North diamond entry'
    })
    .execute()
  return f
}
