import type { Kysely } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import {
  asWindowPeriods,
  defaultScheduleSettings,
  type ScheduleSettings,
  type ScheduleSetup,
  type ScheduleSetupChoice,
  type SeasonScheduleSettings,
  type SetupField
} from '../../common/seasonScheduling'
import { asFieldSize } from '../../common/venues'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { seasonParticipants } from '../stats/seasonTeams'
import { claimCounts } from '../venues/ownership'
import { datesOf } from '../venues/venues'

type Db = Kysely<Database>

export interface SeasonRow {
  id: string
  name: string
  year: number
  timezone: string
  league_id: string | null
  starts_on: string | null
  ends_on: string | null
}

async function seasonRow(db: Db, seasonId: string): Promise<SeasonRow> {
  const season = await db
    .selectFrom('seasons')
    .select([
      'id',
      'name',
      'year',
      'timezone',
      'league_id',
      'starts_on',
      'ends_on'
    ])
    .where('id', '=', seasonId)
    .executeTakeFirst()
  if (season == null) throw notFound()
  return season
}

/** Seasons by id, in no particular order. */
export async function seasonRows(db: Db, ids: string[]): Promise<SeasonRow[]> {
  if (ids.length === 0) return []
  return await db
    .selectFrom('seasons')
    .select([
      'id',
      'name',
      'year',
      'timezone',
      'league_id',
      'starts_on',
      'ends_on'
    ])
    .where('id', 'in', ids)
    .execute()
}

/** The league a season is scheduled under; a season must have one. */
export async function seasonLeagueId(
  db: Db,
  seasonId: string
): Promise<string> {
  const season = await seasonRow(db, seasonId)
  if (season.league_id == null)
    throw conflict('A season must belong to a league to be scheduled')
  return season.league_id
}

/** The settings of seasons, saved or their defaults. */
export async function settingsOf(
  db: Db,
  seasons: SeasonRow[]
): Promise<Map<string, { saved: boolean; settings: ScheduleSettings }>> {
  const rows =
    seasons.length === 0
      ? []
      : await db
          .selectFrom('season_schedule_settings')
          .selectAll()
          .where(
            'season_id',
            'in',
            seasons.map(season => season.id)
          )
          .execute()
  return new Map(
    seasons.map(
      (season): [string, { saved: boolean; settings: ScheduleSettings }] => {
        const row = rows.find(item => item.season_id === season.id)
        if (row == null)
          return [
            season.id,
            {
              saved: false,
              settings: defaultScheduleSettings({
                startsOn: calendarDateText(season.starts_on),
                endsOn: calendarDateText(season.ends_on),
                year: season.year
              })
            }
          ]
        return [
          season.id,
          {
            saved: true,
            settings: {
              fieldSize: asFieldSize(row.field_size),
              gameMinutes: row.game_minutes,
              bufferMinutes: row.buffer_minutes,
              regularGames: row.regular_games,
              exhibitionGames: row.exhibition_games,
              doubleheaders: row.doubleheaders,
              startsOn: calendarDateText(row.starts_on)!,
              endsOn: calendarDateText(row.ends_on)!,
              blackouts: datesOf(row.blackouts),
              windows: asWindowPeriods(row.windows)
            }
          }
        ]
      }
    )
  )
}

export async function seasonScheduleSettings(
  db: Db,
  seasonId: string
): Promise<SeasonScheduleSettings> {
  const season = await seasonRow(db, seasonId)
  const found = (await settingsOf(db, [season])).get(season.id)!
  return { seasonId, ...found }
}

export async function saveSeasonScheduleSettings(
  db: Db,
  seasonId: string,
  settings: ScheduleSettings
): Promise<SeasonScheduleSettings> {
  const values = {
    field_size: settings.fieldSize,
    game_minutes: settings.gameMinutes,
    buffer_minutes: settings.bufferMinutes,
    regular_games: settings.regularGames,
    exhibition_games: settings.exhibitionGames,
    doubleheaders: settings.doubleheaders,
    starts_on: settings.startsOn,
    ends_on: settings.endsOn,
    blackouts: settings.blackouts,
    windows: JSON.stringify(settings.windows),
    updated_at: new Date()
  }
  await db
    .insertInto('season_schedule_settings')
    .values({ season_id: seasonId, ...values })
    .onConflict(oc => oc.column('season_id').doUpdateSet(values))
    .execute()
  return await seasonScheduleSettings(db, seasonId)
}

/**
 * The seasons chosen for a league's next run that are still the league's,
 * in the order they were chosen: the setup's `seasonIds`, without reading
 * the rest of the setup.
 */
export async function chosenSeasonIds(
  db: Db,
  leagueId: string
): Promise<string[]> {
  const chosen = await db
    .selectFrom('league_schedule_setups')
    .select('season_ids')
    .where('league_id', '=', leagueId)
    .executeTakeFirst()
  const ids = chosen?.season_ids ?? []
  if (ids.length === 0) return []
  const own = await db
    .selectFrom('seasons')
    .select('id')
    .where('league_id', '=', leagueId)
    .where('id', 'in', ids)
    .execute()
  return ids.filter(id => own.some(season => season.id === id))
}

