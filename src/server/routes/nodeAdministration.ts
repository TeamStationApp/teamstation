import { asBoolean, asObject } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { asNodeAccountChange } from '../../common/nodeAdministration'
import {
  changeNodeAccount,
  nodeAccounts,
  requireNodeAdmin
} from '../admin/nodeAdministration'
import type { Database } from '../db/database'
import { accountMailEnabled, setAccountMailEnabled } from '../email/accountMail'
import { cleanBody } from '../jsonBody'
import type { SpaceSettings } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

const asAccountMail = asObject({ accountMessages: asBoolean })

export function nodeAdministrationRoutes(
  db: Kysely<Database>,
  space?: SpaceSettings
): Router {
  const router = Router()
  router.get(
    '/users',
    withAsync(async (req, res, next) => {
      if (req.query.view !== 'administration') {
        if (req.query.nodeAdmin != null)
          throw badRequest('nodeAdmin requires view=administration')
        next()
        return
      }
      if (req.actor == null) throw unauthorized()
      if (req.query.query != null && typeof req.query.query !== 'string')
        throw badRequest('Enter one account search')
      if (
        req.query.nodeAdmin != null &&
        req.query.nodeAdmin !== 'true' &&
        req.query.nodeAdmin !== 'false'
      )
        throw badRequest('nodeAdmin must be true or false')
      res.json(
        await nodeAccounts(
          db,
          req.actor,
          req.query.query ?? '',
          req.query.nodeAdmin === 'true',
          space
        )
      )
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
  router.get(
    '/node/mail',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      await requireNodeAdmin(
        db,
        req.actor,
        'Only a node administrator can change account mail'
      )
      res.json({ accountMessages: await accountMailEnabled(db) })
    })
  )
  router.put(
    '/node/mail',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const body = cleanBody(asAccountMail, req.body)
      await setAccountMailEnabled(db, req.actor, body.accountMessages)
      res.json({ accountMessages: body.accountMessages })
    })
  )
  return router
}
