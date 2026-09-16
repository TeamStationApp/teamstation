import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { hashToken, makeToken } from './tokens'

/** Who is making a request, once a token has been resolved. */
export interface Actor {
  userId: string
  isAdmin: boolean
  /** Set when the caller used a machine token rather than signing in. */
  apiTokenId?: string
  scopes: string[]
}

const SESSION_DAYS = 30

export interface NewSession {
  /** Shown once. Only its hash is stored. */
  token: string
  sessionId: string
  expiresAt: Date
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  userAgent: string | undefined
): Promise<NewSession> {
  const token = makeToken()
  const sessionId = makeId('authSession')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000)

  await db
    .insertInto('auth_sessions')
    .values({
      id: sessionId,
      user_id: userId,
      token_hash: hashToken(token),
      user_agent: userAgent ?? null,
      expires_at: expiresAt
    })
    .execute()

  return { token, sessionId, expiresAt }
}

/**
 * Resolves a bearer token to whoever is behind it, trying sessions first and
 * then machine tokens. Returns undefined for anything expired, revoked or
 * unknown — a caller cannot tell which, on purpose.
 */
export async function actorForToken(
  db: Kysely<Database>,
  token: string
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
      'users.is_admin as isAdmin'
    ])
    .where('auth_sessions.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (session != null) {
    if (session.revokedAt != null) return undefined
    if (new Date(session.expiresAt).getTime() <= now.getTime()) return undefined
    await db
      .updateTable('auth_sessions')
      .set({ last_used_at: now })
      .where('id', '=', session.sessionId)
      .execute()
    return { userId: session.userId, isAdmin: session.isAdmin, scopes: [] }
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
      'users.is_admin as isAdmin'
    ])
    .where('api_tokens.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (apiToken == null) return undefined
  if (apiToken.revokedAt != null) return undefined
  if (
    apiToken.expiresAt != null &&
    new Date(apiToken.expiresAt).getTime() <= now.getTime()
  ) {
    return undefined
  }

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
