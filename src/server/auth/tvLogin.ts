import { randomInt } from 'node:crypto'

import { type Kysely, sql } from 'kysely'

import {
  badRequest,
  conflict,
  forbidden,
  unauthorized
} from '../../common/errors'
import {
  normalizeTvCode,
  type TvLoginPreview,
  type TvLoginRequest,
  type TvPlatform
} from '../../common/tvLogin'
import type { Database } from '../db/database'
import { checkLimits, type LimitRule, recordAttempts } from './rateLimit'
import {
  type Actor,
  createSession,
  isHumanSession,
  type NewSession
} from './sessions'
import { hashToken, makeToken, tokensMatch } from './tokens'
export const TV_LOGIN_LIFETIME_MS = 120_000
const invalid = (): Error =>
  unauthorized('That TV sign-in code has expired or is not valid')
export interface TvApproval {
  code?: string
  token?: string
}
export function tvApprovalHash(input: TvApproval): {
  column: 'code_hash' | 'qr_hash'
  hash: string
} {
  if ((input.code == null) === (input.token == null))
    throw badRequest('Enter a code or scan a QR code')
  if (input.code != null) {
    const code = normalizeTvCode(input.code)
    if (code == null)
      throw badRequest('Enter all eight letters shown on your TV')
    return { column: 'code_hash', hash: hashToken(code) }
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token!))
    throw badRequest('That is not a TV sign-in link')
  return { column: 'qr_hash', hash: hashToken(input.token!) }
}
export function requireTvHuman(actor: Actor): void {
  if (!isHumanSession(actor) || actor.sessionId == null)
    throw forbidden('Sign in to your account to connect a TV')
}
/** Serialize rate checks across server workers. */
async function charge(db: Kysely<Database>, rules: LimitRule[]): Promise<void> {
  await db.transaction().execute(async tx => {
    for (const rule of [...rules].sort((a, b) =>
      `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`)
    ))
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${rule.scope}:${rule.key}`}, 0))`.execute(
        tx
      )
    await checkLimits(tx, rules)
    await recordAttempts(tx, rules)
  })
}
export async function startTvLogin(
  db: Kysely<Database>,
  platform: TvPlatform,
  origin: string,
  ip: string | null,
  location: string | null = null
): Promise<TvLoginRequest> {
  await charge(db, [
    { scope: 'tv.start', key: ip ?? 'unknown', limit: 20, windowSec: 600 }
  ])
  await db
    .deleteFrom('tv_login_requests')
    .where('expires_at', '<=', new Date())
    .execute()
  for (;;) {
    const code = Array.from({ length: 8 }, () =>
      String.fromCharCode(65 + randomInt(26))
    ).join('')
    const requestId = makeToken()
    const clientSecret = makeToken()
    const token = makeToken()
    const expiresAt = Date.now() + TV_LOGIN_LIFETIME_MS
    const row = await db
      .insertInto('tv_login_requests')
      .values({
        id: requestId,
        code_hash: hashToken(code),
        qr_hash: hashToken(token),
        secret_hash: hashToken(clientSecret),
        platform,
        location,
        user_id: null,
        approved_at: null,
        consumed_at: null,
        expires_at: new Date(expiresAt)
      })
      .onConflict(oc => oc.column('code_hash').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (row != null)
      return {
        requestId,
        clientSecret,
        displayCode: `${code.slice(0, 4)}–${code.slice(4)}`,
        qrUrl: `${origin}/tv-login?token=${token}`,
        expiresAt
      }
  }
}
export async function inspectOrApproveTvLogin(
  db: Kysely<Database>,
  actor: Actor,
  input: TvApproval,
  ip: string | null,
  approve: boolean
): Promise<TvLoginPreview> {
  requireTvHuman(actor)
  const key = tvApprovalHash(input)
  await charge(db, [
    { scope: 'tv.approve.user', key: actor.userId, limit: 30, windowSec: 3600 },
    { scope: 'tv.approve.ip', key: ip ?? 'unknown', limit: 60, windowSec: 3600 }
  ])
  return await db.transaction().execute(async tx => {
    const row = await tx
      .selectFrom('tv_login_requests')
      .selectAll()
      .where(key.column, '=', key.hash)
      .forUpdate()
      .executeTakeFirst()
    if (
      row == null ||
      row.consumed_at != null ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      throw invalid()
    if (row.user_id != null && row.user_id !== actor.userId)
      throw conflict('This television was just signed in to another account')
    if (approve)
      await tx
        .updateTable('tv_login_requests')
        .set({ user_id: actor.userId, approved_at: new Date() })
        .where('id', '=', row.id)
        .execute()
    return {
      platform: row.platform,
      location: row.location,
      expiresAt: new Date(row.expires_at).getTime()
    }
  })
}
export async function claimTvLogin(
  db: Kysely<Database>,
  requestId: string,
  secret: string,
  userAgent?: string
): Promise<{ userId: string; session: NewSession } | null> {
  const rules = [
    { scope: 'tv.claim', key: hashToken(requestId), limit: 10, windowSec: 900 }
  ]
  await checkLimits(db, rules)
  const result = await db.transaction().execute(async tx => {
    const row = await tx
      .selectFrom('tv_login_requests')
      .selectAll()
      .where('id', '=', requestId)
      .forUpdate()
      .executeTakeFirst()
    if (row == null || !tokensMatch(row.secret_hash, hashToken(secret)))
      return 'invalid' as const
    if (
      row.consumed_at != null ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      throw invalid()
    if (row.user_id == null) return null
    const session = await createSession(tx, row.user_id, userAgent, {
      days: 180,
      deviceName: row.platform
    })
    await tx
      .updateTable('tv_login_requests')
      .set({ consumed_at: new Date() })
      .where('id', '=', row.id)
      .execute()
    return { userId: row.user_id, session }
  })
  if (result === 'invalid') {
    await charge(db, rules)
    throw invalid()
  }
  return result
}
