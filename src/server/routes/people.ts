import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import {
  badRequest,
  conflict,
  notFound,
  unauthorized
} from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { asRole, type Role, ROLE_FLAGS } from '../../common/roles'
import { asUserId } from '../../common/userId'
import { seesPeopleOf, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  authorizePersonChange,
  refuseRoleWhileHeld
} from '../groups/adminGuard'
import { type Clock, realClock } from '../groups/requests'
import {
  canAdminister,
  canManagePeople,
  currentActor,
  requirePeopleManager
} from '../groups/rights'
import {
  type AddedMail,
  canHoldRoles,
  GRANTABLE,
  type Grantable,
  grantAt,
  heldAt,
  mailGrant,
  notifyGrant
} from '../invites/grants'
import { removeFromScope, setScopeRoles } from '../invites/people'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { noteScopeChange } from '../socket/syncRevision'
import { personProfile } from '../teams/personProfile'
import { teamHeadCoach } from '../teams/teamHeadCoach'
import { levelPeople, onPeopleList } from '../teams/teamRoster'
import { readerOf } from '../users/readerNames'

/**
 * People at a team, a season or a league, with nobody's acceptance needed.
 *
 * - A season's and a league's people list, in the roster's six sections.
 * - The person profile, opened from any of the three lists.
 * - One role, or the membership, given or taken away at a level: by its
 *   administrators, coaches and assistants, except Admin, which only its
 *   administrators change. Given at once; the person is told in their inbox,
 *   and mailed when they were not in the level before.
 * - Leaving a level, and stepping down from one role, by the person
 *   themselves.
 */

export interface PeopleRouteOptions extends AddedMail {
  clock?: Clock
}

const asKind = asLiteral('league', 'season', 'team')
const asGrantable = asLiteral(...GRANTABLE)

