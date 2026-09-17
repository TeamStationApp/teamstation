import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { visibleScopes } from '../access'
import type { Database } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { postersFor, posterUrl, warmPosters } from '../media/posters'
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
            .select(['id', 'league_id', 'name', 'year', 'term', 'age_group'])
            .orderBy('year', 'desc')
            .orderBy('name')
            .execute()
        : scopes.seasonIds.size === 0
          ? []
          : await db
              .selectFrom('seasons')
              .select(['id', 'league_id', 'name', 'year', 'term', 'age_group'])
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
          .leftJoin('videos', 'videos.game_id', 'games.id')
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

      res.json(teams)
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

      const games = await db
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .leftJoin('videos', 'videos.game_id', 'games.id')
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
        .where('games.season_id', '=', seasonId)
        .groupBy([
          'games.id',
          'home.name',
          'away.name',
          'home.kind',
          'away.kind'
        ])
        // Newest first: last night's game is the one people look for.
        .orderBy('games.start_at', 'desc')
        .execute()

      const posters = await postersFor(
        db,
        games.map(game => game.id)
      )
      const now = Date.now()

      res.json(
        games.map(game => ({
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
          durationSec:
            game.durationSec == null ? null : Number(game.durationSec),
          posterUrl:
            posters.get(game.id) == null
              ? null
              : posterUrl(media, posters.get(game.id)!.videoId, undefined, now)
        }))
      )

      // Cut after the answer has gone out. The first person to open a list
      // starts the work and sees plain plates; everybody after sees pictures.
      warmPosters(media, [...posters.values()]).catch(() => undefined)
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
