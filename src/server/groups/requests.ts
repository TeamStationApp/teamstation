import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { type Kysely, type Selectable, sql } from 'kysely'

import { conflict, forbidden, notFound } from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import { groupKey } from '../../common/groupLinks'
import { makeId } from '../../common/ids'
import type {
  RelationshipInvitation,
  RequestTerms
} from '../../common/notifications'
import { ROLE_FLAGS } from '../../common/roles'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, GroupRequestsTable } from '../db/database'
import { addToScope, rolesAt, setScopeRoles } from '../invites/people'
import { snapshotRequestInformation } from '../notifications/requestInformation'
import { authorizePersonChange } from './adminGuard'
import { applyParents, previewParents } from './relationships'
import { canAdminister, currentActor, requireGroupAdmin } from './rights'

function invitationHash(body: RelationshipInvitation): string {
  const terms = body.terms
  // Derived previews and season ranges are snapshotted only on the first send.
  const intent =
    terms.kind === 'parent'
      ? { kind: terms.kind, actions: terms.preview.actions }
      : terms.kind === 'participation'
        ? { kind: terms.kind, teamId: terms.teamId, seasonId: terms.seasonId }
        : terms.kind === 'person'
          ? {
              kind: terms.kind,
              scope: terms.scope,
              recipientEmail: terms.recipientEmail,
              admin: terms.admin,
              flags: terms.flags
            }
          : terms
  return createHash('sha256')
    .update(
      JSON.stringify({
        sender: body.sender,
        terms: intent,
        confirmBoth: body.confirmBoth === true
      })
    )
    .digest('hex')
}

export async function recordRequestRecipient(
  db: Kysely<Database>,
  requestId: string,
  userId: number
): Promise<void> {
  await db
    .updateTable('notification_events')
    .set({
      recorded_recipients: sql`array(select distinct unnest(recorded_recipients || ARRAY[${userId}]::bigint[]))`
    })
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', requestId)
    .execute()
}

export type StoredRequest = Selectable<GroupRequestsTable>
export interface Clock {
  now: () => Date
}
export const realClock: Clock = { now: () => new Date() }
export interface RequestSide {
  kind: 'league' | 'season' | 'team' | 'user'
  id: string
}

export function relationshipSides(terms: RequestTerms): RequestSide[] {
  if (terms.kind === 'person')
    return [
      terms.scope,
      {
        kind: 'user',
        id:
          terms.recipientUserId == null
            ? `email:${terms.recipientEmail}`
            : String(terms.recipientUserId)
      }
    ]
  if (terms.kind === 'game')
    return [
      { kind: 'team', id: terms.game.homeTeamId },
      { kind: 'team', id: terms.game.awayTeamId }
    ]
  if (terms.kind === 'parent') {
    const refs = terms.preview.actions
      .filter(action => action.operation === 'attach')
      .flatMap(action => [action.child, action.parent])
    return [...new Map(refs.map(ref => [groupKey(ref), ref])).values()]
  }
  if (terms.kind === 'participation')
    return [
      { kind: 'season', id: terms.seasonId },
      { kind: 'team', id: terms.teamId }
    ]
  return [
    { kind: 'team', id: terms.teamId },
    { kind: 'user', id: String(terms.recipientUserId) }
  ]
}

export async function approvesSide(
  db: Kysely<Database>,
  actor: Actor,
  side: RequestSide
): Promise<boolean> {
  const fresh = await currentActor(db, actor)
  if (side.kind === 'user') {
    if (!side.id.startsWith('email:')) return side.id === String(fresh.userId)
    return (
      (await db
        .selectFrom('user_emails')
        .select('id')
        .where('user_id', '=', fresh.userId)
        .where(sql<string>`lower(email)`, '=', side.id.slice(6).toLowerCase())
        .where('verified_at', 'is not', null)
        .executeTakeFirst()) != null
    )
  }
  const team =
    side.kind === 'team'
      ? await db
          .selectFrom('teams')
          .select(['kind', 'custodian_type', 'custodian_id'])
          .where('id', '=', side.id)
          .executeTakeFirst()
      : null
  if (team?.kind === 'external') {
    if (team.custodian_type == null || team.custodian_id == null) return false
    return await canAdminister(db, fresh, {
      kind: team.custodian_type,
      id: team.custodian_id
    })
  }
  return await canAdminister(db, fresh, { kind: side.kind, id: side.id })
}