/**
 * The teams the scheduler gives a season's games: its active and
 * parent-managed teams, not merged away. Flagged ones are its exhibition
 * teams; the rest are its participants.
 */
export async function schedulingTeams(
  db: Db,
  seasonId: string
): Promise<Array<{ id: string; name: string; exhibition: boolean }>> {
  const { teams } = await seasonParticipants(db, seasonId)
  return teams
    .filter(team => team.activeMember || team.parentMember)
    .map(team => ({
      id: team.id,
      name: team.name,
      exhibition: team.exhibition
    }))
}

/** Marks a team in a season as an exhibition team, or not. */
export async function setExhibition(
  db: Db,
  seasonId: string,
  teamId: string,
  exhibition: boolean
): Promise<void> {
  const { teams } = await seasonParticipants(db, seasonId)
  if (
    !teams.some(
      team => team.id === teamId && (team.activeMember || team.parentMember)
    )
  )
    throw notFound()
  await db
    .insertInto('season_team_flags')
    .values({ season_id: seasonId, team_id: teamId, exhibition })
    .onConflict(oc =>
      oc.columns(['season_id', 'team_id']).doUpdateSet({ exhibition })
    )
    .execute()
}

/** The venues the league owns: a claim of its that counts. */
async function ownedVenueIds(
  db: Db,
  leagueId: string,
  clock: Clock
): Promise<string[]> {
  const claims = await db
    .selectFrom('venue_claims')
    .selectAll()
    .where('league_id', '=', leagueId)
    .where('status', 'in', ['pending', 'approved'])
    .execute()
  return [
    ...new Set(
      claims
        .filter(claim => claimCounts(claim, clock))
        .map(claim => claim.venue_id)
    )
  ]
}

/**
 * Who owns each of these venues: the leagues whose claims count, by id
 * and name.
 */
async function venueOwners(
  db: Db,
  venueIds: string[],
  clock: Clock
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const owners = new Map<string, Array<{ id: string; name: string }>>()
  if (venueIds.length === 0) return owners
  const claims = await db
    .selectFrom('venue_claims')
    .innerJoin('leagues', 'leagues.id', 'venue_claims.league_id')
    .selectAll('venue_claims')
    .select('leagues.name as league_name')
    .where('venue_claims.venue_id', 'in', venueIds)
    .where('venue_claims.status', 'in', ['pending', 'approved'])
    .execute()
  for (const claim of claims) {
    if (!claimCounts(claim, clock)) continue
    const list = owners.get(claim.venue_id) ?? []
    if (!list.some(owner => owner.id === claim.league_id))
      list.push({ id: claim.league_id, name: claim.league_name })
    owners.set(claim.venue_id, list)
  }
  return owners
}

async function setupFields(
  db: Db,
  leagueId: string,
  where: { venueIds: string[]; fieldIds: string[]; addedFieldIds: string[] },
  clock: Clock
): Promise<SetupField[]> {
  if (
    where.venueIds.length === 0 &&
    where.fieldIds.length === 0 &&
    where.addedFieldIds.length === 0
  )
    return []
  const rows = await db
    .selectFrom('venue_fields')
    .innerJoin('venues', 'venues.id', 'venue_fields.venue_id')
    .select([
      'venue_fields.id',
      'venue_fields.name',
      'venue_fields.venue_id',
      'venues.name as venue_name',
      'venue_fields.sizes',
      'venue_fields.starts_on',
      'venue_fields.ends_on',
      'venue_fields.deleted_at'
    ])
    .where(eb =>
      eb.or([
        ...(where.venueIds.length === 0
          ? []
          : [
              eb.and([
                eb('venue_fields.venue_id', 'in', where.venueIds),
                eb('venue_fields.deleted_at', 'is', null)
              ])
            ]),
        ...(where.fieldIds.length === 0
          ? []
          : [eb('venue_fields.id', 'in', where.fieldIds)]),
        // An added field is listed until it is removed, or deleted.
        ...(where.addedFieldIds.length === 0
          ? []
          : [
              eb.and([
                eb('venue_fields.id', 'in', where.addedFieldIds),
                eb('venue_fields.deleted_at', 'is', null)
              ])
            ])
      ])
    )
    .orderBy('venues.name')
    .orderBy('venue_fields.name')
    .orderBy('venue_fields.id')
    .execute()
  const owners = await venueOwners(
    db,
    [...new Set(rows.map(row => row.venue_id))],
    clock
  )
  return rows.map(row => {
    const owning = owners.get(row.venue_id) ?? []
    return {
      id: row.id,
      name: row.name,
      venueId: row.venue_id,
      venueName: row.venue_name,
      sizes: row.sizes.map(size => asFieldSize(size)),
      startsOn: calendarDateText(row.starts_on),
      endsOn: calendarDateText(row.ends_on),
      deleted: row.deleted_at != null,
      ours: owning.some(owner => owner.id === leagueId),
      ownerNames: owning
        .map(owner => owner.name)
        .sort((a, b) => a.localeCompare(b))
    }
  })
}

