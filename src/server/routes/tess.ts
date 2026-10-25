import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  asTessAttachmentBody,
  asTessMessageBody,
  type TessMessage
} from '../../common/api'
import { forbidden, unauthorized, unavailable } from '../../common/errors'
import { isMachine } from '../auth/sessions'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { TessSettings } from '../serverConfig'
import {
  confirmTurn,
  runTurn,
  type TessDeps,
  type TessUser
} from '../tess/agent'
import { storeAttachment } from '../tess/attachments'
import { changesById } from '../tess/changes'
import {
  attachmentIdsOf,
  attachmentInfoById,
  contextTokensOf,
  loadConversation,
  viewMessages
} from '../tess/conversation'
import { credentialsOf } from '../tess/loopback'
import { playerNamesOf } from '../tess/playerLinks'
import { turnRunning } from '../tess/turns'
import { usageWeeks } from '../tess/usage'

export interface TessRouteOptions {
  /** Tess's key and model; null when the server has none, and she is off. */
  settings: TessSettings | null
  /**
   * This server's own origin, for the requests Tess's tools send. Read on
   * each call, since the server may not be listening yet when the routes
   * are built (a test harness listens on a port it learns afterwards).
   */
  origin: () => string
  /** The Messages API's `fetch`, replaced in tests. */
  fetch?: typeof fetch
  now?: () => Date
}

/**
 * Tess, the assistant, under `/me/tess`: the caller's one conversation, the
 * files they give her, the changes she proposes and they confirm, and the
 * tokens it uses each week.
 *
 * Every route needs a person signed in themselves: a machine token is
 * refused, and so is a request Tess's own tools sent, which the deny list
 * already keeps from here. With no key the routes answer 503.
 */
export function tessRoutes(
  db: Kysely<Database>,
  options: TessRouteOptions
): Router {
  const router = Router()
  router.use('/me/tess', requireActor, (req, res, next) => {
    if (req.actor?.viaTess === true) {
      next(forbidden('Tess cannot use her own routes'))
      return
    }
    if (req.actor != null && isMachine(req.actor)) {
      next(forbidden('Sign in to talk to Tess'))
      return
    }
    if (options.settings == null) {
      next(unavailable('Tess is not available on this server'))
      return
    }
    next()
  })

  // Only ever built past the gate above, which answered 503 without settings.
  const deps = (): TessDeps => ({
    db,
    settings: options.settings!,
    origin: options.origin,
    fetch: options.fetch,
    now: options.now
  })
  const userOf = (req: Request): TessUser => {
    if (req.actor == null) throw unauthorized()
    return {
      userId: req.actor.userId,
      isAdmin: req.actor.isAdmin,
      credentials: credentialsOf(req)
    }
  }

  router.get(
    '/me/tess',
    withAsync(async (req, res) => {
      const { userId } = userOf(req)
      res.set('Cache-Control', 'no-store').json({
        available: true,
        messages: await view(db, userId, 0, options.now?.()),
        contextTokens: await contextTokensOf(db, userId),
        answering: await turnRunning(db, userId)
      })
    })
  )

  router.post(
    '/me/tess/messages',
    withAsync(async (req, res) => {
      const user = userOf(req)
      const body = cleanBody(asTessMessageBody, req.body)
      const id = await runTurn(deps(), user, {
        text: body.text,
        attachmentIds: body.attachmentIds,
        screen: body.screen,
        clientId: body.clientId
      })
      res.json({ messages: await view(db, user.userId, id, options.now?.()) })
    })
  )

  router.post(
    '/me/tess/attachments',
    withAsync(async (req, res) => {
      const { userId } = userOf(req)
      const body = cleanBody(asTessAttachmentBody, req.body)
      const attachment = await storeAttachment(db, userId, body)
      setAudit(res.locals, {
        entityType: 'tess_attachment',
        entityId: attachment.id
      })
      res.status(201).json(attachment)
    })
  )

  router.post(
    '/me/tess/changes/:changeId/confirm',
    withAsync(async (req, res) => {
      const user = userOf(req)
      const changeId = String(req.params.changeId)
      const { change, fromId } = await confirmTurn(deps(), user, changeId)
      setAudit(res.locals, { entityType: 'tess_change', entityId: changeId })
      res.json({
        change,
        messages: await view(db, user.userId, fromId, options.now?.())
      })
    })
  )

  router.get(
    '/me/tess/usage',
    withAsync(async (req, res) => {
      const { userId } = userOf(req)
      res
        .set('Cache-Control', 'no-store')
        .json({ weeks: await usageWeeks(db, userId) })
    })
  )

  return router
}

/**
 * The conversation from message `fromId` on, as the app shows it at `now`,
 * its players linked by every name the conversation's API answers carry.
 */
async function view(
  db: Kysely<Database>,
  userId: string,
  fromId: number,
  now = new Date()
): Promise<TessMessage[]> {
  const conversation = (await loadConversation(db, userId)).messages
  const messages = conversation.filter(message => message.id >= fromId)
  const changeIds = messages.flatMap(message =>
    message.content.flatMap(block =>
      block.type === 'change' ? [block.id] : []
    )
  )
  return viewMessages(
    messages,
    await attachmentInfoById(db, userId, attachmentIdsOf(messages)),
    await changesById(db, userId, changeIds, now),
    playerNamesOf(conversation)
  )
}
