import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'

/**
 * Finding a person by an address they typed.
 *
 * An address is an attribute of an account, not its identity: one person holds
 * several, and signing in with any of them reaches the same account. So every
 * lookup goes through `user_emails`, and a merged-away account is never
 * returned — its addresses have already moved to the account that absorbed it,
 * and answering as the closed one would sign somebody in to a dead row.
 */

export interface FoundUser {
  id: number
  displayName: string
  /** The address that was asked for, not necessarily the primary one. */
  email: string
  passwordHash: string | null
  loginEnabled: boolean
  isAdmin: boolean
}

export async function findUserByEmail(
  db: Kysely<Database>,
  email: string
): Promise<FoundUser | undefined> {
  const wanted = email.trim().toLowerCase()
  if (wanted === '') return undefined

  const row = await db
    .selectFrom('user_emails')
    .innerJoin('users', 'users.id', 'user_emails.user_id')
    .select([
      'users.id as id',
      'users.display_name as displayName',
      'user_emails.email as email',
      'users.password_hash as passwordHash',
      'users.login_enabled as loginEnabled',
      'users.is_admin as isAdmin'
    ])
    .where(eb => eb.fn('lower', ['user_emails.email']), '=', wanted)
    .where('users.merged_into', 'is', null)
    .executeTakeFirst()

  return row
}

/** A person's primary address, for showing back to them. */
export async function primaryEmail(
  db: Kysely<Database>,
  userId: number
): Promise<string | undefined> {
  const row = await db
    .selectFrom('user_emails')
    .select(['email'])
    .where('user_id', '=', userId)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .executeTakeFirst()
  return row?.email
}

export interface AddEmailOptions {
  isPrimary?: boolean
  source?: 'peertube' | 'import' | 'manual'
  verifiedAt?: Date | null
}

/**
 * Attaches an address to an account.
 *
 * Returns the account that already holds it when somebody else does — the
 * caller decides whether that is a merge, a mistake or a conflict to report,
 * because this layer cannot know.
 */
export async function addEmail(
  db: Kysely<Database>,
  userId: number,
  email: string,
  options: AddEmailOptions = {}
): Promise<{ added: boolean; heldBy?: number }> {
  const wanted = email.trim()
  const existing = await db
    .selectFrom('user_emails')
    .select(['user_id'])
    .where(eb => eb.fn('lower', ['email']), '=', wanted.toLowerCase())
    .executeTakeFirst()

  if (existing != null) {
    return existing.user_id === userId
      ? { added: false }
      : { added: false, heldBy: existing.user_id }
  }

  await db
    .insertInto('user_emails')
    .values({
      id: makeId('userEmail'),
      user_id: userId,
      email: wanted,
      is_primary: options.isPrimary ?? false,
      source: options.source ?? 'manual',
      verified_at: options.verifiedAt ?? null
    })
    .execute()
  return { added: true }
}
