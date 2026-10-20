import { type Kysely, sql } from 'kysely'

import { notFound } from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import type { PublicGroup, SearchRow } from '../../common/publicGroups'
import { publicStaffName } from '../../common/publicStaffName'
import { givenRolesOnTeams } from '../access'
import type { Database } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import { publicGroup } from './publicSummary'

/** What a game's other side is suggested around. */
export interface RelatedAnchor {
  teamId?: string
  seasonId?: string
}

/** The most suggestions one request answers. */
export const RELATED_LIMIT = 50

/**
 * The calendar date this many months before `now`, kept within its month:
 * six months before Aug 31 is the last day of February, not early March.
 */
export function monthsBefore(now: Date, months: number): Date {
  const date = new Date(now)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - months)
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return date
}

/**
 * The teams a game against the anchor is most likely to be with, in four
 * tiers: the same season, the same league, an opponent within six months,
 * then the same region. Each team appears once, in its first tier; merged
 * teams and the anchor itself never do.
 */
export async function relatedTeams(
  db: Kysely<Database>,
  anchor: RelatedAnchor,
  space: SpaceSettings,
  now: Date
): Promise<PublicGroup[]> {
  const team =
    anchor.teamId == null
      ? undefined
      : await db
          .selectFrom('teams')
          .select(['id', 'league_id', 'locality'])
          .where('id', '=', anchor.teamId)
          .executeTakeFirst()
  if (anchor.teamId != null && team == null) throw notFound()
  const season =
    anchor.seasonId == null
      ? undefined
      : await db
          .selectFrom('seasons')
          .select(['id', 'league_id'])
          .where('id', '=', anchor.seasonId)
          .executeTakeFirst()
  if (anchor.seasonId != null && season == null) throw notFound()

  const order = new Set<string>()
  const add = (ids: string[]): void => {
    for (const id of ids) if (id !== team?.id) order.add(id)
  }
  /** Whether the tiers so far already fill the answer. */
  const full = (): boolean => order.size > RELATED_LIMIT
  const live = async (ids: string[]): Promise<string[]> => {
    if (ids.length === 0) return []
    const rows = await db
      .selectFrom('teams')
      .select('id')
      .where('id', 'in', ids)
      .where('merged_into', 'is', null)
      .execute()
    const kept = new Set(rows.map(row => row.id))
    return ids.filter(id => kept.has(id))
  }

  // The seasons the anchor is in, and the teams each holds.
  const seasonsOfTeam =
    team == null
      ? []
      : (
          await db
            .selectFrom('season_teams')
            .select('season_id')
            .where('team_id', '=', team.id)
            .where('active', '=', true)
            .union(
              db
                .selectFrom('season_team_parents')
                .select('season_id')
                .where('team_id', '=', team.id)
            )
            .execute()
        ).map(row => row.season_id)
  const seasonIds = [
    ...new Set([...(season == null ? [] : [season.id]), ...seasonsOfTeam])
  ]
  const inSeasons = async (ids: string[]): Promise<string[]> => {
    if (ids.length === 0) return []
    const rows = await db
      .selectFrom(eb =>
        eb
          .selectFrom('season_teams')
          .select(['team_id', 'season_id'])
          .where('season_id', 'in', ids)
          .where('active', '=', true)
          .union(
            eb
              .selectFrom('season_team_parents')
              .select(['team_id', 'season_id'])
              .where('season_id', 'in', ids)
          )
          .as('held')
      )
      .innerJoin('seasons', 'seasons.id', 'held.season_id')
      .innerJoin('teams', 'teams.id', 'held.team_id')
      .select(['held.team_id', 'teams.name', 'seasons.starts_on'])
      .execute()
    const newest = new Map<string, { name: string; startsOn: string }>()
    for (const row of rows) {
      const startsOn = calendarDateText(row.starts_on) ?? ''
      const held = newest.get(row.team_id)
      if (held == null || startsOn > held.startsOn)
        newest.set(row.team_id, { name: row.name, startsOn })
    }
    return [...newest]
      .sort(([, a], [, b]) =>
        b.startsOn.localeCompare(a.startsOn) !== 0
          ? b.startsOn.localeCompare(a.startsOn)
          : a.name.localeCompare(b.name)
      )
      .map(([id]) => id)
  }
  add(await live(await inSeasons(seasonIds)))

  // The leagues of the anchor, its seasons and the anchor season.
  const leagueIds = new Set<string>()
  if (team?.league_id != null) leagueIds.add(team.league_id)
  if (season?.league_id != null) leagueIds.add(season.league_id)
  if (seasonsOfTeam.length > 0)
    for (const row of await db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', 'in', seasonsOfTeam)
      .execute())
      if (row.league_id != null) leagueIds.add(row.league_id)
  if (leagueIds.size > 0 && !full()) {
    const leagues = [...leagueIds]
    // A league can hold many teams: read only by name, as far as the answer
    // can still reach, past the ones earlier tiers already hold.
    const leagueSeasons = db
      .selectFrom('seasons')
      .select('id')
      .where('league_id', 'in', leagues)
    const rows = await db
      .selectFrom('teams')
      .select('id')
      .where('merged_into', 'is', null)
      .where(eb =>
        eb.or([
          eb('league_id', 'in', leagues),
          eb(
            'id',
            'in',
            eb
              .selectFrom('season_teams')
              .select('team_id')
              .where('active', '=', true)
              .where('season_id', 'in', leagueSeasons)
          ),
          eb(
            'id',
            'in',
            eb
              .selectFrom('season_team_parents')
              .select('team_id')
              .where('season_id', 'in', leagueSeasons)
          )
        ])
      )
      .orderBy('name')
      .orderBy('id')
      .limit(RELATED_LIMIT + order.size + 2)
      .execute()
    add(rows.map(row => row.id))
  }

  // Opponents within six months, the most recent first.
  if (team != null && !full()) {
    const games = await db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'start_at'])
      .where(eb =>
        eb.or([
          eb('home_team_id', '=', team.id),
          eb('away_team_id', '=', team.id)
        ])
      )
      .where('start_at', '>=', monthsBefore(now, 6))
      .where('start_at', '<=', now)
      .where('status', '!=', 'cancelled')
      .orderBy('start_at', 'desc')
      .execute()
    add(
      await live(
        games.map(game =>
          game.home_team_id === team.id ? game.away_team_id : game.home_team_id
        )
      )
    )
  }

  // The same state or region and country.
  let place = asPlace(team?.locality)
  const leagueOfPlace = team?.league_id ?? season?.league_id
  if (place == null && leagueOfPlace != null)
    place = asPlace(
      (
        await db
          .selectFrom('leagues')
          .select('locality')
          .where('id', '=', leagueOfPlace)
          .executeTakeFirst()
      )?.locality
    )
  if (place != null && !full()) {
    const rows = await db
      .selectFrom('teams')
      .select('id')
      .where('merged_into', 'is', null)
      .where(sql<string>`locality->>'region'`, '=', place.region)
      .where(sql<string>`locality->>'country'`, '=', place.country)
      .orderBy('name')
      .orderBy('id')
      .limit(RELATED_LIMIT + order.size + 2)
      .execute()
    add(rows.map(row => row.id))
  }

  return await Promise.all(
    [...order]
      .slice(0, RELATED_LIMIT)
      .map(async id => await publicGroup(db, { kind: 'team', id }, space))
  )
}

