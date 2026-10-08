import { Router } from 'express'
import type { Kysely } from 'kysely'

import { unauthorized } from '../../common/errors'
import {
  deviceEventControlGrant,
  deviceEventControlSecretProblem
} from '../auth/deviceEventControl'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { activeHuman } from '../oauth/provider'

export interface DeviceEventControlOptions {
  /**
   * `serverConfig.deviceEventControlSecret`; empty, or shorter than 32 bytes,
   * switches the route off.
   */
  secret: string
  /** The server's canonical public origin, which every key is bound to. */
  issuer: string
}

/**
 * `GET /device-event-control/key`: the caller's own key for the local
 * event-control protocol, which lets a Director set the publishing event of
 * nearby devices signed in to the same account without any of them sharing a
 * login.
 *
 * Human sessions only, like `/me/builds`: a machine API token for the same
 * person is refused, because the key stands for a person's devices and a
 * script is not one of them. The key is derived from the caller's own user ID
 * and this server's origin, so another account or another server gets a
 * different one. Never cached by anything between here and the device.
 */
export function deviceEventControlRoutes(
  db: Kysely<Database>,
  options: DeviceEventControlOptions
): Router {
  const router = Router()

  router.get(
    '/device-event-control/key',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await activeHuman(db, req.actor)
      if (actor == null) throw unauthorized()
      res.set('Cache-Control', 'no-store')
      if (deviceEventControlSecretProblem(options.secret) != null) {
        // The shared error shape, plus the one word a device branches on.
        res.status(503).json({
          code: 'unavailable',
          message: 'Device event control is not set up on this server',
          error: 'deviceEventControlUnavailable'
        })
        return
      }
      res.json(
        deviceEventControlGrant(options.secret, options.issuer, actor.userId)
      )
    })
  )

  return router
}
