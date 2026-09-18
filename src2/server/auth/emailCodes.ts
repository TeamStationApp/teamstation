import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { hashEmailCode, makeEmailCode, makeToken, tokensMatch } from './tokens'

const CODE_MINUTES = 10
const MAX_ATTEMPTS = 5

export type CodePurpose = 'login' | 'verify' | 'reset'

/**
 * Issues a code and returns it to the caller to deliver. Any earlier unused
 * code for the same address and purpose is consumed first, so only the newest
 * one works and a stream of requests cannot widen the guessing window.
 */
export interface SignInRequest {
  /** Names the row, and rides on the link so a browser can recognise its own. */
  id: string
  code: string
  /** The link's secret. Hashed in the database; shown once, in the e-mail. */
  token: string
  /** Held by the client that asked, so it can finish a sign-in done elsewhere. */
  clientSecret: string
  expiresAt: Date
}

export type SignInOrigin = 'web' | 'ios' | 'android'

export async function createEmailCode(
  db: Kysely<Database>,
  email: string,
  purpose: CodePurpose,
  options: { origin?: SignInOrigin; next?: string | null } = {}
): Promise<SignInRequest> {
  const normalised = email.trim().toLowerCase()
  const now = new Date()

  await db
    .updateTable('email_codes')
    .set({ consumed_at: now })
    .where('email', '=', normalised)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .execute()

  const id = makeId('emailCode')
  const code = makeEmailCode()
  // The link and the code are the same sign-in: both live on this row, and
  // whichever arrives first consumes it.
  const token = makeToken()
  const clientSecret = makeToken()
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000)
  await db
    .insertInto('email_codes')
    .values({
      id,
      email: normalised,
      code_hash: hashEmailCode(code),
      token_hash: hashEmailCode(token),
      client_secret_hash: hashEmailCode(clientSecret),
      origin: options.origin ?? 'web',
      next_path: options.next ?? null,
      purpose,
      expires_at: expiresAt
    })
    .execute()

  return { id, code, token, clientSecret, expiresAt }
}

export interface LinkClaim {
  email: string
  next: string | null
  origin: SignInOrigin
}

/**
 * Spend the link, and the code with it.
 *
 * A `GET` never reaches this: the address in the e-mail loads the app, which
 * asks for this once a person is behind it. That is what keeps a mail
 * scanner — which follows links and runs no scripts — from burning a sign-in
 * before it is read.
 */
export async function claimSignInLink(
  db: Kysely<Database>,
  token: string
): Promise<LinkClaim | null> {
  const now = new Date()
  const row = await db
    .selectFrom('email_codes')
    .select(['id', 'email', 'expires_at', 'consumed_at', 'next_path', 'origin'])
    .where('token_hash', '=', hashEmailCode(token.trim()))
    .where('purpose', '=', 'login')
    .executeTakeFirst()

  if (row == null) return null
  if (row.consumed_at != null) return null
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null

  await db
    .updateTable('email_codes')
    .set({ consumed_at: now, approved_at: now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .execute()

  return { email: row.email, next: row.next_path, origin: row.origin }
}

/**
 * What the client that asked for the sign-in is waiting on.
 *
 * It polls with a secret only it holds, so a link opened on a laptop finishes
 * the sign-in the phone is still waiting for — and nobody else can ask on its
 * behalf.
 */
export async function claimApprovedRequest(
  db: Kysely<Database>,
  id: string,
  clientSecret: string
): Promise<{ email: string; next: string | null } | null> {
  const row = await db
    .selectFrom('email_codes')
    .select(['id', 'email', 'approved_at', 'client_secret_hash', 'next_path'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (row?.approved_at == null) return null
  if (row.client_secret_hash == null) return null
  if (!tokensMatch(row.client_secret_hash, hashEmailCode(clientSecret))) {
    return null
  }
  return { email: row.email, next: row.next_path }
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
    .set({ consumed_at: now, approved_at: now })
    .where('id', '=', row.id)
    .execute()
  return true
}
