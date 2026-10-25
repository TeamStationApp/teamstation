import { captureException } from '@sentry/node'
import { type Request, type Response, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  asTessAttachmentBody,
  asTessMessageBody,
  type TessMessage
} from '../../common/api'
import {
  forbidden,
  HttpError,
  toApiError,
  unauthorized,
  unavailable
} from '../../common/errors'
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
  type TessUser,
  type TurnEvents
} from '../tess/agent'
import { storeAttachment } from '../tess/attachments'
import { changesById } from '../tess/changes'
import {
  attachmentIdsOf,
  attachmentInfoById,
  contextTokensOf,
  loadConversation,
  storedPlayerNames,
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
  /** How often a streamed turn sends a comment to keep its connection open. */
  keepAliveMs?: number
}

/**
 * A streamed turn's comment interval: well inside the 60 seconds iOS waits
 * for a byte, and any proxy's idle limit.
 */
export const KEEP_ALIVE_MS = 15000

/**
 * Tess, the assistant, under `/me/tess`: the caller's one conversation, the
 * files they give her, the changes she proposes and they confirm, and the
 * tokens it uses each week.
 *
 * Every route needs a person signed in themselves: a machine token is
 * refused, and so is a request Tess's own tools sent, which the deny list
 * already keeps from here. With no key the routes answer 503.
 *
 * A message, and a confirmed change, stream Tess's turn when the request
 * accepts `text/event-stream` (`turnStream`); without that they answer JSON
 * once she is done, as an older app expects.
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
      const input = {
        text: body.text,
        attachmentIds: body.attachmentIds,
        screen: body.screen,
        clientId: body.clientId
      }
      const answer = async (id: number): Promise<unknown> => ({
        messages: await view(db, user.userId, id, options.now?.())
      })
      if (!streams(req)) {
        res.json(await answer(await runTurn(deps(), user, input)))
        return
      }
      await turnStream(
        res,
        options.keepAliveMs ?? KEEP_ALIVE_MS,
        async event => ({
          messages: await view(
            db,
            user.userId,
            event.fromId,
            options.now?.(),
            false
          )
        }),
        async onEvent =>
          await answer(await runTurn(deps(), user, input, onEvent))
      )
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
      const answer = async (
        onEvent?: TurnEvents
      ): Promise<Record<string, unknown>> => {
        const { change, fromId } = await confirmTurn(
          deps(),
          user,
          changeId,
          onEvent
        )
        setAudit(res.locals, { entityType: 'tess_change', entityId: changeId })
        return {
          change,
          messages: await view(db, user.userId, fromId, options.now?.())
        }
      }
      if (!streams(req)) {
        res.json(await answer())
        return
      }
      await turnStream(
        res,
        options.keepAliveMs ?? KEEP_ALIVE_MS,
        async event => {
          // The change has run: the audit says so whatever Tess does next.
          setAudit(res.locals, {
            entityType: 'tess_change',
            entityId: changeId
          })
          return {
            messages: await view(
              db,
              user.userId,
              event.fromId,
              options.now?.(),
              false
            ),
            change: event.change
          }
        },
        answer
      )
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

/** Whether the request asks for its turn as a stream of events. */
function streams(req: Request): boolean {
  return (req.get('accept') ?? '').includes('text/event-stream')
}

/**
 * Runs a turn whose events go to the response as server-sent events, each
 * `event: <type>` with its JSON as `data`: `thinking`, `text` and `step` as
 * the turn tells them, `stored` with what `stored` makes of the turn's
 * stored message, then `done` with the answer the JSON route gives, or
 * `error` with the status and the body it would have failed with, and
 * `kept`: whether the turn's message is still stored, so the app knows
 * without asking whether to give the draft back. It is false before
 * `stored`, and again once the turn has taken the message back
 * (`takenBack`). A comment every `keepAliveMs` keeps the connection open
 * while she works.
 *
 * Nothing is written before `stored`, or before `preparing`: a turn refused
 * before it begins (a turn already running, a message too large to fit
 * beside a compacted conversation) fails as the JSON route does, with its
 * status, whatever the request accepts. When the conversation must first be
 * made fit for the message, model calls that can outlast an idle timeout,
 * the stream opens with a comment at once and keeps it open; a refusal once
 * that is done is the `error` event, with the status and body of the JSON
 * route.
 *
 * `stored` failing (the read of the stored message) is reported and its
 * event left out: the message is stored and the turn goes on, and `done`
 * shows it.
 */
export async function turnStream(
  res: Response,
  keepAliveMs: number,
  stored: (event: { fromId: number; change?: unknown }) => Promise<unknown>,
  run: (onEvent: TurnEvents) => Promise<unknown>
): Promise<void> {
  let keepAlive: ReturnType<typeof setInterval> | undefined
  const write = (text: string): void => {
    if (!res.writableEnded && !res.destroyed) res.write(text)
  }
  const send = (type: string, data: unknown): void => {
    write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const open = (): void => {
    if (res.headersSent) return
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders()
    keepAlive = setInterval(() => {
      write(': keep-alive\n\n')
    }, keepAliveMs)
  }
  res.on('close', () => {
    clearInterval(keepAlive)
  })
  // The turn's message is stored, and has not been taken back.
  let kept = false
  try {
    const answer = await run(async event => {
      if (event.type === 'takenBack') {
        kept = false
        return
      }
      if (event.type === 'preparing') {
        if (res.headersSent) return
        open()
        write(': keep-alive\n\n')
        return
      }
      if (event.type === 'stored') {
        kept = true
        open()
        let shown: unknown
        try {
          shown = await stored(event)
        } catch (error) {
          console.error(
            `POST ${res.req.path}: showing the stored message`,
            error
          )
          captureException(error)
          return
        }
        send('stored', shown)
        return
      }
      open()
      if (event.type === 'step') {
        const { id, label, status } = event
        send('step', { id, label, status })
      } else send(event.type, { delta: event.delta })
    })
    open()
    send('done', answer)
  } catch (error) {
    if (!res.headersSent) throw error
    if (!(error instanceof HttpError)) {
      console.error(`POST ${res.req.path}`, error)
      captureException(error)
    }
    send('error', {
      status: error instanceof HttpError ? error.status : 500,
      ...toApiError(error),
      kept
    })
  } finally {
    clearInterval(keepAlive)
    if (res.headersSent && !res.writableEnded) res.end()
  }
}

/**
 * The conversation from message `fromId` on, as the app shows it at `now`,
 * its players linked by every name the conversation's API answers carry:
 * those of the messages read, when they are the whole of it, or else read
 * from the messages that carry them alone. Without `linked` (a stored
 * message of the person's, which has none) the names are not read.
 */
async function view(
  db: Kysely<Database>,
  userId: string,
  fromId: number,
  now = new Date(),
  linked = true
): Promise<TessMessage[]> {
  const { messages } = await loadConversation(db, userId, fromId)
  const changeIds = messages.flatMap(message =>
    message.content.flatMap(block =>
      block.type === 'change' ? [block.id] : []
    )
  )
  return viewMessages(
    messages,
    await attachmentInfoById(db, userId, attachmentIdsOf(messages)),
    await changesById(db, userId, changeIds, now),
    !linked
      ? new Map()
      : fromId <= 0
        ? playerNamesOf(messages)
        : await storedPlayerNames(db, userId)
  )
}