export function requestStatus(
  request: StoredRequest,
  clock: Clock
): StoredRequest['status'] {
  return request.status === 'pending' &&
    request.expires_at.getTime() <= clock.now().getTime()
    ? 'expired'
    : request.status
}

export async function withdrawRelationshipRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  clock: Clock = realClock
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const fresh = await currentActor(trx, actor)
    const request = await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (request == null) throw notFound()
    if (
      request.sender_id !== fresh.userId &&
      !(await canAdminister(trx, fresh, {
        kind: request.sender_scope_type,
        id: request.sender_scope_id
      }))
    )
      throw forbidden()
    if (request.status === 'accepted')
      throw conflict(
        'This invitation has already been accepted. Manage the relationship in settings.'
      )
    if (request.status === 'pending')
      await trx
        .updateTable('group_requests')
        .set({
          status: 'cancelled',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
    await trx
      .updateTable('invites')
      .set({ revoked_at: clock.now() })
      .where('request_id', '=', id)
      .where('revoked_at', 'is', null)
      .execute()
    return await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  })
}

export async function createRelationshipRequest(
  db: Kysely<Database>,
  actor: Actor,
  body: RelationshipInvitation,
  clock: Clock = realClock
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `creation:request:${actor.userId}:${body.idempotencyKey}`
    ])
    const fresh = await currentActor(trx, actor)
    await requireGroupAdmin(trx, fresh, body.sender)
    const hash = invitationHash(body)
    const previous = await trx
      .selectFrom('creation_idempotency')
      .select(['body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    if (previous != null) {
      if (previous.body_hash !== hash)
        throw conflict('This retry key has different invitation terms')
      const id = (previous.response as { id: string }).id
      return await trx
        .selectFrom('group_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    }
    const sides = relationshipSides(body.terms)
    if (
      !sides.some(
        side => side.kind === body.sender.kind && side.id === body.sender.id
      )
    )
      throw forbidden(
        'The sending organization must be a side of this invitation'
      )
    if (body.terms.kind === 'parent') {
      const live = await previewParents(trx, body.terms.preview.actions)
      if (!isDeepStrictEqual(live, body.terms.preview))
        throw conflict('Review the current parent preview before sending')
    } else if (body.terms.kind === 'game')
      throw forbidden('Use the game proposal flow')
    else if (body.terms.kind === 'participation') {
      const team = await trx
        .selectFrom('teams')
        .select(['kind', 'merged_into'])
        .where('id', '=', body.terms.teamId)
        .executeTakeFirst()
      if (team?.kind !== 'full' || team.merged_into != null)
        throw notFound('Choose a full TeamStation team for season membership')
      const season = await trx
        .selectFrom('seasons')
        .select('id')
        .where('id', '=', body.terms.seasonId)
        .executeTakeFirst()
      if (season == null) throw notFound()
    } else if (body.terms.kind === 'person') {
      if (body.terms.recipientUserId != null)
        await authorizePersonChange(
          trx,
          body.terms.scope,
          body.terms.recipientUserId,
          fresh.userId,
          body.terms.admin
        )
      if (
        body.terms.scope.kind === 'team' &&
        (
          await trx
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', body.terms.scope.id)
            .executeTakeFirst()
        )?.kind === 'external'
      )
        throw conflict(
          'Promote a placeholder team before inviting people to it'
        )
    } else {
      const team = await trx
        .selectFrom('teams')
        .select('kind')
        .where('id', '=', body.terms.teamId)
        .executeTakeFirst()
      if (team?.kind !== 'external')
        throw conflict('Only a placeholder team can be promoted')
      const recipient = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', body.terms.recipientUserId)
        .where('login_enabled', '=', true)
        .where('disabled_at', 'is', null)
        .where('merged_into', 'is', null)
        .where(eb =>
          eb.exists(
            eb
              .selectFrom('user_emails')
              .select('id')
              .whereRef('user_emails.user_id', '=', 'users.id')
              .where('verified_at', 'is not', null)
          )
        )
        .executeTakeFirst()
      if (recipient == null) throw notFound('Choose a verified active account')
      if (
        !(await approvesSide(trx, fresh, {
          kind: 'team',
          id: body.terms.teamId
        }))
      )
        throw forbidden()
    }
    const id = makeId('invite')
    const sent = clock.now()
    const expiry = new Date(sent.getTime() + 7 * 24 * 3600 * 1000)
    await trx
      .insertInto('group_requests')
      .values({
        id,
        kind: body.terms.kind,
        sender_id: fresh.userId,
        sender_scope_type: body.sender.kind,
        sender_scope_id: body.sender.id,
        terms: body.terms,
        sent_at: sent,
        expires_at: expiry
      })
      .execute()
    for (const side of sides) {
      const authorized = await approvesSide(trx, fresh, side)
      const consent =
        (side.kind === body.sender.kind && side.id === body.sender.id) ||
        (body.confirmBoth === true && authorized)
      await trx
        .insertInto('group_request_sides')
        .values({
          request_id: id,
          scope_type: side.kind,
          scope_id: side.id,
          approved_by: consent ? fresh.userId : null,
          approved_at: consent ? sent : null
        })
        .execute()
    }
    const sender = await trx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', fresh.userId)
      .executeTakeFirstOrThrow()
    const table =
      body.sender.kind === 'league'
        ? 'leagues'
        : body.sender.kind === 'season'
          ? 'seasons'
          : 'teams'
    const group = await trx
      .selectFrom(table)
      .select('name')
      .where('id', '=', body.sender.id)
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: 'groupRequest',
        source_id: id,
        revision: 1,
        actor_id: fresh.userId,
        metadata: {
          senderName: sender.display_name,
          senderGroupName: group.name
        },
        recorded_recipients: [fresh.userId],
        created_at: sent
      })
      .execute()
    await snapshotRequestInformation(trx, id)
    await trx
      .insertInto('creation_idempotency')
      .values({
        user_id: fresh.userId,
        key: body.idempotencyKey,
        body_hash: hash,
        response: { id }
      })
      .execute()
    await finishRelationshipRequest(trx, id, clock)
    return await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  })
}

