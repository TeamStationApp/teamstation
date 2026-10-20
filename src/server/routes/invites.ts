import { asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import type { RequestTerms } from '../../common/notifications'
import { adminScopes } from '../access'
import { allowedAppOrigin } from '../appLinks/appOrigin'
import { asSignInOrigin, createEmailCode, signInLink } from '../auth/emailCodes'
import {
  checkLimits,
  clientIp,
  type LimitRule,
  recordAttempts
} from '../auth/rateLimit'
import type { Database } from '../db/database'
import { currentActor } from '../groups/rights'
import {
  alreadyInScope,
  createInvite,
  findInviteByCode,
  findInviteById,
  type Invite,
  inviteProblem,
  type InviteScopeType,
  listInvites,
  mayInviteTo,
  redeemInvite,
  revokeInvite,
  scopeName
} from '../invites/invites'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/**
 * Invite codes: making them, and coming in through one.
 *
 * Two halves that look nothing alike. `/invites` is administration — who may
 * make a code, for what, and who may stop it. `/join/:code` is the door: it is
 * reachable without signing in, because the whole point of an invite is that
 * it reaches somebody who has no account yet.
 *
 * The door does not create an account. It asks for a sign-in **carrying the
 * invite**, and the account is made when the code from that e-mail is typed or
 * its link opened — so nobody can conjure accounts for addresses they cannot
 * read, and a code opened twice still makes one account.
 *
 * An unknown code answers 404. A code is a secret, and telling a stranger
 * which of the ones they tried exist is the first half of guessing one.
 */

const asScopeType = asLiteral('league', 'season', 'team')

const asNewInvite = asObject({
  scopeType: asScopeType,
  scopeId: asString,
  /** An administrator's own wording, like `demo2026`. Generated when absent. */
  code: asOptional(asString),
  label: asOptional(asString),
  maxUses: asOptional(asNumberString),
  /** ISO 8601. Absent for an invite that does not run out, which is usual. */
  expiresAt: asOptional(asString)
})

const asJoinRequest = asObject({
  email: asString,
  /** What the account will be called, when the invite is making one. */
  displayName: asOptional(asString),
  origin: asOptional(asSignInOrigin, 'web'),
  next: asOptional(asString),
  /** The link host of the app asking, as on an ordinary sign-in. */
  appOrigin: asOptional(asString)
})

/**
 * What asking for a code through an invite is allowed to cost.
 *
 * Stricter than an ordinary sign-in in one way that matters: this endpoint
 * will mail an address that has no account, so it is also the one that could
 * be used to send mail to strangers. Bounded by the address, by the caller,
 * and by the invite — a shared code cannot be turned into a mailing list.
 */
const LIMITS = {
  byAddress: { scope: 'invite.address', limit: 5, windowSec: 900 },
  byClient: { scope: 'invite.ip', limit: 20, windowSec: 3600 },
  byCode: { scope: 'invite.code', limit: 30, windowSec: 3600 }
}

export interface InviteRouteOptions {
  /** Delivers the sign-in code. The same one the auth routes use. */
  sendCode: (email: string, code: string, link?: string) => Promise<void>
  /** Where this site lives, for the address in the e-mail. */
  publicUrl?: string
  /** The link hosts of the apps this server signs in (`appLinks.apps`). */
  appOrigins?: readonly string[]
}

export function inviteRoutes(
  db: Kysely<Database>,
  options: InviteRouteOptions
): Router {
  const router = Router()

  /** Refuses anybody who does not administer the scope, without saying so. */
  const mustAdminister = async (
    userId: string,
    isAdmin: boolean,
    scopeType: InviteScopeType,
    scopeId: string
  ): Promise<void> => {
    const scopes = await adminScopes(db, userId, isAdmin)
    if (!mayInviteTo(scopes, scopeType, scopeId)) throw notFound()
    if ((await scopeName(db, scopeType, scopeId)) == null) throw notFound()
  }

  /**
   * The invites for one league, season or team.
   *
   * `canInvite` rides along so the panel knows whether to draw itself for
   * somebody who can see the page but not administer it.
   */
  router.get(
    '/invites',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.query.scopeType)
      const scopeId =
        typeof req.query.scopeId === 'string' ? req.query.scopeId : ''
      if (scopeId === '') throw badRequest('scopeId is required')

      const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
      if (!mayInviteTo(scopes, scopeType, scopeId)) {
        // Not 404: the caller is asking about a team or season they are
        // already looking at, and "you may not make invites here" is the
        // honest answer to draw a screen from.
        res.json({ canInvite: false, invites: [] })
        return
      }

      const invites = await listInvites(db, scopeType, scopeId)
      res.json({
        canInvite: true,
        invites: invites.map(invite => shown(invite, options.publicUrl))
      })
    })
  )

  router.post(
    '/invites',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const body = cleanBody(asNewInvite, req.body)
      await mustAdminister(
        actor.userId,
        actor.isAdmin,
        body.scopeType,
        body.scopeId
      )

      const invite = await createInvite(db, {
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        createdBy: actor.userId,
        code: body.code,
        label: body.label,
        maxUses: body.maxUses,
        expiresAt: body.expiresAt == null ? undefined : whenOf(body.expiresAt)
      })
      setAudit(res.locals, {
        entityType: 'invite',
        entityId: invite.id,
        after: {
          code: invite.code,
          scopeType: invite.scopeType,
          scopeId: invite.scopeId
        }
      })
      res.status(201).json(shown(invite, options.publicUrl))
    })
  )

  router.delete(
    '/invites/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const invite = await findInviteById(db, pathParam(req.params.id))
      if (invite == null) throw notFound()
      await mustAdminister(
        actor.userId,
        actor.isAdmin,
        invite.scopeType,
        invite.scopeId
      )

      await revokeInvite(db, invite.id, actor)
      setAudit(res.locals, {
        entityType: 'invite',
        entityId: invite.id,
        before: { revokedAt: null },
        after: { revokedAt: new Date().toISOString() }
      })
      res.status(204).end()
    })
  )

  /**
   * What is behind a code, for the screen the link opens.
   *
   * Answered signed in or not: somebody with no account needs to be told what
   * they are being invited to before they hand over an address.
   */
  router.get(
    '/join/:code',
    withAsync(async (req, res) => {
      const invite = await findInviteByCode(db, pathParam(req.params.code))
      if (invite == null) throw notFound()
      const name = await scopeName(db, invite.scopeType, invite.scopeId)
      if (name == null) throw notFound()

      const actor = req.actor
      let alreadyIn =
        actor != null && (await alreadyInScope(db, invite, actor.userId))
      let problem = inviteProblem(invite)
      let requestedRoles: string[] = []
      if (invite.requestId != null) {
        const request = await db
          .selectFrom('group_requests')
          .select(['terms', 'status'])
          .where('id', '=', invite.requestId)
          .executeTakeFirstOrThrow()
        const terms = request.terms as RequestTerms
        if (terms.kind === 'person') {
          const own = terms.recipientUserId === actor?.userId
          alreadyIn = alreadyIn && own && request.status === 'accepted'
          if (alreadyIn) problem = null
          requestedRoles = [
            ...(terms.admin ? ['administrator'] : []),
            ...terms.flags
          ]
        }
      }
      res.json({
        code: invite.code,
        valid: problem == null,
        problem,
        scope: { kind: invite.scopeType, id: invite.scopeId, name },
        signedIn: actor != null,
        alreadyIn,
        requestedRoles
      })
    })
  )

  /** Redeem it for the person already signed in. */
  router.post(
    '/join/:code/redeem',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const invite = await findInviteByCode(db, pathParam(req.params.code))
      if (invite == null) throw notFound()
      const name = await scopeName(db, invite.scopeType, invite.scopeId)
      if (name == null) throw notFound()
      if (invite.requestId != null) await currentActor(db, actor)
      const result = await redeemInvite(db, invite, actor.userId)
      setAudit(res.locals, {
        entityType: 'invite',
        entityId: invite.id,
        after: {
          userId: actor.userId,
          scopeType: invite.scopeType,
          scopeId: invite.scopeId,
          granted: result.granted
        }
      })
      res.json({
        granted: result.granted,
        scope: { kind: invite.scopeType, id: invite.scopeId, name }
      })
    })
  )

  /**
   * Asks for a sign-in code that carries this invite.
   *
   * The reply is the same whether or not the address has an account — the
   * account, if there is none, is made when the code comes back — so this
   * cannot be used to find out who is already here.
   */
  router.post(
    '/join/:code/email-code',
    withAsync(async (req, res) => {
      const code = pathParam(req.params.code)
      const body = cleanBody(asJoinRequest, req.body)
      const appOrigin = allowedAppOrigin(
        body.appOrigin,
        options.appOrigins ?? []
      )
      const email = body.email.trim().toLowerCase()
      if (!email.includes('@')) throw badRequest('That is not an address')

      const rules: LimitRule[] = [
        { ...LIMITS.byAddress, key: email },
        { ...LIMITS.byCode, key: code.toLowerCase() }
      ]
      const ip = clientIp(req)
      if (ip != null) rules.push({ ...LIMITS.byClient, key: ip })
      await checkLimits(db, rules)
      await recordAttempts(db, rules)

      const invite = await findInviteByCode(db, code)
      if (invite == null) throw notFound()
      if (inviteProblem(invite) != null) {
        throw badRequest('That invite is no longer good')
      }

      const request = await createEmailCode(db, email, 'login', {
        origin: body.origin,
        // Back to the invite, so the screen can say what they have joined.
        next: body.next ?? `/i/${invite.code}`,
        inviteId: invite.id,
        displayName: body.displayName,
        appOrigin
      })
      await options.sendCode(
        email,
        request.code,
        signInLink(options.publicUrl, request.token, appOrigin)
      )
      res.status(202).json({
        sent: true,
        requestId: request.id,
        clientSecret: request.clientSecret
      })
    })
  )

  return router
}

