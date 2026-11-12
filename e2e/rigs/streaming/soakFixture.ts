import type { Kysely } from 'kysely'

import type { Database } from '../../../src/server/db/database'
import type {
  FixtureAccount,
  FixtureManifest,
  Person,
  WorldContext
} from '../../../src/server/dev/fixtures/accounts'
import type { LiveSettings } from '../../../src/server/serverConfigSchema'
import { ANGLES } from './soakSchedule'

/**
 * The soak's world: one account, its team against an invented visitor, a season, the
 * game "Streaming baseline" and its three camera rows, Phone A, Phone B and Synthetic.
 * It is written through the same helpers as the suite's fixtures
 * (`src/server/dev/fixtures`), under a nonce, into the database `databaseUrl` names.
 *
 * The manifest carries the account's password and each camera's stream key. It goes to
 * stdout and to the scenario's memory, never to a file in the repository or a log.
 *
 *   node -r sucrase/register e2e/rigs/streaming/soakFixture.ts --json --mailbox <mailbox>
 *
 * The command runs where the stack's server configuration is (its database, session
 * secret and live settings), and refuses unless `testSettings` is true.
 */

export const WORLD = 'streaming-soak'
export const GAME_TITLE = 'Streaming baseline'
const OWNER: Person = { first: 'Clayton', last: 'Kershaw' }

export interface SoakStream {
  label: string
  id: string
  videoId: string
  /** The stream key: a secret. */
  key: string
}

export interface SoakFixtureManifest extends FixtureManifest {
  gameId: string
  streams: SoakStream[]
}

/** The server helpers the fixture writes through, injected so a test can stand in. */
export interface SoakFixtureDeps {
  createAccount: (
    context: WorldContext,
    world: string,
    role: string,
    person: Person
  ) => Promise<FixtureAccount>
  createTeam: (
    db: Kysely<Database>,
    body: { name: string; externalIds: never[] },
    creator: { userId: string; isAdmin: boolean }
  ) => Promise<{ id: string }>
  createLiveStream: (
    db: Kysely<Database>,
    options: {
      gameId: string
      teamId: string
      startAt: Date
      userId: string
      slot: number
      label: string
      live: LiveSettings
      sessionSecret: string
      videoTitle: string
      source?: 'rtmp'
    }
  ) => Promise<{ id: string; videoId: string | null; key: string }>
  makeId: (kind: string) => string
  makeNonce: () => string
}

export interface SoakFixtureInput {
  db: Kysely<Database>
  mailbox: string
  sessionSecret: string
  live: LiveSettings
  now?: () => Date
  nonce?: string
}

export async function seedSoakFixture(
  input: SoakFixtureInput,
  deps: SoakFixtureDeps
): Promise<SoakFixtureManifest> {
  const { db } = input
  const nonce = input.nonce ?? deps.makeNonce()
  const now = input.now?.() ?? new Date()
  const owner = await deps.createAccount(
    { db, mailbox: input.mailbox, nonce },
    WORLD,
    'owner',
    OWNER
  )
  const home = await deps.createTeam(
    db,
    { name: `Soak Hosts ${nonce}`, externalIds: [] },
    { userId: owner.userId, isAdmin: false }
  )
  const awayId = deps.makeId('team')
  await db
    .insertInto('teams')
    .values({ id: awayId, name: `Soak Visitors ${nonce}` })
    .execute()
  const seasonId = deps.makeId('season')
  const year = now.getUTCFullYear()
  await db
    .insertInto('seasons')
    .values({
      id: seasonId,
      name: `${GAME_TITLE} ${nonce}`,
      year,
      term: null,
      starts_on: `${year}-01-01`,
      ends_on: `${year}-12-31`
    })
    .execute()
  await db
    .insertInto('season_teams')
    .values([
      { season_id: seasonId, team_id: home.id },
      { season_id: seasonId, team_id: awayId }
    ])
    .execute()
  const gameId = deps.makeId('game')
  await db
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: home.id,
      away_team_id: awayId,
      season_id: seasonId,
      start_at: now,
      venue: 'Soak Field',
      notes: GAME_TITLE,
      status: 'inProgress'
    })
    .execute()
  const streams: SoakStream[] = []
  for (const [index, label] of ANGLES.entries()) {
    const made = await deps.createLiveStream(db, {
      gameId,
      teamId: home.id,
      startAt: now,
      userId: owner.userId,
      slot: index + 1,
      label,
      live: input.live,
      sessionSecret: input.sessionSecret,
      videoTitle: GAME_TITLE,
      ...(label === 'Synthetic' ? { source: 'rtmp' as const } : {})
    })
    streams.push({
      label,
      id: made.id,
      videoId: made.videoId ?? '',
      key: made.key
    })
  }
  const ids: Record<string, string> = {
    team: home.id,
    awayTeam: awayId,
    season: seasonId,
    game: gameId
  }
  for (const stream of streams) ids[`stream:${stream.label}`] = stream.id
  return { world: WORLD, nonce, accounts: { owner }, ids, gameId, streams }
}

