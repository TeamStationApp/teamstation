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
  /** Names the row, and is what the client that asked waits on. */
  id: string
  code: string
  /** The link's secret. Hashed in the database; shown once, in the e-mail. */
  token: string
  /** Held by the client that asked, so it can finish a sign-in done elsewhere. */
  clientSecret: string
  expiresAt: Date
}

export type SignInOrigin = 'web' | 'ios' | 'android'

/** One of the three places a sign-in can start. */
export function asSignInOrigin(raw: unknown): SignInOrigin {
  if (raw === 'ios' || raw === 'android' || raw === 'web') return raw
  throw new TypeError('Expected web, ios or android')
}

export async function createEmailCode(
  db: Kysely<Database>,
  email: string,
  purpose: CodePurpose,
  options: {
    origin?: SignInOrigin
    next?: string | null
    /**
     * An invite this sign-in carries, which is what lets it make an account.
     * Whichever door the person comes back through finds it on the row.
     */
    inviteId?: string | null
    /** What an account made by that invite will be called. */
    displayName?: string | null
  } = {}
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
      invite_id: options.inviteId ?? null,
      display_name: options.displayName ?? null,
      purpose,
      expires_at: expiresAt
    })
    .execute()

  return { id, code, token, clientSecret, expiresAt }
}

/**
 * The address in the e-mail.
 *
 * Always an ordinary `https://` link on our own domain, never a scheme of our
 * own: mail clients hide or strip what they do not know, and a link that
 * cannot open on a laptop is a dead end. With the app installed the operating
 * system hands this same address to it; without, it opens the browser, which
 * is the right answer in both cases.
 */
export function signInLink(
  publicUrl: string | undefined,
  token: string
): string {
  const base = (publicUrl ?? '').replace(/\/$/, '')
  return `${base}/signin/${token}`
}

export interface LinkClaim {
  email: string
  next: string | null
  origin: SignInOrigin
  /** Set when this sign-in was asked for from an invite. */
  inviteId: string | null
  displayName: string | null
}

/**
 * Spend the link, and the code with it.
 *
 * A `GET` never reaches this: the address in the e-mail loads the app, which
 * asks for this once it is running. That is what keeps a mail
 * scanner — which follows links and runs no scripts — from burning a sign-in
 * before it is read.
 */
export async function claimSignInLink(
  db: Kysely<Database>,
  token: string
): Promise<LinkClaim | null> {
  // One statement, so whichever claim updates the row spent the link: two
  // racing — two tabs, or a link and its code — cannot both find it unspent.
  const now = new Date()
  const row = await db
    .updateTable('email_codes')
    .set({ consumed_at: now, approved_at: now })
    .where('token_hash', '=', hashEmailCode(token.trim()))
    .where('purpose', '=', 'login')
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .returning(['email', 'next_path', 'origin', 'invite_id', 'display_name'])
    .executeTakeFirst()
  if (row == null) return null

  return {
    email: row.email,
    next: row.next_path,
    origin: row.origin,
    inviteId: row.invite_id,
    displayName: row.display_name
  }
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
): Promise<{
  email: string
  next: string | null
  inviteId: string | null
  displayName: string | null
} | null> {
  const row = await db
    .selectFrom('email_codes')
    .select([
      'id',
      'email',
      'approved_at',
      'client_secret_hash',
      'next_path',
      'invite_id',
      'display_name'
    ])
    .where('id', '=', id)
    .executeTakeFirst()
  if (row?.approved_at == null) return null
  if (row.client_secret_hash == null) return null
  if (!tokensMatch(row.client_secret_hash, hashEmailCode(clientSecret))) {
    return null
  }
  return {
    email: row.email,
    next: row.next_path,
    inviteId: row.invite_id,
    displayName: row.display_name
  }
}

/** What a spent code carried, beyond the fact that it was right. */
export interface CodeClaim {
  inviteId: string | null
  displayName: string | null
}

/**
 * Checks a code and consumes it on success. A wrong guess counts against the
 * code, and the code dies after five, so a six-digit secret cannot be walked
 * through. Returns null for expired, consumed, exhausted and wrong alike, and
 * on success whatever the sign-in was asked for with.
 */
export async function verifyEmailCode(
  db: Kysely<Database>,
  email: string,
  purpose: CodePurpose,
  code: string
): Promise<CodeClaim | null> {
  const normalised = email.trim().toLowerCase()
  const now = new Date()

  const row = await db
    .selectFrom('email_codes')
    .select([
      'id',
      'code_hash',
      'attempts',
      'expires_at',
      'invite_id',
      'display_name'
    ])
    .where('email', '=', normalised)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()

  if (row == null) return null
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null
  if (row.attempts >= MAX_ATTEMPTS) return null

  if (row.code_hash !== hashEmailCode(code.trim())) {
    // Counted in the database, so wrong guesses sent together each count.
    await db
      .updateTable('email_codes')
      .set(eb => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', row.id)
      .execute()
    return null
  }

  // The link spends this same row, so the code is only good if this is the
  // write that spent it.
  const spent = await db
    .updateTable('email_codes')
    .set({ consumed_at: now, approved_at: now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .executeTakeFirst()
  if (spent.numUpdatedRows === BigInt(0)) return null
  return { inviteId: row.invite_id, displayName: row.display_name }
}
