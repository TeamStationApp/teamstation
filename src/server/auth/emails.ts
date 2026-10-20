import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { openRowOf } from '../admin/people'
import type { Database } from '../db/database'

/**
 * Finding a person by an address they typed.
 *
 * An address is an attribute of an account, not its identity: one person holds
 * several, and signing in with any of them reaches the same account. So every
 * lookup goes through `user_emails`.
 *
 * A merge moves no addresses: they stay on the account that was closed, with
 * everything else it had. So the address is looked up wherever it is, and an
 * account that has been merged answers as the open account at the end of its
 * chain of merges (`openRowOf`) — its name, its password, whether it may sign
 * in. Signing in with a merged-away address signs in to the account that was
 * kept; when that chain reaches no open account the address finds nobody.
 */

export interface FoundUser {
  id: string
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

  const held = await db
    .selectFrom('user_emails')
    .select(['user_id', 'email'])
    .where(eb => eb.fn('lower', ['email']), '=', wanted)
    .executeTakeFirst()
  if (held == null) return undefined

  const userId = await openRowOf(db, held.user_id)
  if (userId == null) return undefined

  const row = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'password_hash as passwordHash',
      'login_enabled as loginEnabled',
      'is_admin as isAdmin'
    ])
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  if (row == null) return undefined

  return { ...row, email: held.email }
}

/** A person's primary address, for showing back to them. */
export async function primaryEmail(
  db: Kysely<Database>,
  userId: string
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
  userId: string,
  email: string,
  options: AddEmailOptions = {}
): Promise<{ added: boolean; heldBy?: string }> {
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
