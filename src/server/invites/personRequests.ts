import { type Kysely, sql } from 'kysely'

import { asAccountEmail } from '../../common/accountSettings'
import { badRequest } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import type { RequestTerms } from '../../common/notifications'
import { asRoleFlags } from '../../common/roles'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  type Clock,
  createRelationshipRequest,
  realClock,
  type StoredRequest
} from '../groups/requests'
import { cleanBody } from '../jsonBody'
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
