import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type * as Config from '../serverConfig'

/**
 * Whether the ingest can be restarted without dropping a game.
 *
 *   node lib/server/live/ingestQuiet.js
 *
 * Exits 0 when no `live_streams` row is `publishing`, 1 when one is, and 2
 * when the database cannot be read — so a check that could not look never
 * reads as quiet. A restart of the ingest ends every publisher and every
 * ffmpeg writing a recording, which is the one thing an app deploy no longer
 * does; this is what the separate restart asks first.
 */

/** How many streams have a publisher connected right now. */
export async function publishingCount(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('live_streams')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('state', '=', 'publishing')
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

export interface IngestQuietDeps {
  databaseUrl: string
  makeDatabase: (url: string) => Kysely<Database>
  print: (line: string) => void
}

/** The program: prints one line and returns its exit code. */
export async function ingestQuietMain(deps: IngestQuietDeps): Promise<number> {
  const db = deps.makeDatabase(deps.databaseUrl)
  try {
    const count = await publishingCount(db)
    deps.print(
      count === 0
        ? 'ingest quiet: 0 publishing'
        : `ingest busy: ${count} publishing`
    )
    return count === 0 ? 0 : 1
  } catch (error) {
    deps.print(`ingest unknown: ${String(error)}`)
    return 2
  } finally {
    await db.destroy().catch(() => undefined)
  }
}

if (require.main === module) {
  // Loaded here, not imported: the tests that import this file must not
  // read a `serverConfig.json`. A configuration that will not load is a
  // check that could not look, so it is 2 as well, never 1.
  let databaseUrl: string | undefined
  try {
    databaseUrl = (require('../serverConfig') as typeof Config).serverConfig
      .databaseUrl
  } catch (error) {
    console.log(`ingest unknown: ${String(error)}`)
    process.exit(2)
  }
  ingestQuietMain({
    databaseUrl,
    makeDatabase,
    print: line => {
      console.log(line)
    }
  }).then(
    code => process.exit(code),
    () => process.exit(2)
  )
}
