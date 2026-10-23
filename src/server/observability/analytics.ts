import { type Kysely, sql } from 'kysely'

import { badRequest, forbidden, unauthorized } from '../../common/errors'
import {
  ANONYMOUS_EVENTS,
  bytes,
  type EventRecord,
  parseBatch,
  parseEvent,
  SERVER_EVENTS
} from '../../common/observability/contract'
import { canSeeGame, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'

export function analyticsBatch(body: unknown, now = Date.now()): EventRecord[] {
  try {
    if (typeof body === 'string') return parseBatch(body, now)
    if (
      !Array.isArray(body) ||
      body.length < 1 ||
      body.length > 50 ||
      bytes(JSON.stringify(body)) > 65536
    )
      throw Error()
    return body.map(row => parseEvent(row, now))
  } catch {
    throw badRequest('Invalid analytics events')
  }
}

export async function storeAnalytics(
  db: Kysely<Database>,
  events: EventRecord[],
  actor?: Actor,
  trusted = false
): Promise<void> {
  await atomic(db, async trx => {
    if (actor != null) {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', actor.userId)
        .where('disabled_at', 'is', null)
        .forShare()
        .executeTakeFirst()
      if (user == null) throw unauthorized()
    }
    for (const row of events) {
      if (!['TS', 'TS web'].includes(row.A))
        throw badRequest('Unsupported analytics app')
      if (!trusted && SERVER_EVENTS.has(row.E)) throw forbidden()
      if (actor == null) {
        if (!ANONYMOUS_EVENTS.has(row.E)) throw unauthorized()
        if (
          (row.E === 'page_viewed' || row.E === 'page_left') &&
          ![
            'home',
            'discover',
            'login',
            'onboarding',
            'game',
            'team',
            'season',
            'league',
            'group',
            'person',
            'join',
            'other'
          ].includes(String(row.P.pg))
        )
          throw forbidden()
        if (
          row.E === 'login_failed' &&
          row.P.ec != null &&
          ![
            'invalid',
            'expired',
            'rate_limited',
            'offline',
            'internal'
          ].includes(String(row.P.ec))
        )
          throw badRequest('Invalid anonymous login outcome')
      }
      if (row.P.vi != null && !trusted) {
        if (actor == null) throw unauthorized()
        const scopes = await visibleScopes(trx, actor.userId, actor.isAdmin)
        const video = await trx
          .selectFrom('videos')
          .innerJoin('games', 'games.id', 'videos.game_id')
          .select([
            'videos.hidden',
            'games.home_team_id as homeTeamId',
            'games.away_team_id as awayTeamId',
            'games.season_id as seasonId'
          ])
          .where('videos.id', '=', String(row.P.vi))
          .executeTakeFirst()
        if (video == null || video.hidden || !canSeeGame(scopes, video))
          throw forbidden()
      }
      await sql`INSERT INTO analytics.events(occurred_at,event_id,app,event_name,user_id,session_id,schema_revision,properties)
        VALUES (${row.D}::timestamptz,${row.I}::uuid,${row.A},${row.E},${actor?.userId ?? null},${row.S ?? null}::uuid,${row.R},${JSON.stringify(row.P)}::jsonb)
        ON CONFLICT (occurred_at,event_id) DO NOTHING`.execute(trx)
    }
  })
}

/** Bounded indexed work; a scheduler repeats until the backlog has gone. */
export async function pruneAnalytics(db: Kysely<Database>): Promise<void> {
  await sql`DELETE FROM analytics.events WHERE (occurred_at,event_id) IN
    (SELECT occurred_at,event_id FROM analytics.events WHERE occurred_at < now() - interval '180 days' ORDER BY occurred_at LIMIT 5000)`.execute(
    db
  )
}

export async function eraseAnalytics(
  db: Kysely<Database>,
  userIds: string[]
): Promise<void> {
  if (userIds.length === 0) return
  await sql`DELETE FROM analytics.events WHERE user_id IN (${sql.join(userIds)})`.execute(
    db
  )
}
