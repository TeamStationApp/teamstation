import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { ageBandOf, asAgeBody, birthMonthText } from '../../common/age'
import { asLiteral } from '../../common/asLiteral'
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asUserId } from '../../common/userId'
import {
  adminScopes,
  canCoach,
  heldByOpenAdd,
  mayEditName,
  roleScopes,
  visibleScopes
} from '../access'
import { findUserByEmail } from '../auth/emails'
import { recheckDmsOf } from '../chat/dms'
import type { Database } from '../db/database'
import { createInvite } from '../invites/invites'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  guardiansOf,
  isGuardianOf,
  linkGuardian,
  mayChangeAge,
  maySeeAge,
  unlinkGuardian
} from '../people/guardians'
import { inviteUrl } from './invites'
import type { ManageRouteOptions } from './manage'

/**
 * A player's guardians and adult family members, a person's age, and a
 * league's SafeSport setting.
 *
 * - `GET /teams/:teamId/players/:userId/guardians`: for the team's
 *   administrators and coaches, the player, and the player's guardians.
 * - `POST` the same: an administrator or coach links somebody by account or
 *   by address. An address with no account is sent an invitation that only
 *   that address can redeem.
 * - `DELETE …/:guardianId`: an administrator or coach, or the guardian
 *   themselves.
 * - `PUT /people/:userId/age`: a year and a month (never a day), 18 or
 *   older, or cleared; by a guardian or a site administrator.
 * - `PUT /manage/league/:leagueId/safesport`: the league's own
 *   administrators say whether it is a SafeSport Local Affiliated
 *   Organization.
 *
 * Everybody else is answered 404, as every private read is.
 */

const asRelativeKind = asLiteral('guardian', 'family')

const asNewRelative = asObject({
  userId: asOptional(asUserId),
  email: asOptional(asString),
  kind: asOptional(asRelativeKind, 'guardian')
})

const asSafesportBody = asObject({ lao: asBoolean })

