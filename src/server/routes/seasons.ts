import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import type { SeasonGame } from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import {
  type AdminScopes,
  canSeeTeam,
  visibleGamesWhere,
  type VisibleScopes,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { teamEventSchedule } from '../events/eventInfo'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import {
  posterSecond,
  postersFor,
  posterUrl,
  warmPosters
} from '../media/posters'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { annotatePending, pendingSchedule } from '../schedule/pendingProjection'
import { scheduleRights } from '../schedule/scheduleGames'
import { teamRecords } from '../stats/records'
import {
  seasonParticipantCounts,
  seasonParticipants
} from '../stats/seasonTeams'

/**
 * Seasons, and what is in one.
 *
 * Home leads with seasons because that is what most people have: PeerTube's
 * channel allow-list gave many of them a season and no team at all, and a
 * team-first screen would show them nothing.
 *
 * The season team list combines active competition members and committed game
 * participants, including placeholders, without creating management links.
 *
 * `GET /seasons?team=…` narrows the list to the seasons those teams play in.
 * Asked that way, a season the caller may schedule games in counts as one
 * they may see, so a team's administrator can read the seasons their team
 * plays in even when nobody has opened them to spectators.
 */
export function seasonRoutes(
  db: Kysely<Database>,
  media: MediaContext
): Router {
  const router = Router()

  router.get(
    '/seasons',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const teamIds = valuesAsked(req.query.team, 'team')

      // Asked by team, a season the caller may schedule in is one they may
      // see; otherwise the list is exactly the seasons opened to them.
      const visible = scopes.isAdmin
        ? undefined
        : teamIds == null
          ? scopes.seasonIds
          : new Set([
              ...scopes.seasonIds,
              ...(await schedulableSeasonIds(db, actor.userId, actor.isAdmin))
            ])

      let query = db
        .selectFrom('seasons')
        .select([
          'id',
          'league_id',
          'name',
          'year',
          'term',
          'age_group',
          'logo_path'
        ])
        .select([
          sql<string | null>`to_char(starts_on, 'YYYY-MM-DD')`.as('startsOn'),
          sql<string | null>`to_char(ends_on, 'YYYY-MM-DD')`.as('endsOn')
        ])
        .orderBy('starts_on', ob => ob.desc().nullsLast())
        .orderBy('ends_on', ob => ob.desc().nullsLast())
        .orderBy('id')
      if (visible != null) query = query.where('id', 'in', [...visible])
      if (teamIds != null) {
        query = query.where('id', 'in', eb =>
          eb
            .selectFrom('season_teams')
            .select('season_teams.season_id')
            .where('season_teams.active', '=', true)
            .where('season_teams.team_id', 'in', teamIds)
        )
      }
      const seasons = visible?.size === 0 ? [] : await query.execute()

      // The counts a person actually wants on a card: how much is in here,
      // and is any of it watchable.
      const ids = seasons.map(season => season.id)
      const counts = new Map<
        string,
        { teams: number; games: number; videos: number }
      >()
      for (const id of ids) counts.set(id, { teams: 0, games: 0, videos: 0 })

      if (ids.length > 0) {
        const teamCounts = await seasonParticipantCounts(db, ids)
        for (const [id, total] of teamCounts) {
          const held = counts.get(id)
          if (held != null) held.teams = total
        }

        const gameRows = await db
          .selectFrom('games')
          .leftJoin('videos', join =>
            join.onRef('videos.game_id', '=', 'games.id').on(isRealVideo)
          )
          .select(['games.season_id as seasonId', 'games.id as gameId'])
          .select(eb => eb.fn.count<number>('videos.id').as('videoCount'))
          .where('games.season_id', 'in', ids)
          .groupBy(['games.season_id', 'games.id'])
          .execute()
        for (const row of gameRows) {
          const held =
            row.seasonId == null ? undefined : counts.get(row.seasonId)
          if (held == null) continue
          held.games += 1
          held.videos += Number(row.videoCount)
        }
      }

      res.json(
        seasons.map(season => ({
          id: season.id,
          leagueId: season.league_id,
          name: season.name,
          year: season.year,
          term: season.term,
          ageGroup: season.age_group,
          // The days the season runs, `YYYY-MM-DD`, which is how a game with
          // no `seasonId` is placed in one.
          startsOn: season.startsOn,
          endsOn: season.endsOn,
          logoUrl: imageUrl(media.space, season.logo_path),
          ...(counts.get(season.id) ?? { teams: 0, games: 0, videos: 0 })
        }))
      )
    })
  )

  router.get(
    '/seasons/:seasonId/teams',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const seasonId = pathParam(req.params.seasonId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!scopes.isAdmin && !scopes.seasonIds.has(seasonId)) throw notFound()

      const { teams } = await seasonParticipants(db, seasonId)

      // A record and a signed logo URL, the same as `/teams` gives. Without
      // the URL the app correctly falls back to initials — it never builds an
      // image address itself — so the logos simply never appeared here.
      const records = await teamRecords(db, { seasonId })

      res.json(
        teams.map(({ activeMember, parentMember, ...team }) => {
          const record = records.find(row => row.teamId === team.id)
          return {
            ...team,
            canViewPrivate: canSeeTeam(scopes, team.id),
            logoUrl: imageUrl(media.space, team.logoPath),
            record:
              record == null || record.w + record.l + record.t === 0
                ? null
                : {
                    w: record.w,
                    l: record.l,
                    t: record.t,
                    seasonName: null
                  }
          }
        })
      )
    })
  )

  return router
}

