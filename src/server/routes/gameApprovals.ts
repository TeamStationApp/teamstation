import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized, unavailable } from '../../common/errors'
import {
  asGameProposal,
  type GameRequestTerms
} from '../../common/gameApprovals'
import { asGroupRef } from '../../common/groupCreation'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { type Clock, realClock, requestStatus } from '../groups/requests'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { completionNotice } from '../notifications/completionNotice'
import {
  decideGameRequest,
  hideDeclinedGame,
  proposeGame,
  resendGameRequest,
  scheduleProposals,
  schedulingGame,
  withdrawFromGame,
  withdrawGameRequest
} from '../schedule/gameApprovals'

function actor(req: Request): Actor {
  if (req.actor == null) throw unauthorized()
  return req.actor
}
function clean<T>(fn: (value: unknown) => T, value: unknown): T {
  try {
    return fn(value)
  } catch (error) {
    if (error instanceof TypeError) throw badRequest(error.message)
    throw error
  }
}
export function gameApprovalRoutes(
  db: Kysely<Database>,
  clock: Clock = realClock
): Router {
  const router = Router()
  router.use(
    withAsync(async (req, res, next) => {
      if (
        !/^\/game-requests(?:\/|$)/i.test(req.path) &&
        !/^\/games\/[^/]+\/(scheduling|withdrawals)\/?$/i.test(req.path)
      ) {
        next()
        return
      }
      const ready = await db
        .selectFrom('system_settings')
        .select('value')
        .where('key', '=', 'creation.hierarchyReady')
        .executeTakeFirst()
      if (ready?.value !== true)
        throw unavailable(
          'A node administrator must finish organization setup before scheduling approved games'
        )
      next()
    })
  )
  router.post(
    '/game-requests',
    requireActor,
    withAsync(async (req, res) => {
      const request = await proposeGame(
        db,
        actor(req),
        clean(asGameProposal, req.body),
        clock
      )
      res.status(201).json({
        id: request.id,
        status: requestStatus(request, clock),
        gameId: request.game_id,
        proposedGameId:
          (request.terms as GameRequestTerms).proposedGameId ?? request.game_id,
        replacesGameId:
          (request.terms as GameRequestTerms).replacesGameId ?? null
      })
    })
  )
  router.get(
    '/game-requests',
    requireActor,
    withAsync(async (req, res) => {
      const ref = clean(asGroupRef, {
        kind: req.query.scopeKind,
        id: req.query.scopeId
      })
      res.json(await scheduleProposals(db, actor(req), ref, clock))
    })
  )
  for (const decision of ['accept', 'decline'] as const)
    router.post(
      `/game-requests/:id/${decision}`,
      requireActor,
      withAsync(async (req, res) => {
        const request = await decideGameRequest(
          db,
          actor(req),
          String(req.params.id),
          decision,
          clock
        )
        res.json({
          id: request.id,
          status: requestStatus(request, clock),
          gameId: request.game_id,
          proposedGameId:
            (request.terms as GameRequestTerms).proposedGameId ??
            request.game_id,
          replacesGameId:
            (request.terms as GameRequestTerms).replacesGameId ?? null
        })
      })
    )
  router.post(
    '/game-requests/:id/withdraw',
    requireActor,
    withAsync(async (req, res) => {
      const request = await withdrawGameRequest(
        db,
        actor(req),
        String(req.params.id),
        clock
      )
      res.json({
        id: request.id,
        status: requestStatus(request, clock),
        gameId: request.game_id,
        proposedGameId:
          (request.terms as GameRequestTerms).proposedGameId ?? request.game_id,
        replacesGameId:
          (request.terms as GameRequestTerms).replacesGameId ?? null
      })
    })
  )
  router.post(
    '/game-requests/:id/resend',
    requireActor,
    withAsync(async (req, res) => {
      const key = req.body?.idempotencyKey
      if (typeof key !== 'string' || key.length < 8 || key.length > 120)
        throw badRequest('Sending needs a retry key')
      const request = await resendGameRequest(
        db,
        actor(req),
        String(req.params.id),
        key,
        clock
      )
      res.status(201).json({
        ...(request.status === 'accepted'
          ? {
              notice: await completionNotice(
                db,
                request.terms as GameRequestTerms
              )
            }
          : {}),
        id: request.id,
        status: requestStatus(request, clock),
        gameId: request.game_id,
        proposedGameId:
          (request.terms as GameRequestTerms).proposedGameId ?? request.game_id,
        replacesGameId:
          (request.terms as GameRequestTerms).replacesGameId ?? null
      })
    })
  )
  router.delete(
    '/game-requests/:id/schedule-entry',
    requireActor,
    withAsync(async (req, res) => {
      const scope =
        req.query.scopeKind == null && req.query.scopeId == null
          ? undefined
          : clean(asGroupRef, {
              kind: req.query.scopeKind,
              id: req.query.scopeId
            })
      await hideDeclinedGame(db, actor(req), String(req.params.id), scope)
      res.json({ ok: true })
    })
  )
  router.get(
    '/games/:gameId/scheduling',
    requireActor,
    withAsync(async (req, res) => {
      res.json(await schedulingGame(db, actor(req), String(req.params.gameId)))
    })
  )
  router.post(
    '/games/:gameId/withdrawals',
    requireActor,
    withAsync(async (req, res) => {
      const team = clean(asGroupRef, { kind: 'team', id: req.body?.teamId })
      const game = await withdrawFromGame(
        db,
        actor(req),
        String(req.params.gameId),
        team.id,
        clock
      )
      res.json({
        id: game.id,
        status: game.status,
        reason: game.cancellation_reason,
        withdrawnByTeamId: game.withdrawn_by_team_id
      })
    })
  )
  return router
}
