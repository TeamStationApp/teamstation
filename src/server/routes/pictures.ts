import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import type { Database } from '../db/database'
import {
  availablePictures,
  selectAccountCatalogPicture
} from '../media/pictureCatalog'
import type { SpaceSettings } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export function pictureRoutes(
  db: Kysely<Database>,
  space: SpaceSettings
): Router {
  const router = Router()
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
      if (actor == null || actor.apiTokenId != null) throw unauthorized()
      try {
        await selectAccountCatalogPicture(db, actor.userId, req.body?.catalogId)
      } catch (error) {
        if (error instanceof TypeError) throw badRequest(error.message)
        throw error
      }
      res.json({ ok: true })
    })
  )
  return router
}
