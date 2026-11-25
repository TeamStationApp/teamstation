import { asObject, asOptional, asString } from 'cleaners'
import {
  type Request,
  type RequestHandler,
  type Response,
  Router
} from 'express'
import { rateLimit } from 'express-rate-limit'
import { type Kysely, sql, type Transaction } from 'kysely'

import { asAccountEmail } from '../../common/accountSettings'
import { asSession } from '../../common/api'
import {
  badRequest,
  conflict,
  notFound,
  unauthorized,
  unavailable
} from '../../common/errors'
import { asClientHash, rejectRawPassword } from '../../common/passwordProtocol'
import { isDevelopmentWebOrigin } from '../../common/primaryUrl'
import { safeNext } from '../../common/signInReturn'
import { asTvPlatform, defaultTvAppOrigin } from '../../common/tvLogin'
import {
  type AccountSwitch,
  asAccountSwitch,
  EXPECTED_ACTOR_HEADER,
  SIGNED_OUT_ACTOR
} from '../../common/webPasswordLink'
import { allowedAppOrigin } from '../appLinks/appOrigin'
import {
  asSignInOrigin,
  claimApprovedRequest,
  claimSignInLink,
  createEmailCode,
  forgetTypedName,
  signInLink,
  verifyEmailCode
} from '../auth/emailCodes'
import type { FoundUser } from '../auth/emails'
import { findUserByEmail, primaryEmail } from '../auth/emails'
import {
  decoyParameters,
  passwordMatches,
  readPasswordRecord
} from '../auth/passwords'
import {
  checkLimits,
  clientIp,
  type LimitRule,
  recordAttempts
} from '../auth/rateLimit'
import {
  type Actor,
  actorForToken,
  createSession,
  revokeSession
} from '../auth/sessions'
import { onboardingFor, settleAccount } from '../auth/settleAccount'
import { makeToken, SESSION_COOKIE, sessionToken } from '../auth/tokens'
import { tvLocation } from '../auth/tvLocation'
import {
  claimTvLogin,
  inspectOrApproveTvLogin,
  startTvLogin
} from '../auth/tvLogin'
import type { Database } from '../db/database'
import { settleInviteSignIn } from '../invites/joining'
import { applyWaitingInvitations } from '../invites/personRequests'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { recordOutcome } from '../observability/outcomes'
import { gumboIdOf } from '../users/insertUser'

/**
 * What make of device a sign-in is on, as the native app reads it from the
 * system ("iPhone", "Samsung SM-S911B", "Apple TV"). Node administrators see
 * it in User Management; a browser sends none, and is read from its agent.
 */
export function asDeviceModel(raw: unknown): string {
  const model = asString(raw).trim()
  if (model.length < 1 || model.length > 80)
    throw new TypeError('A device model is 1 to 80 characters')
  return model
}

const asPasswordLogin = asObject({
  email: asString,
  clientHash: asClientHash,
  deviceModel: asOptional(asDeviceModel)
})

const asCodeRequest = asObject({
  email: asAccountEmail,
  /**
   * Where the sign-in was asked for, so the link comes back to it.
   *
   * There is no phone app yet. Recording this now is what stops every link
   * having to be reissued the day there is one.
   */
  origin: asOptional(asSignInOrigin, 'web'),
  /** Where they were going before they were asked to sign in. */
  next: asOptional(asString),
  /**
   * The link host of the app asking, so the e-mail's link opens that app.
   * Must be one of the server's configured apps.
   */
  appOrigin: asOptional(asString)
})

const asLinkLogin = asObject({
  token: asString,
  /** Set by a device spending its own link, and it is what it will be called. */
  deviceName: asOptional(asString),
  /**
   * The sign-in request the spender is itself polling for, when it asked for
   * this link: that request is not approved a second time.
   */
  requestId: asOptional(asString),
  deviceModel: asOptional(asDeviceModel)
})

const asRequestClaim = asObject({
  requestId: asString,
  clientSecret: asString,
  /** Set by a device signing itself in, and it is what it will be called. */
  deviceName: asOptional(asString),
  deviceModel: asOptional(asDeviceModel)
})

