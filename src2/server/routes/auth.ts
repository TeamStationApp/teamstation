import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { createEmailCode, verifyEmailCode } from '../auth/emailCodes'
import { passwordMatches } from '../auth/passwords'
import { createSession, revokeSession } from '../auth/sessions'
import { bearerToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

const asPasswordLogin = asObject({
  email: asString,
  password: asString
})

const asCodeRequest = asObject({
  email: asString
})

const asCodeLogin = asObject({
  email: asString,
  code: asString
})

/** What a successful sign-in returns. Cleaned on the way out as well as in. */
const asSession = asObject({
  token: asString,
  expiresAt: asString,
  user: asObject({
    id: asString,
    displayName: asString,
    email: asOptional(asString),
    isAdmin: asBoolean
  })
})

export interface AuthOptions {
  /**
   * Delivers a sign-in code. In production this is SMTP; in development it
   * logs, so the flow can be exercised without a mail server.
   */
  sendCode: (email: string, code: string) => Promise<void>
}

export function authRoutes(db: Kysely<Database>, options: AuthOptions): Router {
  const router = Router()

  router.post(
    '/auth/password',
    withAsync(async (req, res) => {
      const body = cleanBody(asPasswordLogin, req.body)
      const email = body.email.trim().toLowerCase()

      const user = await db
        .selectFrom('users')
        .select([
          'id',
          'display_name',
          'email',
          'password_hash',
          'is_admin',
          'login_enabled'
        ])
        .where(eb => eb.fn('lower', ['email']), '=', email)
        .executeTakeFirst()

      // The same answer whether the address is unknown, the password is wrong,
      // or the account has no login: none of those should be discoverable.
      const ok =
        user != null &&
        user.login_enabled &&
        (await passwordMatches(body.password, user.password_hash))
      if (!ok || user == null) throw unauthorized('Wrong e-mail or password')

      const session = await createSession(db, user.id, req.header('user-agent'))
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            displayName: user.display_name,
            email: user.email ?? undefined,
            isAdmin: user.is_admin
          }
        })
      )
    })
  )

  router.post(
    '/auth/email-code',
    withAsync(async (req, res) => {
      const body = cleanBody(asCodeRequest, req.body)
      const email = body.email.trim().toLowerCase()

      const user = await db
        .selectFrom('users')
        .select(['id'])
        .where(eb => eb.fn('lower', ['email']), '=', email)
        .executeTakeFirst()

      // Always the same answer, so this cannot be used to find out who has an
      // account. The code is only made when there is somebody to send it to.
      if (user != null) {
        const { code } = await createEmailCode(db, email, 'login')
        await options.sendCode(email, code)
      }
      res.status(202).json({ sent: true })
    })
  )

  router.post(
    '/auth/email-code/verify',
    withAsync(async (req, res) => {
      const body = cleanBody(asCodeLogin, req.body)
      const email = body.email.trim().toLowerCase()

      const good = await verifyEmailCode(db, email, 'login', body.code)
      if (!good) throw unauthorized('That code is wrong or has expired')

      const user = await db
        .selectFrom('users')
        .select(['id', 'display_name', 'email', 'is_admin'])
        .where(eb => eb.fn('lower', ['email']), '=', email)
        .executeTakeFirst()
      if (user == null) throw unauthorized('That code is wrong or has expired')

      const session = await createSession(db, user.id, req.header('user-agent'))
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            displayName: user.display_name,
            email: user.email ?? undefined,
            isAdmin: user.is_admin
          }
        })
      )
    })
  )

  router.post(
    '/auth/logout',
    requireActor,
    withAsync(async (req, res) => {
      const token = bearerToken(req.header('authorization'))
      if (token != null) await revokeSession(db, token)
      res.status(204).end()
    })
  )

  router.get(
    '/auth/me',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const user = await db
        .selectFrom('users')
        .select(['id', 'display_name', 'email', 'is_admin'])
        .where('id', '=', actor.userId)
        .executeTakeFirst()
      if (user == null) throw unauthorized()
      res.json({
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        isAdmin: user.is_admin,
        viaApiToken: actor.apiTokenId != null
      })
    })
  )

  return router
}

/** Turns a cleaner's complaint into a 400 that names the problem. */
function cleanBody<T>(cleaner: (raw: unknown) => T, raw: unknown): T {
  try {
    return cleaner(raw)
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'Malformed request body'
    )
  }
}
