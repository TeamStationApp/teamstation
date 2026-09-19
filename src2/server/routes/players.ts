import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { shortName } from '../../common/names'
import { mayEditName, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/**
 * One person: their picture, their name, how they bat and throw, and the teams
 * they have played for.
 *
 * The teams travel with the person because the filter on their stats is built
 * from them — season, team and year are exactly the three things this list
 * knows — so narrowing a page costs no second request.
 *
 * **No jersey number here.** A number belongs to a player *on a team*
 * (`memberships.jersey`) and is drawn where that context exists: the team's
 * roster, and the box score. Sending it from an endpoint about a person is how
 * it ends up on a card that has to choose between a child's two numbers.
 */
export function playerRoutes(
  db: Kysely<Database>,
  media: MediaContext
): Router {
  const router = Router()

  router.get(
    '/players/:userId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const user = await db
        .selectFrom('users')
        .select([
          'id',
          'display_name as displayName',
          'first_name as firstName',
          'last_name as lastName',
          'avatar_path as avatarPath',
          'bats',
          'throws',
          'merged_into as mergedInto'
        ])
        .where('id', '=', userId)
        .executeTakeFirst()
      if (user == null) throw notFound()

      // A merged account is closed rather than deleted, and its plays now
      // belong to the person it was merged into. Follow the link rather than
      // showing a page whose stats moved out from under it.
      if (user.mergedInto != null) {
        res.redirect(
          303,
          `/api/v1/players/${encodeURIComponent(user.mergedInto)}`
        )
        return
      }

      const teams = await teamsOf(db, userId)

      // The same rule as every other read: you may see somebody if you can
      // already see a team they are on, or a season opened up to you. Their
      // own page is always theirs.
      const visible =
        scopes.isAdmin ||
        userId === actor.userId ||
        teams.some(
          team =>
            scopes.teamIds.has(team.teamId) ||
            (team.seasonId != null && scopes.seasonIds.has(team.seasonId))
        )
      if (!visible) throw notFound()

      // `Jensen P`, for everybody, always. There is no viewer who gets the
      // whole name because of who they are: this endpoint does not know how to
      // send one. The surname lives behind `/name` below, which is the field
      // you type it into rather than a page you read.
      const mayEdit = await mayEditName(db, actor.userId, userId, {
        isAdmin: actor.isAdmin
      })

      res.json({
        userId,
        name: shortName({ ...user, id: userId }),
        /** Whether to offer this person the name field at all. */
        canEditName: mayEdit,
        avatarUrl: imageUrl(media.space, user.avatarPath, PROFILE_SIZE),
        bats: user.bats,
        throws: user.throws,
        teams: teams.filter(
          team =>
            scopes.isAdmin ||
            userId === actor.userId ||
            scopes.teamIds.has(team.teamId) ||
            (team.seasonId != null && scopes.seasonIds.has(team.seasonId))
        )
      })
    })
  )

  /**
   * The name in full, for the one thing it is for: changing it.
   *
   * A separate request, deliberately, so that reading a player's page cannot
   * carry a surname to a screen by accident. A parent or an administrator
   * opening the name field asks for it; everybody else is answered 404, and
   * the page they were reading never had it.
   */
  router.get(
    '/players/:userId/name',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)

      const mayEdit = await mayEditName(db, actor.userId, userId, {
        isAdmin: actor.isAdmin
      })
      if (!mayEdit) throw notFound()

      const user = await db
        .selectFrom('users')
        .select([
          'id',
          'display_name as displayName',
          'first_name as firstName',
          'last_name as lastName'
        ])
        .where('id', '=', userId)
        .executeTakeFirst()
      if (user == null) throw notFound()

      res.json({
        userId,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName
      })
    })
  )

  return router
}

export interface PlayerTeam {
  teamId: string
  teamName: string
  seasonId: string | null
  seasonName: string | null
  seasonYear: number | null
}

/**
 * Every team this person has played for, and in which season.
 *
 * Two sources, because neither is complete on its own: a membership is a team
 * they were put on, and a stats row is a team they actually batted for. A
 * child imported from a roster has the first without the second until their
 * games are ingested; a child who appears only in an opponent's play-by-play
 * can have the second without the first.
 */
export async function teamsOf(
  db: Kysely<Database>,
  userId: string
): Promise<PlayerTeam[]> {
  const fromMemberships = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .leftJoin('season_teams', 'season_teams.team_id', 'memberships.team_id')
    .leftJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .select([
      'memberships.team_id as teamId',
      'teams.name as teamName',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .where('memberships.user_id', '=', userId)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()

  const fromPlays = await db
    .selectFrom('player_season_stats')
    .innerJoin('teams', 'teams.id', 'player_season_stats.team_id')
    .leftJoin('seasons', 'seasons.id', 'player_season_stats.season_id')
    .select([
      'player_season_stats.team_id as teamId',
      'teams.name as teamName',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .where('player_season_stats.user_id', '=', userId)
    .where('teams.merged_into', 'is', null)
    .execute()

  const byKey = new Map<string, PlayerTeam>()
  for (const row of [...fromPlays, ...fromMemberships]) {
    byKey.set(`${row.teamId} ${row.seasonId ?? ''}`, row)
  }

  // Newest season first, and a team with no season at the end: a page opens on
  // what somebody is doing now, not on what they did three years ago.
  return [...byKey.values()].sort((a, b) => {
    const byYear = (b.seasonYear ?? 0) - (a.seasonYear ?? 0)
    if (byYear !== 0) return byYear
    return a.teamName.localeCompare(b.teamName)
  })
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
