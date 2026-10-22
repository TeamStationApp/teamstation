import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import type { Database } from '../db/database'
import { requireVisibleGame } from '../events/requireVisibleGame'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { narrationFor } from '../replay/narrationAudio'
import { type SpeechSettings, SpeechUnavailable } from '../replay/speech'

/**
 * GET /games/:gameId/narrations/:stepKey?count=N — the replay's announcer
 * reading one step of the game, as `audio/mpeg`: the step as it stood with
 * its first `count` actions, or as it stands without one. Whoever can read
 * the game's plays can hear them. 503 when speech is off or the speech
 * service fails.
 */
export function narrationRoutes(
  db: Kysely<Database>,
  settings: SpeechSettings | null,
  fetchImpl: typeof fetch = fetch
): Router {
  const router = Router()
  router.get(
    '/games/:gameId/narrations/:stepKey',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = req.params.gameId
      const stepKey = req.params.stepKey
      if (typeof gameId !== 'string' || typeof stepKey !== 'string')
        throw notFound()
      const asked = req.query.count
      const count = asked == null ? undefined : Number(asked)
      if (count != null && !(Number.isInteger(count) && count > 0))
        throw badRequest('count is a whole number of actions.')
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      if (settings == null) {
        res.status(503).json({ error: 'narrationUnavailable' })
        return
      }
      try {
        const spoken = await narrationFor(
          db,
          gameId,
          stepKey,
          settings,
          fetchImpl,
          count
        )
        const etag = `"${spoken.digest}"`
        res.set('ETag', etag)
        res.set('Cache-Control', 'private, no-cache')
        if (req.get('If-None-Match') === etag) {
          res.status(304).end()
          return
        }
        res.type('audio/mpeg').send(spoken.audio)
      } catch (error) {
        if (error instanceof SpeechUnavailable) {
          console.error(`narration ${gameId} ${stepKey}: ${error.message}`)
          res.status(503).json({ error: 'narrationUnavailable' })
          return
        }
        throw error
      }
    })
  )
  return router
}
