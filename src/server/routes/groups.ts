import { isDeepStrictEqual } from 'node:util'

import { asEither, asObject } from 'cleaners'
import { type Request, Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { asAccountEmail, asAccountName } from '../../common/accountSettings'
import {
  badRequest,
  conflict,
  forbidden,
  unauthorized,
  unavailable
} from '../../common/errors'
import {
  asCalendarDate,
  asCreateGroup,
  asGroupKind,
  asGroupRef,
  calendarDateText,
  type GroupRef,
  isRecord
} from '../../common/groupCreation'
import { asParentActions } from '../../common/groupLinks'
import { makeId } from '../../common/ids'
import { asLocality } from '../../common/locality'
import { shortName } from '../../common/names'
import type {
  GuardianTerms,
  RelationshipInvitation
} from '../../common/notifications'
import { asCatalogId, catalogPicture } from '../../common/pictureCatalog'
import type { PublicGroup } from '../../common/publicGroups'
import { asRoleFlags } from '../../common/roles'
import { asUserId } from '../../common/userIdNumber'
import { adminScopes, roleScopes, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import type { GuardianInvitation } from '../email/sendMail'
import { createGroup } from '../groups/createGroup'
import { setFollow } from '../groups/follows'
import { storeGroupPhoto } from '../groups/groupPhoto'
import { isGuardianRequest } from '../groups/guardianLimits'
import {
  type OwnershipChoice,
  ownershipPreflight
} from '../groups/ownershipPreflight'
import {
  discoverGroups,
  groupDetail,
  publicGroup
} from '../groups/publicSummary'
import { applyParents, previewParents } from '../groups/relationships'
import {
  type Clock,
  createRelationshipRequest,
  decideRelationshipRequest,
  oweGuardianMail,
  realClock,
  type SentRequest,
  withdrawRelationshipRequest
} from '../groups/requests'
import {
  adminRecipients,
  currentActor,
  requireGroupAdmin
} from '../groups/rights'
import type { AddedMail } from '../invites/grants'
import { setScopeRoles } from '../invites/people'
import {
  addPersonByAddress,
  ensurePersonLink,
  personTerms
} from '../invites/personRequests'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { followMerges } from '../teams/followMerges'
import { inviteUrl } from './invites'

function clean<T>(fn: (raw: unknown) => T, raw: unknown): T {
  try {
    return fn(raw)
  } catch (error) {
    if (error instanceof TypeError) throw badRequest(error.message)
    throw error
  }
}
function actorOf(req: Request): Actor {
  if (req.actor == null) throw unauthorized()
  return req.actor
}
async function invitation(
  db: Kysely<Database>,
  raw: unknown,
  userId?: number
): Promise<RelationshipInvitation> {
  if (
    !isRecord(raw) ||
    typeof raw.idempotencyKey !== 'string' ||
    raw.idempotencyKey.length < 8 ||
    raw.idempotencyKey.length > 120
  )
    throw badRequest('Sending needs a retry key')
  if (raw.kind === 'guardian')
    return {
      sender: raw.sender == null ? undefined : clean(asGroupRef, raw.sender),
      terms: await guardianTerms(db, raw.playerUserId, raw.guardian),
      idempotencyKey: raw.idempotencyKey
    }
  const sender = clean(asGroupRef, raw.sender)
  if (raw.kind === 'parent') {
    const actions = clean(asParentActions, raw.actions)
    let preview
    const held =
      userId == null
        ? null
        : await db
            .selectFrom('creation_idempotency')
            .select('response')
            .where('user_id', '=', userId)
            .where('key', '=', raw.idempotencyKey)
            .executeTakeFirst()
    const original =
      held == null
        ? null
        : await db
            .selectFrom('group_requests')
            .select('terms')
            .where('id', '=', (held.response as { id: string }).id)
            .executeTakeFirst()
    const terms = original?.terms as RelationshipInvitation['terms'] | undefined
    if (terms?.kind === 'parent') preview = { ...terms.preview, actions }
    else {
      preview = await previewParents(db, actions)
      if (
        raw.expected != null &&
        !isDeepStrictEqual(raw.expected, preview.expected)
      )
        throw conflict(
          'The parent relationships changed. Review the updated preview before sending.'
        )
    }
    return {
      sender,
      terms: { kind: 'parent', preview },
      confirmBoth: raw.confirmBoth === true,
      idempotencyKey: raw.idempotencyKey
    }
  }
  if (raw.kind === 'participation') {
    if (typeof raw.teamId !== 'string' || typeof raw.seasonId !== 'string')
      throw badRequest('Choose a season and team')
    const season = await db
      .selectFrom('seasons')
      .select(['starts_on', 'ends_on', 'timezone'])
      .where('id', '=', raw.seasonId)
      .executeTakeFirst()
    if (season == null) throw badRequest('Choose an existing season')
    return {
      sender,
      terms: {
        kind: 'participation',
        teamId: raw.teamId,
        seasonId: raw.seasonId,
        range: {
          startsOn: calendarDateText(season.starts_on),
          endsOn: calendarDateText(season.ends_on),
          timezone: season.timezone
        }
      },
      confirmBoth: raw.confirmBoth === true,
      idempotencyKey: raw.idempotencyKey
    }
  }
  if (raw.kind === 'person') {
    if (
      typeof raw.recipientEmail !== 'string' ||
      (raw.admin !== undefined && typeof raw.admin !== 'boolean')
    )
      throw badRequest('Choose a recipient email and roles')
    return {
      sender,
      terms: await personTerms(
        db,
        sender,
        raw.recipientEmail,
        raw.admin === true,
        clean(asRoleFlags, raw.flags ?? [])
      ),
      idempotencyKey: raw.idempotencyKey
    }
  }
  if (
    raw.kind === 'promotion' &&
    typeof raw.teamId === 'string' &&
    (typeof raw.recipientEmail === 'string' ||
      (typeof raw.recipientUserId === 'number' &&
        Number.isSafeInteger(raw.recipientUserId)))
  ) {
    if (raw.recipientEmail != null && raw.recipientUserId != null)
      throw badRequest('Choose one recipient')
    let recipientUserId = raw.recipientUserId as number
    if (raw.recipientEmail != null) {
      const recipient = await db
        .selectFrom('user_emails')
        .innerJoin('users', 'users.id', 'user_emails.user_id')
        .select('users.id')
        .where(
          sql<string>`lower(email)`,
          '=',
          clean(asAccountEmail, raw.recipientEmail)
        )
        .where('verified_at', 'is not', null)
        .where('users.login_enabled', '=', true)
        .where('users.disabled_at', 'is', null)
        .where('users.merged_into', 'is', null)
        .executeTakeFirst()
      if (recipient == null)
        throw badRequest(
          'Ask this person to sign in and verify their email before inviting them to administer the team'
        )
      recipientUserId = recipient.id
    }
    return {
      sender,
      terms: {
        kind: 'promotion',
        teamId: raw.teamId,
        recipientUserId
      },
      idempotencyKey: raw.idempotencyKey
    }
  }
  throw badRequest(
    'Choose parent, participation, promotion, person or guardian invitation'
  )
}

const asGuardianInput = asEither(
  asObject({ userId: asUserId }),
  asObject({ email: asAccountEmail })
)

/**
 * Who is asked to be a player's guardian. An address that a signing-in
 * account has verified names that account, and keeps the address the
 * invitation is mailed to; any other address waits for whoever verifies it.
 */
async function guardianTerms(
  db: Kysely<Database>,
  playerUserId: unknown,
  guardian: unknown
): Promise<GuardianTerms> {
  const player = clean(asUserId, playerUserId)
  const named = clean(asGuardianInput, guardian)
  if ('userId' in named)
    return { kind: 'guardian', playerUserId: player, guardian: named }
  const account = await db
    .selectFrom('user_emails')
    .innerJoin('users', 'users.id', 'user_emails.user_id')
    .select('users.id')
    .where(sql<string>`lower(email)`, '=', named.email)
    .where('verified_at', 'is not', null)
    .where('users.login_enabled', '=', true)
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .executeTakeFirst()
  return {
    kind: 'guardian',
    playerUserId: player,
    guardian:
      account == null ? named : { userId: account.id, email: named.email }
  }
}

/** Mount before the compatible private team/season collection routers. */
export function groupRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  clock: Clock = realClock,
  personMail?: {
    publicUrl?: string
    sendInvite: (
      email: string,
      invitation: { scopeName: string; invitedBy: string; link: string }
    ) => Promise<void>
    sendGuardianInvite?: (
      email: string,
      invitation: GuardianInvitation
    ) => Promise<void>
    sendAdded?: AddedMail['sendAdded']
  }
): Router {
  const router = Router()
  const deliverPerson = async (
    request: Awaited<ReturnType<typeof createRelationshipRequest>>
  ): Promise<void> => {
    const terms = request.terms as RelationshipInvitation['terms']
    if (terms.kind === 'guardian') {
      await deliverGuardian(request, terms)
      return
    }
    if (terms.kind !== 'person') return
    const invite = await ensurePersonLink(db, request)
    if (personMail == null) return
    if (
      terms.recipientUserId != null &&
      (await db
        .selectFrom('user_emails')
        .select('id')
        .where('user_id', '=', terms.recipientUserId)
        .where(sql<string>`lower(email)`, '=', terms.recipientEmail)
        .where('verified_at', 'is not', null)
        .executeTakeFirst()) == null
    )
      return
    const sender = await db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', request.sender_id)
      .executeTakeFirstOrThrow()
    const group = await publicGroup(db, terms.scope, media.space)
    await personMail.sendInvite(terms.recipientEmail, {
      scopeName: group.name,
      invitedBy: sender.display_name,
      link: inviteUrl(personMail.publicUrl, invite.code)
    })
  }
  /**
   * A guardian invitation addressed by email, a team's or a guardian's, is
   * mailed, linking to the notification, which is where it is accepted.
   * Requests, and invitations to an account by id, wait in the inbox alone.
   */
  const deliverGuardian = async (
    request: Awaited<ReturnType<typeof createRelationshipRequest>>,
    terms: GuardianTerms
  ): Promise<void> => {
    const email = terms.guardian.email
    if (
      personMail?.sendGuardianInvite == null ||
      email == null ||
      isGuardianRequest(request)
    )
      return
    const sender = await db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', request.sender_id)
      .executeTakeFirstOrThrow()
    const team =
      request.sender_scope_id == null
        ? undefined
        : await db
            .selectFrom('teams')
            .select('name')
            .where('id', '=', request.sender_scope_id)
            .executeTakeFirstOrThrow()
    const player = await db
      .selectFrom('users')
      .select([
        'id',
        'first_name as firstName',
        'last_name as lastName',
        'display_name as displayName'
      ])
      .where('id', '=', terms.playerUserId)
      .executeTakeFirstOrThrow()
    const base = (personMail.publicUrl ?? '').replace(/\/$/, '')
    await personMail.sendGuardianInvite(email, {
      playerName: shortName(player),
      ...(team == null ? {} : { teamName: team.name }),
      invitedBy: sender.display_name,
      link: `${base}/notifications/${encodeURIComponent(request.id)}`
    })
  }
  router.get(
    '/node/ownership-preflight',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      if (!actor.isAdmin) throw forbidden()
      res.json(await ownershipPreflight(db, { dryRun: true }))
    })
  )
  router.post(
    '/node/ownership-preflight',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      if (!actor.isAdmin) throw forbidden()
      const choices: OwnershipChoice[] = []
      if (req.body?.choices != null) {
        if (!Array.isArray(req.body.choices))
          throw badRequest(
            'Choose management parents for each conflicting team'
          )
        for (const row of req.body.choices) {
          if (
            !isRecord(row) ||
            typeof row.teamId !== 'string' ||
            !Array.isArray(row.parentSeasonIds) ||
            row.parentSeasonIds.some(id => typeof id !== 'string')
          )
            throw badRequest('Invalid parent choice')
          choices.push({
            teamId: row.teamId,
            parentSeasonIds: row.parentSeasonIds as string[]
          })
        }
      }
      const report = await db.transaction().execute(async trx => {
        await lockKeys(trx, [
          'creation:ownership-cutover',
          'creation:parent-graph'
        ])
        const fresh = await currentActor(trx, actor)
        if (!fresh.isAdmin) throw forbidden()
        if (req.body?.administrators != null) {
          if (!Array.isArray(req.body.administrators))
            throw badRequest('Invalid administrator replacements')
          for (const replacement of req.body.administrators) {
            const ref = clean(asGroupRef, replacement?.group)
            if (!Number.isSafeInteger(replacement?.userId))
              throw badRequest('Choose a verified replacement account')
            await setScopeRoles(
              trx,
              ref.kind,
              ref.id,
              replacement.userId,
              { admin: true, flags: [] },
              actor.userId
            )
          }
        }
        if (req.body?.custodians != null) {
          if (!Array.isArray(req.body.custodians))
            throw badRequest('Invalid placeholder custodians')
          for (const selection of req.body.custodians) {
            const ref = clean(asGroupRef, selection?.custodian)
            if (typeof selection?.teamId !== 'string')
              throw badRequest('Choose a placeholder team')
            await requireGroupAdmin(trx, fresh, ref)
            const team = await trx
              .selectFrom('teams')
              .select('kind')
              .where('id', '=', selection.teamId)
              .where('merged_into', 'is', null)
              .executeTakeFirst()
            if (team?.kind !== 'external')
              throw badRequest('Custody applies only to placeholder teams')
            if (
              ref.kind === 'team' &&
              (
                await trx
                  .selectFrom('teams')
                  .select('kind')
                  .where('id', '=', ref.id)
                  .executeTakeFirstOrThrow()
              ).kind !== 'full'
            )
              throw badRequest('Choose a full-team custodian')
            await trx
              .updateTable('teams')
              .set({ custodian_type: ref.kind, custodian_id: ref.id })
              .where('id', '=', selection.teamId)
              .execute()
          }
        }
        const result = await ownershipPreflight(trx, { dryRun: false, choices })
        if (!result.ready)
          throw conflict(
            'Resolve administrator, custodian and lineage conflicts before enabling management',
            result
          )
        return result
      })
      res.json(report)
    })
  )
  router.use(
    withAsync(async (req, res, next) => {
      const creation =
        req.method === 'POST' &&
        (/^\/(leagues|seasons)\/?$/i.test(req.path) ||
          (/^\/teams\/?$/i.test(req.path) && req.body?.idempotencyKey != null))
      const relationship =
        req.method === 'POST' &&
        /^\/(parent-previews|relationship-requests(?:\/[^/]+\/(?:accept|decline|withdraw|resend))?)\/?$/i.test(
          req.path
        )
      const settings =
        req.method === 'PUT' &&
        /^\/(parent-links|groups\/(?:league|season|team)\/[^/]+)\/?$/i.test(
          req.path
        )
      const competition =
        req.method === 'DELETE' &&
        /^\/seasons\/[^/]+\/memberships\/[^/]+\/?$/i.test(req.path)
      // Retained team/season routes continue operating during an unresolved
      // cutover; only these new graph-dependent method/path pairs need it.
      if (!creation && !relationship && !settings && !competition) {
        next()
        return
      }
      const ready = await db
        .selectFrom('system_settings')
        .select('value')
        .where('key', '=', 'creation.hierarchyReady')
        .executeTakeFirst()
      if (ready?.value !== true) {
        const report = await ownershipPreflight(db, { dryRun: false })
        if (!report.ready)
          throw unavailable(
            'A node administrator must finish organization setup before using creation and linking'
          )
      }
      next()
    })
  )

  router.get(
    '/me/groups',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      if (req.query.role != null) {
        if (req.query.role !== 'admin')
          throw badRequest('role must be admin when provided')
        // What this person administers by their own roles and what those
        // carry down. A node administrator's reach over everything is not
        // a list anybody can choose from, so it is not widened here.
        const scopes = await adminScopes(db, actor.userId, false)
        res.json([
          ...(await discoverGroups(
            db,
            'league',
            '',
            media.space,
            [...scopes.leagueIds],
            null
          )),
          ...(await discoverGroups(
            db,
            'season',
            '',
            media.space,
            [...scopes.seasonIds],
            null
          )),
          ...(await discoverGroups(
            db,
            'team',
            '',
            media.space,
            [...scopes.teamIds],
            null
          ))
        ])
        return
      }
      const roles = await roleScopes(db, actor.userId, actor.isAdmin)
      const visible = await visibleScopes(db, actor.userId, actor.isAdmin)
      const members = await db
        .selectFrom('league_members')
        .select('league_id')
        .where('user_id', '=', actor.userId)
        .execute()
      const leagues = new Set([
        ...members.map(row => row.league_id),
        ...Object.values(roles).flatMap(scope =>
          typeof scope === 'boolean' ? [] : [...scope.leagueIds]
        )
      ])
      res.json([
        ...(await discoverGroups(
          db,
          'league',
          '',
          media.space,
          actor.isAdmin ? undefined : [...leagues],
          null
        )),
        ...(await discoverGroups(
          db,
          'season',
          '',
          media.space,
          actor.isAdmin ? undefined : [...visible.seasonIds],
          null
        )),
        ...(await discoverGroups(
          db,
          'team',
          '',
          media.space,
          actor.isAdmin ? undefined : [...visible.teamIds],
          null
        ))
      ])
    })
  )
  router.get(
    '/me/follows',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      const rows = await db
        .selectFrom('follows')
        .select(['group_type', 'group_id'])
        .where('user_id', '=', actor.userId)
        .orderBy('created_at')
        .execute()
      const groups: PublicGroup[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        // A followed team that was merged is followed as what it became.
        const id =
          row.group_type === 'team'
            ? await followMerges(db, row.group_id)
            : row.group_id
        if (seen.has(`${row.group_type}:${id}`)) continue
        seen.add(`${row.group_type}:${id}`)
        try {
          groups.push(
            await publicGroup(db, { kind: row.group_type, id }, media.space)
          )
        } catch {
          // A group that has gone away is simply no longer on the list.
        }
      }
      res.json(groups)
    })
  )
  router.put(
    '/me/follows/:kind/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      const ref: GroupRef = {
        kind: clean(asGroupKind, req.params.kind),
        id: String(req.params.id)
      }
      const group = await publicGroup(db, ref, media.space)
      await setFollow(db, actor.userId, { kind: ref.kind, id: group.id }, true)
      res.json(group)
    })
  )
  router.delete(
    '/me/follows/:kind/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = await currentActor(db, actorOf(req))
      const kind = clean(asGroupKind, req.params.kind)
      await setFollow(
        db,
        actor.userId,
        { kind, id: String(req.params.id) },
        false
      )
      res.json({ ok: true })
    })
  )
  for (const [kind, collection] of [
    ['league', 'leagues'],
    ['season', 'seasons'],
    ['team', 'teams']
  ] as const) {
    router.get(
      `/${collection}`,
      withAsync(async (req, res, next) => {
        if (req.query.view != null && req.query.view !== 'public')
          throw badRequest('view must be public when provided')
        if (req.query.view !== 'public' && kind !== 'league') {
          next()
          return
        }
        const query = req.query.query ?? ''
        if (typeof query !== 'string' || query.length > 120)
          throw badRequest('Invalid discovery filters')
        let allowedIds: string[] | undefined
        if (kind === 'league' && req.query.view !== 'public') {
          const actor = await currentActor(db, actorOf(req))
          const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
          if (!scopes.isAdmin) allowedIds = [...scopes.leagueIds]
        }
        const groups = await discoverGroups(
          db,
          kind,
          query,
          media.space,
          allowedIds
        )
        res.json(groups)
      })
    )
    router.get(
      `/${collection}/:id`,
      withAsync(async (req, res) => {
        const id = typeof req.params.id === 'string' ? req.params.id : ''
        res.json(await groupDetail(db, { kind, id }, media.space, req.actor))
      })
    )
    router.post(
      `/${collection}`,
      requireActor,
      withAsync(async (req, res, next) => {
        if (kind === 'team' && req.body?.idempotencyKey == null) {
          next()
          return
        }
        const body = clean(asCreateGroup, { ...req.body, kind })
        res.status(201).json(await createGroup(db, actorOf(req), body, media))
      })
    )
  }
  router.post(
    '/parent-previews',
    requireActor,
    withAsync(async (req, res) => {
      const actions = clean(asParentActions, req.body?.actions)
      const actor = actorOf(req)
      let allowed = false
      for (const action of actions) {
        try {
          await requireGroupAdmin(db, actor, action.child)
          allowed = true
        } catch {}
        try {
          await requireGroupAdmin(db, actor, action.parent)
          allowed = true
        } catch {}
      }
      if (!allowed) throw forbidden()
      res.json(await previewParents(db, actions))
    })
  )
  router.put(
    '/parent-links',
    requireActor,
    withAsync(async (req, res) => {
      const actions = clean(asParentActions, req.body?.actions)
      const actor = actorOf(req)
      const preview = await previewParents(db, actions)
      if (
        typeof req.body?.expected !== 'object' ||
        !isDeepStrictEqual(req.body.expected, preview.expected)
      )
        throw badRequest('Confirm the current parent preview')
      await db.transaction().execute(async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const recipients = await adminRecipients(
          trx,
          preview.effects.flatMap(effect => [effect.child, effect.parent])
        )
        await applyParents(trx, [actor], preview)
        await trx
          .insertInto('notification_events')
          .values({
            id: makeId('audit'),
            source_type: 'parentUnlink',
            source_id: makeId('audit'),
            revision: 1,
            actor_id: actor.userId,
            metadata: {
              title: 'Parent relationships updated',
              description: preview.explanation.join(' ')
            },
            recorded_recipients: [...new Set([actor.userId, ...recipients])]
          })
          .execute()
      })
      res.json({ ok: true })
    })
  )
  router.post(
    '/relationship-requests',
    requireActor,
    withAsync(async (req, res) => {
      // Guardian kinds are authorized when the request is made.
      if (req.body?.kind !== 'guardian')
        await requireGroupAdmin(
          db,
          actorOf(req),
          clean(asGroupRef, req.body?.sender)
        )
      const body = await invitation(db, req.body, actorOf(req).userId)
      let result: SentRequest
      if (body.terms.kind === 'person') {
        // An address an account holds adds that account at once; there is
        // nothing to wait for, and the answer says so.
        const added = await addPersonByAddress(
          db,
          actorOf(req),
          body.terms.scope,
          {
            email: body.terms.recipientEmail,
            admin: body.terms.admin,
            flags: body.terms.flags,
            idempotencyKey: body.idempotencyKey
          },
          clock,
          { publicUrl: personMail?.publicUrl, sendAdded: personMail?.sendAdded }
        )
        if ('applied' in added) {
          if (added.applied.added.length === 0)
            throw conflict(
              `${added.applied.displayName} already has this access here`
            )
          res.status(201).json({
            id: added.applied.notificationId ?? '',
            status: 'accepted'
          })
          return
        }
        result = added.invited.request
      } else
        result = await createRelationshipRequest(db, actorOf(req), body, clock)
      if (result.answer == null) {
        await deliverPerson(result)
        res.status(201).json({ id: result.id, status: result.status })
        return
      }
      // A guardian request is mailed once, and its retry key always gets
      // its first answer: 200 when the same one was already waiting.
      if (result.deliver === true)
        try {
          await deliverPerson(result)
        } catch (error) {
          await oweGuardianMail(
            db,
            actorOf(req).userId,
            body.idempotencyKey,
            result.id,
            result.answer
          )
          throw error
        }
      res
        .status(result.answer.code)
        .json({ id: result.id, status: result.answer.status })
    })
  )
  for (const decision of ['accept', 'decline'] as const)
    router.post(
      `/relationship-requests/:id/${decision}`,
      requireActor,
      withAsync(async (req, res) => {
        const id = typeof req.params.id === 'string' ? req.params.id : ''
        const result = await decideRelationshipRequest(
          db,
          actorOf(req),
          id,
          decision,
          clock
        )
        res.json({ id: result.id, status: result.status })
      })
    )
  router.post(
    '/relationship-requests/:id/withdraw',
    requireActor,
    withAsync(async (req, res) => {
      const id = typeof req.params.id === 'string' ? req.params.id : ''
      const result = await withdrawRelationshipRequest(
        db,
        actorOf(req),
        id,
        clock
      )
      res.json({ id: result.id, status: result.status })
    })
  )
  router.post(
    '/relationship-requests/:id/resend',
    requireActor,
    withAsync(async (req, res) => {
      const actor = actorOf(req)
      const id = typeof req.params.id === 'string' ? req.params.id : ''
      const sent = await db.transaction().execute(async trx => {
        if (
          typeof req.body?.idempotencyKey !== 'string' ||
          req.body.idempotencyKey.length < 8 ||
          req.body.idempotencyKey.length > 120
        )
          throw badRequest('Sending needs a retry key')
        await lockKeys(trx, [
          'creation:parent-graph',
          `request:${id}`,
          `creation:request:${actor.userId}:${req.body.idempotencyKey}`
        ])
        const original = await trx
          .selectFrom('group_requests')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
        if (original.kind === 'guardian')
          throw conflict('A guardian request is not resent. Send a new one.')
        await requireGroupAdmin(trx, actor, {
          kind: original.sender_scope_type!,
          id: original.sender_scope_id!
        })
        const held = await trx
          .selectFrom('creation_idempotency')
          .select('response')
          .where('user_id', '=', actor.userId)
          .where('key', '=', req.body.idempotencyKey)
          .executeTakeFirst()
        if (held != null) {
          const prior = await trx
            .selectFrom('group_requests')
            .selectAll()
            .where('id', '=', (held.response as { id: string }).id)
            .executeTakeFirst()
          if (prior?.supersedes_id !== id)
            throw badRequest('This retry key belongs to a different invitation')
          return prior
        }
        const recipientTerms = original.terms as RelationshipInvitation['terms']
        if (
          recipientTerms.kind === 'person' &&
          recipientTerms.recipientUserId != null &&
          (await trx
            .selectFrom('user_emails')
            .select('id')
            .where('user_id', '=', recipientTerms.recipientUserId)
            .where(
              sql<string>`lower(email)`,
              '=',
              recipientTerms.recipientEmail
            )
            .where('verified_at', 'is not', null)
            .executeTakeFirst()) == null
        )
          throw conflict(
            'The recipient identity or verified email changed. Send a new invitation to their current address.'
          )
        await withdrawRelationshipRequest(trx, actor, id, clock)
        const terms = original.terms as RelationshipInvitation['terms']
        if (terms.kind === 'game')
          throw badRequest('Use the game invitation flow')
        const body = await invitation(trx, {
          kind: terms.kind,
          sender: {
            kind: original.sender_scope_type!,
            id: original.sender_scope_id!
          },
          actions: terms.kind === 'parent' ? terms.preview.actions : undefined,
          teamId:
            terms.kind === 'participation' || terms.kind === 'promotion'
              ? terms.teamId
              : undefined,
          seasonId: terms.kind === 'participation' ? terms.seasonId : undefined,
          recipientUserId:
            terms.kind === 'promotion' ? terms.recipientUserId : undefined,
          recipientEmail:
            terms.kind === 'person' ? terms.recipientEmail : undefined,
          admin: terms.kind === 'person' ? terms.admin : undefined,
          flags: terms.kind === 'person' ? terms.flags : undefined,
          idempotencyKey: req.body?.idempotencyKey
        })
        const replacement = await createRelationshipRequest(
          trx,
          actor,
          body,
          clock
        )
        if (body.terms.kind === 'person')
          await ensurePersonLink(trx, replacement)
        await trx
          .updateTable('group_requests')
          .set({ supersedes_id: id })
          .where('id', '=', replacement.id)
          .execute()
        return replacement
      })
      await deliverPerson(sent)
      res.status(201).json({ id: sent.id, status: sent.status })
    })
  )
  router.delete(
    '/seasons/:seasonId/memberships/:teamId',
    requireActor,
    withAsync(async (req, res) => {
      const seasonId = String(req.params.seasonId)
      const teamId = String(req.params.teamId)
      await db.transaction().execute(async trx => {
        await lockKeys(trx, [
          'creation:parent-graph',
          `group:season:${seasonId}`,
          `group:team:${teamId}`
        ])
        const actor = await currentActor(trx, actorOf(req))
        let allowed = false
        for (const ref of [
          { kind: 'season' as const, id: seasonId },
          { kind: 'team' as const, id: teamId }
        ]) {
          try {
            await requireGroupAdmin(trx, actor, ref)
            allowed = true
          } catch {}
        }
        if (!allowed) throw forbidden()
        await trx
          .updateTable('season_teams')
          .set({ active: false })
          .where('season_id', '=', seasonId)
          .where('team_id', '=', teamId)
          .execute()
      })
      res.json({ ok: true })
    })
  )
  router.put(
    '/groups/:kind/:id',
    requireActor,
    withAsync(async (req, res) => {
      const ref: GroupRef = {
        kind: clean(asGroupKind, req.params.kind),
        id: String(req.params.id)
      }
      const actor = actorOf(req)
      await db.transaction().execute(async trx => {
        await lockKeys(trx, [
          'creation:parent-graph',
          `group:${ref.kind}:${ref.id}`
        ])
        await requireGroupAdmin(trx, actor, ref)
        const table =
          ref.kind === 'league'
            ? 'leagues'
            : ref.kind === 'season'
              ? 'seasons'
              : 'teams'
        if (req.body?.name != null)
          await trx
            .updateTable(table)
            .set({
              name: clean(asAccountName, req.body.name),
              updated_at: clock.now()
            })
            .where('id', '=', ref.id)
            .execute()
        if (ref.kind !== 'season' && req.body?.locality != null)
          await trx
            .updateTable(ref.kind === 'team' ? 'teams' : 'leagues')
            .set({ locality: clean(asLocality, req.body.locality) })
            .where('id', '=', ref.id)
            .execute()
        if (
          ref.kind === 'season' &&
          (req.body?.startsOn != null ||
            req.body?.endsOn != null ||
            req.body?.timezone != null)
        ) {
          const row = await trx
            .selectFrom('seasons')
            .select(['starts_on', 'ends_on', 'timezone', 'year'])
            .where('id', '=', ref.id)
            .executeTakeFirstOrThrow()
          const start =
            req.body.startsOn == null
              ? calendarDateText(row.starts_on)
              : clean(asCalendarDate, req.body.startsOn)
          const end =
            req.body.endsOn == null
              ? calendarDateText(row.ends_on)
              : clean(asCalendarDate, req.body.endsOn)
          if (start != null && end != null && end < start)
            throw badRequest('End date precedes start date')
          const timezone = req.body.timezone ?? row.timezone
          try {
            new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
          } catch {
            throw badRequest('Choose a timezone')
          }
          await trx
            .updateTable('seasons')
            .set({
              starts_on: start,
              ends_on: end,
              timezone,
              year: start == null ? row.year : Number(start.slice(0, 4))
            })
            .where('id', '=', ref.id)
            .execute()
          if (
            start !== calendarDateText(row.starts_on) ||
            end !== calendarDateText(row.ends_on) ||
            timezone !== row.timezone
          )
            await trx
              .updateTable('group_requests')
              .set({ status: 'superseded', resolved_at: clock.now() })
              .where('kind', 'in', ['participation', 'parent'])
              .where('status', '=', 'pending')
              .where(eb =>
                eb.or([
                  eb(sql<string>`terms->>'seasonId'`, '=', ref.id),
                  sql<boolean>`(terms->'preview'->'expected') ? ${`season:${ref.id}`}`
                ])
              )
              .execute()
        }
        const picture =
          req.body?.picture ??
          (req.body?.image == null ? undefined : { image: req.body.image })
        if (picture != null) {
          if (
            !isRecord(picture) ||
            (picture.catalogId != null && picture.image != null)
          )
            throw badRequest('Choose one picture')
          if (picture.catalogId != null) {
            const chosen = catalogPicture(
              clean(asCatalogId, picture.catalogId)
            )!
            await trx
              .updateTable(table)
              .set({
                logo_path: chosen.prefix,
                logo_sha256: chosen.sha256,
                logo_source: 'upload',
                picture_catalog_id: chosen.id
              })
              .where('id', '=', ref.id)
              .execute()
          } else if (picture.image != null) {
            await storeGroupPhoto(
              trx,
              media,
              ref,
              picture.image as { contentType: string; base64: string }
            )
          } else if (picture.initials === true)
            await trx
              .updateTable(table)
              .set({
                logo_path: null,
                logo_sha256: null,
                logo_source: null,
                picture_catalog_id: null
              })
              .where('id', '=', ref.id)
              .execute()
          else throw badRequest('Choose a photo or initials')
        }
      })
      res.json(await publicGroup(db, ref, media.space))
    })
  )
  return router
}
