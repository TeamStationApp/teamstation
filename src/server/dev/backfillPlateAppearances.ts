import { sql } from 'kysely'

import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Asks the stats builder to build again every built game that has no plate
 * appearances: one built before they were written, or built by a server
 * still running the code before them while the new one was deployed. A
 * game whose plays make no plate appearance is asked for again each run,
 * which costs a build with nothing to write. Asked for as
 * `requestAllGameStats` asks, and the builder woken.
 *
 * A game whose last build was incomplete or failed keeps the lines it had,
 * and gets no plate appearances until its plays are corrected and it builds:
 * `Query.stats` leaves it out until then. The count of those is printed.
 *
 *   npm run backfill-plate-appearances -- --dry
 *   npm run backfill-plate-appearances
 */
async function main(): Promise<void> {
  const dry = process.argv.includes('--dry')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const owed = sql`
      select s.game_id from game_stats_state s
      where s.status = 'built'
        and not exists (
          select 1 from plate_appearances p where p.game_id = s.game_id
        )`
    const stuck = await db
      .selectFrom('game_stats_state')
      .select(eb => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', ['incomplete', 'failed'])
      .executeTakeFirstOrThrow()
    console.log(
      `${stuck.count} game(s) whose last build was incomplete or failed get none until they build`
    )
    if (dry) {
      const games = await sql<{ game_id: string }>`${owed}`.execute(db)
      console.log(
        `would ask for ${games.rows.length} game(s) to be built again`
      )
      return
    }
    const asked = await sql`
      update game_stats_state
      set requested_generation = requested_generation + 1,
          status = 'pending',
          attempts = 0,
          retry_at = null::timestamptz,
          requested_at = now()
      where game_id in (${owed})`.execute(db)
    await sql`select pg_notify('game_stats', ${'all'})`.execute(db)
    console.log(
      `asked for ${Number(asked.numAffectedRows ?? 0)} game(s) to be built again`
    )
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
