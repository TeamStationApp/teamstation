import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { hashEmailCode, makeEmailCode } from './tokens'

const CODE_MINUTES = 10
const MAX_ATTEMPTS = 5

export type CodePurpose = 'login' | 'verify' | 'reset'

/**
 * Issues a code and returns it to the caller to deliver. Any earlier unused
 * code for the same address and purpose is consumed first, so only the newest
 * one works and a stream of requests cannot widen the guessing window.
 */
export async function createEmailCode(
  db: Kysely<Database>,
  email: string,
  purpose: CodePurpose
): Promise<{ code: string; expiresAt: Date }> {
  const normalised = email.trim().toLowerCase()
  const now = new Date()

  await db
    .updateTable('email_codes')
    .set({ consumed_at: now })
    .where('email', '=', normalised)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .execute()

  const code = makeEmailCode()
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000)
  await db
    .insertInto('email_codes')
    .values({
      id: makeId('emailCode'),
      email: normalised,
      code_hash: hashEmailCode(code),
      purpose,
      expires_at: expiresAt
    })
    .execute()

  return { code, expiresAt }
}

/**
 * Checks a code and consumes it on success. A wrong guess counts against the
 * code, and the code dies after five, so a six-digit secret cannot be walked
 * through. Returns false for expired, consumed, exhausted and wrong alike.
 */
export async function verifyEmailCode(
  db: Kysely<Database>,
  email: string,
  purpose: CodePurpose,
  code: string
): Promise<boolean> {
  const normalised = email.trim().toLowerCase()
  const now = new Date()

  const row = await db
    .selectFrom('email_codes')
    .select(['id', 'code_hash', 'attempts', 'expires_at'])
    .where('email', '=', normalised)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()

  if (row == null) return false
  if (new Date(row.expires_at).getTime() <= now.getTime()) return false
  if (row.attempts >= MAX_ATTEMPTS) return false

  if (row.code_hash !== hashEmailCode(code.trim())) {
    await db
      .updateTable('email_codes')
      .set({ attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute()
    return false
  }

  await db
    .updateTable('email_codes')
    .set({ consumed_at: now })
    .where('id', '=', row.id)
    .execute()
  return true
}