/** Revalidate every recorded side; sender consent is not redundantly requested. */
export async function finishRelationshipRequest(
  db: Kysely<Database>,
  requestId: string,
  clock: Clock
): Promise<boolean> {
  const request = await db
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', requestId)
    .executeTakeFirstOrThrow()
  if (requestStatus(request, clock) !== 'pending') return false
  const sides = await db
    .selectFrom('group_request_sides')
    .selectAll()
    .where('request_id', '=', requestId)
    .execute()
  const actors: Actor[] = []
  for (const side of sides) {
    if (side.approved_by == null) return false
    const actor: Actor = {
      userId: side.approved_by,
      isAdmin: false,
      scopes: []
    }
    try {
      if (
        !(await approvesSide(db, actor, {
          kind: side.scope_type,
          id: side.scope_id
        }))
      )
        return false
    } catch {
      return false
    }
    actors.push(actor)
  }
  const terms = request.terms as RequestTerms
  if (terms.kind === 'parent') await applyParents(db, actors, terms.preview)
  else if (terms.kind === 'game') throw forbidden('Use the game approval flow')
  else if (terms.kind === 'participation') {
    const season = await db
      .selectFrom('seasons')
      .select(['starts_on', 'ends_on', 'timezone'])
      .where('id', '=', terms.seasonId)
      .executeTakeFirstOrThrow()
    if (
      !isDeepStrictEqual(
        {
          startsOn: calendarDateText(season.starts_on),
          endsOn: calendarDateText(season.ends_on),
          timezone: season.timezone
        },
        terms.range
      )
    )
      throw conflict('The season time frame changed. Send a fresh invitation.')
    await db
      .insertInto('season_teams')
      .values({
        season_id: terms.seasonId,
        team_id: terms.teamId,
        active: true
      })
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
  } else if (terms.kind === 'person') {
    const side = await db
      .selectFrom('group_request_sides')
      .select('approved_by')
      .where('request_id', '=', requestId)
      .where('scope_type', '=', 'user')
      .executeTakeFirstOrThrow()
    const recipient = side.approved_by!
    const existing = await rolesAt(
      db,
      terms.scope.kind,
      terms.scope.id,
      recipient
    )
    const owner =
      terms.scope.kind !== 'team'
        ? null
        : await db
            .selectFrom('memberships')
            .select('role')
            .where('team_id', '=', terms.scope.id)
            .where('user_id', '=', recipient)
            .executeTakeFirst()
    const source = await db
      .selectFrom('group_request_sides')
      .select('approved_by')
      .where('request_id', '=', requestId)
      .where('scope_type', '=', terms.scope.kind)
      .where('scope_id', '=', terms.scope.id)
      .executeTakeFirstOrThrow()
    await authorizePersonChange(
      db,
      terms.scope,
      recipient,
      source.approved_by!,
      terms.admin
    )
    if (terms.admin || terms.flags.length > 0)
      await setScopeRoles(
        db,
        terms.scope.kind,
        terms.scope.id,
        recipient,
        {
          admin:
            terms.admin ||
            existing.includes('admin') ||
            owner?.role === 'owner' ||
            owner?.role === 'manager',
          flags: ROLE_FLAGS.filter(
            role => existing.includes(role) || terms.flags.includes(role)
          )
        },
        source.approved_by!
      )
    else await addToScope(db, terms.scope.kind, terms.scope.id, recipient)
  } else {
    if (
      (
        await db
          .selectFrom('teams')
          .select('kind')
          .where('id', '=', terms.teamId)
          .executeTakeFirst()
      )?.kind !== 'external'
    )
      throw conflict(
        'This team is already claimed. Invite its current administrators through the normal team flow.'
      )
    await db
      .updateTable('teams')
      .set({ kind: 'full', custodian_type: null, custodian_id: null })
      .where('id', '=', terms.teamId)
      .where('kind', '=', 'external')
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: terms.recipientUserId,
        scope_type: 'team',
        scope_id: terms.teamId,
        role: 'admin',
        granted_by: request.sender_id
      })
      .onConflict(oc =>
        oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
      )
      .execute()
    await db
      .updateTable('group_request_sides')
      .set({ approved_by: null, approved_at: null })
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', terms.teamId)
      .where(
        'request_id',
        'in',
        db
          .selectFrom('group_requests')
          .select('id')
          .where('kind', '=', 'game')
          .where('status', '=', 'pending')
      )
      .execute()
    await db
      .updateTable('group_requests')
      .set({ status: 'superseded', resolved_at: clock.now() })
      .where('kind', '=', 'promotion')
      .where('status', '=', 'pending')
      .where('id', '!=', requestId)
      .where(sql<string>`terms->>'teamId'`, '=', terms.teamId)
      .execute()
  }
  await db
    .updateTable('group_requests')
    .set({ status: 'accepted', resolved_at: clock.now() })
    .where('id', '=', requestId)
    .execute()
  return true
}

