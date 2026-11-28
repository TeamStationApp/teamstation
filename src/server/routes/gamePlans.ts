import { Router } from 'express'
import type { Kysely } from 'kysely'

import type { GamePlansResponse, PlanInning, SidePlan } from '../../common/api'
import {
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asGamePlan, MAX_PLAN_INNINGS } from '../../common/gamePlan'
import { namedTeamIds } from '../../common/openSides'
import {
  canScore,
  canSeeGame,
  planTeams,
  roleScopes,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  loadPlanInning,
  loadSidePlan,
  openInning,
  type PlanGame,
  planGameState,
  saveGamePlan
} from '../games/gamePlans'
import type { GameSideIds } from '../games/namedSides'
import { cleanBody } from '../jsonBody'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

type PlannedGame = PlanGame & GameSideIds

/**
 * A coach's per-inning game plans. Each side's plan is read and saved only
 * by a coach or assistant of that team (`planTeams`: given the coach or the
 * assistant flag on the team, a season it belongs to or its league, head
 * coach or not), and answered with the Playing Time Rules and same-day load
 * its warnings are judged by. No administrator or scorekeeper reads it. A plan is on when it
 * holds a position: the `enabled` a save sends is not read. A save is
 * announced on the game socket as a `plans` change naming the team and the
 * inning, only when it changes the inning in play.
 *
 * A scorer reads one inning's column, `GET
 * /games/:gameId/plans/:teamId/innings/:inning`: whoever scores either team,
 * or a coach or assistant of the team (`planTeams`), once the game's start time has
 * passed, for the inning in play alone, until the game is over. The reason
 * for a refusal is in its `details` (`planNotStarted`, `planGameOver`,
 * `planInningNotCurrent`).
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

  /**
   * The teams of the game whose plans the actor may read and save: the ones
   * they were given the coach or the assistant flag on (`planTeams`). No
   * administrator or scorekeeper is one.
   */
  const plannedTeams = async (
    actor: Actor,
    game: PlannedGame
  ): Promise<string[]> => await planTeams(db, actor.userId, game)

  router.get(
    '/games/:gameId/plans',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const game = await visibleGame(actor, pathParam(req.params.gameId))
      const teams = await plannedTeams(actor, game)
      // An open side has no team, and so no plan.
      const side = async (teamId: string | null): Promise<SidePlan | null> =>
        teamId != null && teams.includes(teamId)
          ? await loadSidePlan(db, game, teamId)
          : null
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
          "Only the team's coaches and assistants may save its game plan"
        )
      await saveGamePlan(db, game, teamId, plan, actor.userId)
      res.json(await loadSidePlan(db, game, teamId))
    })
  )

  router.get(
    '/games/:gameId/plans/:teamId/innings/:inning',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const game = await visibleGame(actor, pathParam(req.params.gameId))
      const teamId = pathParam(req.params.teamId)
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      const scores = namedTeamIds(game.away_team_id, game.home_team_id).some(
        id => canScore(scopes, id)
      )
      if (
        !scores &&
        !(await planTeams(db, actor.userId, game)).includes(teamId)
      )
        throw forbidden(
          "Only a scorekeeper or the team's coaches and assistants may read an inning's plan"
        )
      const inning = Number(pathParam(req.params.inning))
      if (
        (teamId !== game.home_team_id && teamId !== game.away_team_id) ||
        !Number.isInteger(inning) ||
        inning < 1 ||
        inning > MAX_PLAN_INNINGS
      )
        throw notFound()
      const state = await planGameState(db, game.id)
      const open = openInning(state, new Date())
      if ('refused' in open && open.refused !== 'planInningNotCurrent')
        throw forbidden(
          open.refused === 'planNotStarted'
            ? 'The game has not reached its start time'
            : 'The game is over',
          { reason: open.refused }
        )
      if (!('inning' in open) || open.inning !== inning)
        throw conflict(`Inning ${inning} is not the inning in play`, {
          reason: 'planInningNotCurrent',
          inning: state.inning
        })
      const answer: PlanInning = {
        teamId,
        inning,
        column: await loadPlanInning(db, game.id, teamId, inning)
      }
      res.json(answer)
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
