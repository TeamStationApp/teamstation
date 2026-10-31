import {
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  sql,
  type SqlBool
} from 'kysely'

import type { ApiKeyPermission } from '../../common/apiKeys'
import { unauthorized } from '../../common/errors'
import { makeId } from '../../common/ids'
import { anyOf } from '../db/anyOf'
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
  /**
   * Set when Tess's tools sent the request: the person's own session, but a
   * machine acting for them, not the person. See `isMachine`.
   */
  viaTess?: true
  /**
   * Set when the caller used an API key the person made under Account: the
   * person, within the permissions the key holds. See `keyAllows`.
   */
  apiKey?: { id: string; permissions: ReadonlySet<ApiKeyPermission> }
  scopes: string[]
}

/**
 * How often a credential's `last_used_at` is written, at most: one GraphQL
 * query reads through the same session, token or key many times at once,
 * and the row need not be written for each.
 */
const USE_GRANULARITY_MS = 60_000

/** A `last_used_at` never written, or written more than a minute ago. */
function staleUse(
  now: Date
): (
  eb: ExpressionBuilder<
    Database,
    'auth_sessions' | 'api_tokens' | 'user_api_keys'
  >
) => Expression<SqlBool> {
  return eb =>
    eb.or([
      eb('last_used_at', 'is', null),
      eb('last_used_at', '<', new Date(now.getTime() - USE_GRANULARITY_MS))
    ])
}

/** What every user API key's secret starts with. */
export const USER_API_KEY_PREFIX = 'tsk_'

/**
 * Whether the caller may use `permission`: anyone who is not using an API
 * key, and a key that holds it.
 */
export function keyAllows(
  actor: Actor | undefined,
  permission: ApiKeyPermission
): boolean {
  return actor?.apiKey == null || actor.apiKey.permissions.has(permission)
}

/**
 * Whether the person is here themselves, signed in: not a machine token, not
 * Tess, not an API key. Only they may make or remove the account's keys.
 */
export function isHumanSession(actor: Actor): boolean {
  return !isMachine(actor) && actor.apiKey == null
}

/**
 * Whether a machine is acting for the person rather than the person
 * themselves: a machine token, or Tess's tools on their session. A route for
 * the person alone (their account, its keys, approving another app) refuses
 * either one.
 */
export function isMachine(actor: Actor): boolean {
  return actor.apiTokenId != null || actor.viaTess === true
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
 * Resolves a bearer token to whoever is behind it: a user API key by its
 * `tsk_` prefix, otherwise a session and then a machine token. Returns undefined for anything expired, revoked or
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
  const actors = await actorsForTokens(db, [token])
  const actor = actors.get(token)
  if (actor != null && options.recordUse !== false)
    await recordCredentialUse(db, actor, new Date())
  return actor
}

/**
 * `actorForToken` of each of these tokens at once, recording no use: whoever
 * each resolves to, with a token refused for any reason left out. A read of
 * each kind of credential, for all the tokens still unanswered, however many
 * there are.
 */
