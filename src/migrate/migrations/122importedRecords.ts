import { Kysely, PostgresDialect } from 'kysely'
import type { PoolClient } from 'pg'

import type { Database } from '../../server/db/database'
import type { Migration } from '../runner'

/**
 * Gives every stored game an outside scorer posted, or a person typed in,
 * the TeamStation records its plays came without (`convertImportedGames`),
 * so it replays, opens on the scoring screen and counts as a game scored
 * here, and asks for each one's statistics again. A game whose turn at bat
 * names nobody, or that holds a final score alone, is left as it is. The
 * records are data a later post rebuilds, so going down removes nothing.
 *
 * It delegates to the live converter on purpose, as 092 and 094 do: the
 * records it writes are the ones any later post or `imported-records
 * --rebuild` would build, so a database that runs it later gets the
 * converter of that day. Conversion is idempotent — a second run writes
 * nothing — and touches only games TeamStation does not own. Each game is
 * converted under its own savepoint, so one that fails, even on a schema
 * this migration predates, is left as it was and named in the notice, and
 * the migration goes on.
 */
export const migration122ImportedRecords: Migration = {
  name: '122importedRecords',
  up: 'select 1;',
  down: 'select 1;',
  steps: async client => {
    // Read here, not at the top: the converter reaches the server's settings
    // and accounts, which a reader of the migration list must not load.
    const { convertImportedGames } =
      await import('../../server/events/convertImportedGames')
    // Each converted game asks for its statistics (`requestGameStats`),
    // whose notify wakes the builder once the migration commits.
    const out = await convertImportedGames(onClient(client), {
      inTransaction: true
    })
    const message =
      `122importedRecords: ${out.games} games converted, ${out.plays} plays ` +
      `written; left: ${out.unnamedPlayers.length} naming nobody, ` +
      `${out.noPlayByPlay.length} final score only, ` +
      `${out.unreadable.length} unreadable; ${out.failed.length} failed` +
      (out.failed.length === 0
        ? ''
        : ` (${out.failed.map(one => one.gameId).join(', ')}; ` +
          'npm run imported-records converts them)')
    await client.query(
      `do $notice$ begin raise notice '%', ${literal(message)}; end $notice$`
    )
  }
}

/** A Kysely over the migration's own connection, inside its transaction. */
function onClient(client: PoolClient): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        // The connection stays the migration's: Kysely never releases it.
        connect: async () => ({
          query: client.query.bind(client),
          release: () => {}
        }),
        end: async () => {},
        options: {}
      }
    })
  })
}

/** A SQL string literal. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}