const asCodeLogin = asObject({
  email: asString,
  code: asString,
  deviceName: asOptional(asString),
  deviceModel: asOptional(asDeviceModel)
})

/**
 * How long a session lasts.
 *
 * A browser gets the ordinary month. A **device** — TS Director, signed in
 * once indoors and then used every weekend from a field where fixing it is
 * the last thing anybody wants to be doing — gets a season, and is named, so
 * a list of them reads like a list of iPads rather than of user agents.
 */
const DEVICE_SESSION_DAYS = 180

/**
 * A named device lasts a season. A device model only says what the sign-in
 * is on: it is stored where the name would be, and the session lasts what a
 * browser's does.
 */
function sessionOptionsFor(
  deviceName: string | undefined,
  deviceModel?: string
): {
  days?: number
  deviceName?: string
} {
  if (deviceName == null || deviceName.trim() === '')
    return deviceModel == null ? {} : { deviceName: deviceModel }
  return { days: DEVICE_SESSION_DAYS, deviceName: deviceName.trim() }
}

export interface AuthOptions {
  passwordParameterSecret?: string
  /**
   * Delivers a sign-in code. In production this is SMTP; in development it
   * logs, so the flow can be exercised without a mail server.
   */
  sendCode: (email: string, code: string, link?: string) => Promise<void>
  /** Signs the picture in the header. Absent until a Space is configured. */
  space?: SpaceSettings
  /** Decides whether the session cookie may be marked `Secure`. */
  publicUrl?: string
  /** Override the deployment's opt-in origin in an isolated fixture. */
  passwordLinkOrigin?: string
  /** The link hosts of the apps this server signs in (`appLinks.apps`). */
  appOrigins?: readonly string[]
  tvAppOrigin?: string
  tvAppOrigins?: readonly string[]
  /** Optional local GeoIP lookup; never send a viewer address to a third party. */
  tvLocationLookup?: (ip: string) => Promise<string | null>
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
 *
 * A link counts apart from a typed code from the same client. Opening a link
 * spends it with no tap, so every old e-mail opened again is a refusal;
 * counted against the per-client budget for codes, a club's shared network
 * could lock everybody on it out of typing a right one. The per-token rule
 * only stops one dead link being hammered; guessing is bounded per client.
 */
const LIMITS = {
  codeByAddress: { scope: 'emailCode.address', limit: 5, windowSec: 900 },
  codeByClient: { scope: 'emailCode.ip', limit: 20, windowSec: 3600 },
  passwordByAddress: { scope: 'password.address', limit: 10, windowSec: 900 },
  passwordByClient: { scope: 'password.ip', limit: 50, windowSec: 3600 },
  verifyByAddress: { scope: 'verify.address', limit: 10, windowSec: 900 },
  verifyByClient: { scope: 'verify.ip', limit: 50, windowSec: 3600 },
  linkByToken: { scope: 'link.token', limit: 10, windowSec: 900 },
  linkByClient: { scope: 'link.ip', limit: 50, windowSec: 3600 }
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

/** The session cookie is `Secure` unless the site is served over plain http://. */
export function secureCookieFor(publicUrl: string | undefined): boolean {
  return publicUrl?.startsWith('http://') !== true
}

export async function checkBrowserActor(
  db: Kysely<Database>,
  req: Request
): Promise<void> {
  const expected = req.header(EXPECTED_ACTOR_HEADER)
  if (expected == null) return
  const cookie = sessionToken(undefined, req.header('cookie'))
  const token = sessionToken(req.header('authorization'), req.header('cookie'))
  const actor =
    cookie != null && cookie !== token
      ? await actorForToken(db, cookie)
      : req.actor
  if ((actor?.userId ?? SIGNED_OUT_ACTOR) !== expected)
    throw conflict('The account changed. Reload to continue.')
}

export function clearSessionCookie(res: Response, secure: boolean): void {
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

// The actor was resolved from this browser's cookie. Retiring the exact
// session also stops push delivery for that session on an account switch.
export async function retireLinkSession(
  tx: Transaction<Database>,
  previous: Actor | undefined,
  userId: string,
  newSessionId: string
): Promise<void> {
  if (previous?.sessionId == null) return
  const retired = await tx
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', previous.sessionId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirstOrThrow()
  if (retired.numUpdatedRows !== 1n)
    throw conflict('The account changed. Reload to continue.')
  if (previous.userId === userId) {
    await tx
      .updateTable('push_registrations')
      .set({ session_id: newSessionId })
      .where('session_id', '=', previous.sessionId)
      .execute()
  }
}

export function authRoutes(db: Kysely<Database>, options: AuthOptions): Router {
  const parameterSecret =
    options.passwordParameterSecret == null ||
    options.passwordParameterSecret === ''
      ? makeToken()
      : options.passwordParameterSecret
  const router = Router()
  // Bound request load before parsing, location lookup, or authentication.
  // Database-backed TV attempt limits still enforce security across workers.
  const tvTrafficLimit = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      code: 'rateLimited',
      message: 'Too many TV sign-in requests. Try again shortly.'
    }
  })
  const secureCookie = secureCookieFor(options.publicUrl)

