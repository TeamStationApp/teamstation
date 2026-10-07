import type { RequestHandler } from 'express'
import { type Kysely, sql } from 'kysely'

import { checkLimits, clientIp, recordAttempts } from '../auth/rateLimit'
import type { Database } from '../db/database'
import { withAsync } from '../middleware/withErrors'

/** No authorization decision depends on an IP address; this bounds abuse only. */
export function oauthRequestLimit(db: Kysely<Database>): RequestHandler {
  return withAsync(async (req, _res, next) => {
    const rules = [
      {
        scope: 'oauth.request',
        key: clientIp(req) ?? 'unknown',
        limit: 120,
        windowSec: 60
      }
    ]
    await checkLimits(db, rules)
    await recordAttempts(db, rules)
    next()
  })
}

export async function pruneOAuth(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async tx => {
    await sql`delete from oauth_records where expires_at <= now()`.execute(tx)
    await sql`delete from oauth_approvals where expires_at <= now()`.execute(tx)
    await sql`delete from oauth_decisions where expires_at <= now()`.execute(tx)
    await sql`delete from oauth_grant_sessions g where not exists (
      select 1 from oauth_records r where r.model = 'Grant' and r.id_hash = g.grant_hash
    )`.execute(tx)
  })
}

export function scheduleOAuthPrune(
  db: Kysely<Database>,
  intervalMs = 3600000
): NodeJS.Timeout {
  const timer = setInterval(() => {
    pruneOAuth(db).catch(() => {
      console.error('OAuth record cleanup failed')
    })
  }, intervalMs)
  timer.unref()
  return timer
}
