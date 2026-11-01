import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { asFenceDistanceBody } from '../../common/fenceDistance'
import { makeId } from '../../common/ids'
import { asRoleFlags, type RoleFlag } from '../../common/roles'
import { asUserId } from '../../common/userId'
import { adminScopes } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { currentActor, requirePeopleManager } from '../groups/rights'
import { type AddedMail, heldAt, notifyGrant } from '../invites/grants'
import {
  type Invite,
  inviteProblem,
  type InviteScopeType,
  listInvites,
  mayInviteTo,
  scopeName
} from '../invites/invites'
import {
  managementPeopleTree,
  pendingInvitations,
  peopleInScope,
  removeFromScope,
  rolesAt,
  setScopeRoles
} from '../invites/people'
import { addPersonByAddress } from '../invites/personRequests'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { onPeopleList } from '../teams/teamRoster'
import { inviteUrl } from './invites'

/**
 * The page behind the gear: who can see this, and who may change it.
 *
 * One screen for a league, a season or a team, because an administrator's
 * question is the same at all three heights — who are these people, how did
 * they get in, and how do I add or remove one. The answer is never a single
 * list: access arrives at three levels and one person often holds two of
 * them, so the table shows every grant rather than the strongest.
 *
 * What an administrator may change is exactly what they administer. A team's
 * manager can drop somebody from the team; the row still shows the season
 * membership they cannot touch, rather than a button that appears to do
 * nothing.
 */

const asScopeType = asLiteral('league', 'season', 'team')

const asPersonByEmail = asObject({
  email: asString,
  /** Shown in the invitation when there is no account to add yet. */
  displayName: asOptional(asString),
  admin: asOptional(asBoolean, false),
  flags: asOptional(asRoleFlags, []),
  idempotencyKey: asOptional(asString)
})

const asRoleChange = asObject({
  role: asLiteral('admin', 'member')
})

const asRolesChange = asObject({
  admin: asBoolean,
  flags: asRoleFlags
})

export interface ManageRouteOptions {
  /** Delivers an invitation. Swapped out in tests. */
  sendInvite: (
    email: string,
    invitation: { scopeName: string; invitedBy: string; link: string }
  ) => Promise<void>
  /** Tells somebody with an account they were added. */
  sendAdded?: AddedMail['sendAdded']
  publicUrl?: string
  clock?: Clock
}