export function peopleRoutes(
  db: Kysely<Database>,
  media: Pick<MediaContext, 'space'>,
  options: PeopleRouteOptions = {}
): Router {
  const router = Router()
  const clock = options.clock ?? realClock

  const actorOf = async (actor: Actor | undefined): Promise<Actor> => {
    if (actor == null) throw unauthorized()
    return await currentActor(db, actor)
  }

  for (const kind of ['season', 'league'] as const)
    router.get(
      `/${kind}s/:id/people`,
      requireActor,
      withAsync(async (req, res) => {
        const actor = await actorOf(req.actor)
        const ref = { kind, id: pathParam(req.params.id) }
        if (!(await seesPeopleOf(db, actor, ref))) throw notFound()
        const people = await levelPeople(
          db,
          media.space,
          ref,
          actor,
          readerOf(req.actor),
          await visibleScopes(db, actor.userId, actor.isAdmin)
        )
        if (people == null) throw notFound()
        const manages = await canManagePeople(db, actor, ref)
        res.json({
          people,
          manages,
          admin: manages && (await canAdminister(db, actor, ref))
        })
      })
    )

  for (const kind of ['team', 'season', 'league'] as const)
    router.get(
      `/${kind}s/:id/people/:userId`,
      requireActor,
      withAsync(async (req, res) => {
        const actor = await actorOf(req.actor)
        res.json(
          await personProfile(
            db,
            media.space,
            actor,
            { kind, id: pathParam(req.params.id) },
            userIdParam(req.params.userId)
          )
        )
      })
    )

  /**
   * Gives one role at this level, or its membership, at once. A role brings
   * the membership with it, as it always has.
   */
  router.put(
    '/manage/:scopeType/:scopeId/people/:userId/roles/:role',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await actorOf(req.actor)
      const ref = groupOf(req.params.scopeType, req.params.scopeId)
      const userId = userIdParam(req.params.userId)
      const designation = req.params.role === 'headCoach' && ref.kind === 'team'
      const role = designation ? 'coach' : grantableParam(req.params.role)
      const added = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        await requirePeopleManager(trx, actor, ref, role === 'admin')
        if (!(await onPeopleList(trx, ref, userId, actor))) throw notFound()
        await authorizePersonChange(
          trx,
          ref,
          userId,
          actor.userId,
          role === 'admin',
          role === 'admin' ? 'admin' : 'manager'
        )
        if (role !== 'member' && !(await canHoldRoles(trx, userId)))
          throw conflict(
            'Only somebody who can sign in can hold a role. Add an email address to their account first.'
          )
        if (role !== 'member')
          await refuseRoleWhileHeld(trx, ref, userId, actor.userId)
        const added = await grantAt(
          trx,
          ref,
          userId,
          role === 'member' ? ['member'] : [role, 'member'],
          actor.userId
        )
        if (designation) {
          const incumbent = await teamHeadCoach(trx, ref.id)
          if (
            incumbent?.userId !== userId &&
            (req.body?.expectedHeadCoach ?? null) !==
              (incumbent?.userId ?? null)
          )
            throw conflict(
              'The team’s Manager/Head Coach changed. Refresh and confirm the replacement.'
            )
          if (incumbent != null && incumbent.grantUserId !== userId) {
            await authorizePersonChange(
              trx,
              ref,
              incumbent.userId,
              actor.userId,
              false,
              'manager'
            )
            await trx
              .updateTable('scope_roles')
              .set({ is_head_coach: false })
              .where('scope_id', '=', ref.id)
              .where('is_head_coach', '=', true)
              .execute()
            noteScopeChange(trx, { userId: incumbent.userId, teamId: ref.id })
          }
          noteScopeChange(trx, { userId, teamId: ref.id })
          await trx
            .updateTable('scope_roles')
            .set({ is_head_coach: true })
            .where('scope_type', '=', 'team')
            .where('scope_id', '=', ref.id)
            .where('user_id', '=', userId)
            .where('role', '=', 'coach')
            .execute()
        }
        const notificationId = await notifyGrant(trx, {
          ref,
          userId,
          added,
          actorId: actor.userId,
          at: clock.now()
        })
        // Somebody new to the level hears of it where an invitation would
        // have reached them.
        if (notificationId != null && added.includes('member'))
          await mailGrant(
            trx,
            { ref, userId, added, actorId: actor.userId, notificationId },
            options
          )
        return added
      })
      const after = await heldAt(db, ref, userId)
      setAudit(res.locals, {
        entityType: 'scopeRoles',
        entityId: userId,
        after: { scopeType: ref.kind, scopeId: ref.id, added, ...after }
      })
      res.json({ userId, ...after })
    })
  )

  /**
   * Takes one role at this level away, or with `member` takes the person out
   * of the level, membership and every role there. Taking away Admin, or
   * taking an administrator out, is for an administrator. A player is not
   * taken off a team this way (409): their membership is their place on its
   * roster, which is the roster's to change.
   */
  router.delete(
    '/manage/:scopeType/:scopeId/people/:userId/roles/:role',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await actorOf(req.actor)
      const ref = groupOf(req.params.scopeType, req.params.scopeId)
      const userId = userIdParam(req.params.userId)
      const designation = req.params.role === 'headCoach' && ref.kind === 'team'
      const role = designation ? 'coach' : grantableParam(req.params.role)
      const { before, after } = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const before = await heldAt(trx, ref, userId)
        const touchesAdmin =
          role === 'admin' ||
          (role === 'member' && before.roles.includes('admin'))
        await requirePeopleManager(trx, actor, ref, touchesAdmin)
        if (!(await exists(trx, userId))) throw notFound()
        const authority = touchesAdmin ? 'admin' : 'manager'
        if (designation) {
          if (!(await onPeopleList(trx, ref, userId, actor))) throw notFound()
          await authorizePersonChange(
            trx,
            ref,
            userId,
            actor.userId,
            false,
            'manager'
          )
          await trx
            .updateTable('scope_roles')
            .set({ is_head_coach: false })
            .where('scope_type', '=', 'team')
            .where('scope_id', '=', ref.id)
            .where('user_id', 'in', (await onePerson(trx, userId)).userIds)
            .where('is_head_coach', '=', true)
            .execute()
          noteScopeChange(trx, { userId, teamId: ref.id })
        } else if (role === 'member')
          await removeFromScope(
            trx,
            ref.kind,
            ref.id,
            userId,
            actor.userId,
            authority,
            true
          )
        else if (before.roles.includes(role))
          await setScopeRoles(
            trx,
            ref.kind,
            ref.id,
            userId,
            without(before.roles, role),
            actor.userId,
            authority
          )
        const after = await heldAt(trx, ref, userId)
        return { before, after }
      })
      setAudit(res.locals, {
        entityType: 'scopeRoles',
        entityId: userId,
        before: { scopeType: ref.kind, scopeId: ref.id, ...before },
        after: { scopeType: ref.kind, scopeId: ref.id, ...after }
      })
      res.json({ userId, ...after })
    })
  )

  /**
   * Leaves a team, season or league: its membership and every role there.
   * A level above that makes them a member or gives them a role is left as
   * it is; they leave it there. The last direct administrator stays (409).
   */
  router.delete(
    '/me/groups/:kind/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await actorOf(req.actor)
      const ref = groupOf(req.params.kind, req.params.id)
      if (!(await groupExists(db, ref))) throw notFound()
      const gone = await removeFromScope(
        db,
        ref.kind,
        ref.id,
        actor.userId,
        actor.userId,
        'self'
      )
      setAudit(res.locals, {
        entityType: 'membership',
        entityId: actor.userId,
        before: { scopeType: ref.kind, scopeId: ref.id },
        after: { left: gone.removed }
      })
      res.json(gone)
    })
  )

  /** Steps down from one role of their own at a level, keeping the rest. */
  router.delete(
    '/me/groups/:kind/:id/roles/:role',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await actorOf(req.actor)
      const ref = groupOf(req.params.kind, req.params.id)
      let role: Role
      try {
        role = asRole(req.params.role)
      } catch {
        throw badRequest('Choose one of your roles')
      }
      if (!(await groupExists(db, ref))) throw notFound()
      const { before, after } = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const before = await heldAt(trx, ref, actor.userId)
        if (before.roles.includes(role))
          await setScopeRoles(
            trx,
            ref.kind,
            ref.id,
            actor.userId,
            without(before.roles, role),
            actor.userId,
            'self'
          )
        const after = await heldAt(trx, ref, actor.userId)
        return { before, after }
      })
      setAudit(res.locals, {
        entityType: 'scopeRoles',
        entityId: actor.userId,
        before: { scopeType: ref.kind, scopeId: ref.id, ...before },
        after: { scopeType: ref.kind, scopeId: ref.id, ...after }
      })
      res.json({ userId: actor.userId, ...after })
    })
  )

  return router
}

