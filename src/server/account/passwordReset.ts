import type { Kysely } from 'kysely'

import { badRequest } from '../../common/errors'
import type { ResetAuthorization } from '../../common/passwordProtocol'
import { createEmailCode } from '../auth/emailCodes'
import { hashEmailCode, hashToken, tokensMatch } from '../auth/tokens'
import type { Database } from '../db/database'

export async function requestPasswordReset(
  db: Kysely<Database>,
  userId: string,
  stored: string | null
): Promise<{ id: string; code: string; email: string }> {
  const address = await db
    .selectFrom('user_emails')
    .select('email')
    .where('user_id', '=', userId)
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .executeTakeFirst()
  if (address == null)
    throw badRequest(
      'Add and verify an email address before resetting your password'
    )
  const pending = await createEmailCode(db, address.email, 'reset', {
    next: JSON.stringify({ userId, credential: hashToken(stored ?? '') })
  })
  return { id: pending.id, code: pending.code, email: address.email }
}

/** Validate under account/code locks; consume only in the replacement transaction. */
export async function confirmPasswordReset(
  db: Kysely<Database>,
  userId: string,
  stored: string | null,
  reset: ResetAuthorization,
  consume = true
): Promise<boolean> {
  const row = await db
    .selectFrom('email_codes')
    .selectAll()
    .where('id', '=', reset.requestId)
    .where('purpose', '=', 'reset')
    .forUpdate()
    .executeTakeFirst()
  if (
    row?.next_path == null ||
    row.consumed_at != null ||
    row.attempts >= 5 ||
    new Date(row.expires_at).getTime() <= Date.now()
  )
    return false
  let context: { userId?: unknown; credential?: unknown }
  try {
    context = JSON.parse(row.next_path)
  } catch {
    return false
  }
  if (
    context?.userId !== userId ||
    context.credential !== hashToken(stored ?? '')
  )
    return false
  const owner = await db
    .selectFrom('user_emails')
    .select('id')
    .where('user_id', '=', userId)
    .where(eb => eb.fn('lower', ['email']), '=', row.email)
    .executeTakeFirst()
  if (owner == null) return false
  if (!tokensMatch(row.code_hash, hashEmailCode(reset.code.trim()))) {
    await db
      .updateTable('email_codes')
      .set({ attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute()
    return false
  }
  if (!consume) return true
  await db
    .updateTable('email_codes')
    .set({ consumed_at: new Date() })
    .where('id', '=', row.id)
    .execute()
  return true
}
