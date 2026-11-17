import { randomBytes } from 'node:crypto'

import type { Kysely } from 'kysely'

import { addEmail } from '../../auth/emails'
import { hashPassword } from '../../auth/passwords'
import type { Database } from '../../db/database'
import { insertUser } from '../../users/insertUser'
import { testAddress } from './address'

/** One person a fixture made. The password is on the manifest and nowhere else. */
export interface FixtureAccount {
  role: string
  email: string
  password: string
  userId: string
  displayName: string
}

export interface FixtureManifest {
  world: string
  nonce: string
  accounts: Record<string, FixtureAccount>
  /** Every other id the world made, by name. */
  ids: Record<string, string>
}

export interface WorldContext {
  db: Kysely<Database>
  mailbox: string
  nonce: string
}

export function makeNonce(): string {
  return randomBytes(4).toString('hex')
}

/** Invented people, with MLB players' names, as `AGENTS.md` asks of test data. */
export interface Person {
  first: string
  last: string
}

/** A person who can sign in with a generated password and has finished onboarding. */
export async function createAccount(
  context: WorldContext,
  world: string,
  role: string,
  person: Person,
  options: { isAdmin?: boolean } = {}
): Promise<FixtureAccount> {
  const { db, mailbox, nonce } = context
  const password = randomBytes(18).toString('base64url')
  const email = testAddress(mailbox, `${world}-${role}-${nonce}`)
  const displayName = `${person.first} ${person.last}`
  const userId = await insertUser(db, {
    display_name: displayName,
    first_name: person.first,
    last_name: person.last,
    password_hash: await hashPassword(password),
    login_enabled: true,
    is_admin: options.isAdmin === true,
    onboarding_step: 'complete',
    onboarding_completed_at: new Date()
  })
  await addEmail(db, userId, email, { isPrimary: true, source: 'manual' })
  return { role, email, password, userId, displayName }
}
