import { Router } from 'express'
import type { Kysely } from 'kysely'

import type { FollowableTeam, ScheduleEntry } from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { canReadFollowedTeam, canSeeTeam, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { teamStaff } from '../teams/teamStaff'

/** A search needs this many characters, so one letter never lists the site. */
export const MIN_SEARCH_LENGTH = 2
/** And answers at most this many teams. */
export const MAX_SEARCH_RESULTS = 20

/**
 * Following a team, and what following one shows.
 *
 * Anybody signed in may find a full team by name and follow it, with nobody's
 * permission. A fan then reads the team's schedule, roster and staff — the
 * first and last here, the roster in `teams.ts` — and nothing else of it: its
 * games, box scores, stats and videos still answer 404, because a follow is
 * kept out of `teamIds` (`visibleScopes`).
 *
 * - `GET /teams/search?q=` finds teams to follow;
 * - `PUT` and `DELETE /teams/:teamId/follow` follow and unfollow, both
 *   idempotent, answering `{ following }`;
 * - `GET /me/follows` lists the teams the caller follows;
 * - `GET /teams/:teamId/schedule` and `GET /teams/:teamId/staff` are read by
 *   anybody who can read the team's listing (`canSeeTeamListing`).
 *
 * A missing, external or merged team answers 404, as anything the caller
 * cannot see does.
 */
export function followRoutes(
  db: Kysely<Database>,
  media: MediaContext
): Router {
  const router = Router()

  router.get(
    '/teams/search',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (query.length < MIN_SEARCH_LENGTH) {
        throw badRequest(
          `A search needs at least ${MIN_SEARCH_LENGTH} characters`
        )
      }
      const teams = await db
        .selectFrom('teams')
        .select(['id', 'name', 'logo_path as logoPath'])
        .where('kind', '=', 'full')
        .where('merged_into', 'is', null)
        .where('name', 'ilike', `%${escapeLike(query)}%`)
        .orderBy('name')
        .orderBy('id')
        .limit(MAX_SEARCH_RESULTS)
        .execute()
      res.json(await followable(db, media, actor.userId, teams))
    })
  )

  router.put(
    '/teams/:teamId/follow',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = await followableTeam(db, pathParam(req.params.teamId))
      await db
        .insertInto('team_follows')
        .values({ user_id: actor.userId, team_id: teamId })
        .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
        .execute()
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { following: true }
      })
      res.json({ following: true })
    })
  )

  router.delete(
    '/teams/:teamId/follow',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = await followableTeam(db, pathParam(req.params.teamId))
      await db
        .deleteFrom('team_follows')
        .where('user_id', '=', actor.userId)
        .where('team_id', '=', teamId)
        .execute()
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { following: false }
      })
      res.json({ following: false })
    })
  )

  router.get(
    '/me/team-follows',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teams = await db
        .selectFrom('team_follows')
        .innerJoin('teams', 'teams.id', 'team_follows.team_id')
        .select(['teams.id as id', 'teams.name as name'])
        .select('teams.logo_path as logoPath')
        .where('team_follows.user_id', '=', actor.userId)
        .where('teams.kind', '=', 'full')
        .where('teams.merged_into', 'is', null)
        .orderBy('teams.name')
        .orderBy('teams.id')
        .execute()
      res.json(await followable(db, media, actor.userId, teams))
    })
  )

  /**
   * A team's games, oldest first, as a fan may read them: when, who and
   * where. No status, score, poster or video, and no cancelled game, which
   * without its status would read as one still to be played.
   */
  router.get(
    '/teams/:teamId/schedule',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeTeam(scopes, teamId) &&
        !(await canReadFollowedTeam(db, actor.userId, teamId))
      )
        throw notFound()

      const games = await db
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'games.id as gameId',
          'games.start_at as startAt',
          'games.venue as venue',
          'home.id as homeId',
          'home.name as homeName',
          'away.id as awayId',
          'away.name as awayName'
        ])
        .where(eb =>
          eb.or([
            eb('games.home_team_id', '=', teamId),
            eb('games.away_team_id', '=', teamId)
          ])
        )
        .where('games.status', '<>', 'cancelled')
        .orderBy('games.start_at')
        .orderBy('games.id')
        .execute()

      const schedule: ScheduleEntry[] = games.map(game => ({
        gameId: game.gameId,
        startsAt: game.startAt.toISOString(),
        homeTeam: { id: game.homeId, name: game.homeName },
        awayTeam: { id: game.awayId, name: game.awayName },
        venue: game.venue
      }))
      res.json(schedule)
    })
  )

  router.get(
    '/teams/:teamId/staff',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeTeam(scopes, teamId) &&
        !(await canReadFollowedTeam(db, actor.userId, teamId))
      )
        throw notFound()
      res.json(await teamStaff(db, media.space, teamId))
    })
  )

  return router
}

/** The id of a team that may be followed: full and not merged, or 404. */
async function followableTeam(
  db: Kysely<Database>,
  teamId: string
): Promise<string> {
  const team = await db
    .selectFrom('teams')
    .select(['id'])
    .where('id', '=', teamId)
    .where('kind', '=', 'full')
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  if (team == null) throw notFound()
  return team.id
}

/** Teams as a follow list draws them: seasons titled, and followed or not. */
async function followable(
  db: Kysely<Database>,
  media: MediaContext,
  userId: number,
  teams: Array<{ id: string; name: string; logoPath: string | null }>
): Promise<FollowableTeam[]> {
  if (teams.length === 0) return []
  const ids = teams.map(team => team.id)
  const seasons = await db
    .selectFrom('season_teams')
    .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
    .select([
      'season_teams.team_id as teamId',
      'seasons.id as id',
      'seasons.name as name',
      'leagues.name as leagueName'
    ])
    .where('season_teams.team_id', 'in', ids)
    .orderBy('seasons.year', 'desc')
    .orderBy('seasons.name')
    .execute()
  const follows = await db
    .selectFrom('team_follows')
    .select(['team_id as teamId'])
    .where('user_id', '=', userId)
    .where('team_id', 'in', ids)
    .execute()
  const followed = new Set(follows.map(row => row.teamId))

  return teams.map(team => ({
    id: team.id,
    name: team.name,
    logoUrl: imageUrl(media.space, team.logoPath),
    seasons: seasons
      .filter(season => season.teamId === team.id)
      .map(season => ({
        id: season.id,
        title: seasonTitle(season.leagueName, season.name)
      })),
    following: followed.has(team.id)
  }))
}

/** `<league> <season>` when the season has a league, the season alone if not. */
export function seasonTitle(
  leagueName: string | null,
  seasonName: string
): string {
  return leagueName == null ? seasonName : `${leagueName} ${seasonName}`
}

/** `query` as literal text inside an `ilike` pattern. */
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, match => `\\${match}`)
}

/**
 * Express 5 types a path parameter as `string | string[]`. None of ours
 * repeat, so anything else is read as no id, which no team has: a 404.
 */
function pathParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}
