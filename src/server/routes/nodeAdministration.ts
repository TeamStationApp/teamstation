import { asBoolean, asObject } from 'cleaners'
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'

import { badRequest, unauthorized } from '../../common/errors'
import { asNodeAccountChange } from '../../common/nodeAdministration'
import { asNodeSettingsUpdate } from '../../common/nodeSettings'
import { asUserId } from '../../common/userId'
import {
  changeNodeAccount,
  nodeAccounts,
  requireNodeAdmin
} from '../admin/nodeAdministration'
import {
  activityQueryOf,
  recentLogins,
  recentSessions
} from '../admin/userActivity'
import {
  directoryQueryOf,
  directorySearch,
  personAdministration
} from '../admin/userDirectory'
import type { PooledDatabase } from '../db/database'
import { accountMailEnabled, setAccountMailEnabled } from '../email/accountMail'
import { cleanBody } from '../jsonBody'
import type { SpaceSettings } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  clearJevKey,
  iosAppBannerId,
  JEV_KEY_MAX,
  nodeSettings,
  setJevKey,
  setNodeSettings
} from '../nodeSettings'
import { highlightSettings } from '../settings'
import { dropReplacedSample } from '../sponsors/sample'

const asAccountMail = asObject({ accountMessages: asBoolean })

/** A Jev key: printable, no spaces, at most `JEV_KEY_MAX` characters. */
const asJevKeyBody = asObject({
  apiKey: (raw: unknown): string => {
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (key === '' || key.length > JEV_KEY_MAX || !/^[\x21-\x7e]+$/.test(key))
      throw new TypeError(
        `apiKey must be 1 to ${JEV_KEY_MAX} printable characters with no spaces`
      )
    return key
  }
})

/**
 * How often one address may read User Management's people and activity: a
 * minute's worth of pages and searches, well past what a person scrolling
 * and typing asks for, and short of a script walking every account.
 */
export const USER_MANAGEMENT_LIMIT = { windowMs: 60_000, limit: 120 }

export function nodeAdministrationRoutes(
  db: PooledDatabase,
  space?: SpaceSettings
): Router {
  const router = Router()
  const peopleLimit = rateLimit({
    ...USER_MANAGEMENT_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The `/users` collection's other views are not User Management's.
    skip: req => req.path === '/users' && req.query.view !== 'directory',
    message: {
      code: 'rateLimited',
      message: 'Too many User Management requests. Try again shortly.'
    }
  })
  router.get(
    '/users',
    peopleLimit,
    withAsync(async (req, res, next) => {
      if (req.query.view === 'directory') {
        if (req.actor == null) throw unauthorized()
        res.json(
          await directorySearch(
            db,
            req.actor,
            directoryQueryOf(req.query),
            space
          )
        )
        return
      }
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
  router.get(
    '/users/:userId/administration',
    peopleLimit,
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const userId = cleanBody(asUserId, req.params.userId)
      res.json(await personAdministration(db, req.actor, userId, space))
    })
  )
  router.patch(
    '/users/:userId/administration',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const userId = cleanBody(asUserId, req.params.userId)
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
    '/node/logins',
    peopleLimit,
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json(
        await recentLogins(db, req.actor, activityQueryOf(req.query), space)
      )
    })
  )
  router.get(
    '/node/sessions',
    peopleLimit,
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json(
        await recentSessions(db, req.actor, activityQueryOf(req.query), space)
      )
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
  router.get(
    '/node/ios-app-banner',
    withAsync(async (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.vary('Accept')
      const appId = await iosAppBannerId(db)
      if (req.accepts(['application/json', 'text/css']) === 'text/css')
        res
          .type('text/css')
          .send(appId == null ? '' : `:root{--teamstation-ios-app-id:${appId}}`)
      else res.json({ appId })
    })
  )
  router.get(
    '/node/settings',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json(await nodeSettings(db, req.actor))
    })
  )
  router.put(
    '/node/settings',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      // An app from before a highlight's tail was a setting sends none: the
      // node's own stays, rather than going back to the default.
      const body = req.body as { highlights?: Record<string, unknown> } | null
      const highlights = body?.highlights
      if (
        highlights != null &&
        typeof highlights === 'object' &&
        highlights.tailSec == null
      )
        highlights.tailSec = (await highlightSettings(db, true)).tailSec
      const settings = cleanBody(asNodeSettingsUpdate, req.body)
      const { replacedSampleKey } = await setNodeSettings(
        db,
        req.actor,
        settings
      )
      // Reset to defaults leaves the uploaded clip it replaced to nobody.
      if (space != null)
        await dropReplacedSample(space, replacedSampleKey, null)
      // What is stored now, including a pitch delay the save left alone.
      res.json(await nodeSettings(db, req.actor))
    })
  )
  router.put(
    '/node/jev-key',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      // Who may set it first: a body that does not read is still a 403 to
      // anybody but a node administrator.
      await requireNodeAdmin(
        db,
        req.actor,
        'Only a node administrator can set the Jev key'
      )
      const { apiKey } = cleanBody(asJevKeyBody, req.body)
      await setJevKey(db, req.actor, apiKey)
      res.json({ configured: true })
    })
  )
  router.delete(
    '/node/jev-key',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      await clearJevKey(db, req.actor)
      res.json({ configured: false })
    })
  )
  return router
}
