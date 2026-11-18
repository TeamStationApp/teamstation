import { makeId } from '../../../common/ids'
import { packedLeagueRun } from '../../../test/packedLeagueRun'
import { createTeam } from '../../teams/createTeam'
import { insertUser } from '../../users/insertUser'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/**
 * The Auto-Scheduler's packed league (`src/test/packedLeagueRun.ts`) as a
 * league a person can open: an `admin` who administers it, its six seasons
 * with their teams, every team's head coach (six of them coaching in two
 * seasons), the park's five fields with their hours, and the scheduler's
 * setup and settings saved, every season and field chosen. Building it with
 * the exact solver gives 10, 10, 12, 14, 16 and 16 games per team.
 */

/** Invented coaches, with MLB players' names. */
const SURNAMES = [
  'Ohtani',
  'Judge',
  'Soto',
  'Betts',
  'Freeman',
  'Alvarez',
  'Acuña',
  'Lindor',
  'Harper',
  'Trout',
  'Witt',
  'Seager'
]

export async function runPackedLeague(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'packed-league'
  const run = packedLeagueRun()
  const admin = await createAccount(context, world, 'admin', {
    first: 'Dave',
    last: 'Roberts'
  })
  const now = new Date()
  const league = makeId('league')
  await db
    .insertInto('leagues')
    .values({
      id: league,
      name: `Packed League ${nonce}`,
      short_name: null,
      locality: null,
      website: null,
      logo_path: null,
      logo_sha256: null,
      logo_source: null,
      logo_updated_at: null,
      notes: null,
      era_innings: null,
      fence_distance_ft: null,
      created_at: now,
      updated_at: now
    })
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: admin.userId,
      scope_type: 'league',
      scope_id: league,
      role: 'admin',
      granted_by: null,
      granted_at: now
    })
    .execute()

  // The park and its fields, claimed by the league.
  const venue = makeId('venue')
  const park = run.fields[0].availability
  await db
    .insertInto('venues')
    .values({
      id: venue,
      google_place_id: `fixture:${world}:${nonce}`,
      name: `Packed Park ${nonce}`,
      address: '1 Packed Park Way',
      latitude: 32.7,
      longitude: -117.1,
      timezone: park.timezone,
      default_hours: JSON.stringify([]),
      default_windows: JSON.stringify(
        run.fields.find(field => field.name === 'F2')?.availability.windows
      ),
      default_blackouts: []
    })
    .execute()
  await db
    .insertInto('venue_claims')
    .values({
      id: makeId('venueClaim'),
      venue_id: venue,
      league_id: league,
      kind: 'claim',
      requested_by: admin.userId,
      status: 'approved',
      // Requested a week ago and approved now, as a claim must be.
      requested_at: new Date(now.getTime() - 7 * 86_400_000),
      approves_at: now,
      decided_by: admin.userId,
      decided_at: now
    })
    .execute()
  const fieldIds = new Map<string, string>()
  for (const field of run.fields) {
    const id = makeId('venueField')
    fieldIds.set(field.id, id)
    // The unlit fields keep the park's sunset hours; the lit ones their own.
    const unlit = field.name === 'F2' || field.name === 'F4'
    await db
      .insertInto('venue_fields')
      .values({
        id,
        venue_id: venue,
        name: field.name,
        sizes: field.sizes,
        pin_latitude: null,
        pin_longitude: null,
        starts_on: null,
        ends_on: null,
        hours: unlit ? null : JSON.stringify(field.availability.hours),
        windows: unlit ? null : JSON.stringify(field.availability.windows),
        blackouts: []
      })
      .execute()
  }

  // The seasons, their teams and head coaches, and their settings.
  const coaches = new Map<string, string>()
  const coachOf = async (manager: string): Promise<string> => {
    let userId = coaches.get(manager)
    if (userId == null) {
      const surname = SURNAMES[coaches.size % SURNAMES.length]
      userId = await insertUser(db, {
        display_name: `Coach ${surname} ${coaches.size + 1}`,
        first_name: 'Coach',
        last_name: `${surname} ${coaches.size + 1}`,
        login_enabled: true,
        onboarding_step: 'complete',
        onboarding_completed_at: now
      })
      coaches.set(manager, userId)
    }
    return userId
  }
  const ids: Record<string, string> = { league, venue }
  const seasonIds: string[] = []
  for (const season of run.seasons) {
    const seasonId = makeId('season')
    seasonIds.push(seasonId)
    ids[season.name] = seasonId
    await db
      .insertInto('seasons')
      .values({
        id: seasonId,
        league_id: league,
        name: season.name,
        timezone: park.timezone,
        year: 2027,
        term: 'Spring',
        starts_on: '2027-03-01',
        ends_on: '2027-05-31',
        age_group: null,
        logo_path: null,
        logo_sha256: null,
        logo_source: null,
        logo_updated_at: null,
        era_innings: null,
        fence_distance_ft: null,
        playing_time_rules: null,
        created_at: now,
        updated_at: now
      })
      .execute()
    for (const teamKey of season.participants) {
      const team = await createTeam(
        db,
        { name: `${run.teamNames[teamKey]} ${nonce}`, externalIds: [] },
        { userId: admin.userId, isAdmin: false }
      )
      ids[teamKey] = team.id
      await db
        .insertInto('season_teams')
        .values({ season_id: seasonId, team_id: team.id, active: true })
        .execute()
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: await coachOf(run.headCoaches?.[teamKey] ?? teamKey),
          scope_type: 'team',
          scope_id: team.id,
          role: 'coach',
          is_head_coach: true,
          granted_by: admin.userId,
          granted_at: now
        })
        .execute()
    }
    const { settings } = season
    await db
      .insertInto('season_schedule_settings')
      .values({
        season_id: seasonId,
        field_ids: (settings.fieldIds ?? []).flatMap(
          field => fieldIds.get(field) ?? []
        ),
        field_size: settings.fieldSize,
        game_minutes: settings.gameMinutes,
        buffer_minutes: settings.bufferMinutes,
        regular_games: settings.regularGames,
        exhibition_games: settings.exhibitionGames,
        doubleheaders: settings.doubleheaders,
        max_games_on_weekdays: settings.maxGamesOnWeekdays,
        max_games_on_weekend: settings.maxGamesOnWeekend,
        prefer_game_on: settings.preferGameOn,
        starts_on: settings.startsOn,
        ends_on: settings.endsOn,
        blackouts: settings.blackouts,
        windows: JSON.stringify(settings.windows)
      })
      .execute()
  }
  await db
    .insertInto('league_schedule_setups')
    .values({
      league_id: league,
      avoid_head_coach_conflicts: true,
      season_ids: seasonIds,
      field_ids: [...fieldIds.values()]
    })
    .execute()
  return { world, nonce, accounts: { admin }, ids }
}
