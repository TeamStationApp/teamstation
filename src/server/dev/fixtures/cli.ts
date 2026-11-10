import { makeDatabase } from '../../db/database'
import { serverConfig } from '../../serverConfig'
import type { FixtureManifest, WorldContext } from './accounts'
import { makeNonce } from './accounts'
import { splitMailbox } from './address'
import { runBaseline } from './baseline'
import { runTeamWithRoster } from './teamWithRoster'

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
  'team-with-roster': runTeamWithRoster
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
  if (world !== 'baseline' && WORLDS[world] == null) {
    throw new Error(`No fixture world "${world}"`)
  }
  return { world, mailbox }
}

/** Runs one world against the configured database and returns its manifest. */
export async function runFixture(args: FixtureArgs): Promise<FixtureManifest> {
  refuseWithoutTestSettings(serverConfig.testSettings)
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    if (args.world === 'baseline') return await runBaseline(db, args.mailbox)
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