/**
 * A league's Auto-Scheduler setup: its seasons with their settings and team
 * counts; the fields of its venues, every field it added from another
 * venue, chosen or not, and any other field already chosen; and the seasons
 * and fields chosen for the next run.
 */
export async function scheduleSetup(
  db: Db,
  leagueId: string,
  clock: Clock = realClock
): Promise<ScheduleSetup> {
  const chosen = await db
    .selectFrom('league_schedule_setups')
    .select(['season_ids', 'field_ids', 'added_field_ids'])
    .where('league_id', '=', leagueId)
    .executeTakeFirst()
  const seasons = await db
    .selectFrom('seasons')
    .select([
      'id',
      'name',
      'year',
      'timezone',
      'league_id',
      'starts_on',
      'ends_on'
    ])
    .where('league_id', '=', leagueId)
    .orderBy('starts_on', 'desc')
    .orderBy('year', 'desc')
    .orderBy('name')
    .orderBy('id')
    .execute()
  const settings = await settingsOf(db, seasons)
  const seasonIds = (chosen?.season_ids ?? []).filter(id =>
    seasons.some(season => season.id === id)
  )
  const fields = await setupFields(
    db,
    leagueId,
    {
      venueIds: await ownedVenueIds(db, leagueId, clock),
      fieldIds: chosen?.field_ids ?? [],
      addedFieldIds: chosen?.added_field_ids ?? []
    },
    clock
  )
  return {
    leagueId,
    seasonIds,
    fieldIds: (chosen?.field_ids ?? []).filter(id =>
      fields.some(field => field.id === id)
    ),
    // A deleted field is no longer one to add back, so it is not listed as
    // added, and a save that resends the list needs no change to it.
    addedFieldIds: (chosen?.added_field_ids ?? []).filter(id =>
      fields.some(field => field.id === id && !field.deleted)
    ),
    seasons: await Promise.all(
      seasons.map(async season => {
        const teams = await schedulingTeams(db, season.id)
        const found = settings.get(season.id)!
        return {
          id: season.id,
          name: season.name,
          year: season.year,
          timezone: season.timezone,
          participants: teams.filter(team => !team.exhibition).length,
          exhibitionTeams: teams.filter(team => team.exhibition).length,
          teams,
          saved: found.saved,
          settings: found.settings
        }
      })
    ),
    fields
  }
}

/**
 * Chooses the next run's seasons and fields: seasons of this league, and
 * any fields in the registry that are not deleted, wherever they are and
 * whether or not anybody claims their venue. With `addedFieldIds`, it also
 * replaces the fields the league added from other venues, less any deleted
 * or unknown one, which the setup lists whether they are chosen or not;
 * left out, they are kept.
 */
export async function saveScheduleSetup(
  db: Db,
  leagueId: string,
  choice: ScheduleSetupChoice,
  clock: Clock = realClock
): Promise<ScheduleSetup> {
  if (choice.seasonIds.length > 0) {
    const own = await db
      .selectFrom('seasons')
      .select('id')
      .where('id', 'in', choice.seasonIds)
      .where('league_id', '=', leagueId)
      .execute()
    if (own.length !== choice.seasonIds.length)
      throw badRequest('Choose seasons of this league')
  }
  // The chosen fields must exist. The added ones are remembered rows, not a
  // choice: their owners can delete them while the setup is open, and every
  // save resends the list, so a deleted or unknown one is dropped instead.
  const listed = [
    ...new Set([...choice.fieldIds, ...(choice.addedFieldIds ?? [])])
  ]
  const live = new Set(
    listed.length === 0
      ? []
      : (
          await db
            .selectFrom('venue_fields')
            .select('id')
            .where('id', 'in', listed)
            .where('deleted_at', 'is', null)
            .execute()
        ).map(field => field.id)
  )
  if (choice.fieldIds.some(id => !live.has(id)))
    throw badRequest('Choose fields that exist')
  const values = {
    season_ids: choice.seasonIds,
    field_ids: choice.fieldIds,
    ...(choice.addedFieldIds == null
      ? {}
      : {
          added_field_ids: [...new Set(choice.addedFieldIds)].filter(id =>
            live.has(id)
          )
        }),
    updated_at: new Date()
  }
  await db
    .insertInto('league_schedule_setups')
    .values({ league_id: leagueId, ...values })
    .onConflict(oc => oc.column('league_id').doUpdateSet(values))
    .execute()
  return await scheduleSetup(db, leagueId, clock)
}
