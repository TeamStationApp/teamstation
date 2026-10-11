import { type Kysely, sql } from 'kysely'

import { asAccountEmail } from '../../common/accountSettings'
import { badRequest, conflict } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import type { RequestTerms } from '../../common/notifications'
import { asRoleFlags } from '../../common/roles'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { authorizePersonChange } from '../groups/adminGuard'
import {
  type Clock,
  createRelationshipRequest,
  decideRelationshipRequest,
  realClock,
  type StoredRequest
} from '../groups/requests'
import { cleanBody } from '../jsonBody'
import {
  accountForAddress,
  type AddedMail,
  type Grantable,
  grantAt,
  mailGrant,
  notifyGrant
} from './grants'
import { createInvite, findInviteById, type Invite } from './invites'

export type PersonTerms = Extract<RequestTerms, { kind: 'person' }>
export async function personTerms(
  db: Kysely<Database>,
  scope: GroupRef,
  email: string,
  admin = false,
  flags: unknown = []
): Promise<PersonTerms> {
  const recipientEmail = cleanBody(asAccountEmail, email)
  const recipient = await db
    .selectFrom('user_emails')
    .innerJoin('users', 'users.id', 'user_emails.user_id')
    .select('users.id')
    .where(sql<string>`lower(email)`, '=', recipientEmail)
    .where('verified_at', 'is not', null)
    .where('users.login_enabled', '=', true)
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .executeTakeFirst()
  return {
    kind: 'person',
    scope,
    recipientEmail,
    recipientUserId: recipient?.id ?? null,
    admin,
    flags: cleanBody(asRoleFlags, flags)
  }
}
/** One opaque email link refers to the shared request, never a second grant lifecycle. */
export async function ensurePersonLink(
  db: Kysely<Database>,
  request: StoredRequest
): Promise<Invite> {
  const held = await db
    .selectFrom('invites')
    .select('id')
    .where('request_id', '=', request.id)
    .executeTakeFirst()
  if (held != null) return (await findInviteById(db, held.id))!
  const terms = request.terms as PersonTerms
  return await createInvite(db, {
    scopeType: terms.scope.kind,
    scopeId: terms.scope.id,
    createdBy: request.sender_id,
    forEmail: terms.recipientEmail,
    label: terms.recipientEmail,
    maxUses: 1,
    expiresAt: request.expires_at,
    createdAt: request.sent_at,
    requestId: request.id
  })
}
export async function invitePerson(
  db: Kysely<Database>,
  actor: Actor,
  scope: GroupRef,
  options: {
    email: string
    admin?: boolean
    flags?: unknown
    idempotencyKey: string
  },
  clock: Clock = realClock
): Promise<{ request: StoredRequest; invite: Invite }> {
  if (options.idempotencyKey.length < 8 || options.idempotencyKey.length > 120)
    throw badRequest('Sending needs a retry key')
  return await atomic(db, async trx => {
    const terms = await personTerms(
      trx,
      scope,
      options.email,
      options.admin,
      options.flags
    )
    const request = await createRelationshipRequest(
      trx,
      actor,
      { sender: scope, terms, idempotencyKey: options.idempotencyKey },
      clock
    )
    const invite = await ensurePersonLink(trx, request)
    return { request, invite }
  })
}

/** What adding somebody by address did. */
export type AddedByAddress =
  | {
      /** An account holds the address: added at once. */
      applied: {
        userId: number
        displayName: string
        email: string
        /** What was new, `member` first when the membership was. */
        added: Grantable[]
        notificationId?: string
      }
    }
  | {
      /** Nobody has verified the address: it is invited, as before. */
      invited: { request: StoredRequest; invite: Invite }
    }

/**
 * Adds somebody to a level by an address, with the roles asked for.
 *
 * An address an account has verified names that account, and it is added at
 * once, membership and roles, Admin included: told in its inbox, and mailed
 * at the address it was added by, in the same transaction, so a failed mail
 * leaves nothing done for a retry to find. An address nobody has verified
 * gets the seven-day invitation, applied when somebody verifies it
 * (`applyWaitingInvitations`) or accepts it from its link.
 */
export async function addPersonByAddress(
  db: Kysely<Database>,
  actor: Actor,
  scope: GroupRef,
  options: {
    email: string
    admin?: boolean
    flags?: unknown
    idempotencyKey: string
  },
  clock: Clock = realClock,
  mail?: AddedMail
): Promise<AddedByAddress> {
  if (options.idempotencyKey.length < 8 || options.idempotencyKey.length > 120)
    throw badRequest('Sending needs a retry key')
  const email = cleanBody(asAccountEmail, options.email)
  const flags = cleanBody(asRoleFlags, options.flags ?? [])
  const admin = options.admin === true
  const account = await accountForAddress(db, email)
  if (account == null)
    return {
      invited: await invitePerson(
        db,
        actor,
        scope,
        { ...options, email, flags },
        clock
      )
    }
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph'])
    if (
      scope.kind === 'team' &&
      (
        await trx
          .selectFrom('teams')
          .select('kind')
          .where('id', '=', scope.id)
          .executeTakeFirst()
      )?.kind === 'external'
    )
      throw conflict('Promote a placeholder team before inviting people to it')
    await authorizePersonChange(trx, scope, account.id, actor.userId, admin)
    const added = await grantAt(
      trx,
      scope,
      account.id,
      [...(admin ? (['admin'] as const) : []), ...flags, 'member'],
      actor.userId
    )
    const notificationId = await notifyGrant(trx, {
      ref: scope,
      userId: account.id,
      added,
      actorId: actor.userId,
      at: clock.now()
    })
    if (notificationId != null)
      await mailGrant(
        trx,
        {
          ref: scope,
          userId: account.id,
          added,
          actorId: actor.userId,
          notificationId,
          email
        },
        mail
      )
    return {
      applied: {
        userId: account.id,
        displayName: account.displayName,
        email,
        added,
        notificationId
      }
    }
  })
}

/**
 * Applies every person invitation still waiting for an address this account
 * has now verified, as if they had accepted each: called when somebody signs
 * in with a code or link for the first time, and when they add an address.
 * One that can no longer apply (its sender has lost the right, or it has
 * expired) is left as it is.
 */
export async function applyWaitingInvitations(
  db: Kysely<Database>,
  userId: number,
  clock: Clock = realClock
): Promise<string[]> {
  const addresses = await db
    .selectFrom('user_emails')
    .select('email')
    .where('user_id', '=', userId)
    .where('verified_at', 'is not', null)
    .execute()
  if (addresses.length === 0) return []
  const waiting = await db
    .selectFrom('group_requests')
    .select('id')
    .where('kind', '=', 'person')
    .where('status', '=', 'pending')
    .where('expires_at', '>', clock.now())
    .where(sql<string>`terms->>'recipientUserId'`, 'is', null)
    .where(
      sql<string>`lower(terms->>'recipientEmail')`,
      'in',
      addresses.map(row => row.email.toLowerCase())
    )
    .orderBy('sent_at')
    .execute()
  const applied: string[] = []
  for (const { id } of waiting) {
    try {
      const decided = await decideRelationshipRequest(
        db,
        { userId, isAdmin: false, scopes: [] },
        id,
        'accept',
        clock
      )
      if (decided.status === 'accepted') applied.push(id)
    } catch {
      // Left waiting, for its sender to see and withdraw.
    }
  }
  return applied
}
