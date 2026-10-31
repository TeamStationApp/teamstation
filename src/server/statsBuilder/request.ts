import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * Ask the stats builder to (re)build one game. The upsert is the durable
 * queue entry; `pg_notify` only wakes a listening builder. Postgres delivers
 * the notify when the surrounding transaction commits, so a rolled-back post
 * never wakes anyone.
 */
export async function requestGameStats(
  db: Kysely<Database>,
  gameId: string
): Promise<void> {
  await sql`
    insert into game_stats_state (
      game_id, requested_generation, status, attempts, retry_at, requested_at
    )
    values (${gameId}, 1, 'pending', 0, null::timestamptz, now())
    on conflict (game_id) do update
      set requested_generation = game_stats_state.requested_generation + 1,
          status = 'pending',
          attempts = 0,
          retry_at = null::timestamptz,
          requested_at = now()
  `.execute(db)
  await sql`select pg_notify('game_stats', ${gameId})`.execute(db)
}

/**
 * `requestGameStats` for many games in one write and one wake-up statement,
 * each game still woken by its own notice. A game no longer there is skipped.
 */
export async function requestGamesStats(
  db: Kysely<Database>,
  gameIds: readonly string[]
): Promise<void> {
  if (gameIds.length === 0) return
  await sql`
    insert into game_stats_state (
      game_id, requested_generation, status, attempts, retry_at, requested_at
    )
    select id, 1, 'pending', 0, null::timestamptz, now()
    from games where id = any(${[...gameIds]}::text[])
    on conflict (game_id) do update
      set requested_generation = game_stats_state.requested_generation + 1,
          status = 'pending',
          attempts = 0,
          retry_at = null::timestamptz,
          requested_at = now()
  `.execute(db)
  await sql`select pg_notify('game_stats', id) from games where id = any(${[...gameIds]}::text[])`.execute(
    db
  )
}

/**
 * Ask for every game that has at least one play. One notify wakes the builder;
 * the rows are what it drains.
 */
export async function requestAllGameStats(db: Kysely<Database>): Promise<void> {
  await sql`
    insert into game_stats_state (
      game_id, requested_generation, status, attempts, retry_at, requested_at
    )
    select distinct "gameId", 1, 'pending', 0, null::timestamptz, now()
    from events
    on conflict (game_id) do update
      set requested_generation = game_stats_state.requested_generation + 1,
          status = 'pending',
          attempts = 0,
          retry_at = null::timestamptz,
          requested_at = now()
  `.execute(db)
  await sql`select pg_notify('game_stats', ${'all'})`.execute(db)
}