  /**
   * Who this sign-in is for — making the account first when it came from an
   * invite and there is nobody there yet.
   *
   * Every way of finishing a sign-in comes through here, because a person who
   * asked on a phone may well finish on a laptop, and the account must be
   * made exactly once no matter which of the three arrives. An address that
   * already has an account is simply found, invite or not.
   *
   * The claim carries the name typed at sign-up, read before anything clears
   * it; once the account is settled the code forgets it, so the name lives
   * on `users` alone.
   */
  const userForSignIn = async (
    email: string,
    claim: {
      codeId: string
      inviteId: string | null
      displayName: string | null
    },
    app: unknown
  ): Promise<FoundUser | undefined> => {
    const settled =
      claim.inviteId != null
        ? await settleInviteSignIn(db, {
            email,
            inviteId: claim.inviteId,
            displayName: claim.displayName
          })
        : await settleAccount(db, email)
    await forgetTypedName(db, claim.codeId)
    const user = await findUserByEmail(db, email)
    if (settled?.createdAccount === true && user != null)
      await recordOutcome(
        db,
        app,
        { userId: user.id, isAdmin: user.isAdmin },
        'account_created'
      )
    // The address is proved now: whatever it was added to while nobody held
    // it applies at once.
    if (user != null) await applyWaitingInvitations(db, user.id)
    return user
  }

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
    '/auth/tv/start',
    tvTrafficLimit,
    withAsync(async (req, res) => {
      res.set('cache-control', 'no-store')
      const body = cleanBody(
        asObject({ platform: asTvPlatform, appOrigin: asOptional(asString) }),
        req.body
      )
      const fallback =
        options.tvAppOrigin ??
        defaultTvAppOrigin(options.publicUrl, options.tvAppOrigins)
      const appOrigin =
        allowedAppOrigin(body.appOrigin, options.tvAppOrigins ?? [fallback]) ??
        fallback
      res.json(
        await startTvLogin(
          db,
          body.platform,
          appOrigin,
          clientIp(req),
          await tvLocation(clientIp(req), options.tvLocationLookup),
          options.publicUrl == null
            ? undefined
            : new URL(options.publicUrl).origin
        )
      )
    })
  )
  router.post(
    '/auth/tv/claim',
    tvTrafficLimit,
    withAsync(async (req, res) => {
      res.set('cache-control', 'no-store')
      const body = cleanBody(
        asObject({ requestId: asString, clientSecret: asString }),
        req.body
      )
      const claim = await claimTvLogin(
        db,
        body.requestId,
        body.clientSecret,
        req.header('user-agent')
      )
      if (claim == null) {
        res.status(202).json({ ready: false })
        return
      }
      const user = await db
        .selectFrom('users')
        .select(['id', 'display_name', 'is_admin'])
        .where('id', '=', claim.userId)
        .executeTakeFirstOrThrow()
      res.json(
        asSession({
          token: claim.session.token,
          expiresAt: claim.session.expiresAt.toISOString(),
          user: {
            id: user.id,
            gumboId: await gumboIdOf(db, user.id),
            displayName: user.display_name,
            email: await primaryEmail(db, user.id),
            isAdmin: user.is_admin,
            avatarUrl: await avatarFor(user.id),
            onboarding: await onboardingFor(db, user.id)
          }
        })
      )
    })
  )
  router.post(
    '/auth/tv/inspect',
    tvTrafficLimit,
    requireActor,
    withAsync(async (req, res) => {
      res.set('cache-control', 'no-store')
      if (req.actor == null) throw unauthorized()
      const body = cleanBody(asObject({ token: asString }), req.body)
      res.json(
        await inspectOrApproveTvLogin(db, req.actor, body, clientIp(req), false)
      )
    })
  )
  router.post(
    '/auth/tv/approve',
    tvTrafficLimit,
    requireActor,
    withAsync(async (req, res) => {
      res.set('cache-control', 'no-store')
      if (req.actor == null) throw unauthorized()
      const body = cleanBody(
        asObject({ code: asOptional(asString), token: asOptional(asString) }),
        req.body
      )
      await inspectOrApproveTvLogin(db, req.actor, body, clientIp(req), true)
      res.sendStatus(204)
    })
  )

  router.post(
    '/auth/password/parameters',
    withAsync(async (req, res) => {
      const { email: rawEmail } = cleanBody(
        asObject({ email: asString }),
        req.body
      )
      const email = rawEmail.trim().toLowerCase()
      if (email.length > 254) throw badRequest('Email address is too long')
      const rules = rulesFor(
        { ...LIMITS.passwordByAddress, scope: 'passwordParameters.address' },
        { ...LIMITS.passwordByClient, scope: 'passwordParameters.client' },
        email,
        clientIp(req)
      )
      await chargePasswordAttempt(db, rules)
      const user = await findUserByEmail(db, email)
      const record =
        user?.loginEnabled === true
          ? readPasswordRecord(user.passwordHash)
          : null
      res.json(record?.client ?? decoyParameters(email, parameterSecret))
    })
  )
  const passwordLogin = (fromLink: boolean): RequestHandler =>
    withAsync(async (req, res) => {
      const verifySwitch = fromLink
        ? passwordLinkGuard(
            options.publicUrl,
            options.passwordLinkOrigin ??
              process.env.TS_WEB_PASSWORD_LINK_ORIGIN,
            res,
            req.body,
            req.actor?.userId,
            async id => await primaryEmail(db, id)
          )
        : undefined
      let previous: Actor | undefined
      if (fromLink) {
        const cookie = sessionToken(undefined, req.header('cookie'))
        const bearer = sessionToken(req.header('authorization'), undefined)
        if (cookie != null && bearer != null && cookie !== bearer)
          throw conflict('The account changed. Reload to continue.')
        if (cookie != null) previous = req.actor
      }
      const body = cleanBody(raw => {
        rejectRawPassword(raw)
        return asPasswordLogin(raw)
      }, req.body)
      const email = body.email.trim().toLowerCase()
      const rules = rulesFor(
        LIMITS.passwordByAddress,
        LIMITS.passwordByClient,
        email,
        clientIp(req)
      )
      await chargePasswordAttempt(db, rules)
      // An address of an account that was merged into another finds the
      // account that was kept, so it signs in with that account's password;
      // the merged account's own password is no longer anybody's.
      const user = await findUserByEmail(db, email)

      // Keep the failure message uniform. The public parameter handshake can
      // still distinguish accounts with non-default stored hashing costs.
      const ok =
        user?.loginEnabled === true &&
        (await passwordMatches(body.clientHash, user.passwordHash, user.id))
      if (!ok || user == null) {
        throw unauthorized(
          'Wrong e-mail or password. Use an email code to sign in and set a new password'
        )
      }

      await verifySwitch?.(user)

      const session = await db.transaction().execute(async tx => {
        const current = await tx
          .selectFrom('users')
          .select(['password_hash', 'login_enabled', 'merged_into'])
          .where('id', '=', user.id)
          .forUpdate()
          .executeTakeFirst()
        if (
          current?.password_hash !== user.passwordHash ||
          !current.login_enabled ||
          current.merged_into != null
        )
          throw unauthorized('Your password changed. Please sign in again')
        const replacement = await createSession(
          tx,
          user.id,
          req.header('user-agent'),
          sessionOptionsFor(undefined, body.deviceModel)
        )
        await retireLinkSession(tx, previous, user.id, replacement.sessionId)
        return replacement
      })
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            gumboId: await gumboIdOf(db, user.id),
            displayName: user.displayName,
            email: await primaryEmail(db, user.id),
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id),
            onboarding: await onboardingFor(db, user.id)
          }
        })
      )
    })
  router.post('/auth/password', passwordLogin(false))
  router.post('/auth/password/link', passwordLogin(true))

  router.post(
    '/auth/email-code',
    withAsync(async (req, res) => {
      const body = cleanBody(asCodeRequest, req.body)
      const appOrigin = allowedAppOrigin(
        body.appOrigin,
        options.appOrigins ?? []
      )
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

      // Email ownership is established by verification, never by requesting a code.
      const request = await createEmailCode(db, email, 'login', {
        origin: body.origin,
        next: safeNext(body.next),
        appOrigin
      })
      try {
        await options.sendCode(
          email,
          request.code,
          signInLink(
            options.publicUrl,
            request.token,
            appOrigin,
            options.appOrigins?.includes(options.publicUrl ?? '') === true
          )
        )
      } catch {
        await db
          .updateTable('email_codes')
          .set({ consumed_at: new Date() })
          .where('id', '=', request.id)
          .execute()
        throw unavailable(
          'The sign-in email could not be sent. Please try again.'
        )
      }
      res.status(202).json({
        sent: true,
        // Named for what they are: the request this client is waiting on, and
        // the secret that proves the wait is its own. Both are useless without
        // somebody opening the link or typing the code.
        requestId: request.id,
        clientSecret: request.clientSecret
      })
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
      const claim = await verifyEmailCode(db, email, 'login', body.code)
      const user =
        claim == null
          ? null
          : await userForSignIn(email, claim, req.header('x-teamstation-app'))
      if (claim == null || user == null) {
        await recordAttempts(db, rules)
        throw unauthorized('That code is wrong or has expired')
      }

      const session = await createSession(
        db,
        user.id,
        req.header('user-agent'),
        sessionOptionsFor(body.deviceName, body.deviceModel)
      )
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            gumboId: await gumboIdOf(db, user.id),
            displayName: user.displayName,
            email: await primaryEmail(db, user.id),
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id),
            onboarding: await onboardingFor(db, user.id)
          }
        })
      )
    })
  )

  /**
   * Spend the link from the e-mail.
   *
   * A `POST`, and never a `GET`: the address in the e-mail loads the app, and
   * the app asks for this once it is running. Mail scanners follow
   * links and run no scripts, so a sign-in cannot be burnt before it is read.
   */
  router.post(
    '/auth/link/verify',
    withAsync(async (req, res) => {
      const body = cleanBody(asLinkLogin, req.body)
      const rules = rulesFor(
        LIMITS.linkByToken,
        LIMITS.linkByClient,
        body.token.slice(0, 16),
        clientIp(req)
      )
      await checkLimits(db, rules)

      const claim = await claimSignInLink(db, body.token, {
        asker: body.requestId
      })
      const user =
        claim == null
          ? null
          : await userForSignIn(
              claim.email,
              claim,
              req.header('x-teamstation-app')
            )
      if (claim == null || user == null) {
        await recordAttempts(db, rules)
        throw unauthorized('That link is no longer good')
      }

      const session = await createSession(
        db,
        user.id,
        req.header('user-agent'),
        sessionOptionsFor(body.deviceName, body.deviceModel)
      )
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          next: safeNext(claim.next),
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            gumboId: await gumboIdOf(db, user.id),
            displayName: user.displayName,
            email: await primaryEmail(db, user.id),
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id),
            onboarding: await onboardingFor(db, user.id)
          }
        })
      )
    })
  )

  /**
   * What the client that asked is waiting for.
   *
   * Tap the link on a laptop while the phone is still waiting, and this is how
   * the phone finds out and carries on: it polls with a secret only it holds,
   * and gets its own session once the request has been approved anywhere.
   */
  router.post(
    '/auth/request/claim',
    withAsync(async (req, res) => {
      await checkBrowserActor(db, req)
      const body = cleanBody(asRequestClaim, req.body)
      const claim = await claimApprovedRequest(
        db,
        body.requestId,
        body.clientSecret
      )
      if (claim == null) {
        // Not an error: waiting is the normal state of this endpoint.
        res.status(202).json({ ready: false })
        return
      }
      const user = await userForSignIn(
        claim.email,
        claim,
        req.header('x-teamstation-app')
      )
      if (user == null) throw unauthorized('That sign-in is no longer good')

      const session = await createSession(
        db,
        user.id,
        req.header('user-agent'),
        sessionOptionsFor(body.deviceName, body.deviceModel)
      )
      setSessionCookie(res, session.token, session.expiresAt, secureCookie)
      res.json(
        asSession({
          next: safeNext(claim.next),
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: {
            id: user.id,
            gumboId: await gumboIdOf(db, user.id),
            displayName: user.displayName,
            email: await primaryEmail(db, user.id),
            isAdmin: user.isAdmin,
            avatarUrl: await avatarFor(user.id),
            onboarding: await onboardingFor(db, user.id)
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
      await checkBrowserActor(db, req)
      if (token != null) await revokeSession(db, token)
      if (req.actor != null)
        await recordOutcome(
          db,
          req.header('x-teamstation-app'),
          req.actor,
          'logout'
        )
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
        gumboId: await gumboIdOf(db, user.id),
        displayName: user.display_name,
        email: await primaryEmail(db, user.id),
        isAdmin: user.is_admin,
        avatarUrl:
          options.space == null
            ? null
            : imageUrl(options.space, user.avatar_path),
        onboarding: await onboardingFor(db, user.id),
        viaApiToken: actor.apiTokenId != null
      })
    })
  )

  return router
}

// Gate and parse the development request before any account lookup. The
// returned decision is only evaluated once password verification succeeds.
export function passwordLinkGuard(
  origin: string | undefined,
  configuredOrigin: string | undefined,
  res: Pick<Response, 'set'>,
  body: unknown,
  currentId: string | undefined,
  accountEmail: (id: string) => Promise<string | undefined>
): (target: Pick<FoundUser, 'id' | 'email'>) => Promise<void> {
  res.set('cache-control', 'no-store')
  if (!isDevelopmentWebOrigin(origin, configuredOrigin)) throw notFound()
  const { confirmation } = cleanBody(
    asObject({ confirmation: asOptional(asAccountSwitch) }),
    body
  )
  return async target => {
    await confirmPasswordLinkSwitch(
      currentId,
      target,
      confirmation,
      accountEmail
    )
  }
}

// Decide only after the target password has been verified, before creating a session.
export async function confirmPasswordLinkSwitch(
  currentId: string | undefined,
  target: Pick<FoundUser, 'id' | 'email'>,
  confirmation: AccountSwitch | undefined,
  accountEmail: (id: string) => Promise<string | undefined>
): Promise<void> {
  if (confirmation != null) {
    if (
      currentId !== confirmation.currentId ||
      target.id !== confirmation.targetId
    )
      throw conflict('The account changed. Open the sign-in link again.')
  } else if (currentId != null && currentId !== target.id) {
    throw conflict('Confirm the account switch', {
      reason: 'confirmAccountSwitch',
      confirmation: { currentId, targetId: target.id },
      currentLabel: (await accountEmail(currentId)) ?? currentId,
      targetLabel: target.email
    })
  }
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

/** Serialize quota accounting before launching a memory-hard hash. */
async function chargePasswordAttempt(
  db: Kysely<Database>,
  rules: LimitRule[]
): Promise<void> {
  await db.transaction().execute(async tx => {
    for (const key of rules.map(rule => `${rule.scope}:${rule.key}`).sort())
      await sql`select pg_advisory_xact_lock(hashtext('password-limits'), hashtext(${key}))`.execute(
        tx
      )
    await checkLimits(tx, rules)
    await recordAttempts(tx, rules)
  })
}
