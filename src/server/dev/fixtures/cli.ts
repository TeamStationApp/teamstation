import { makeDatabase } from '../../db/database'
import { serverConfig } from '../../serverConfig'
import type { FixtureManifest, WorldContext } from './accounts'
import { makeNonce } from './accounts'
import { splitMailbox } from './address'
import { refuseRealAddresses, runBaseline } from './baseline'
import { runCoachGame } from './coachGame'
import { runPackedLeague, runPackedLeagueLimit } from './packedLeague'
import { runRefreshNotices } from './refreshNotices'
import { runSearch } from './search'
import { runSponsors } from './sponsors'
import { runStreaming } from './streaming'
import { runTeamWithRoster } from './teamWithRoster'
import { runTess } from './tess'

/**
 * Builds a database from nothing:
 *
 *   npm run fixtures -- <world> --json --mailbox <mailbox>
 *
 * It writes invented data, and refuses to run unless `testSettings` is true, which
 * production never sets. The manifest, with its passwords, goes to stdout and nowhere
 * else. A scenario's own world is read by the scenario and kept in memory.
 */
export const WORLDS: Record<
  string,
  (context: WorldContext) => Promise<FixtureManifest>
> = {
  'team-with-roster': runTeamWithRoster,
  streaming: runStreaming,
  'coach-game': runCoachGame,
  'packed-league': runPackedLeague,
  'packed-league-limit': runPackedLeagueLimit,
  'refresh-notices': runRefreshNotices,
  search: runSearch,
  sponsors: runSponsors,
  tess: runTess
}

export function refuseWithoutTestSettings(testSettings: boolean): void {
  if (!testSettings) {
    throw new Error(
      'The fixtures script runs only where serverConfig.testSettings is true'
    )
  }
}

export interface FixtureArgs {
  world: string
  mailbox: string
}

export function parseFixtureArgs(argv: string[]): FixtureArgs {
  const at = argv.indexOf('--mailbox')
  const mailbox = at < 0 ? undefined : argv[at + 1]
  const world = argv.find(
    (arg, index) => !arg.startsWith('--') && (at < 0 || index !== at + 1)
  )
  if (world == null || mailbox == null) {
    throw new Error(
      'Usage: npm run fixtures -- <world> --json --mailbox <mailbox>'
    )
  }
  splitMailbox(mailbox)
  // Its own worlds only: `constructor` and the like are not one.
  if (world !== 'baseline' && !Object.hasOwn(WORLDS, world)) {
    throw new Error(`No fixture world "${world}"`)
  }
  return { world, mailbox }
}

/**
 * Runs one world against the configured database and returns its manifest.
 * Every world refuses a database holding an address that is not the
 * mailbox's.
 */
export async function runFixture(args: FixtureArgs): Promise<FixtureManifest> {
  refuseWithoutTestSettings(serverConfig.testSettings)
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    // The baseline reads the addresses once, for this and for its own use.
    if (args.world === 'baseline') return await runBaseline(db, args.mailbox)
    await refuseRealAddresses(db, args.mailbox)
    return await WORLDS[args.world]({
      db,
      mailbox: args.mailbox,
      nonce: makeNonce()
    })
  } finally {
    await db.destroy()
  }
}

/** Prints the manifest, or why there is none, and returns the exit code. */
export async function runCli(
  argv: string[],
  out: Pick<Console, 'log' | 'error'> = console
): Promise<number> {
  try {
    out.log(JSON.stringify(await runFixture(parseFixtureArgs(argv))))
    return 0
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }, console.error)
}