/** Somebody's roles at a level without one of them, as `setScopeRoles` takes them. */
function without(
  roles: readonly Role[],
  gone: Role
): { admin: boolean; flags: Array<(typeof ROLE_FLAGS)[number]> } {
  return {
    admin: roles.includes('admin') && gone !== 'admin',
    flags: ROLE_FLAGS.filter(flag => roles.includes(flag) && flag !== gone)
  }
}

async function exists(db: Kysely<Database>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  return row != null
}

async function groupExists(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<boolean> {
  const table =
    ref.kind === 'league'
      ? 'leagues'
      : ref.kind === 'season'
        ? 'seasons'
        : 'teams'
  const row = await db
    .selectFrom(table)
    .select('id')
    .where('id', '=', ref.id)
    .executeTakeFirst()
  return row != null
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

function groupOf(
  kind: string | string[] | undefined,
  id: string | string[] | undefined
): GroupRef {
  try {
    return { kind: asKind(pathParam(kind)), id: pathParam(id) }
  } catch {
    throw notFound()
  }
}

function grantableParam(value: string | string[] | undefined): Grantable {
  try {
    return asGrantable(pathParam(value))
  } catch {
    throw badRequest(
      'Choose admin, coach, assistant, scorekeeper, songkeeper, videographer or member'
    )
  }
}