export async function decideRelationshipRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  decision: 'accept' | 'decline',
  clock: Clock = realClock
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const fresh = await currentActor(trx, actor)
    const request = await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (request == null) throw notFound()
    const sides = await trx
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', id)
      .execute()
    const permitted = []
    for (const side of sides)
      if (
        await approvesSide(trx, fresh, {
          kind: side.scope_type,
          id: side.scope_id
        })
      )
        permitted.push(side)
    if (permitted.length === 0)
      throw forbidden('Only the invited side can decide this invitation')
    if (requestStatus(request, clock) !== 'pending') {
      if (request.status === 'pending')
        await trx
          .updateTable('group_requests')
          .set({ status: 'expired', resolved_at: clock.now() })
          .where('id', '=', id)
          .execute()
      return await trx
        .selectFrom('group_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    }
    await recordRequestRecipient(trx, id, fresh.userId)
    if (decision === 'decline') {
      await trx
        .updateTable('group_requests')
        .set({
          status: 'declined',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
      await trx
        .updateTable('invites')
        .set({ revoked_at: clock.now() })
        .where('request_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute()
    } else {
      for (const side of permitted)
        await trx
          .updateTable('group_request_sides')
          .set({ approved_by: fresh.userId, approved_at: clock.now() })
          .where('request_id', '=', id)
          .where('scope_type', '=', side.scope_type)
          .where('scope_id', '=', side.scope_id)
          .execute()
      const terms = request.terms as RequestTerms
      if (
        terms.kind === 'person' &&
        terms.recipientUserId == null &&
        permitted.some(side => side.scope_type === 'user')
      ) {
        await trx
          .updateTable('group_request_sides')
          .set({ scope_id: String(fresh.userId) })
          .where('request_id', '=', id)
          .where('scope_type', '=', 'user')
          .execute()
        await trx
          .updateTable('group_requests')
          .set({ terms: { ...terms, recipientUserId: fresh.userId } })
          .where('id', '=', id)
          .execute()
      }
      await finishRelationshipRequest(trx, id, clock)
    }
    return await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  })
}