export async function actorsForTokens(
  db: Kysely<Database>,
  tokens: readonly string[]
): Promise<Map<string, Actor>> {
  const actors = new Map<string, Actor>()
  const hashes = new Map(tokens.map(token => [token, hashToken(token)]))
  const now = new Date()

  // A session token can begin `tsk_` too, one in 16.7 million: one that is
  // no key is looked for as a session after all.
  const keyShaped = [...hashes.keys()].filter(token =>
    token.startsWith(USER_API_KEY_PREFIX)
  )
  if (keyShaped.length > 0) {
    const keys = await db
      .selectFrom('user_api_keys')
      .innerJoin('users', 'users.id', 'user_api_keys.user_id')
      .select([
        'user_api_keys.id as keyId',
        'user_api_keys.user_id as userId',
        'user_api_keys.token_hash as tokenHash',
        'user_api_keys.permissions as permissions',
        'user_api_keys.revoked_at as revokedAt',
        'users.is_admin as isAdmin',
        'users.disabled_at as disabledAt',
        'users.merged_into as mergedInto'
      ])
      .where(
        'user_api_keys.token_hash',
        '=',
        anyOf(keyShaped.map(token => hashes.get(token)!))
      )
      .execute()
    const keyed = new Map(keys.map(key => [key.tokenHash, key]))
    for (const token of keyShaped) {
      const key = keyed.get(hashes.get(token)!)
      if (key == null || key.revokedAt != null) continue
      if (key.disabledAt != null || key.mergedInto != null) continue
      actors.set(token, {
        userId: key.userId,
        isAdmin: key.isAdmin,
        apiKey: {
          id: key.keyId,
          permissions: new Set(key.permissions as ApiKeyPermission[])
        },
        scopes: []
      })
    }
  }

  const unkeyed = [...hashes.keys()].filter(token => !actors.has(token))
  if (unkeyed.length === 0) return actors
  const sessions = await db
    .selectFrom('auth_sessions')
    .innerJoin('users', 'users.id', 'auth_sessions.user_id')
    .select([
      'auth_sessions.id as sessionId',
      'auth_sessions.user_id as userId',
      'auth_sessions.token_hash as tokenHash',
      'auth_sessions.expires_at as expiresAt',
      'auth_sessions.revoked_at as revokedAt',
      'users.is_admin as isAdmin',
      'users.disabled_at as disabledAt',
      'users.merged_into as mergedInto'
    ])
    .where(
      'auth_sessions.token_hash',
      '=',
      anyOf(unkeyed.map(token => hashes.get(token)!))
    )
    .execute()
  const bySession = new Map(sessions.map(row => [row.tokenHash, row]))
  // A token found as a session is answered by that session, even when it
  // refuses: only one found nowhere is looked for as a machine token.
  const unfound: string[] = []
  for (const token of unkeyed) {
    const session = bySession.get(hashes.get(token)!)
    if (session == null) {
      unfound.push(token)
      continue
    }
    if (session.disabledAt != null || session.mergedInto != null) continue
    if (session.revokedAt != null) continue
    if (new Date(session.expiresAt).getTime() <= now.getTime()) continue
    actors.set(token, {
      userId: session.userId,
      isAdmin: session.isAdmin,
      sessionId: session.sessionId,
      scopes: []
    })
  }
  if (unfound.length === 0) return actors

  const apiTokens = await db
    .selectFrom('api_tokens')
    .innerJoin('users', 'users.id', 'api_tokens.user_id')
    .select([
      'api_tokens.id as tokenId',
      'api_tokens.user_id as userId',
      'api_tokens.token_hash as tokenHash',
      'api_tokens.scopes as scopes',
      'api_tokens.expires_at as expiresAt',
      'api_tokens.revoked_at as revokedAt',
      'users.is_admin as isAdmin',
      'users.disabled_at as disabledAt',
      'users.merged_into as mergedInto'
    ])
    .where(
      'api_tokens.token_hash',
      '=',
      anyOf(unfound.map(token => hashes.get(token)!))
    )
    .execute()
  const byApiToken = new Map(apiTokens.map(row => [row.tokenHash, row]))
  for (const token of unfound) {
    const apiToken = byApiToken.get(hashes.get(token)!)
    if (apiToken == null) continue
    if (apiToken.disabledAt != null || apiToken.mergedInto != null) continue
    if (apiToken.revokedAt != null) continue
    if (
      apiToken.expiresAt != null &&
      new Date(apiToken.expiresAt).getTime() <= now.getTime()
    )
      continue
    actors.set(token, {
      userId: apiToken.userId,
      isAdmin: apiToken.isAdmin,
      apiTokenId: apiToken.tokenId,
      scopes: apiToken.scopes
    })
  }
  return actors
}

/** Writes `last_used_at` on whichever credential this actor came through. */
async function recordCredentialUse(
  db: Kysely<Database>,
  actor: Actor,
  now: Date
): Promise<void> {
  if (actor.apiKey != null)
    await db
      .updateTable('user_api_keys')
      .set({ last_used_at: now })
      .where('id', '=', actor.apiKey.id)
      .where(staleUse(now))
      .execute()
  else if (actor.sessionId != null)
    await db
      .updateTable('auth_sessions')
      .set({ last_used_at: now })
      .where('id', '=', actor.sessionId)
      .where(staleUse(now))
      .execute()
  else if (actor.apiTokenId != null)
    await db
      .updateTable('api_tokens')
      .set({ last_used_at: now })
      .where('id', '=', actor.apiTokenId)
      .where(staleUse(now))
      .execute()
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
  apiKeys: number
  oauthGrants: number
}

/**
 * Signs one account, or each of several, out of everything it is signed in
 * to: every session on every device, every machine token, every API key the
 * person made, and every OAuth grant with the tokens issued under it.
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
  userId: string | readonly string[],
  at = new Date()
): Promise<SignedOut> {
  const userIds = typeof userId === 'string' ? [userId] : [...userId]
  if (userIds.length === 0)
    return { sessions: 0, apiTokens: 0, apiKeys: 0, oauthGrants: 0 }
  const sessions = await db
    .updateTable('auth_sessions')
    .set({ revoked_at: at })
    .where('user_id', 'in', userIds)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  const apiTokens = await db
    .updateTable('api_tokens')
    .set({ revoked_at: at })
    .where('user_id', 'in', userIds)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  const apiKeys = await db
    .updateTable('user_api_keys')
    .set({ revoked_at: at })
    .where('user_id', 'in', userIds)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  // A Grant is stored under its own id; every token issued under it carries
  // the grant's id in `grant_hash`.
  const ids = sql.join(userIds)
  await sql`delete from oauth_records r using oauth_grant_sessions g
    where g.user_id in (${ids})
      and (r.grant_hash = g.grant_hash or (r.model = 'Grant' and r.id_hash = g.grant_hash))`.execute(
    db
  )
  const grants = await sql`delete from oauth_grant_sessions
    where user_id in (${ids})`.execute(db)
  return {
    sessions: Number(sessions.numUpdatedRows),
    apiTokens: Number(apiTokens.numUpdatedRows),
    apiKeys: Number(apiKeys.numUpdatedRows),
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
