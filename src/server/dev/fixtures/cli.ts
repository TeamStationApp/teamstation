import { makeDatabase } from '../../db/database'
import { serverConfig } from '../../serverConfig'
import type { FixtureManifest, WorldContext } from './accounts'
import { makeNonce } from './accounts'
import { DUMP_WORLD_MAILBOX, splitMailbox } from './address'
import { refuseRealAddresses, runBaseline } from './baseline'
import { runCoachGame } from './coachGame'
import { runCoachPlan } from './coachPlan'
import { runConcurrentScoring } from './concurrentScoring'
import { runDefensiveSetup } from './defensiveSetup'
import {
  runEventGroups,
  runEventInfo,
  runEventInfoPeople,
  runEventSchedule,
  runGameForm
} from './eventGroups'
import { runExistingPlayer, runExistingPlayerGuest } from './existingPlayer'
import {
  runDefenseGaps,
  runEmptyDefense,
  runEventTags,
  runPickoffGame,
  runPriorRunner,
  runRosterPlayers
} from './fieldGames'
import { runLineupGame } from './lineupGame'
import { runMessaging, runMessagingDated } from './messaging'
import { runPackedLeague, runPackedLeagueLimit } from './packedLeague'
import { runPlayerNames } from './playerNames'
import { runRefreshNotices } from './refreshNotices'
import { runReplayGames } from './replayGames'
import { runScoringField } from './scoringField'
import { runScoringGame } from './scoringGame'
import { runScoringPreview } from './scoringPreview'
import { runRosterEdit, runScoringSheets } from './scoringSheets'
import { runSearch } from './search'
import { runStreaming } from './streaming'
import { runTeamWithRoster } from './teamWithRoster'
import { runTess } from './tess'
import { runWalkUp } from './walkUp'

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
  'concurrent-scoring': runConcurrentScoring,
  'defensive-setup': runDefensiveSetup,
  'event-groups': runEventGroups,
  'event-info': runEventInfo,
  'event-info-people': runEventInfoPeople,
  'event-schedule': runEventSchedule,
  'game-form': runGameForm,
  'replay-games': runReplayGames,
  'existing-player': runExistingPlayer,
  'roster-players': runRosterPlayers,
  'defense-gaps': runDefenseGaps,
  'empty-defense': runEmptyDefense,
  'pickoff-game': runPickoffGame,
  'prior-runner': runPriorRunner,
  'event-tags': runEventTags,
  'existing-player-guest': runExistingPlayerGuest,
  'coach-plan': runCoachPlan,
  'lineup-game': runLineupGame,
  'player-names': runPlayerNames,
  'packed-league': runPackedLeague,
  'packed-league-limit': runPackedLeagueLimit,
  'refresh-notices': runRefreshNotices,
  'roster-edit': runRosterEdit,
  'scoring-sheets': runScoringSheets,
  'scoring-game': runScoringGame,
  'scoring-preview': runScoringPreview,
  'scoring-field': runScoringField,
  search: runSearch,
  tess: runTess,
  'walk-up': runWalkUp,
  messaging: runMessaging,
  'messaging-dated': runMessagingDated
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
    // A restored dump world's accounts are on its own test mailbox.
    await refuseRealAddresses(db, args.mailbox, [DUMP_WORLD_MAILBOX])
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
