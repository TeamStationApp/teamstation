import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import type { GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'
import { seedUmpireCounts } from './umpireTypes'

/**
 * Two League A seasons of the umpire fixture that no fixture user plays in,
 * neither overlapping `seasonA` (2027-03-01 – 2027-05-31): `ses_umpire_later`
 * with the upcoming `gam_umpire_other`, and `ses_umpire_past` with the past
 * `gam_umpire_past`. Team B is active in both; each requires a majors plate.
 */
export async function addAcceptanceSeasons(f: GroupFixture): Promise<void> {
  const db = f.h.db
  for (const [id, name, startsOn, endsOn, game, startAt] of [
    [
      'ses_umpire_later',
      'Demo Summer',
      '2027-06-15',
      '2027-08-31',
      'gam_umpire_other',
      '2027-07-03T00:00:00Z'
    ],
    [
      'ses_umpire_past',
      'Demo Fall',
      '2026-09-01',
      '2026-12-31',
      'gam_umpire_past',
      '2026-10-03T00:00:00Z'
    ]
  ] as const) {
    await db
      .insertInto('seasons')
      .values({
        id,
        league_id: f.leagueA,
        name,
        year: Number(startsOn.slice(0, 4)),
        starts_on: startsOn,
        ends_on: endsOn,
        timezone: 'America/Los_Angeles'
      })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: id, team_id: f.teamB, active: true })
      .execute()
    await db
      .insertInto('season_umpire_requirements')
      .values({ season_id: id, level_id: 'ulv_majors' })
      .execute()
    await seedUmpireCounts(db, id)
    const start = new Date(startAt)
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: f.teamB,
        away_team_id: f.teamA,
        season_id: id,
        start_at: start,
        end_at: new Date(start.getTime() + 2 * 3600000),
        timezone: 'America/Los_Angeles',
        venue: 'Demo Field',
        status: 'scheduled'
      })
      .execute()
  }
}

/**
 * A new person with no membership anywhere, signed in as gumbo `id`, given
 * League A's umpire role (unless `role` is false) and majors plate and field
 * certifications. Answers their user id.
 */
export async function freshUmpire(
  f: GroupFixture,
  id: number,
  role = true
): Promise<string> {
  await insertFixtureUsers(f.h.db, {
    id,
    legacyId: `usr_acceptance_${id}`,
    display_name: `Umpire ${id}`,
    first_name: 'Umpire',
    last_name: String(id),
    login_enabled: true,
    is_admin: false
  })
  const userId = userIdOfGumbo(id)
  f.h.tokens.set(id, (await createSession(f.h.db, userId, 'acceptance')).token)
  if (role)
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userId,
        granted_by: userIdOfGumbo(101)
      })
      .execute()
  await f.h.db
    .insertInto('umpire_certifications')
    .values(
      ['uty_plate', 'uty_field'].map(typeId => ({
        user_id: userId,
        level_id: 'ulv_majors',
        type_id: typeId,
        enabled: true
      }))
    )
    .execute()
  return userId
}

/** A direct role row for `userId` on a league, season or team. */
export async function grantScopeRole(
  f: GroupFixture,
  userId: string,
  scopeType: 'league' | 'season' | 'team',
  scopeId: string,
  role: 'admin' | 'coach' = 'coach'
): Promise<string> {
  const id = `rol_acceptance_${userId.slice(-6)}_${scopeType}_${role}`
  await f.h.db
    .insertInto('scope_roles')
    .values({
      id,
      user_id: userId,
      scope_type: scopeType,
      scope_id: scopeId,
      role,
      granted_by: userIdOfGumbo(101),
      granted_at: new Date()
    })
    .execute()
  return id
}