export function guardianRoutes(
  db: Kysely<Database>,
  options: ManageRouteOptions
): Router {
  const router = Router()

  /** The player, when they play on the team; 404 otherwise. */
  const mustPlayOn = async (teamId: string, userId: string): Promise<void> => {
    const place = await db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(['memberships.id'])
      .where('memberships.team_id', '=', teamId)
      .where('memberships.user_id', '=', userId)
      .where('memberships.is_player', '=', true)
      .where('users.merged_into', 'is', null)
      .executeTakeFirst()
    if (place == null) throw notFound()
  }

  /**
   * Whether a team reaches this player only through an add their side may
   * still reject. Their guardians are that side: who they are, and the links
   * themselves, are not such a team's to read or change.
   */
  const heldFrom = async (
    actor: { userId: string; isAdmin: boolean },
    teamId: string,
    userId: string
  ): Promise<boolean> =>
    (await heldByOpenAdd(db, teamId, [userId])) &&
    !(await mayEditName(db, actor.userId, userId, actor))

  router.get(
    '/teams/:teamId/players/:userId/guardians',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const userId = userIdParam(req.params.userId)
      await mustPlayOn(teamId, userId)

      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      const allowed =
        (canCoach(scopes, teamId) &&
          !(await heldFrom(actor, teamId, userId))) ||
        actor.userId === userId ||
        (await isGuardianOf(db, actor.userId, userId))
      if (!allowed) throw notFound()

      res.json(await guardiansOf(db, userId))
    })
  )

  router.post(
    '/teams/:teamId/players/:userId/guardians',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const userId = userIdParam(req.params.userId)
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      if (!canCoach(scopes, teamId)) throw notFound()
      await mustPlayOn(teamId, userId)
      if (await heldFrom(actor, teamId, userId)) throw notFound()

      const body = cleanBody(asNewRelative, req.body)
      if ((body.userId == null) === (body.email == null)) {
        throw badRequest('Send a userId or an email, not both')
      }

      let relativeId = body.userId
      if (relativeId != null) {
        // Somebody the caller can already see on a team of theirs, so the
        // ids of strangers cannot be tried one after another.
        if (!actor.isAdmin) {
          const visible = await visibleScopes(db, actor.userId, false)
          const theirs = await db
            .selectFrom('memberships')
            .select(['team_id'])
            .where('user_id', '=', relativeId)
            .execute()
          if (!theirs.some(row => visible.teamIds.has(row.team_id))) {
            throw notFound()
          }
        }
      } else {
        const email = (body.email ?? '').trim().toLowerCase()
        if (!email.includes('@')) throw badRequest('That is not an address')
        const held = await findUserByEmail(db, email)
        relativeId = held?.id
        if (relativeId == null) {
          const invite = await createInvite(db, {
            scopeType: 'team',
            scopeId: teamId,
            createdBy: actor.userId,
            forEmail: email,
            label: email,
            maxUses: 1,
            guardianOf: { userId, kind: body.kind }
          })
          const names = await db
            .selectFrom('teams')
            .select(['name'])
            .where('id', '=', teamId)
            .executeTakeFirst()
          const who = await db
            .selectFrom('users')
            .select(['display_name'])
            .where('id', '=', actor.userId)
            .executeTakeFirst()
          await options.sendInvite(email, {
            scopeName: names?.name ?? 'TeamStation',
            invitedBy: who?.display_name ?? 'A TeamStation administrator',
            link: inviteUrl(options.publicUrl, invite.code)
          })
          setAudit(res.locals, {
            entityType: 'invite',
            entityId: invite.id,
            after: {
              teamId,
              forEmail: email,
              guardianOf: userId,
              kind: body.kind
            }
          })
          res.status(201).json({
            guardians: await guardiansOf(db, userId),
            invited: {
              inviteId: invite.id,
              email,
              code: invite.code,
              invitedAt: invite.createdAt.toISOString()
            }
          })
          return
        }
      }

      const linkedId = relativeId
      const linked = await db
        .transaction()
        .execute(
          async trx =>
            await linkGuardian(
              trx,
              userId,
              linkedId,
              teamId,
              actor.userId,
              body.kind
            )
        )
      setAudit(res.locals, {
        entityType: 'userLink',
        entityId: linked.linkId,
        after: { teamId, playerId: userId, userId: linkedId, kind: body.kind }
      })
      res.status(201).json({ guardians: await guardiansOf(db, userId) })
    })
  )

  router.delete(
    '/teams/:teamId/players/:userId/guardians/:guardianId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const userId = userIdParam(req.params.userId)
      const guardianId = userIdParam(req.params.guardianId)
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      if (!canCoach(scopes, teamId) && actor.userId !== guardianId) {
        throw notFound()
      }
      await mustPlayOn(teamId, userId)
      if (
        actor.userId !== guardianId &&
        (await heldFrom(actor, teamId, userId))
      )
        throw notFound()

      const removed = await db
        .transaction()
        .execute(async trx => await unlinkGuardian(trx, userId, guardianId))
      setAudit(res.locals, {
        entityType: 'userLink',
        entityId: guardianId,
        before: { teamId, playerId: userId, userId: guardianId },
        after: { removed }
      })
      res.json({ removed })
    })
  )

  /**
   * A person's age, changed by a guardian or a site administrator:
   * `{ year, month }`, `{ adult: true }`, or `{ year: null, month: null }` to
   * clear it (`mayChangeAge` says who may make which change). Anybody else
   * is answered 404.
   */
  router.put(
    '/people/:userId/age',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = userIdParam(req.params.userId)
      const now = new Date()
      const user = await db
        .selectFrom('users')
        .select(['birth_year', 'birth_month', 'is_adult'])
        .where('id', '=', userId)
        .where('merged_into', 'is', null)
        .executeTakeFirst()
      if (user == null) throw notFound()
      if (!(await maySeeAge(db, actor, userId))) throw notFound()

      const body = cleanBody(raw => asAgeBody(raw, now), req.body)
      const before = {
        birthYear: user.birth_year,
        birthMonth: user.birth_month,
        isAdult: user.is_adult
      }
      // Clearing forgets both the month and the flag; 18 or older without a
      // month replaces a month; a month leaves the flag, which it wins over.
      const after =
        body == null
          ? { birthYear: null, birthMonth: null, isAdult: false }
          : body.kind === 'adult'
            ? { birthYear: null, birthMonth: null, isAdult: true }
            : {
                birthYear: body.year,
                birthMonth: body.month,
                isAdult: user.is_adult
              }
      const current = ageBandOf(before, now)
      const next = body == null ? null : ageBandOf(after, now)
      const change = mayChangeAge(actor, current, next)
      if (change === 'adultToMinor') {
        throw forbidden('Only a site administrator can make an adult a minor', {
          reason: 'adultToMinor'
        })
      }
      if (change === 'clearNotAllowed') {
        throw forbidden('Only a site administrator can clear an age', {
          reason: 'clearNotAllowed'
        })
      }
      if (change === 'notYet') {
        throw conflict('This person has not given their age yet', {
          reason: 'ageNotSet'
        })
      }

      // A first age (only an administrator gives one for somebody else) is
      // stamped as the person's own answer is, and closes and hides what it
      // breaks before anybody reads with it.
      const first = body != null && current === 'unknown'
      await db.transaction().execute(async tx => {
        await tx
          .updateTable('users')
          .set({
            birth_year: after.birthYear,
            birth_month: after.birthMonth,
            is_adult: after.isAdult,
            // A cleared age is no answer at all: the person gives it again.
            ...(body == null
              ? { age_source: null, age_set_at: null }
              : { age_source: actor.isAdmin ? 'admin' : 'guardian' }),
            ...(first ? { age_set_at: now } : {}),
            updated_at: now
          })
          .where('id', '=', userId)
          .execute()
        if (first) await recheckDmsOf(tx, userId, now)
      })

      const birthMonth =
        after.birthYear == null || after.birthMonth == null
          ? null
          : birthMonthText(after.birthYear, after.birthMonth)
      const band = ageBandOf(after, now)
      setAudit(res.locals, {
        entityType: 'age',
        entityId: userId,
        before: { band: current },
        after: { band }
      })
      res.json({ userId, band, birthMonth, isAdult: after.isAdult })
    })
  )

  /** Whether a league is a SafeSport Local Affiliated Organization. */
  router.put(
    '/manage/league/:leagueId/safesport',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const leagueId = pathParam(req.params.leagueId)
      const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
      if (!scopes.isAdmin && !scopes.leagueIds.has(leagueId)) throw notFound()
      const league = await db
        .selectFrom('leagues')
        .select(['safesport_lao'])
        .where('id', '=', leagueId)
        .executeTakeFirst()
      if (league == null) throw notFound()

      const body = cleanBody(asSafesportBody, req.body)
      await db
        .updateTable('leagues')
        .set({ safesport_lao: body.lao, updated_at: new Date() })
        .where('id', '=', leagueId)
        .execute()
      setAudit(res.locals, {
        entityType: 'league',
        entityId: leagueId,
        before: { safesportLao: league.safesport_lao },
        after: { safesportLao: body.lao }
      })
      res.json({ leagueId, safesportLao: body.lao })
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function userIdParam(value: string | string[] | undefined): string {
  try {
    return asUserId(pathParam(value))
  } catch {
    throw notFound()
  }
}
