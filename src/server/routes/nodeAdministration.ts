import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { asNodeAccountChange } from '../../common/nodeAdministration'
import { changeNodeAccount, nodeAccounts } from '../admin/nodeAdministration'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export function nodeAdministrationRoutes(db: Kysely<Database>): Router {
  const router = Router()
  router.get(
    '/users',
    withAsync(async (req, res, next) => {
      if (req.query.view !== 'administration') {
        next()
        return
      }
      if (req.actor == null) throw unauthorized()
      if (req.query.query != null && typeof req.query.query !== 'string')
        throw badRequest('Enter one account search')
      res.json(await nodeAccounts(db, req.actor, req.query.query ?? ''))
    })
  )
  router.patch(
    '/users/:userId/administration',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const userId = Number(req.params.userId)
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw badRequest('Choose a valid account')
      await changeNodeAccount(
        db,
        req.actor,
        userId,
        cleanBody(asNodeAccountChange, req.body)
      )
      res.json({ ok: true })
    })
  )
  return router
}
