import { asObject, asOptional, asString } from 'cleaners'
import type { Kysely } from 'kysely'

import { badRequest, conflict } from '../../common/errors'
import { makeId } from '../../common/ids'
import { asUserId } from '../../common/userIdNumber'
import { createEmailCode } from '../auth/emailCodes'
import { hashEmailCode, tokensMatch } from '../auth/tokens'
import type { Database } from '../db/database'

const asContext = asObject({
  userId: asUserId,
  replaceEmailId: asOptional(asString)
})

/** Called with the account row locked, so primary and replacement writes serialize. */
export async function checkEmailChange(
  db: Kysely<Database>,
  userId: number,
  email: string,
  replaceEmailId?: string
): Promise<void> {
  if (replaceEmailId != null) {
    const held = await db
      .selectFrom('user_emails')
      .select('id')
      .where('id', '=', replaceEmailId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    if (held == null)
      throw badRequest('That email address is no longer on your account')
  }
  const existing = await db
    .selectFrom('user_emails')
    .select('user_id')
    .where(eb => eb.fn('lower', ['email']), '=', email)
    .executeTakeFirst()
  if (existing != null) {
    throw conflict(
      existing.user_id === userId
        ? 'That email address is already on your account'
        : 'That email address belongs to another account'
    )
  }
}

export async function requestAccountEmail(
  db: Kysely<Database>,
  userId: number,
  email: string,
  replaceEmailId?: string
): Promise<{ id: string; code: string }> {
  await checkEmailChange(db, userId, email, replaceEmailId)
  return await createEmailCode(db, email, 'verify', {
    next: JSON.stringify({ userId, replaceEmailId })
  })
}

/**
 * False is returned, not thrown: failed guesses must commit their attempt count.
 * The caller holds the account lock; this row lock also makes code consumption
 * and address acceptance one atomic operation.
 */
export async function confirmAccountEmail(
  db: Kysely<Database>,
  userId: number,
  requestId: string,
  code: string
): Promise<boolean> {
  const row = await db
    .selectFrom('email_codes')
    .selectAll()
    .where('id', '=', requestId)
    .where('purpose', '=', 'verify')
    .forUpdate()
    .executeTakeFirst()
  if (row?.next_path == null) return false
  let context: ReturnType<typeof asContext>
  try {
    context = asContext(JSON.parse(row.next_path))
  } catch {
    return false
  }
  if (
    context.userId !== userId ||
    row.consumed_at != null ||
    row.attempts >= 5 ||
    new Date(row.expires_at).getTime() <= Date.now()
  )
    return false
  if (!tokensMatch(row.code_hash, hashEmailCode(code.trim()))) {
    await db
      .updateTable('email_codes')
      .set({ attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute()
    return false
  }
  await checkEmailChange(db, userId, row.email, context.replaceEmailId)
  const addresses = await db
    .selectFrom('user_emails')
    .select(['id', 'is_primary'])
    .where('user_id', '=', userId)
    .execute()
  const replacing = addresses.find(
    address => address.id === context.replaceEmailId
  )
  const primary =
    replacing?.is_primary === true ||
    !addresses.some(address => address.is_primary)
  if (replacing != null) {
    await db
      .updateTable('user_emails')
      .set({
        email: row.email,
        verified_at: new Date(),
        source: 'manual',
        is_primary: primary
      })
      .where('id', '=', replacing.id)
      .execute()
  } else {
    await db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: userId,
        email: row.email,
        is_primary: primary,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
  }
  // Verification is not a sign-in approval: approved_at stays null.
  await db
    .updateTable('email_codes')
    .set({ consumed_at: new Date() })
    .where('id', '=', row.id)
    .execute()
  return true
}

export async function selectPrimaryEmail(
  db: Kysely<Database>,
  userId: number,
  emailId: string
): Promise<void> {
  const row = await db
    .selectFrom('user_emails')
    .select('id')
    .where('user_id', '=', userId)
    .where('id', '=', emailId)
    .executeTakeFirst()
  if (row == null) throw badRequest('Choose an email address on your account')
  await db
    .updateTable('user_emails')
    .set({ is_primary: false })
    .where('user_id', '=', userId)
    .where('is_primary', '=', true)
    .execute()
  await db
    .updateTable('user_emails')
    .set({ is_primary: true })
    .where('id', '=', emailId)
    .execute()
}