export function manageRoutes(
  db: Kysely<Database>,
  options: ManageRouteOptions
): Router {
  const router = Router()
  router.use(
    '/manage',
    requireActor,
    withAsync(async (req, res, next) => {
      if (req.actor == null) throw unauthorized()
      req.actor = await currentActor(db, req.actor)
      next()
    })
  )
  /** The scope, refused as 404 to anybody who does not administer it. */
  const mustAdminister = async (
    userId: string,
    isAdmin: boolean,
    scopeType: InviteScopeType,
    scopeId: string
  ): Promise<string> => {
    const scopes = await adminScopes(db, userId, isAdmin)
    if (!mayInviteTo(scopes, scopeType, scopeId)) throw notFound()
    const name = await scopeName(db, scopeType, scopeId)
    if (name == null) throw notFound()
    return name
  }

  router.get(
    '/manage/:scopeType/:scopeId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      const name = await mustAdminister(
        actor.userId,
        actor.isAdmin,
        scopeType,
        scopeId
      )

      const tree = await managementPeopleTree(db, scopeType, scopeId)
      if (tree == null) throw notFound()
      const [people, pending, invites] = await Promise.all([
        peopleInScope(db, tree, actor),
        pendingInvitations(db, scopeType, scopeId, options.clock?.now()),
        listInvites(db, scopeType, scopeId)
      ])

      // A league says whether it is a SafeSport Local Affiliated
      // Organization, for the switch its page draws.
      const league =
        scopeType === 'league'
          ? await db
              .selectFrom('leagues')
              .select(['safesport_lao'])
              .where('id', '=', scopeId)
              .executeTakeFirst()
          : undefined

      res.json({
        scope: {
          kind: scopeType,
          id: scopeId,
          name,
          ...(league == null ? {} : { safesportLao: league.safesport_lao })
        },
        // The columns the table draws, named, so a tick can say which season
        // or league it stands for rather than only that there is one.
        tree,
        people,
        pending,
        invites: invites
          .filter(invite => invite.forEmail == null)
          .map(invite => shown(invite, options.publicUrl))
      })
    })
  )

  /**
   * Add one person by address.
   *
   * An address an account has verified adds that account at once, with the
   * roles asked for: told in its inbox and mailed there, with a way to
   * leave. An address nobody has verified gets a seven-day invitation, which
   * applies itself when somebody verifies the address, or is accepted from
   * its link.
   */
  router.post(
    '/manage/:scopeType/:scopeId/people',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      const name = await mustAdminister(
        actor.userId,
        actor.isAdmin,
        scopeType,
        scopeId
      )
      const body = cleanBody(asPersonByEmail, req.body)
      const result = await addPersonByAddress(
        db,
        actor,
        { kind: scopeType, id: scopeId },
        {
          email: body.email,
          admin: body.admin,
          flags: body.flags,
          idempotencyKey: body.idempotencyKey ?? makeId('invite')
        },
        options.clock ?? realClock,
        { publicUrl: options.publicUrl, sendAdded: options.sendAdded }
      )
      if ('applied' in result) {
        const { applied } = result
        setAudit(res.locals, {
          entityType: 'scopeRoles',
          entityId: applied.userId,
          after: { scopeType, scopeId, added: applied.added }
        })
        // `added` is false for somebody who held all of it already.
        res.status(201).json({
          added: applied.added.length > 0,
          person: {
            userId: applied.userId,
            displayName: applied.displayName,
            email: applied.email
          }
        })
        return
      }
      const { request, invite } = result.invited
      const email = invite.forEmail!
      const who = await db
        .selectFrom('users')
        .select(['display_name'])
        .where('id', '=', actor.userId)
        .executeTakeFirst()
      await options.sendInvite(email, {
        scopeName: name,
        invitedBy: who?.display_name ?? 'A TeamStation administrator',
        link: inviteUrl(options.publicUrl, invite.code)
      })
      setAudit(res.locals, {
        entityType: 'invite',
        entityId: invite.id,
        after: { scopeType, scopeId, forEmail: email }
      })
      res.status(201).json({
        added: false,
        invited: {
          inviteId: invite.id,
          requestId: request.id,
          email,
          code: invite.code,
          invitedAt: invite.createdAt.toISOString()
        }
      })
    })
  )

  /** Take away what this scope grants. Never what a level above it grants. */
  router.delete(
    '/manage/:scopeType/:scopeId/people/:userId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      const userId = userIdParam(req.params.userId)
      await mustAdminister(actor.userId, actor.isAdmin, scopeType, scopeId)

      const gone = await removeFromScope(
        db,
        scopeType,
        scopeId,
        userId,
        actor.userId
      )
      setAudit(res.locals, {
        entityType: 'membership',
        entityId: userId,
        before: { scopeType, scopeId },
        after: { removed: gone.removed }
      })
      res.json(gone)
    })
  )

  /**
   * Somebody who may be given a role here: an account that has not been
   * merged into another, on this level's people list (404 otherwise). The
   * roles take effect at once, with the level's membership, and they are
   * told so.
   */
  const mustBePerson = async (userId: string): Promise<void> => {
    const person = await db
      .selectFrom('users')
      .select(['id'])
      .where('id', '=', userId)
      .where('merged_into', 'is', null)
      .executeTakeFirst()
    if (person == null) throw notFound()
  }

  /**
   * What one person may do at this level: administer it, and any of the four
   * role flags, set together.
   *
   * Only ever at **this** level. A team's page sets team roles and nothing
   * else; the season's page is where a season's are set, and they reach its
   * teams from there. That is the same rule the rest of this file follows,
   * and it is what stops a team's manager quietly gaining the run of the
   * league by promoting themselves somewhere the page never showed.
   *
   * The body is the whole of what they hold here, so an empty list with
   * `admin: false` takes every role on this level away and leaves them a
   * member.
   *
   * Its administrators, coaches and assistants may call it; changing
   * whether somebody is an administrator is for an administrator (403 for
   * anybody else), and anybody who is none of those gets 404.
   */
  router.put(
    '/manage/:scopeType/:scopeId/people/:userId/roles',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      const userId = userIdParam(req.params.userId)
      const ref = { kind: scopeType, id: scopeId }
      const body = cleanBody(asRolesChange, req.body)
      const held = await heldAt(db, ref, userId)
      const touchesAdmin = body.admin !== held.roles.includes('admin')
      await requirePeopleManager(db, actor, ref, touchesAdmin)

      await mustBePerson(userId)
      if (!(await onPeopleList(db, ref, userId, actor))) throw notFound()

      const { before, roles } = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const before = await rolesAt(trx, scopeType, scopeId, userId)
        const was = await heldAt(trx, ref, userId)
        const roles = await setScopeRoles(
          trx,
          scopeType,
          scopeId,
          userId,
          body,
          actor.userId,
          touchesAdmin ? 'admin' : 'manager'
        )
        await notifyGrant(trx, {
          ref,
          userId,
          added: [
            ...(was.member ? [] : (['member'] as const)),
            ...roles.filter(role => !was.roles.includes(role))
          ],
          actorId: actor.userId,
          at: (options.clock ?? realClock).now()
        })
        return { before, roles }
      })

      setAudit(res.locals, {
        entityType: 'scopeRoles',
        entityId: userId,
        before: { scopeType, scopeId, roles: before },
        after: { scopeType, scopeId, roles }
      })
      res.json({ userId, roles })
    })
  )

  /**
   * The route from before the role flags: `admin` makes somebody this level's
   * administrator and `member` takes that away, leaving any flags they hold
   * as they were. Kept so a phone build from before the flags still works.
   */
  router.put(
    '/manage/:scopeType/:scopeId/people/:userId/role',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      const userId = userIdParam(req.params.userId)
      await mustAdminister(actor.userId, actor.isAdmin, scopeType, scopeId)
      const body = cleanBody(asRoleChange, req.body)

      await mustBePerson(userId)

      if (
        !(await onPeopleList(
          db,
          { kind: scopeType, id: scopeId },
          userId,
          actor
        ))
      )
        throw notFound()

      const { before, roles } = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const before = await rolesAt(trx, scopeType, scopeId, userId)
        const roles = await setScopeRoles(
          trx,
          scopeType,
          scopeId,
          userId,
          {
            admin: body.role === 'admin',
            flags: before.filter((role): role is RoleFlag => role !== 'admin')
          },
          actor.userId
        )
        return { before, roles }
      })

      setAudit(res.locals, {
        entityType: 'scopeRoles',
        entityId: userId,
        before: { scopeType, scopeId, roles: before },
        after: { scopeType, scopeId, roles }
      })
      res.json({ userId, role: body.role })
    })
  )

  /**
   * How far the fence stands on this league's or season's fields, or `null`
   * to leave it to the level above. A game of its own may still say
   * otherwise. A team plays on whatever field its games are at, so it has no
   * fence of its own.
   */
  router.put(
    '/manage/:scopeType/:scopeId/field',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopeType = asScopeType(req.params.scopeType)
      const scopeId = pathParam(req.params.scopeId)
      if (scopeType === 'team') {
        throw badRequest('A team has no field of its own: set its games')
      }
      await mustAdminister(actor.userId, actor.isAdmin, scopeType, scopeId)
      const body = cleanBody(asFenceDistanceBody, req.body)

      const table = scopeType === 'league' ? 'leagues' : 'seasons'
      const before = await db
        .selectFrom(table)
        .select(['fence_distance_ft'])
        .where('id', '=', scopeId)
        .executeTakeFirstOrThrow()
      await db
        .updateTable(table)
        .set({
          fence_distance_ft: body.fenceDistanceFt,
          updated_at: new Date()
        })
        .where('id', '=', scopeId)
        .execute()

      setAudit(res.locals, {
        entityType: scopeType,
        entityId: scopeId,
        before: { fenceDistanceFt: before.fence_distance_ft },
        after: { fenceDistanceFt: body.fenceDistanceFt }
      })
      res.json({ scopeType, scopeId, fenceDistanceFt: body.fenceDistanceFt })
    })
  )

  return router
}

/** The invite as the manage page is given it, with its link already built. */
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

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function userIdParam(value: string | string[] | undefined): string {
  try {
    return asUserId(pathParam(value))
  } catch {
    throw badRequest('Expected a canonical user id')
  }
}