/**
 * The seasons a person may schedule games in: those they administer, a
 * league's included, and every season a team they administer plays in.
 */
export async function schedulableSeasonIds(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean
): Promise<Set<string>> {
  const rights = await scheduleRights(db, userId, isAdmin)
  const out = new Set(rights.seasonIds)
  if (rights.teamAdminIds.size > 0) {
    const played = await db
      .selectFrom('season_teams')
      .select('season_id')
      .where('team_id', 'in', [...rights.teamAdminIds])
      .where('active', '=', true)
      .execute()
    for (const row of played) out.add(row.season_id)
  }
  return out
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

/** A schedule row plus the logo paths the event list turns into URLs. */
/**
 * A game as the schedule query reads it: the logos are still paths here, and
 * `GET /events` signs them into the `homeLogoUrl`/`awayLogoUrl` it answers
 * with.
 */
export interface ScheduleRow extends Omit<
  SeasonGame,
  'homeLogoUrl' | 'awayLogoUrl'
> {
  homeLogoPath: string | null
  awayLogoPath: string | null
}

export interface ScheduleFilter {
  actor?: Actor
  /** Public game previews never include private titled team events. */
  gamesOnly?: boolean
  publishedOnly?: boolean
  teamId?: string
  seasonIds?: string[]
  /** Games `canSeeGame` lets that person see. */
  visible?: VisibleScopes
  /**
   * Games this account may score. A site admin is unfiltered. Somebody who
   * runs no team gets an empty list.
   */
  run?: AdminScopes
  /**
   * Games this account may film. A site admin is unfiltered. Somebody who
   * films no team gets an empty list.
   */
  film?: { teamIds: Set<string>; isAdmin: boolean }
  externalIds?: string[]
  played?: boolean
  limit?: number
  omitCancelled?: boolean
  since?: Date
  until?: Date
  untilInclusive?: boolean
  /** No score yet, and the start is still ahead. */
  upcoming?: boolean
  /** The complement of `upcoming`, including a game with no start. */
  past?: boolean
  /** The start is still ahead, whether or not it has a score. */
  future?: boolean
  now?: Date
  order?: 'asc' | 'desc'
}

/**
 * Games in the shape a schedule shows them: both teams, the score, how many
 * videos and whether one is live, and a poster. Each game carries the
 * external ids it has. Every filter given narrows the list. `GET /events`
 * is the route that asks.
 */
export async function scheduleOf(
  db: Kysely<Database>,
  media: MediaContext,
  filter: ScheduleFilter
): Promise<ScheduleRow[]> {
  const effectiveNow = filter.now ?? new Date()
  const teamScope = filter.run ?? filter.film
  if (teamScope != null && !teamScope.isAdmin && teamScope.teamIds.size === 0) {
    return []
  }
  let query = db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .leftJoin(
      'teams as withdrawn',
      'withdrawn.id',
      'games.withdrawn_by_team_id'
    )
    .leftJoin('videos', join =>
      join
        .onRef('videos.game_id', '=', 'games.id')
        .on('videos.hidden', '=', false)
        .on(isRealVideo)
    )
    .select([
      'games.id as id',
      'games.home_team_id as homeTeamId',
      'games.away_team_id as awayTeamId',
      'home.name as homeTeamName',
      'away.name as awayTeamName',
      // So the app can tell a real team from a one-off opponent.
      'home.kind as homeTeamKind',
      'away.kind as awayTeamKind',
      'games.season_id as seasonId',
      'games.start_at as startAt',
      'games.venue as venue',
      'games.end_at as endAt',
      'games.address as address',
      'games.latitude as latitude',
      'games.longitude as longitude',
      'games.exhibition as exhibition',
      'games.timezone as timezone',
      'games.cancellation_reason as cancellationReason',
      'games.withdrawn_by_team_id as withdrawnByTeamId',
      'withdrawn.name as withdrawnByTeamName',
      'games.status as status',
      'games.home_score as homeScore',
      'games.away_score as awayScore',
      'games.ingest_status as ingestStatus',
      'home.logo_path as homeLogoPath',
      'away.logo_path as awayLogoPath'
    ])
    .select(eb => eb.fn.count<number>('videos.id').as('videoCount'))
    // The longest video of the game: on a multi-camera game that is the
    // full broadcast rather than whichever clip happens to sort first.
    .select(eb => eb.fn.max('videos.duration_sec').as('durationSec'))
    // Whether any of its videos is arriving now. The same join already
    // being made for the count, so a live game costs nothing to spot.
    .select(eb =>
      eb.fn
        .max(eb.case().when('videos.status', '=', 'live').then(1).else(0).end())
        .as('liveNow')
    )
    .groupBy([
      'games.id',
      'withdrawn.name',
      'home.name',
      'away.name',
      'home.kind',
      'away.kind',
      'home.logo_path',
      'away.logo_path'
    ])

  if (filter.teamId != null) {
    const teamId = filter.teamId
    query = query.where(eb =>
      eb.or([
        eb('games.home_team_id', '=', teamId),
        eb('games.away_team_id', '=', teamId)
      ])
    )
  }
  if (filter.seasonIds != null) {
    query = query.where('games.season_id', 'in', filter.seasonIds)
  }
  const visible =
    filter.visible == null ? undefined : visibleGamesWhere(filter.visible)
  if (visible != null) query = query.where(visible)
  if (filter.played === true) {
    query = query.where('games.home_score', 'is not', null)
  }
  if (filter.omitCancelled === true) {
    query = query.where('games.status', '<>', 'cancelled')
  }
  if (teamScope != null && !teamScope.isAdmin) {
    const teamIds = [...teamScope.teamIds]
    query = query.where(eb =>
      eb.or([
        eb('games.home_team_id', 'in', teamIds),
        eb('games.away_team_id', 'in', teamIds)
      ])
    )
  }
  if (filter.since != null) {
    query = query.where('games.start_at', '>=', filter.since)
  }
  if (filter.until != null) {
    query = query.where(
      'games.start_at',
      filter.untilInclusive === true ? '<=' : '<',
      filter.until
    )
  }
  if (filter.future === true) {
    query = query.where('games.start_at', '>', effectiveNow)
  }
  if (filter.upcoming === true) {
    query = query
      .where('games.start_at', '>', effectiveNow)
      .where('games.away_score', 'is', null)
  }
  if (filter.past === true) {
    const now = effectiveNow
    query = query.where(eb =>
      eb.or([
        eb('games.start_at', 'is', null),
        eb('games.start_at', '<=', now),
        eb('games.away_score', 'is not', null)
      ])
    )
  }
  // Newest first, unless the caller is looking forward.
  query = query
    .orderBy('games.start_at', filter.order ?? 'desc')
    // Match JavaScript's ID byte ordering regardless of the database locale.
    .orderBy(sql<string>`games.id collate "C"`, filter.order ?? 'desc')
  if (filter.externalIds != null) {
    const externalIds = filter.externalIds
    query = query.where(eb =>
      eb.exists(
        eb
          .selectFrom('external_ids')
          .select('external_ids.id')
          .where('external_ids.entity_type', '=', 'game')
          .whereRef('external_ids.entity_id', '=', 'games.id')
          .where('external_ids.external_id', 'in', externalIds)
      )
    )
  }
  // Only the first N published rows can occur in the first N of the combined list.
  if (filter.limit != null) query = query.limit(filter.limit)
  const games = await query
    .select(eb =>
      eb
        .selectFrom('external_ids')
        .select(
          sql<
            string[]
          >`coalesce(array_agg(external_ids.external_id order by external_ids.external_id), '{}')`.as(
            'ids'
          )
        )
        .where('external_ids.entity_type', '=', 'game')
        .whereRef('external_ids.entity_id', '=', 'games.id')
        .as('externalIds')
    )
    .execute()

  const posters = await postersFor(
    db,
    games.map(game => game.id)
  )
  const now = Date.now()

  const answer = games.map((game): ScheduleRow => {
    const poster = posters.get(game.id)
    return {
      id: game.id,
      homeLogoPath: game.homeLogoPath,
      awayLogoPath: game.awayLogoPath,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      homeTeamName: game.homeTeamName,
      awayTeamName: game.awayTeamName,
      homeTeamExternal: game.homeTeamKind === 'external',
      awayTeamExternal: game.awayTeamKind === 'external',
      seasonId: game.seasonId,
      startAt: toIso(game.startAt),
      venue: game.venue,
      endAt: toIso(game.endAt),
      address: game.address,
      latitude: game.latitude,
      longitude: game.longitude,
      exhibition: game.exhibition,
      timezone: game.timezone,
      cancellationReason: game.cancellationReason,
      withdrawnByTeamId: game.withdrawnByTeamId,
      withdrawnByTeamName: game.withdrawnByTeamName,
      pendingApproval: false,
      pendingRequestId: null,
      status: game.status,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      ingestStatus: game.ingestStatus,
      videoCount: Number(game.videoCount),
      durationSec: game.durationSec == null ? null : Number(game.durationSec),
      posterUrl:
        poster == null
          ? null
          : posterUrl(
              media,
              poster.videoId,
              posterSecond(poster.durationSec),
              now
            ),
      isLive: Number(game.liveNow) === 1,
      externalIds: game.externalIds ?? []
    }
  })

  // Not waited for. The first person to open a list starts the work and sees
  // plain plates; everybody after sees pictures.
  warmPosters(media, [...posters.values()]).catch(() => undefined)
  const pending = await pendingSchedule(db, filter.actor, effectiveNow, {
    publishedGameIds: answer.map(game => game.id),
    teamId: filter.teamId,
    seasonIds: filter.seasonIds,
    visible: filter.visible,
    includeNew:
      teamScope == null &&
      filter.externalIds == null &&
      filter.publishedOnly !== true
  })
  const projected: ScheduleRow[] =
    teamScope != null ||
    filter.externalIds != null ||
    filter.publishedOnly === true
      ? []
      : pending
          .filter(row => row.existingGameId == null)
          .filter(
            row =>
              filter.seasonIds == null ||
              filter.seasonIds.some(id => row.hostSeasonIds.includes(id))
          )
          .filter(
            row =>
              filter.teamId == null ||
              row.homeTeamId === filter.teamId ||
              row.awayTeamId === filter.teamId
          )
          .filter(
            row =>
              filter.visible == null ||
              filter.visible.isAdmin ||
              [row.homeTeamId, row.awayTeamId].some(
                id => filter.visible?.teamIds.has(id) === true
              ) ||
              row.hostSeasonIds.some(
                id => filter.visible?.seasonIds.has(id) === true
              )
          )
          .map(
            ({ existingGameId, affectedTeamIds, hostSeasonIds, ...row }) => ({
              ...row,
              pendingApproval: true,
              status: 'scheduled',
              cancellationReason: null,
              withdrawnByTeamId: null,
              withdrawnByTeamName: null,
              homeScore: null,
              awayScore: null,
              ingestStatus: 'none',
              videoCount: 0,
              durationSec: null,
              posterUrl: null,
              isLive: false,
              externalIds: []
            })
          )
  const nonGames: ScheduleRow[] = []
  if (
    filter.gamesOnly !== true &&
    teamScope == null &&
    filter.played !== true &&
    filter.externalIds == null &&
    filter.publishedOnly !== true &&
    (filter.seasonIds == null || filter.seasonIds.length > 0) &&
    (filter.visible == null ||
      filter.visible.isAdmin ||
      filter.visible.teamIds.size > 0)
  ) {
    let eventQuery = db
      .selectFrom('team_events')
      .innerJoin('teams', 'teams.id', 'team_events.team_id')
      .selectAll('team_events')
      .select(['teams.name as teamName', 'teams.logo_path as logoPath'])
    if (filter.teamId != null)
      eventQuery = eventQuery.where('team_events.team_id', '=', filter.teamId)
    if (filter.seasonIds != null)
      eventQuery = eventQuery.where('team_events.team_id', 'in', eb =>
        eb
          .selectFrom('season_teams')
          .select('team_id')
          .where('active', '=', true)
          .where('season_id', 'in', filter.seasonIds!)
      )
    if (filter.visible != null && !filter.visible.isAdmin)
      eventQuery = eventQuery.where('team_events.team_id', 'in', [
        ...filter.visible.teamIds
      ])
    for (const row of await eventQuery.execute())
      nonGames.push(teamEventSchedule(row, row.teamName, row.logoPath))
  }
  const nowMs = effectiveNow.getTime()
  let combined = [
    ...annotatePending(answer, pending),
    ...projected,
    ...nonGames
  ].filter(row => {
    const when = row.startAt == null ? null : Date.parse(row.startAt)
    if (filter.played === true && row.homeScore == null) return false
    if (filter.omitCancelled === true && row.status === 'cancelled')
      return false
    if (filter.since != null && (when == null || when < filter.since.getTime()))
      return false
    if (
      filter.until != null &&
      (when == null ||
        (filter.untilInclusive === true
          ? when > filter.until.getTime()
          : when >= filter.until.getTime()))
    )
      return false
    if (
      (filter.future === true || filter.upcoming === true) &&
      (when == null || when <= nowMs)
    )
      return false
    if (filter.upcoming === true && row.awayScore != null) return false
    if (
      filter.past === true &&
      when != null &&
      when > nowMs &&
      row.awayScore == null
    )
      return false
    return true
  })
  combined.sort((a, b) => {
    const order = filter.order === 'asc' ? 1 : -1
    if (a.startAt == null || b.startAt == null) {
      if (a.startAt !== b.startAt) return (a.startAt == null ? 1 : -1) * order
    }
    const date =
      a.startAt == null || b.startAt == null
        ? 0
        : Date.parse(a.startAt) - Date.parse(b.startAt)
    const id = a.id === b.id ? 0 : a.id < b.id ? -1 : 1
    return (date !== 0 ? date : id) * order
  })
  if (filter.limit != null) combined = combined.slice(0, filter.limit)
  return combined
}

/**
 * A repeatable query parameter: undefined when it is not asked for, and
 * otherwise every value, each a non-empty string.
 */
export function valuesAsked(
  asked: unknown,
  name: string
): string[] | undefined {
  if (asked === undefined) return undefined
  const values = Array.isArray(asked) ? asked : [asked]
  if (values.some(value => typeof value !== 'string' || value === '')) {
    throw badRequest(`${name} must be a non-empty string`)
  }
  return values as string[]
}

/** The `externalId` filter of `GET /events`, `GET /users` and `GET /teams`. */
export function externalIdsAsked(asked: unknown): string[] | undefined {
  return valuesAsked(asked, 'externalId')
}
