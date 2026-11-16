import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { isMachine } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  availablePictures,
  selectAccountCatalogPicture
} from '../media/pictureCatalog'
import type { SpaceSettings } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { administeredId } from './account'

export function pictureRoutes(
  db: Kysely<Database>,
  space: SpaceSettings
): Router {
  const router = Router()
  /** A catalog picture for this account; one it does not offer is a 400. */
  const choose = async (userId: string, catalogId: unknown): Promise<void> => {
    await selectAccountCatalogPicture(db, space, userId, catalogId).catch(
      (error: unknown) => {
        throw error instanceof TypeError ? badRequest(error.message) : error
      }
    )
  }
  router.get(
    '/pictures',
    withAsync(async (_req, res) => {
      res.json(await availablePictures(space))
    })
  )
  router.put(
    '/me/account/catalog-picture',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null || isMachine(actor)) throw unauthorized()
      await choose(actor.userId, req.body?.catalogId)
      res.json({ ok: true })
    })
  )
  router.put(
    '/users/:userId/account/catalog-picture',
    requireActor,
    withAsync(async (req, res) => {
      // A node administrator choosing for somebody, from User Management.
      const userId = await administeredId(db, req)
      await choose(userId, req.body?.catalogId)
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json({ ok: true })
    })
  )
  return router
}
