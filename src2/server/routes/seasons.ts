import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import type { SeasonGame } from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { visibleGamesWhere, type VisibleScopes, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
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

/**
 * Seasons, and what is in one.
 *
 * Home leads with seasons because that is what most people have: PeerTube's
 * channel allow-list gave many of them a season and no team at all, and a
 * team-first screen would show them nothing.
 *
 * An **external team** — an opponent from outside the season — is deliberately
 * absent from `/seasons/:id/teams`. It appears on a game, and nowhere else.
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

      const seasons = scopes.isAdmin
        ? await db
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
            .orderBy('year', 'desc')
            .orderBy('name')
            .execute()
        : scopes.seasonIds.size === 0
          ? []
          : await db
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
              .where('id', 'in', [...scopes.seasonIds])
              .orderBy('year', 'desc')
              .orderBy('name')
              .execute()

      // The counts a person actually wants on a card: how much is in here,
      // and is any of it watchable.
      const ids = seasons.map(season => season.id)
      const counts = new Map<
        string,
        { teams: number; games: number; videos: number }
      >()
      for (const id of ids) counts.set(id, { teams: 0, games: 0, videos: 0 })

      if (ids.length > 0) {
        const teamRows = await db
          .selectFrom('season_teams')
          .innerJoin('teams', 'teams.id', 'season_teams.team_id')
          .select(['season_teams.season_id as seasonId'])
          .where('season_teams.season_id', 'in', ids)
          // External teams are not in the season, so they are not counted.
          .where('teams.kind', '=', 'full')
          .execute()
        for (const row of teamRows) {
          const held = counts.get(row.seasonId)
          if (held != null) held.teams += 1
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

      const teams = await db
        .selectFrom('season_teams')
        .innerJoin('teams', 'teams.id', 'season_teams.team_id')
        .select([
          'teams.id as id',
          'teams.name as name',
          'teams.short_name as shortName',
          'teams.logo_path as logoPath'
        ])
        .where('season_teams.season_id', '=', seasonId)
        .where('teams.kind', '=', 'full')
        .orderBy('teams.name')
        .execute()

      // A record and a signed logo URL, the same as `/teams` gives. Without
      // the URL the app correctly falls back to initials — it never builds an
      // image address itself — so the logos simply never appeared here.
      const records = await db
        .selectFrom('team_season_records')
        .select(['team_id', 'w', 'l', 't'])
        .where('season_id', '=', seasonId)
        .execute()

      res.json(
        teams.map(team => {
          const record = records.find(row => row.team_id === team.id)
          return {
            ...team,
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

  router.get(
    '/seasons/:seasonId/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const seasonId = pathParam(req.params.seasonId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!scopes.isAdmin && !scopes.seasonIds.has(seasonId)) throw notFound()
      res.json(await scheduleOf(db, media, { seasonIds: [seasonId] }))
    })
  )

  /**
   * Every game this person can see, by the rule `canSeeGame` applies to one:
   * their teams' games, and every game of a season opened to them. A site
   * administrator sees every game. The shape is a season's schedule, and one
   * query answers it, so a schedule of every team does not cost a request per
   * season.
   *
   * `externalId` narrows it to the games another service knows by those ids —
   * an importer records one for each game it brings in. It may be given more
   * than once, to ask after a whole schedule at once, and each game answers
   * with the external ids it has, so the asker can tell which were found.
   * An `externalId` that is empty, or not a plain value, is refused rather
   * than read as no filter, which would answer every game.
   */
  router.get(
    '/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const externalIds = externalIdsAsked(req.query.externalId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      res.json(await scheduleOf(db, media, { visible: scopes, externalIds }))
    })
  )

  /**
   * The most recent played game the signed-in person can see, anywhere.
   *
   * The newest season is not the season with the newest game, and somebody on
   * several teams has games in more than one, so this looks across all of
   * them rather than inside the first season.
   */
  router.get(
    '/games/recent',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      // Played, which is what `recent` means here: a fixture nobody turned
      // up to is not the game somebody opened the app to see.
      const [game] = await scheduleOf(db, media, {
        visible: scopes,
        played: true,
        limit: 1
      })
      res.json(game ?? null)
    })
  )

  return router
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

/**
 * Games in the shape a schedule shows them: both teams, the score, how many
 * videos and whether one is live, and a poster. Each game carries the
 * external ids it has. Every filter given narrows the list:
 *
 * - `seasonIds`: games in those seasons.
 * - `visible`: games `canSeeGame` lets that person see.
 * - `externalIds`: games another service knows by any of those ids.
 * - `played`: games with a score.
 * - `limit`: the newest few.
 */
async function scheduleOf(
  db: Kysely<Database>,
  media: MediaContext,
  filter: {
    seasonIds?: string[]
    visible?: VisibleScopes
    externalIds?: string[]
    played?: boolean
    limit?: number
  }
): Promise<SeasonGame[]> {
  let query = db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .leftJoin('videos', join =>
      join.onRef('videos.game_id', '=', 'games.id').on(isRealVideo)
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
      'games.status as status',
      'games.home_score as homeScore',
      'games.away_score as awayScore',
      'games.ingest_status as ingestStatus'
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
    .groupBy(['games.id', 'home.name', 'away.name', 'home.kind', 'away.kind'])
    // Newest first: last night's game is the one people look for.
    .orderBy('games.start_at', 'desc')

  if (filter.seasonIds != null) {
    query = query.where('games.season_id', 'in', filter.seasonIds)
  }
  const visible =
    filter.visible == null ? undefined : visibleGamesWhere(filter.visible)
  if (visible != null) query = query.where(visible)
  if (filter.played === true) {
    query = query.where('games.home_score', 'is not', null)
  }
  if (filter.limit != null) query = query.limit(filter.limit)
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

  const answer = games.map((game): SeasonGame => {
    const poster = posters.get(game.id)
    return {
      id: game.id,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      homeTeamName: game.homeTeamName,
      awayTeamName: game.awayTeamName,
      homeTeamExternal: game.homeTeamKind === 'external',
      awayTeamExternal: game.awayTeamKind === 'external',
      seasonId: game.seasonId,
      startAt: toIso(game.startAt),
      venue: game.venue,
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
  return answer
}

/**
 * The `externalId` filter of `GET /games` and `GET /users`: undefined when it
 * is not asked for, and otherwise every value, each a non-empty string.
 */
export function externalIdsAsked(asked: unknown): string[] | undefined {
  if (asked === undefined) return undefined
  const values = Array.isArray(asked) ? asked : [asked]
  if (values.some(value => typeof value !== 'string' || value === '')) {
    throw badRequest('externalId must be a non-empty string')
  }
  return values as string[]
}
