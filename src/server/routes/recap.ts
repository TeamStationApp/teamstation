import { randomUUID } from 'node:crypto'

import { Router } from 'express'
import type { Kysely } from 'kysely'

import { membersOnly, notFound, unauthorized } from '../../common/errors'
import { asRecapDocument, type GameRecap } from '../../common/gameRecap'
import { canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { gamePlaysDigest } from '../events/postPlays'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { recapClips } from '../recap/clips'
import { recapSnapshot, requestRecap } from '../recap/queue'
import { highlightSettings } from '../settings'

export function recapRoutes(db: Kysely<Database>): Router {
  const router = Router()
  router.get(
    '/games/:gameId/recap',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = String(req.params.gameId)
      let outdatedRequest: string | undefined
      let missing = false
      const read = async (): Promise<GameRecap> =>
        await db
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx): Promise<GameRecap> => {
            const game = await trx
              .selectFrom('games')
              .select([
                'status',
                'home_team_id as homeTeamId',
                'away_team_id as awayTeamId',
                'season_id as seasonId'
              ])
              .where('id', '=', gameId)
              .executeTakeFirst()
            if (game == null) throw notFound()
            if (
              !canSeeGame(
                await visibleScopes(trx, actor.userId, actor.isAdmin),
                game
              )
            )
              throw membersOnly()
            const absent: GameRecap = {
              status: 'absent',
              document: null,
              clips: {}
            }
            if (game.status !== 'final') {
              return absent
            }
            const row = await trx
              .selectFrom('game_recaps')
              .select(['status', 'document', 'context_digest', 'request_id'])
              .where('game_id', '=', gameId)
              .executeTakeFirst()
            if (row == null) {
              missing = true
              return absent
            }
            if (row.status !== 'ready') {
              return { status: row.status, document: null, clips: {} }
            }
            if (
              row.context_digest !==
              (await recapSnapshot(trx, gameId)).contextDigest
            ) {
              outdatedRequest = row.request_id
              return { status: 'pending', document: null, clips: {} }
            }
            const events = await trx
              .selectFrom('events')
              .select([
                'atBatIndex',
                'startTime',
                'endTime',
                'timeNudgeSec',
                'eventType',
                'isScoringPlay',
                'hidden'
              ])
              .where('gameId', '=', gameId)
              .execute()
            const videos = await trx
              .selectFrom('videos')
              .select(['id', 'start_at', 'sync_offset_sec', 'duration_sec'])
              .where('game_id', '=', gameId)
              .where('hidden', '=', false)
              .where('status', '=', 'ready')
              .orderBy('start_at')
              .orderBy('id')
              .execute()
            return {
              status: 'ready',
              document: asRecapDocument(row.document),
              clips: recapClips(events, videos, await highlightSettings(trx))
            } satisfies GameRecap
          })
      let result = await read()
      if (missing) {
        // Serialize first visits with scoring and the worker. A concurrent visit
        // must never replace a request, reset its attempts or discard its result.
        await db.transaction().execute(async trx => {
          const game = await trx
            .selectFrom('games')
            .selectAll()
            .where('id', '=', gameId)
            .forUpdate()
            .executeTakeFirst()
          if (game?.status !== 'final') return
          const queued = await trx
            .selectFrom('game_recaps')
            .select('status')
            .where('game_id', '=', gameId)
            .executeTakeFirst()
          if (queued == null)
            await requestRecap(
              trx,
              gameId,
              true,
              await gamePlaysDigest(trx, game)
            )
        })
        // It may already have finished while this visitor waited for the lock.
        result = await read()
      }
      // A correction may have replaced this request since the read snapshot.
      // Only invalidate the exact stale document; never expose it while requeuing.
      if (outdatedRequest != null)
        await db
          .updateTable('game_recaps')
          .set({
            status: 'pending',
            document: null,
            request_id: randomUUID(),
            context_digest: null,
            attempts: 0,
            available_at: new Date(),
            lease_id: null
          })
          .where('game_id', '=', gameId)
          .where('request_id', '=', outdatedRequest)
          .where('status', '=', 'ready')
          .execute()
      res.json(result)
    })
  )
  return router
}
