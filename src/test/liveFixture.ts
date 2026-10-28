import type { Kysely } from 'kysely'
import { Pool } from 'pg'

import { testDatabaseUrl } from '../migrate/testDatabase'
import type { Database } from '../server/db/database'
import { createLiveStream } from '../server/live/streamKeys'
import type { LiveSettings } from '../server/serverConfig'
import { addPerson, scratchDatabase } from './scoreboardKit'

/**
 * A scratch database with a game somebody may stream, for the ingest's tests.
 *
 * The stream's owner can sign in and films for the home team, so a key made
 * here is one the ingest accepts. Streams are made the way the API makes them,
 * with `createLiveStream`.
 */
export interface LiveFixture {
  url: string
  db: Kysely<Database>
  /** A stream for the game, and its key. `state` is written after it. */
  addStream: (
    live: LiveSettings,
    sessionSecret: string,
    state?: 'idle' | 'publishing'
  ) => Promise<{ id: string; key: string; videoId: string }>
  stateOf: (id: string) => Promise<string>
  /** Destroys the pool and drops the database. */
  drop: () => Promise<void>
}

/** `undefined` when there is no Postgres to make one on. */
export async function liveFixture(
  label: string
): Promise<LiveFixture | undefined> {
  const probe = new Pool({ connectionString: testDatabaseUrl })
  try {
    await probe.query('select 1')
  } catch {
    return undefined
  } finally {
    await probe.end()
  }
  // Lower case: Postgres folds an unquoted name, and the URL must match it.
  const { db, url, drop } = await scratchDatabase(label.toLowerCase())

  const now = new Date()
  for (const [id, teamName] of [
    ['tem_home', 'Demo Home'],
    ['tem_away', 'Demo Away']
  ]) {
    await db
      .insertInto('teams')
      .values({ id, name: teamName, created_at: now, updated_at: now })
      .execute()
  }
  const owner = await addPerson(db, 'owner')
  await db
    .updateTable('users')
    .set({ login_enabled: true })
    .where('id', '=', owner.userId)
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: `rol_${label}_owner`,
      user_id: owner.userId,
      scope_type: 'team',
      scope_id: 'tem_home',
      role: 'videographer'
    })
    .execute()

  // A game of its own for each stream: one person has four cameras a game.
  let games = 0
  return {
    url,
    db,
    addStream: async (live, sessionSecret, state = 'idle') => {
      games++
      const gameId = `gam_${games}`
      await db
        .insertInto('games')
        .values({
          id: gameId,
          home_team_id: 'tem_home',
          away_team_id: 'tem_away',
          start_at: now,
          created_at: now,
          updated_at: now
        })
        .execute()
      const made = await createLiveStream(db, {
        gameId,
        teamId: 'tem_home',
        startAt: now,
        userId: owner.userId,
        slot: 1,
        live,
        sessionSecret,
        videoTitle: 'Demo Away at Demo Home'
      })
      if (state !== 'idle') {
        await db
          .updateTable('live_streams')
          .set({ state })
          .where('id', '=', made.id)
          .execute()
      }
      return { id: made.id, key: made.key, videoId: made.videoId! }
    },
    stateOf: async id =>
      (
        await db
          .selectFrom('live_streams')
          .select('state')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).state,
    drop
  }
}
