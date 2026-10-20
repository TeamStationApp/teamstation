import { type Kysely, sql } from 'kysely'

import { unauthorized } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { hashToken, makeToken } from './tokens'

/** Who is making a request, once a token has been resolved. */
export interface Actor {
  userId: string
  isAdmin: boolean
  /** Set when the caller used a machine token rather than signing in. */
  apiTokenId?: string
  /** The human login this actor came from; absent for machine tokens. */
  sessionId?: string
  scopes: string[]
}

const SESSION_DAYS = 30

export interface NewSession {
  /** Shown once. Only its hash is stored. */
  token: string
  sessionId: string
  expiresAt: Date
}

export interface SessionOptions {
  /** How long it lasts. A browser gets a month; a Director gets a season. */
  days?: number
  /** What this session is, when it is a thing rather than a browser tab. */
  deviceName?: string
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  userAgent: string | undefined,
  options: SessionOptions = {}
): Promise<NewSession> {
  const write = async (source: Kysely<Database>): Promise<NewSession> => {
    const user = await source
      .selectFrom('users')
      .select(['disabled_at', 'merged_into'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (user == null || user.disabled_at != null || user.merged_into != null)
      throw unauthorized('This account cannot sign in')
    const token = makeToken()
    const sessionId = makeId('authSession')
    const days = options.days ?? SESSION_DAYS
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000)

    await source
      .insertInto('auth_sessions')
      .values({
        id: sessionId,
        user_id: userId,
        token_hash: hashToken(token),
        user_agent: userAgent ?? null,
        device_name: options.deviceName ?? null,
        expires_at: expiresAt
      })
      .execute()

    return { token, sessionId, expiresAt }
  }
  return db.isTransaction
    ? await write(db)
    : await db.transaction().execute(write)
}

/**
 * Resolves a bearer token to whoever is behind it, trying sessions first and
 * then machine tokens. Returns undefined for anything expired, revoked or
 * unknown — a caller cannot tell which, on purpose.
 *
 * A token whose account has been merged into another is refused the same way.
 * A merge revokes everything the closing account held (`signOutEverywhere`),
 * so this is the second lock on the same door: it holds for a row closed before
 * merges revoked anything, and for one closed by hand. Every client already
 * treats a refused token as "signed out, sign in again", and signing in again
 * with either account's address lands on the account that was kept.
 *
 * Repeated delivery checks may omit the last-used write so validation remains
 * read-only inside a transaction holding the current game.
 */
export async function actorForToken(
  db: Kysely<Database>,
  token: string,
  options: { recordUse?: boolean } = {}
): Promise<Actor | undefined> {
  const tokenHash = hashToken(token)
  const now = new Date()

  const session = await db
    .selectFrom('auth_sessions')
    .innerJoin('users', 'users.id', 'auth_sessions.user_id')
    .select([
      'auth_sessions.id as sessionId',
      'auth_sessions.user_id as userId',
      'auth_sessions.expires_at as expiresAt',
      'auth_sessions.revoked_at as revokedAt',
      'users.is_admin as isAdmin',
      'users.disabled_at as disabledAt',
      'users.merged_into as mergedInto'
    ])
    .where('auth_sessions.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (session != null) {
    if (session.disabledAt != null || session.mergedInto != null)
      return undefined
    if (session.revokedAt != null) return undefined
    if (new Date(session.expiresAt).getTime() <= now.getTime()) return undefined
    if (options.recordUse !== false)
      await db
        .updateTable('auth_sessions')
        .set({ last_used_at: now })
        .where('id', '=', session.sessionId)
        .execute()
    return {
      userId: session.userId,
      isAdmin: session.isAdmin,
      sessionId: session.sessionId,
      scopes: []
    }
  }

  const apiToken = await db
    .selectFrom('api_tokens')
    .innerJoin('users', 'users.id', 'api_tokens.user_id')
    .select([
      'api_tokens.id as tokenId',
      'api_tokens.user_id as userId',
      'api_tokens.scopes as scopes',
      'api_tokens.expires_at as expiresAt',
      'api_tokens.revoked_at as revokedAt',
      'users.is_admin as isAdmin',
      'users.disabled_at as disabledAt',
      'users.merged_into as mergedInto'
    ])
    .where('api_tokens.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (apiToken == null) return undefined
  if (apiToken.disabledAt != null || apiToken.mergedInto != null)
    return undefined
  if (apiToken.revokedAt != null) return undefined
  if (
    apiToken.expiresAt != null &&
    new Date(apiToken.expiresAt).getTime() <= now.getTime()
  ) {
    return undefined
  }

  if (options.recordUse !== false)
    await db
      .updateTable('api_tokens')
      .set({ last_used_at: now })
      .where('id', '=', apiToken.tokenId)
      .execute()

  return {
    userId: apiToken.userId,
    isAdmin: apiToken.isAdmin,
    apiTokenId: apiToken.tokenId,
    scopes: apiToken.scopes
  }
}

export async function revokeSession(
  db: Kysely<Database>,
  token: string
): Promise<void> {
  await db
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date() })
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .execute()
}

/** What `signOutEverywhere` took away. */
export interface SignedOut {
  sessions: number
  apiTokens: number
  oauthGrants: number
}

/**
 * Signs one account out of everything it is signed in to: every session on
 * every device, every machine token, and every OAuth grant with the tokens
 * issued under it.
 *
 * A merge calls this for the account it closes, inside the merge's own
 * transaction, so a device signed in as the closed account can make no request
 * once the merge has committed. It must sign in again, and doing so with
 * either account's address lands on the account that was kept.
 *
 * Sessions and machine tokens are marked revoked rather than deleted: when they
 * were last used is still the answer to "has this account ever been used", and
 * a merge that is undone leaves them revoked, because a device that was signed
 * out should not find itself signed back in to an account it was told had gone.
 * OAuth records are deleted, which is how the provider itself revokes them; a
 * grant is dead in any case once the session that approved it is.
 */
export async function signOutEverywhere(
  db: Kysely<Database>,
  userId: string,
  at = new Date()
): Promise<SignedOut> {
  const sessions = await db
    .updateTable('auth_sessions')
    .set({ revoked_at: at })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  const apiTokens = await db
    .updateTable('api_tokens')
    .set({ revoked_at: at })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  // A Grant is stored under its own id; every token issued under it carries
  // the grant's id in `grant_hash`.
  await sql`delete from oauth_records r using oauth_grant_sessions g
    where g.user_id = ${userId}
      and (r.grant_hash = g.grant_hash or (r.model = 'Grant' and r.id_hash = g.grant_hash))`.execute(
    db
  )
  const grants = await sql`delete from oauth_grant_sessions
    where user_id = ${userId}`.execute(db)
  return {
    sessions: Number(sessions.numUpdatedRows),
    apiTokens: Number(apiTokens.numUpdatedRows),
    oauthGrants: Number(grants.numAffectedRows ?? 0)
  }
}

/** Drops sessions that expired a while ago. Called by the nightly job. */
export async function purgeExpiredSessions(
  db: Kysely<Database>,
  before: Date
): Promise<number> {
  const result = await db
    .deleteFrom('auth_sessions')
    .where('expires_at', '<', before)
    .executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}
