import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { type Kysely, type Selectable, sql } from 'kysely'

import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import type { GameRequestTerms } from '../../common/gameApprovals'
import { calendarDateText, type GroupRef } from '../../common/groupCreation'
import { groupKey } from '../../common/groupLinks'
import { makeId } from '../../common/ids'
import { shortName } from '../../common/names'
import type {
  GuardianTerms,
  RelationshipInvitation,
  RequestTerms
} from '../../common/notifications'
import {
  canCoach,
  canSeeTeam,
  guardiansWhoCanAct,
  guardsPlayer,
  roleScopes,
  teamsPlayedOnNow,
  visibleScopes
} from '../access'
import { type OnePerson, onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, GroupRequestsTable } from '../db/database'
import { grantAt, notifyGrant } from '../invites/grants'
import { snapshotRequestInformation } from '../notifications/requestInformation'
import { seasonGameConsent } from '../schedule/seasonGameConsent'
import { authorizePersonChange } from './adminGuard'
import { checkGuardianLimits, isGuardianRequest } from './guardianLimits'
import { applyParents, previewParents } from './relationships'
import {
  canAdminister,
  canScheduleFor,
  currentActor,
  requireGroupAdmin
} from './rights'

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
          : terms.kind === 'guardian'
            ? {
                kind: terms.kind,
                playerUserId: terms.playerUserId,
                // An address is the intent, whatever account it resolved to.
                guardian:
                  terms.guardian.email == null
                    ? terms.guardian
                    : { email: terms.guardian.email }
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

/**
 * The sides that must each approve. A team's guardian invitation is its team
 * and the guardian. With no sending group, a guardian request, whose sender
 * names themselves, is that guardian and the player; and a guardian's
 * invitation of somebody else is the inviting guardian (`senderId`) and the
 * one invited.
 */
export function relationshipSides(
  terms: RequestTerms,
  sender: GroupRef | null = null,
  senderId?: number
): RequestSide[] {
  if (terms.kind === 'guardian') {
    const guardian: RequestSide = {
      kind: 'user',
      id:
        'userId' in terms.guardian
          ? String(terms.guardian.userId)
          : `email:${terms.guardian.email}`
    }
    if (sender != null) return [sender, guardian]
    return senderId == null ||
      isGuardianRequest({ sender_id: senderId, sender_scope_type: null, terms })
      ? [guardian, { kind: 'user', id: String(terms.playerUserId) }]
      : [{ kind: 'user', id: String(senderId) }, guardian]
  }
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

/**
 * Whether somebody may approve one side of a request, by its kind and terms.
 *
 * A user side is that user, or whoever has verified its address. A group
 * side is an administrator of the group, or of a placeholder team's
 * custodian.
 *
 * Once a player has a guardian, only their guardians (and the player) say
 * who else becomes one; a team's staff speak only for a player who has none.
 * Only a guardian who can sign in counts (`hasGuardian`). Each is read when
 * the side is decided, not when the request was sent. So
 * a guardian request's player side is the player, when their account signs
 * in; any guardian of the player; while the player has no guardian, an
 * administrator, coach or assistant of a team the player plays on now; and
 * a site administrator; but never the guardian who asked: one approval means
 * somebody else's. A team's guardian invitation's team side is an
 * administrator, coach or assistant of that team, while the player has no
 * guardian. A guardian's invitation's inviting side is that guardian, while
 * they still are one. A site administrator speaks for either whatever the
 * player has.
 */
export async function approvesSide(
  db: Kysely<Database>,
  actor: Actor,
  side: RequestSide,
  request: Pick<StoredRequest, 'kind' | 'terms'>
): Promise<boolean> {
  const fresh = await currentActor(db, actor)
  if (request.kind === 'guardian') {
    const terms = request.terms as GuardianTerms
    if (side.kind === 'user' && side.id === String(terms.playerUserId))
      return (
        !(await namesPerson(db, terms.guardian, fresh.userId)) &&
        (await approvesForPlayer(db, fresh, terms.playerUserId))
      )
    if (side.kind === 'team')
      return (
        (await coachesTeam(db, fresh, side.id)) &&
        (fresh.isAdmin || !(await hasGuardian(db, terms.playerUserId)))
      )
    if (side.kind === 'user' && !namesSide(terms.guardian, side))
      return (
        side.id === String(fresh.userId) &&
        (fresh.isAdmin ||
          (await guardsPlayer(db, fresh.userId, terms.playerUserId)))
      )
  }
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
  if (
    request.kind === 'game' &&
    side.kind === 'team' &&
    ((request.terms as GameRequestTerms).game.homeTeamId === side.id ||
      (request.terms as GameRequestTerms).game.awayTeamId === side.id) &&
    (await seasonGameConsent(
      db,
      fresh,
      (request.terms as GameRequestTerms).game
    ))
  )
    return true
  if (request.kind === 'game' || request.kind === 'gameChange')
    return await canScheduleFor(db, fresh, { kind: side.kind, id: side.id })
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

/** An administrator, coach or assistant of the team. */
async function coachesTeam(
  db: Kysely<Database>,
  actor: Actor,
  teamId: string
): Promise<boolean> {
  return (
    (await canAdminister(db, actor, { kind: 'team', id: teamId })) ||
    canCoach(await roleScopes(db, actor.userId, actor.isAdmin), teamId)
  )
}

/** Whether a guardian names this side: its account, or its address. */
function namesSide(
  guardian: GuardianTerms['guardian'],
  side: RequestSide
): boolean {
  return 'userId' in guardian
    ? side.id === String(guardian.userId)
    : side.id === `email:${guardian.email}`
}

/**
 * Whether a player has a guardian who holds the say over further guardians:
 * an account that can sign in, neither disabled nor closed into another,
 * with a `guardian` or `family` link to any of their rows. A guardian who
 * cannot sign in, as a roster import makes a parent with no address, leaves
 * the say with the team's staff.
 */
export async function hasGuardian(
  db: Kysely<Database>,
  playerUserId: number
): Promise<boolean> {
  return (await guardiansWhoCanAct(db, [playerUserId])).length > 0
}

/** An administrator, coach or assistant of a team the player plays on now. */
async function coachesPlayer(
  db: Kysely<Database>,
  actor: Actor,
  player: OnePerson
): Promise<boolean> {
  const plays = await teamsPlayedOnNow(db, player.userIds)
  if (plays.length === 0) return false
  const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
  if (plays.some(teamId => canCoach(scopes, teamId))) return true
  for (const teamId of plays)
    if (await canAdminister(db, actor, { kind: 'team', id: teamId }))
      return true
  return false
}

/**
 * The player, signed in as the row they are now; any guardian of theirs; a
 * site administrator; and, only while the player has no guardian who can
 * sign in (`guardiansWhoCanAct`), an
 * administrator, coach or assistant of a team the player, by any of their
 * rows, plays on now.
 */
async function approvesForPlayer(
  db: Kysely<Database>,
  actor: Actor,
  playerUserId: number
): Promise<boolean> {
  const player = await onePerson(db, playerUserId)
  // `currentActor` already refused an account that cannot sign in.
  if (player.userId === actor.userId || actor.isAdmin) return true
  const guardians = await guardiansWhoCanAct(db, [player.userId])
  if (guardians.length > 0) return guardians.includes(actor.userId)
  return await coachesPlayer(db, actor, player)
}

/**
 * How somebody may invite a guardian of this player, for the Player screen:
 * `guardian`, as one of the player's guardians, with no sending team;
 * `team`, as an administrator, coach or assistant, from a team the player
 * plays on now, which only a player with no guardian who can sign in yet
 * can be invited from (a site administrator, from any of their teams); or
 * `null`, not at all.
 */
export async function guardianInviteAs(
  db: Kysely<Database>,
  actor: Actor,
  playerUserId: number
): Promise<'guardian' | 'team' | null> {
  // Nobody who cannot manage invitations, like an API token or an account
  // that no longer signs in, invites one.
  let fresh: Actor
  try {
    fresh = await currentActor(db, actor)
  } catch {
    return null
  }
  const player = await onePerson(db, playerUserId)
  const guardians = await guardiansWhoCanAct(db, [player.userId])
  if (guardians.includes(fresh.userId)) return 'guardian'
  if (fresh.isAdmin) return 'team'
  if (guardians.length > 0) return null
  return (await coachesPlayer(db, fresh, player)) ? 'team' : null
}

/** "Avery S has a guardian already", for a refusal. */
async function hasGuardianAlready(
  db: Kysely<Database>,
  playerUserId: number
): Promise<string> {
  const player = await db
    .selectFrom('users')
    .select([
      'id',
      'first_name as firstName',
      'last_name as lastName',
      'display_name as displayName'
    ])
    .where('id', '=', (await onePerson(db, playerUserId)).userId)
    .executeTakeFirstOrThrow()
  return `${shortName(player)} has a guardian already. Ask them to invite another guardian.`
}

/**
 * Whether somebody acts for a request's sending side, to withdraw it: an
 * administrator of the sending group; for a team's guardian invitation an
 * administrator, coach or assistant of its team, whether or not the player
 * has a guardian since; and for a guardian request or a guardian's
 * invitation, which no group sent, only its sender.
 */
export async function speaksForSender(
  db: Kysely<Database>,
  actor: Actor,
  request: StoredRequest
): Promise<boolean> {
  if (request.sender_scope_type == null || request.sender_scope_id == null)
    return request.sender_id === actor.userId
  const sender = {
    kind: request.sender_scope_type,
    id: request.sender_scope_id
  }
  if (request.kind === 'game' || request.kind === 'gameChange')
    return await canScheduleFor(db, actor, sender)
  if (request.kind === 'guardian')
    return await coachesTeam(db, await currentActor(db, actor), sender.id)
  return await canAdminister(db, actor, sender)
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
      !(await speaksForSender(trx, fresh, request))
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

/**
 * Who may send a guardian invitation or request, about which player.
 *
 * A team's invitation comes from a team its sender administers, coaches or
 * assists, about one of that team's players who has no guardian yet: once
 * they have one, their guardians decide who else becomes one. A guardian's
 * invitation, with no sending group, names somebody else as the guardian,
 * and comes from a guardian of the player. A request names its sender as the
 * guardian, about a player on a team the sender can see. A site
 * administrator may send any of them. Either way the terms name the player
 * by the row they are now.
 */
async function authorizeGuardian(
  db: Kysely<Database>,
  actor: Actor,
  sender: GroupRef | null,
  terms: GuardianTerms
): Promise<GuardianTerms> {
  const player = await onePerson(db, terms.playerUserId)
  const row = await db
    .selectFrom('users')
    .select('disabled_at')
    .where('id', '=', player.userId)
    .executeTakeFirst()
  if (row == null || row.disabled_at != null) throw notFound()
  const plays = await teamsPlayedOnNow(db, player.userIds)
  if (sender != null) {
    if (sender.kind !== 'team')
      throw badRequest('A guardian invitation comes from a team')
    if (!(await coachesTeam(db, actor, sender.id)))
      throw forbidden(
        'Only an administrator, coach or assistant of the team can invite a guardian'
      )
    if (!plays.includes(sender.id)) throw notFound()
    if (!actor.isAdmin && (await hasGuardian(db, player.userId)))
      throw forbidden(await hasGuardianAlready(db, player.userId))
  } else if (
    !('userId' in terms.guardian) ||
    terms.guardian.userId !== actor.userId
  ) {
    if (
      !actor.isAdmin &&
      !(await guardsPlayer(db, actor.userId, player.userId))
    )
      throw forbidden(
        'Only a guardian of the player can invite a guardian without a team'
      )
  } else {
    const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
    if (!plays.some(teamId => canSeeTeam(scopes, teamId))) throw notFound()
  }
  return { ...terms, playerUserId: player.userId }
}

/** Whether a guardian names any row of this person, or an address of theirs. */
async function namesPerson(
  db: Kysely<Database>,
  guardian: GuardianTerms['guardian'],
  userId: number
): Promise<boolean> {
  const person = await onePerson(db, userId)
  if ('userId' in guardian)
    return (await onePerson(db, guardian.userId)).userId === person.userId
  return (
    (await db
      .selectFrom('user_emails')
      .select('id')
      .where('user_id', 'in', person.userIds)
      .where(sql<string>`lower(email)`, '=', guardian.email)
      .executeTakeFirst()) != null
  )
}

/**
 * The guardian may be no row of the player, nor an address of theirs; and an
 * invitation's guardian is not its sender, who would otherwise be the one
 * approval it needs.
 */
async function refuseOwnGuardian(
  db: Kysely<Database>,
  senderId: number,
  invitation: boolean,
  terms: GuardianTerms
): Promise<void> {
  if (await namesPerson(db, terms.guardian, terms.playerUserId))
    throw badRequest("A player can't be their own guardian")
  if (invitation && (await namesPerson(db, terms.guardian, senderId)))
    throw badRequest("You can't invite yourself to be a guardian")
}

/** Somebody who already guards the player, by any of their rows, is not asked again. */
async function refuseGuardianAgain(
  db: Kysely<Database>,
  invitation: boolean,
  terms: GuardianTerms
): Promise<void> {
  if (!('userId' in terms.guardian)) return
  const guardianUserId = terms.guardian.userId
  if (!(await guardsPlayer(db, guardianUserId, terms.playerUserId))) return
  const [player, guardian] = await Promise.all(
    [terms.playerUserId, guardianUserId].map(
      async id =>
        await db
          .selectFrom('users')
          .select([
            'id',
            'first_name as firstName',
            'last_name as lastName',
            'display_name as displayName'
          ])
          .where('id', '=', (await onePerson(db, id)).userId)
          .executeTakeFirstOrThrow()
    )
  )
  throw conflict(
    invitation
      ? `${shortName(guardian)} is already ${shortName(player)}'s guardian`
      : `You are already ${shortName(player)}'s guardian`
  )
}

/**
 * The same guardian request still waiting: the sender's own request for this
 * player, their own invitation of the same account or address as a guardian,
 * or this team's invitation of them. Asking again answers it rather than
 * sending a second.
 */
async function waitingGuardianRequest(
  db: Kysely<Database>,
  senderId: number,
  sender: GroupRef | null,
  terms: GuardianTerms,
  now: Date
): Promise<StoredRequest | undefined> {
  const player = await onePerson(db, terms.playerUserId)
  let query = db
    .selectFrom('group_requests')
    .selectAll()
    .where('kind', '=', 'guardian')
    .where('status', '=', 'pending')
    .where('expires_at', '>', now)
    .where(sql<number>`(terms->>'playerUserId')::bigint`, 'in', player.userIds)
  query =
    sender == null
      ? query
          .where('sender_id', '=', senderId)
          .where('sender_scope_type', 'is', null)
      : query
          .where('sender_scope_type', '=', sender.kind)
          .where('sender_scope_id', '=', sender.id)
  const guardian =
    'userId' in terms.guardian
      ? await onePerson(db, terms.guardian.userId)
      : undefined
  const email = terms.guardian.email?.toLowerCase()
  for (const request of await query.orderBy('sent_at').execute()) {
    const named = (request.terms as GuardianTerms).guardian
    if (
      (guardian != null &&
        'userId' in named &&
        guardian.userIds.includes(named.userId)) ||
      (email != null && named.email?.toLowerCase() === email)
    )
      return request
  }
  return undefined
}

/**
 * How a guardian request's retry key was answered: 201 when it sent the
 * request, 200 when the same one was already waiting. A replay of the key
 * gives the same answer. `owed` marks an invitation whose mail did not go.
 */
interface GuardianAnswer {
  id: string
  code: 200 | 201
  status: StoredRequest['status']
  owed?: true
}

/**
 * A sent request. A guardian one carries its `answer`, and `deliver` says
 * whether to mail it: only when it was just sent, or when its mail is owed.
 * A repeat or a replay is sent to nobody again.
 */
export type SentRequest = StoredRequest & {
  answer?: { code: 200 | 201; status: StoredRequest['status'] }
  deliver?: boolean
}

/** A guardian invitation's mail did not go; a replay of its key sends it. */
export async function oweGuardianMail(
  db: Kysely<Database>,
  userId: number,
  key: string,
  id: string,
  answer: NonNullable<SentRequest['answer']>
): Promise<void> {
  const owed: GuardianAnswer = { id, ...answer, owed: true }
  await db
    .updateTable('creation_idempotency')
    .set({ response: owed })
    .where('user_id', '=', userId)
    .where('key', '=', key)
    .execute()
}

export async function createRelationshipRequest(
  db: Kysely<Database>,
  actor: Actor,
  body: RelationshipInvitation,
  clock: Clock = realClock
): Promise<SentRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `creation:request:${actor.userId}:${body.idempotencyKey}`
    ])
    const fresh = await currentActor(trx, actor)
    const sender = body.sender ?? null
    // A retry key is its sender's own, so only they can replay it.
    const hash = invitationHash(body)
    const previous = await trx
      .selectFrom('creation_idempotency')
      .select(['body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    const replay = async (): Promise<SentRequest> => {
      if (previous!.body_hash !== hash)
        throw conflict('This retry key has different invitation terms')
      const answer = previous!.response as Partial<GuardianAnswer> & {
        id: string
      }
      const request = await trx
        .selectFrom('group_requests')
        .selectAll()
        .where('id', '=', answer.id)
        .executeTakeFirstOrThrow()
      if (request.kind !== 'guardian') return request
      // A guardian replay gives the first answer, and mails only what is owed.
      const given: GuardianAnswer = {
        id: request.id,
        code: answer.code ?? 201,
        status: answer.status ?? request.status
      }
      if (answer.owed === true)
        await trx
          .updateTable('creation_idempotency')
          .set({ response: given })
          .where('user_id', '=', fresh.userId)
          .where('key', '=', body.idempotencyKey)
          .execute()
      return {
        ...request,
        answer: { code: given.code, status: given.status },
        deliver: answer.owed === true
      }
    }
    // A guardian key was authorized when it was first sent: its replay gives
    // that answer, and settles its mail, though the sender has since lost the
    // team or the player has left it. Only a fresh send is authorized.
    if (previous != null && body.terms.kind === 'guardian')
      return await replay()
    // Guardian kinds are authorized by their own rules, and name the player
    // by the row they are now.
    const terms =
      body.terms.kind === 'guardian'
        ? await authorizeGuardian(trx, fresh, sender, body.terms)
        : body.terms
    if (terms.kind !== 'guardian') {
      if (sender == null) throw badRequest('Choose the sending organization')
      await requireGroupAdmin(trx, fresh, sender)
    }
    if (previous != null) return await replay()
    const sides = relationshipSides(terms, sender, fresh.userId)
    if (
      sender != null &&
      !sides.some(side => side.kind === sender.kind && side.id === sender.id)
    )
      throw forbidden(
        'The sending organization must be a side of this invitation'
      )
    if (terms.kind === 'parent') {
      const live = await previewParents(trx, terms.preview.actions)
      if (!isDeepStrictEqual(live, terms.preview))
        throw conflict('Review the current parent preview before sending')
    } else if (terms.kind === 'game')
      throw forbidden('Use the game proposal flow')
    else if (terms.kind === 'participation') {
      const team = await trx
        .selectFrom('teams')
        .select(['kind', 'merged_into'])
        .where('id', '=', terms.teamId)
        .executeTakeFirst()
      if (team?.kind !== 'full' || team.merged_into != null)
        throw notFound('Choose a full TeamStation team for season membership')
      const season = await trx
        .selectFrom('seasons')
        .select('id')
        .where('id', '=', terms.seasonId)
        .executeTakeFirst()
      if (season == null) throw notFound()
    } else if (terms.kind === 'person') {
      if (terms.recipientUserId != null)
        await authorizePersonChange(
          trx,
          terms.scope,
          terms.recipientUserId,
          fresh.userId,
          terms.admin
        )
      if (
        terms.scope.kind === 'team' &&
        (
          await trx
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', terms.scope.id)
            .executeTakeFirst()
        )?.kind === 'external'
      )
        throw conflict(
          'Promote a placeholder team before inviting people to it'
        )
    } else if (terms.kind === 'guardian') {
      const invitation = !isGuardianRequest({
        sender_id: fresh.userId,
        sender_scope_type: sender?.kind ?? null,
        terms
      })
      await refuseOwnGuardian(trx, fresh.userId, invitation, terms)
      await refuseGuardianAgain(trx, invitation, terms)
      const waiting = await waitingGuardianRequest(
        trx,
        fresh.userId,
        sender,
        terms,
        clock.now()
      )
      if (waiting != null) {
        const answer: GuardianAnswer = {
          id: waiting.id,
          code: 200,
          status: waiting.status
        }
        await trx
          .insertInto('creation_idempotency')
          .values({
            user_id: fresh.userId,
            key: body.idempotencyKey,
            body_hash: hash,
            response: answer
          })
          .execute()
        return {
          ...waiting,
          answer: { code: 200, status: waiting.status },
          deliver: false
        }
      }
      // A person's own requests, and a guardian's invitations, count toward
      // their limits; a team's invitations never do.
      if (sender == null)
        await checkGuardianLimits(trx, fresh.userId, clock, {
          declines: !invitation
        })
    } else {
      const team = await trx
        .selectFrom('teams')
        .select('kind')
        .where('id', '=', terms.teamId)
        .executeTakeFirst()
      if (team?.kind !== 'external')
        throw conflict('Only a placeholder team can be promoted')
      const recipient = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', terms.recipientUserId)
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
        !(await approvesSide(
          trx,
          fresh,
          { kind: 'team', id: terms.teamId },
          { kind: terms.kind, terms }
        ))
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
        kind: terms.kind,
        sender_id: fresh.userId,
        sender_scope_type: sender?.kind ?? null,
        sender_scope_id: sender?.id ?? null,
        terms,
        sent_at: sent,
        expires_at: expiry
      })
      .execute()
    for (const side of sides) {
      const authorized = await approvesSide(trx, fresh, side, {
        kind: terms.kind,
        terms
      })
      // Sending is the sender's consent: their group's, or for a request
      // sent by nobody's group, their own.
      const consent =
        (sender == null
          ? side.kind === 'user' && side.id === String(fresh.userId)
          : side.kind === sender.kind && side.id === sender.id) ||
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
    const named = await trx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', fresh.userId)
      .executeTakeFirstOrThrow()
    const group =
      sender == null
        ? null
        : await trx
            .selectFrom(
              sender.kind === 'league'
                ? 'leagues'
                : sender.kind === 'season'
                  ? 'seasons'
                  : 'teams'
            )
            .select('name')
            .where('id', '=', sender.id)
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
          senderName: named.display_name,
          ...(group == null ? {} : { senderGroupName: group.name })
        },
        recorded_recipients: [fresh.userId],
        created_at: sent
      })
      .execute()
    await snapshotRequestInformation(trx, id)
    await finishRelationshipRequest(trx, id, clock)
    const created = await trx
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const answer: GuardianAnswer | undefined =
      terms.kind === 'guardian'
        ? { id, code: 201, status: created.status }
        : undefined
    await trx
      .insertInto('creation_idempotency')
      .values({
        user_id: fresh.userId,
        key: body.idempotencyKey,
        body_hash: hash,
        response: answer ?? { id }
      })
      .execute()
    return answer == null
      ? created
      : {
          ...created,
          answer: { code: 201, status: created.status },
          deliver: true
        }
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
        !(await approvesSide(
          db,
          actor,
          { kind: side.scope_type, id: side.scope_id },
          request
        ))
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
    // What the invitation offered is added to what they hold, and they are
    // told so, as anybody added with an account is.
    const added = await grantAt(
      db,
      terms.scope,
      recipient,
      [...(terms.admin ? (['admin'] as const) : []), ...terms.flags, 'member'],
      source.approved_by!
    )
    await notifyGrant(db, {
      ref: terms.scope,
      userId: recipient,
      added,
      actorId: source.approved_by!,
      at: clock.now()
    })
  } else if (terms.kind === 'guardian') {
    // The guardian is whoever approved the guardian's side: the sender of a
    // request, or the account that accepted an invitation.
    const guardian = sides.find(
      side =>
        side.scope_type === 'user' &&
        namesSide(terms.guardian, { kind: 'user', id: side.scope_id })
    )!.approved_by!
    const player = await onePerson(db, terms.playerUserId)
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: guardian,
        related_user_id: player.userId,
        kind: 'guardian',
        can_manage: true,
        created_at: clock.now()
      })
      .onConflict(oc =>
        oc.columns(['user_id', 'related_user_id', 'kind']).doNothing()
      )
      .execute()
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
        await approvesSide(
          trx,
          fresh,
          { kind: side.scope_type, id: side.scope_id },
          request
        )
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
      const terms = request.terms as RequestTerms
      const guardianSide =
        terms.kind === 'guardian'
          ? permitted.find(
              side =>
                side.scope_type === 'user' &&
                namesSide(terms.guardian, { kind: 'user', id: side.scope_id })
            )
          : undefined
      if (
        terms.kind === 'guardian' &&
        guardianSide != null &&
        (await onePerson(trx, terms.playerUserId)).userId === fresh.userId
      )
        throw conflict("A player can't be their own guardian")
      if (
        terms.kind === 'guardian' &&
        guardianSide != null &&
        !isGuardianRequest(request) &&
        (await onePerson(trx, request.sender_id)).userId === fresh.userId
      )
        throw conflict("You can't invite yourself to be a guardian")
      // A team's invitation stands only while the player has no guardian: a
      // guardian since then decides who else becomes one.
      if (terms.kind === 'guardian' && request.sender_scope_type === 'team') {
        const team = sides.find(side => side.scope_type === 'team')
        if (
          team?.approved_by != null &&
          (await hasGuardian(trx, terms.playerUserId)) &&
          !(await approvesSide(
            trx,
            { userId: team.approved_by, isAdmin: false, scopes: [] },
            { kind: 'team', id: team.scope_id },
            request
          ).catch(() => false))
        )
          throw forbidden(await hasGuardianAlready(trx, terms.playerUserId))
      }
      for (const side of permitted)
        await trx
          .updateTable('group_request_sides')
          .set({ approved_by: fresh.userId, approved_at: clock.now() })
          .where('request_id', '=', id)
          .where('scope_type', '=', side.scope_type)
          .where('scope_id', '=', side.scope_id)
          .execute()
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
      // An invitation to an address is bound to the account that accepted it.
      if (
        terms.kind === 'guardian' &&
        guardianSide?.scope_id.startsWith('email:') === true
      ) {
        await trx
          .updateTable('group_request_sides')
          .set({ scope_id: String(fresh.userId) })
          .where('request_id', '=', id)
          .where('scope_type', '=', 'user')
          .where('scope_id', '=', guardianSide.scope_id)
          .execute()
        await trx
          .updateTable('group_requests')
          .set({
            terms: {
              ...terms,
              guardian: { userId: fresh.userId, email: terms.guardian.email }
            }
          })
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