/** The invite as the app is given it, with the link already built. */
function shown(
  invite: Invite,
  publicUrl: string | undefined
): Record<string, unknown> {
  return {
    id: invite.id,
    code: invite.code,
    url: inviteUrl(publicUrl, invite.code),
    scopeType: invite.scopeType,
    scopeId: invite.scopeId,
    label: invite.label,
    maxUses: invite.maxUses,
    uses: invite.uses,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    problem: inviteProblem(invite)
  }
}

/**
 * The address on the invite.
 *
 * `/i/<code>`, which is the address PeerTube's invites already use. Those
 * links are in mailboxes and group chats and printed on team sheets; when
 * TeamStation takes the domain over they have to keep working, and the way to
 * be sure of that is to serve the same path rather than to redirect from it.
 */
export function inviteUrl(publicUrl: string | undefined, code: string): string {
  const base = (publicUrl ?? '').replace(/\/$/, '')
  return `${base}/i/${code}`
}

/** A count that may arrive as a number or as the string a form sends. */
function asNumberString(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError('Expected a whole number of uses, at least one')
  }
  return value
}

function whenOf(raw: string): Date {
  const when = new Date(raw)
  if (Number.isNaN(when.getTime())) throw badRequest('That is not a date')
  return when
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function cleanBody<T>(cleaner: (raw: unknown) => T, raw: unknown): T {
  try {
    return cleaner(raw)
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'Malformed request body'
    )
  }
}
