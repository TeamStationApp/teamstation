import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  API_KEY_CREATE_WINDOW_MIN,
  API_KEY_CREATES_PER_WINDOW,
  type ApiKey,
  type ApiKeyPermission,
  asApiKeyCreate,
  MAX_API_KEYS
} from '../../common/apiKeys'
import {
  conflict,
  forbidden,
  notFound,
  unauthorized,
  unavailable
} from '../../common/errors'
import { makeId } from '../../common/ids'
import { checkLimits, type LimitRule, recordAttempts } from '../auth/rateLimit'
import { isHumanSession, USER_API_KEY_PREFIX } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { openSecret, sealSecret } from '../live/secrets'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export interface ApiKeyRouteOptions {
  /** Seals each secret so Account can copy it again. Empty refuses creates. */
  sessionSecret: string
}

/**
 * The person's own API keys: list, make and revoke. Only the person, signed
 * in, may call these: a machine token, Tess and an API key are refused, so a
 * key cannot make another key or outlive its own revocation.
 */
export function apiKeyRoutes(
  db: Kysely<Database>,
  options: ApiKeyRouteOptions
): Router {
  const router = Router()
  router.use('/me/api-keys', requireActor, (req, res, next) => {
    // Every answer here can carry a secret that does not expire.
    res.set('Cache-Control', 'no-store')
    next()
  })

  router.get(
    '/me/api-keys',
    withAsync(async (req, res) => {
      const userId = personOf(req)
      res.json({ keys: await activeKeys(db, userId, options.sessionSecret) })
    })
  )

  router.post(
    '/me/api-keys',
    withAsync(async (req, res) => {
      const userId = personOf(req)
      const body = cleanBody(asApiKeyCreate, req.body)
      if (options.sessionSecret === '')
        throw unavailable('API keys are not set up on this server')
      const secret = `${USER_API_KEY_PREFIX}${makeToken()}`
      const key = await db.transaction().execute(async tx => {
        // One create at a time per account, so two at once cannot both pass
        // the cap.
        await tx
          .selectFrom('users')
          .select('id')
          .where('id', '=', userId)
          .forUpdate()
          .executeTakeFirst()
        const rules: LimitRule[] = [
          {
            scope: 'apiKey.create',
            key: userId,
            limit: API_KEY_CREATES_PER_WINDOW,
            windowSec: API_KEY_CREATE_WINDOW_MIN * 60
          }
        ]
        await checkLimits(tx, rules)
        const held = await tx
          .selectFrom('user_api_keys')
          .select(eb => eb.fn.countAll<string>().as('count'))
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .executeTakeFirstOrThrow()
        if (Number(held.count) >= MAX_API_KEYS)
          throw conflict(
            `An account may hold ${MAX_API_KEYS} API keys. Delete one to make another`
          )
        await recordAttempts(tx, rules)
        return await tx
          .insertInto('user_api_keys')
          .values({
            id: makeId('userApiKey'),
            user_id: userId,
            name: body.name,
            token_hash: hashToken(secret),
            secret_sealed: sealSecret(options.sessionSecret, secret),
            permissions: body.permissions
          })
          .returning(['id', 'name', 'created_at', 'permissions'])
          .executeTakeFirstOrThrow()
      })
      setAudit(res.locals, { entityType: 'userApiKey', entityId: key.id })
      res.status(201).json(keyOf(key, secret))
    })
  )

  router.delete(
    '/me/api-keys/:id',
    withAsync(async (req, res) => {
      const userId = personOf(req)
      const id = String(req.params.id)
      const revoked = await db
        .updateTable('user_api_keys')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
      if (Number(revoked.numUpdatedRows) === 0)
        throw notFound('No such API key')
      setAudit(res.locals, { entityType: 'userApiKey', entityId: id })
      res.status(204).end()
    })
  )

  return router
}

/** The signed-in person's id, or a refusal for anything acting for them. */
function personOf(req: Request): string {
  if (req.actor == null) throw unauthorized()
  if (!isHumanSession(req.actor))
    throw forbidden('Only a signed-in person can manage API keys')
  return req.actor.userId
}

/** The account's keys that still work, oldest first. */
export async function activeKeys(
  db: Kysely<Database>,
  userId: string,
  sessionSecret: string
): Promise<ApiKey[]> {
  const rows = await db
    .selectFrom('user_api_keys')
    .select(['id', 'name', 'created_at', 'permissions', 'secret_sealed'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map(row => keyOf(row, opened(sessionSecret, row.secret_sealed)))
}

/** The sealed secret, or null when the server's secret has changed since. */
function opened(sessionSecret: string, sealed: string): string | null {
  try {
    return openSecret(sessionSecret, sealed)
  } catch {
    return null
  }
}

function keyOf(
  row: {
    id: string
    name: string
    created_at: Date | string
    permissions: string[]
  },
  secret: string | null
): ApiKey {
  return {
    id: row.id,
    name: row.name,
    secret,
    createdAt: new Date(row.created_at).toISOString(),
    permissions: row.permissions as ApiKeyPermission[]
  }
}
