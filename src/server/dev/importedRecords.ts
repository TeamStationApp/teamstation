import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { convertImportedGames } from '../events/convertImportedGames'

/**
 * Gives the stored games an outside scorer posted their TeamStation records,
 * as migration 122 does, for a game repaired since or a run checked again.
 *
 *   npm run imported-records -- [--game <id>]… [--preview] [--rebuild]
 *
 * `--preview` works out what would be written and writes nothing; a second
 * run after a first answers no games. `--rebuild` builds again the records
 * of every game TeamStation does not own, as a better converter would.
 */
export async function importedRecordsReport(
  db: Kysely<Database>,
  argv: readonly string[]
): Promise<Record<string, unknown>> {
  const gameIds: string[] = []
  let preview = false
  let rebuild = false
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === '--game') gameIds.push(argv[++at])
    else if (argv[at] === '--preview') preview = true
    else if (argv[at] === '--rebuild') rebuild = true
    else throw new Error(`Unknown argument ${argv[at]}`)
  }
  const out = await convertImportedGames(db, {
    preview,
    rebuild,
    ...(gameIds.length === 0 ? {} : { gameIds })
  })
  return {
    preview,
    games: out.games,
    plays: out.plays,
    corrections: out.corrections,
    unnamedPlayers: out.unnamedPlayers.length,
    noPlayByPlay: out.noPlayByPlay.length,
    unreadable: out.unreadable,
    failed: out.failed
  }
}

/* c8 ignore start: the script itself */
async function main(): Promise<void> {
  // Read here, not at the top: importing the configuration reads
  // `./serverConfig.json`, which the tests of this module must not.
  const { makeDatabase } = await import('../db/database')
  const { serverConfig } = await import('../serverConfig')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const report = await importedRecordsReport(db, process.argv.slice(2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.destroy()
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
/* c8 ignore stop */