/** The real helpers, loaded only when the fixture runs: importing this module loads no server code. */
export function serverDeps(): SoakFixtureDeps {
  const accounts = require('../../../src/server/dev/fixtures/accounts')
  const teams = require('../../../src/server/teams/createTeam')
  const keys = require('../../../src/server/live/streamKeys')
  const ids = require('../../../src/common/ids')

  return {
    createAccount: accounts.createAccount,
    makeNonce: accounts.makeNonce,
    createTeam: teams.createTeam,
    createLiveStream: keys.createLiveStream,
    makeId: ids.makeId
  }
}

export interface RunSoakFixture {
  databaseUrl: string
  mailbox: string
  sessionSecret: string
  live: LiveSettings
  makeDatabase: (url: string) => Kysely<Database>
  deps?: SoakFixtureDeps
}

/** Seeds the world into the database at `databaseUrl`, and always lets go of it. */
export async function runSoakFixture(
  options: RunSoakFixture
): Promise<SoakFixtureManifest> {
  if (options.sessionSecret === '') {
    throw new Error(
      "the soak fixture needs the server's session secret to seal stream keys"
    )
  }
  const db = options.makeDatabase(options.databaseUrl)
  try {
    return await seedSoakFixture(
      {
        db,
        mailbox: options.mailbox,
        sessionSecret: options.sessionSecret,
        live: options.live
      },
      options.deps ?? serverDeps()
    )
  } finally {
    await db.destroy()
  }
}

export function parseArgs(argv: string[]): { mailbox: string } {
  const at = argv.indexOf('--mailbox')
  const mailbox = at < 0 ? undefined : argv[at + 1]
  if (mailbox?.includes('@') !== true) {
    throw new Error('Usage: soakFixture.ts --json --mailbox <mailbox>')
  }
  return { mailbox }
}

interface ServerConfigLike {
  testSettings: boolean
  databaseUrl: string
  sessionSecret: string
  live: LiveSettings
}

/** Prints the manifest, or why there is none, and returns the exit code. */
export async function runCli(
  argv: string[],
  load: () => {
    config: ServerConfigLike
    makeDatabase: (url: string) => Kysely<Database>
  },
  out: Pick<Console, 'log' | 'error'> = console
): Promise<number> {
  try {
    const { mailbox } = parseArgs(argv)
    const { config, makeDatabase } = load()
    if (!config.testSettings) {
      throw new Error(
        'The soak fixture runs only where serverConfig.testSettings is true'
      )
    }
    const manifest = await runSoakFixture({
      databaseUrl: config.databaseUrl,
      mailbox,
      sessionSecret: config.sessionSecret,
      live: config.live,
      makeDatabase
    })
    out.log(JSON.stringify(manifest))
    return 0
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), () => ({
    config: require('../../../src/server/serverConfig').serverConfig,
    makeDatabase: require('../../../src/server/db/database').makeDatabase
  })).then(code => {
    process.exitCode = code
  }, console.error)
}
