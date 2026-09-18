import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { type Response, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { createEmailCode, verifyEmailCode } from '../auth/emailCodes'
import { findUserByEmail, primaryEmail } from '../auth/emails'
import { passwordMatches } from '../auth/passwords'
import {
  checkLimits,
  clientIp,
  type LimitRule,
  recordAttempts
} from '../auth/rateLimit'
import { createSession, revokeSession } from '../auth/sessions'
import { SESSION_COOKIE, sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
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
  /** Signs the picture in the header. Absent until a Space is configured. */
  space?: SpaceSettings
  /** Decides whether the session cookie may be marked `Secure`. */
  publicUrl?: string
}

/**
 * What the sign-in endpoints allow.
 *
 * Guessing a code was already bounded — a code dies after five wrong tries —
 * but nothing bounded how many codes could be *asked for*, so the server would
 * mail any address as often as it was told to, and a six-digit code could be
 * attacked by requesting a fresh one every five guesses. Passwords had no
 * bound of any kind.
 *
 * Two keys, because one alone is not enough. Limiting by address stops one
 * person's inbox being used as a weapon; limiting by client stops the same
 * attacker walking through all 185 known addresses a few tries each.
 *
 * The numbers are set where a real person will not meet them: five codes in a
 * quarter of an hour is already more than anyone needs, and ten wrong
 * passwords is a bad memory rather than an attack.
 */
const LIMITS = {
  codeByAddress: { scope: 'emailCode.address', limit: 5, windowSec: 900 },
  codeByClient: { scope: 'emailCode.ip', limit: 20, windowSec: 3600 },
  passwordByAddress: { scope: 'password.address', limit: 10, windowSec: 900 },
  passwordByClient: { scope: 'password.ip', limit: 50, windowSec: 3600 },
  verifyByAddress: { scope: 'verify.address', limit: 10, windowSec: 900 },
  verifyByClient: { scope: 'verify.ip', limit: 50, windowSec: 3600 }
}

/** The rules for one attempt: always by address, and by client when known. */
function rulesFor(
  byAddress: { scope: string; limit: number; windowSec: number },
  byClient: { scope: string; limit: number; windowSec: number },
  email: string,
  ip: string | null
): LimitRule[] {
  const rules: LimitRule[] = [{ ...byAddress, key: email }]
  if (ip != null) rules.push({ ...byClient, key: ip })
  return rules
}

/**
 * The one cookie this application sets, and the only thing it holds.
 *
 * `HttpOnly` so the app's own JavaScript cannot read it, which means a script
 * injected onto the page cannot steal it either. `SameSite=Lax` so it does not
 * ride along on a cross-site POST, and every mutating call here sends
 * `content-type: application/json`, which forces a preflight a forged form
 * cannot satisfy. Both, not either.
 *
 * `Secure` everywhere but a plain-HTTP development origin, where a browser
 * would refuse to store it at all.
 */
function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  secure: boolean
): void {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  )
  res.append(
    'set-cookie',
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      ...(secure ? ['Secure'] : [])
    ].join('; ')
  )
}

function clearSessionCookie(res: Response, secure: boolean): void {
  res.append(
    'set-cookie',
    [
      `${SESSION_COOKIE}=`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      'Max-Age=0',
      ...(secure ? ['Secure'] : [])
    ].join('; ')
  )
}

export function authRoutes(db: Kysely<Database>, options: AuthOptions): Router {
  const router = Router()
  const secureCookie = options.publicUrl?.startsWith('http://') !== true

  /** The signed-in person's own picture, for the header. */
  const avatarFor = async (userId: string): Promise<string | null> => {
    if (options.space == null) return null
    const row = await db
      .selectFrom('users')
      .select('avatar_path')
      .where('id', '=', userId)
      .executeTakeFirst()
    return imageUrl(options.space, row?.avatar_path ?? null)
  }

  router.post(
    '/auth/password',
    withAsync(async (req, res) => {
      const body = cleanBody(asPasswordLogin, req.body)
      const email = body.email.trim().toLowerCase()
      const rules = rulesFor(
        LIMITS.passwordByAddress,
        LIMITS.passwordByClient,
        email,
        clientIp(req)
      )
      await checkLimits(db, rules)

      const user = await findUserByEmail(db, email)

      // The same answer whether the address is unknown, the password is wrong,
      // or the account has no login: none of those should be discoverable.
      const ok =
        user != null &&
        user.loginEnabled &&
        (await passwordMatches(body.password, user.passwordHash))
      if (!ok || user == null) {
        // Only a failure counts. Somebody who signs in correctly all day is not
        // the problem, and locking them out would be this change causing one.
        await recordAttempts(db, rules)
        throw unauthorized('Wrong e-mail or password')
      }

      const session = await createSession(db, user.id, req.header('user-agent'))
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id)
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
      const rules = rulesFor(
        LIMITS.codeByAddress,
        LIMITS.codeByClient,
        email,
        clientIp(req)
      )
      await checkLimits(db, rules)
      // Recorded whether or not an account exists, and before finding out, so
      // that a known address and an unknown one behave identically. Charging
      // only for real sends would make the quota itself say who has an account.
      await recordAttempts(db, rules)

      const user = await findUserByEmail(db, email)

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
      const rules = rulesFor(
        LIMITS.verifyByAddress,
        LIMITS.verifyByClient,
        email,
        clientIp(req)
      )
      await checkLimits(db, rules)

      // A code already dies after five wrong guesses. This is the bound across
      // *codes*: without it, a guesser could ask for a new one every five tries
      // and keep going, which is the same attack wearing a hat.
      const good = await verifyEmailCode(db, email, 'login', body.code)
      const user = good ? await findUserByEmail(db, email) : null
      if (!good || user == null) {
        await recordAttempts(db, rules)
        throw unauthorized('That code is wrong or has expired')
      }

      const session = await createSession(db, user.id, req.header('user-agent'))
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id)
          }
        })
      )
    })
  )

  router.post(
    '/auth/logout',
    requireActor,
    withAsync(async (req, res) => {
      const token = sessionToken(
        req.header('authorization'),
        req.header('cookie')
      )
      if (token != null) await revokeSession(db, token)
      clearSessionCookie(res, secureCookie)
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
        .select(['id', 'display_name', 'is_admin', 'avatar_path'])
        .where('id', '=', actor.userId)
        .executeTakeFirst()
      if (user == null) throw unauthorized()
      res.json({
        id: user.id,
        displayName: user.display_name,
        email: await primaryEmail(db, user.id),
        isAdmin: user.is_admin,
        avatarUrl:
          options.space == null
            ? null
            : imageUrl(options.space, user.avatar_path),
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
