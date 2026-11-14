import {
  asMaybe,
  asObject,
  asOptional,
  asString,
  asUnknown,
  type Cleaner
} from 'cleaners'
import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { forbidden, notFound, unauthorized } from '../../common/errors'
import { makeId } from '../../common/ids'
import { isMachine } from '../auth/sessions'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit, skipAudit } from '../middleware/withAudit'
import { withAsync } from '../middleware/withErrors'

export interface PushRouteOptions {
  /** The VAPID public key browsers subscribe with, or null with Web Push off. */
  webPushKey: string | null
}

/** An APNs device token or an FCM registration token. */
const asToken: Cleaner<string> = raw => {
  const token = asString(raw)
  if (!/^[A-Za-z0-9_:.-]{8,4096}$/.test(token))
    throw new TypeError('Expected a device token')
  return token
}

/**
 * The push services browsers subscribe through. A subscription is a URL the
 * server posts to, so one anywhere else is refused: the server never posts
 * where a caller points it.
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/
]

/** base64url of exactly `length` bytes. */
const asKeyOf =
  (length: number, first?: number): Cleaner<string> =>
  raw => {
    const text = asString(raw)
    const bytes = /^[A-Za-z0-9_-]+={0,2}$/.test(text)
      ? Buffer.from(text, 'base64url')
      : Buffer.alloc(0)
    if (bytes.length !== length || (first != null && bytes[0] !== first))
      throw new TypeError(`Expected ${length} bytes in base64url`)
    return bytes.toString('base64url')
  }

const asEndpoint: Cleaner<string> = raw => {
  const text = asString(raw)
  const url = asMaybe((value: unknown) => new URL(asString(value)))(text)
  if (
    text.length > 2048 ||
    url?.protocol !== 'https:' ||
    url.port !== '' ||
    !PUSH_SERVICE_HOSTS.some(host => host.test(url.hostname))
  )
    throw new TypeError('Expected a push service endpoint')
  return url.href
}

const asSubscriptionShape = asObject({
  endpoint: asEndpoint,
  expirationTime: asOptional(asUnknown),
  keys: asObject({ p256dh: asKeyOf(65, 4), auth: asKeyOf(16) })
})

/**
 * A browser's `PushSubscription`, as its JSON text or as the object, stored
 * in one spelling: the same subscription posted again reads the same.
 */
const asSubscription: Cleaner<{ key: string; address: string }> = raw => {
  const value: unknown =
    typeof raw === 'string'
      ? asMaybe((text: unknown) => JSON.parse(asString(text)) as unknown)(raw)
      : raw
  const { endpoint, keys } = asSubscriptionShape(value)
  return {
    key: endpoint,
    address: JSON.stringify({
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth }
    })
  }
}

const asRegistrationBody = asObject({
  platform: asLiteral('ios', 'android', 'web'),
  address: asUnknown,
  environment: asOptional(asLiteral('production', 'development'), 'production')
})

/**
 * How many registrations one person keeps: far more phones and browsers than
 * anybody signs in on, and few enough that a session posting made-up tokens
 * cannot make every message to them hundreds of sends. A new one past it
 * pushes out whichever of theirs was posted least recently.
 */
export const MAX_REGISTRATIONS_PER_USER = 20

/** The session a device registers under; a key, a token or Tess is refused. */
function sessionCaller(req: Request): { userId: string; sessionId: string } {
  const actor = req.actor
  if (actor == null) throw unauthorized()
  if (isMachine(actor) || actor.apiKey != null || actor.sessionId == null)
    throw forbidden('Notifications need a signed-in session', {
      reason: 'sessionRequired'
    })
  return { userId: actor.userId, sessionId: actor.sessionId }
}

/**
 * Where a signed-in device asks to be woken (`src/server/push/`).
 *
 * - `GET /push/web-key`: the VAPID public key a browser subscribes with; 404
 *   while Web Push is off.
 * - `POST /me/push-registrations { platform, address, environment }`: this
 *   device's token or subscription, bound to this session. The same address
 *   posted again, by anyone, moves to the posting session, and is sent to
 *   again if a push service had refused it. A person keeps the
 *   `MAX_REGISTRATIONS_PER_USER` they posted most recently.
 * - `DELETE /me/push-registrations/:id`: one of the caller's own.
 *
 * A registration is live while its session is: signing out or the session's
 * expiry stops its pushes, and deleting the session deletes it.
 */
export function pushRoutes(
  db: Kysely<Database>,
  options: PushRouteOptions
): Router {
  const router = Router()

  router.get('/push/web-key', (req, res) => {
    sessionCaller(req)
    if (options.webPushKey == null) throw notFound('Web Push is off')
    res.json({ publicKey: options.webPushKey })
  })

  router.post(
    '/me/push-registrations',
    withAsync(async (req, res) => {
      const caller = sessionCaller(req)
      const body = cleanBody(asRegistrationBody, req.body)
      const { key, address } = cleanBody(
        body.platform === 'web'
          ? asSubscription
          : (raw: unknown) => {
              const token = asToken(raw)
              return { key: token, address: token }
            },
        body.address
      )
      const now = new Date()
      const row = await db.transaction().execute(async trx => {
        const posted = await trx
          .insertInto('push_registrations')
          .values({
            id: makeId('pushRegistration'),
            user_id: caller.userId,
            session_id: caller.sessionId,
            platform: body.platform,
            address_key: key,
            address,
            environment: body.environment,
            created_at: now,
            seen_at: now,
            rejected_at: null
          })
          .onConflict(oc =>
            oc.columns(['platform', 'address_key']).doUpdateSet({
              user_id: caller.userId,
              session_id: caller.sessionId,
              address,
              environment: body.environment,
              seen_at: now,
              rejected_at: null
            })
          )
          .returning('id')
          .executeTakeFirstOrThrow()
        // This one, and the rest of the person's newest, stay.
        await trx
          .deleteFrom('push_registrations')
          .where('user_id', '=', caller.userId)
          .where('id', '!=', posted.id)
          .where(eb =>
            eb(
              'id',
              'not in',
              eb
                .selectFrom('push_registrations')
                .select('id')
                .where('user_id', '=', caller.userId)
                .where('id', '!=', posted.id)
                .orderBy('seen_at', 'desc')
                .orderBy('id', 'desc')
                .limit(MAX_REGISTRATIONS_PER_USER - 1)
            )
          )
          .execute()
        return posted
      })
      setAudit(res.locals, {
        entityType: 'pushRegistration',
        entityId: row.id,
        after: { platform: body.platform, environment: body.environment }
      })
      res.json({ id: row.id })
    })
  )

  router.delete(
    '/me/push-registrations/:id',
    withAsync(async (req, res) => {
      const caller = sessionCaller(req)
      const id = String(req.params.id)
      const removed = await db
        .deleteFrom('push_registrations')
        .where('id', '=', id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst()
      if (removed.numDeletedRows === 0n) {
        skipAudit(res.locals)
        throw notFound('No such registration')
      }
      setAudit(res.locals, { entityType: 'pushRegistration', entityId: id })
      res.status(204).end()
    })
  )

  return router
}