function asPlace(
  value: unknown
): { region: string; country: string } | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const { region, country } = value as { region?: unknown; country?: unknown }
  return typeof region === 'string' &&
    region !== '' &&
    typeof country === 'string'
    ? { region, country }
    : undefined
}

const ROLE_ORDER = ['coach', 'assistant', 'admin']

/**
 * What a team row in a search or a suggestion adds: the seasons the team is
 * in, newest first, and the public short names of its staff, coaches first.
 * Somebody who has not named themselves yet is left out.
 */
export async function teamRowExtras(
  db: Kysely<Database>,
  groups: PublicGroup[]
): Promise<SearchRow[]> {
  const ids = groups
    .filter(group => group.kind === 'team')
    .map(group => group.id)
  if (ids.length === 0) return groups
  const seasons = await db
    .selectFrom(eb =>
      eb
        .selectFrom('season_teams')
        .select(['team_id', 'season_id'])
        .where('team_id', 'in', ids)
        .where('active', '=', true)
        .union(
          eb
            .selectFrom('season_team_parents')
            .select(['team_id', 'season_id'])
            .where('team_id', 'in', ids)
        )
        .as('held')
    )
    .innerJoin('seasons', 'seasons.id', 'held.season_id')
    .select(['held.team_id', 'seasons.name'])
    .orderBy('seasons.starts_on', ob => ob.desc().nullsLast())
    .orderBy('seasons.name')
    .execute()
  const roles = await givenRolesOnTeams(db, ids)
  const userIds = [
    ...new Set([...roles.values()].flatMap(held => [...held.keys()]))
  ]
  const users = new Map(
    (userIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select([
            'id',
            'first_name',
            'last_name',
            'display_name',
            'onboarding_step'
          ])
          .where('id', 'in', userIds)
          .execute()
    ).map(user => [user.id, user])
  )
  const rank = (held: string[]): number =>
    Math.min(
      ...held.map(role =>
        ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length
      )
    )
  return groups.map(group => {
    if (group.kind !== 'team') return group
    const staff = [...(roles.get(group.id) ?? new Map<string, string[]>())]
      .map(([userId, held]) => ({ user: users.get(userId), held }))
      .filter(
        (
          entry
        ): entry is { user: NonNullable<typeof entry.user>; held: string[] } =>
          entry.user != null && entry.user.onboarding_step !== 'name'
      )
      .map(({ user, held }) => ({
        name: publicStaffName({
          firstName: user.first_name,
          lastName: user.last_name,
          displayName: user.display_name
        }),
        rank: rank(held)
      }))
      .sort((a, b) =>
        a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name)
      )
    return {
      ...group,
      seasonNames: [
        ...new Set(
          seasons.filter(row => row.team_id === group.id).map(row => row.name)
        )
      ],
      staffNames: [...new Set(staff.map(entry => entry.name))]
    }
  })
}
