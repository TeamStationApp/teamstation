import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'
import { whileLive } from './liveUser'
import type { MessagesUsage } from './messagesApi'

/**
 * Tess's tokens, per person per UTC week, from Monday 00:00 to Sunday 24:00.
 * Input and output are kept apart, since they are priced apart, and so are
 * the input's cache reads and writes, so the hit rate can be read. Nothing is
 * capped: the weeks are read, not enforced.
 */

const DAY_MS = 86400000

/** One week of one person's use. */
export interface UsageWeek {
  /** The week's Monday, `YYYY-MM-DD`. */
  weekStart: string
  /** Everything read: fresh input, cache writes and cache reads. */
  inputTokens: number
  outputTokens: number
  /** Of the input, read from the cache. */
  cacheReadTokens: number
  /** Of the input, written to the cache. */
  cacheWriteTokens: number
  requests: number
}

/**
 * The Monday 00:00 UTC on or before `at`, as `YYYY-MM-DD`. Sunday
 * 23:59:59.999 UTC is still the week of the Monday before it.
 */
export function weekStartUtc(at: Date): string {
  const midnight = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate()
  )
  // getUTCDay counts from Sunday; a week here starts on Monday.
  const sinceMonday = (at.getUTCDay() + 6) % 7
  return new Date(midnight - sinceMonday * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Adds one Messages call to its week. Every call counts, compaction's and
 * attachment descriptions' included. Input is everything the provider read:
 * fresh input, what it wrote to its cache and what it read from it. A
 * deleted account's call is refused with 410 and not kept.
 */
export async function recordUsage(
  db: Kysely<Database>,
  userId: string,
  usage: MessagesUsage,
  at: Date = new Date()
): Promise<void> {
  const input = Math.round(
    usage.inputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens
  )
  const output = Math.round(usage.outputTokens)
  const read = Math.round(usage.cacheReadInputTokens)
  const written = Math.round(usage.cacheCreationInputTokens)
  await whileLive(db, userId, async trx => {
    await trx
      .insertInto('tess_usage_weeks')
      .values({
        user_id: userId,
        week_start: weekStartUtc(at),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: written,
        requests: 1
      })
      .onConflict(conflict =>
        conflict.columns(['user_id', 'week_start']).doUpdateSet({
          input_tokens: sql`tess_usage_weeks.input_tokens + excluded.input_tokens`,
          output_tokens: sql`tess_usage_weeks.output_tokens + excluded.output_tokens`,
          cache_read_tokens: sql`tess_usage_weeks.cache_read_tokens + excluded.cache_read_tokens`,
          cache_write_tokens: sql`tess_usage_weeks.cache_write_tokens + excluded.cache_write_tokens`,
          requests: sql`tess_usage_weeks.requests + 1`
        })
      )
      .execute()
  })
}

/** The person's latest weeks, newest first. */
export async function usageWeeks(
  db: Kysely<Database>,
  userId: string,
  limit = 12
): Promise<UsageWeek[]> {
  const rows = await db
    .selectFrom('tess_usage_weeks')
    .select([
      sql<string>`to_char(week_start, 'YYYY-MM-DD')`.as('weekStart'),
      // Text, so a count reads the same with or without the int8 parser.
      sql<string>`input_tokens::text`.as('inputTokens'),
      sql<string>`output_tokens::text`.as('outputTokens'),
      sql<string>`cache_read_tokens::text`.as('cacheReadTokens'),
      sql<string>`cache_write_tokens::text`.as('cacheWriteTokens'),
      'requests'
    ])
    .where('user_id', '=', userId)
    .orderBy('week_start', 'desc')
    .limit(limit)
    .execute()
  return rows.map(row => ({
    weekStart: row.weekStart,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    requests: row.requests
  }))
}
