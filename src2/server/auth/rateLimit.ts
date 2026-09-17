import type { Request } from 'express'
import type { Kysely } from 'kysely'

import { rateLimited } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'

/**
 * How often one address, or one client, may attempt something.
 *
 * Counted in the database rather than in memory. The server forks a worker per
 * core, so an in-memory counter is silently divided by the worker count and the
 * real limit becomes whatever the load balancer happened to do — a limit that
 * looks enforced and is not is worse than none, because nobody looks again.
 */
export interface LimitRule {
  /** What is being limited, e.g. `emailCode.address`. */
  scope: string
  /** Who is doing it: an e-mail address, or a client IP. */
  key: string
  /** How many attempts the window allows. */
  limit: number
  windowSec: number
}

/**
 * The client's address, or null when it cannot be believed.
 *
 * Caddy proxies from the loopback and sets `X-Forwarded-For`, which Express
 * resolves because `trust proxy` is set to `loopback`. If either of those ever
 * stops being true, every request arrives looking like `127.0.0.1` — and a
 * per-client limit keyed on that would treat the whole world as one person and
 * lock everybody out at once.
 *
 * So a loopback address is read as "unknown" and the per-client rule is skipped
 * rather than applied to everyone. The failure that follows a misconfiguration
 * is then a limit that is too loose, which is noticed in a log, instead of a
 * site that refuses every sign-in, which is noticed by Paul.
 */
export function clientIp(req: Request): string | null {
  const raw = typeof req.ip === 'string' ? req.ip : ''
  const bare = raw.replace(/^::ffff:/, '')
  if (bare === '' || bare === '127.0.0.1' || bare === '::1') return null
  return bare
}

/**
 * Throws when any rule is already used up, and says how long to wait.
 *
 * Checking is separate from recording because the two are not always wanted
 * together: a wrong password should count against the guesser, while a correct
 * one should not count against a person who simply signs in often.
 */
export async function checkLimits(
  db: Kysely<Database>,
  rules: LimitRule[]
): Promise<void> {
  const now = Date.now()
  for (const rule of rules) {
    const since = new Date(now - rule.windowSec * 1000)
    const rows = await db
      .selectFrom('rate_events')
      .select('at')
      .where('scope', '=', rule.scope)
      .where('key', '=', rule.key)
      .where('at', '>=', since)
      .orderBy('at', 'asc')
      .limit(rule.limit)
      .execute()

    if (rows.length < rule.limit) continue

    // The window frees up when its oldest attempt falls out of it.
    const oldest = new Date(rows[0].at).getTime()
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + rule.windowSec * 1000 - now) / 1000)
    )
    throw rateLimited(
      `Too many attempts. Try again in ${describeWait(retryAfterSec)}.`,
      retryAfterSec
    )
  }
}

/**
 * Records an attempt against each rule, and drops that key's attempts that have
 * fallen out of the window.
 *
 * Pruning here rather than in a sweeper keeps the table proportional to recent
 * traffic with nothing else to run, remember or monitor.
 */
export async function recordAttempts(
  db: Kysely<Database>,
  rules: LimitRule[]
): Promise<void> {
  for (const rule of rules) {
    await db
      .insertInto('rate_events')
      .values({
        id: makeId('rateEvent'),
        scope: rule.scope,
        key: rule.key
      })
      .execute()

    await db
      .deleteFrom('rate_events')
      .where('scope', '=', rule.scope)
      .where('key', '=', rule.key)
      .where('at', '<', new Date(Date.now() - rule.windowSec * 1000))
      .execute()
  }
}

/** "3 minutes", "45 seconds" — for a message a person reads. */
function describeWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}
