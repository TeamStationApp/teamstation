import { Router } from 'express'
import type { Kysely } from 'kysely'

import type { GamePlansResponse, SidePlan } from '../../common/api'
import { forbidden, notFound, unauthorized } from '../../common/errors'
import { asGamePlan } from '../../common/gamePlan'
import { canSeeGame, lineupTeams, roleScopes, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { loadSidePlan, type PlanGame, saveGamePlan } from '../games/gamePlans'
import { cleanBody } from '../jsonBody'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

type PlannedGame = PlanGame & { home_team_id: string; away_team_id: string }

/**
 * A coach's per-inning game plans. Each side's plan is read and saved by
 * whoever may save that side's lineup (`lineupTeams`: the team's head coach,
 * or a scorekeeper of either team), and answered with the Playing Time Rules
 * and same-day load its warnings are judged by. A plan is on
 * when it holds a position: the `enabled` a save sends is not read. A save is
 * announced on the game socket as a `plans` change naming only the team.
 */
export function gamePlanRoutes(db: Kysely<Database>): Router {
  const router = Router()

  /** The game, or 404 when there is none or the actor may not see it. */
  const visibleGame = async (
    actor: Actor,
    gameId: string
  ): Promise<PlannedGame> => {
    const game = await db
      .selectFrom('games')
      .select([
        'id',
        'home_team_id',
        'away_team_id',
        'season_id',
        'start_at',
        'timezone'
      ])
      .where('id', '=', gameId)
      .executeTakeFirst()
    if (game == null) throw notFound()
    const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
    if (
      !canSeeGame(scopes, {
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        seasonId: game.season_id
      })
    )
      throw notFound()
    return game
  }

  /** The teams of the game whose plans the actor may read and save. */
  const plannedTeams = async (
    actor: Actor,
    game: PlannedGame
  ): Promise<string[]> =>
    lineupTeams(await roleScopes(db, actor.userId, actor.isAdmin), game)

  router.get(
    '/games/:gameId/plans',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const game = await visibleGame(actor, pathParam(req.params.gameId))
      const teams = await plannedTeams(actor, game)
      const side = async (teamId: string): Promise<SidePlan | null> =>
        teams.includes(teamId) ? await loadSidePlan(db, game, teamId) : null
      const [away, home] = await Promise.all([
        side(game.away_team_id),
        side(game.home_team_id)
      ])
      const answer: GamePlansResponse = { away, home }
      res.json(answer)
    })
  )

  router.put(
    '/games/:gameId/plans/:teamId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const teamId = pathParam(req.params.teamId)
      const plan = cleanBody(asGamePlan, req.body)
      const game = await visibleGame(actor, gameId)
      if (teamId !== game.home_team_id && teamId !== game.away_team_id)
        throw notFound()
      if (!(await plannedTeams(actor, game)).includes(teamId))
        throw forbidden(
          "Only the team's head coach or a scorekeeper may save its game plan"
        )
      await saveGamePlan(db, game, teamId, plan, actor.userId)
      res.json(await loadSidePlan(db, game, teamId))
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
