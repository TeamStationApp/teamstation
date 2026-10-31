import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { sql } from 'kysely'
import { Client } from 'pg'

import {
  type Actor,
  paced,
  Publishers,
  reachable,
  RestReaders,
  Scorekeeper,
  serverFor,
  SocketViewer,
  Tally
} from './actors'
import { amountsFor } from './amounts'
import {
  type LoadDatabase,
  openLoadDatabase,
  requireLoadDatabase
} from './database'
import { runEvent, startEventSchedule } from './events'
import {
  accountsForShard,
  cleanupRun,
  describeShapes,
  newRunId,
  parseShard,
  readTokens,
  seedFixture,
  verifyShapes
} from './fixture'
import { renderProbes, runProbes } from './probe'
import {
  buildReport,
  type ReportData,
  renderReport,
  writeReport
} from './report'
import { Sampler } from './sampler'

/**
 * The load rig's command line. It seeds, drives, probes or cleans up, whichever
 * its flags name, and drives any server over HTTP.
 *
 *   npm run start.dbLoad -- --database <url> --scale small --tokens tokens.json
 *   npm run start.dbLoad -- --server <url> --database <url> --tokens tokens.json \
 *     --users 500 --games 5 --pitch-seconds 15 --rest-rate 50 --minutes 3 --report load.log
 *   npm run start.dbLoad -- --database <url> --tokens tokens.json --event teamMerge
 *   npm run start.dbLoad -- --server <url> --database <url> --tokens tokens.json --probe
 *   npm run start.dbLoad -- --database <url> --tokens tokens.json --cleanup
 *
 * Every mode refuses a database not marked for load testing.
 */

export interface Io {
  log: (message: string) => void
}

const OPTIONS = {
  server: { type: 'string', multiple: true },
  database: { type: 'string' },
  scale: { type: 'string' },
  accounts: { type: 'string' },
  'run-id': { type: 'string' },
  users: { type: 'string' },
  shard: { type: 'string' },
  tokens: { type: 'string' },
  games: { type: 'string' },
  'pitch-seconds': { type: 'string' },
  'rest-rate': { type: 'string' },
  minutes: { type: 'string' },
  report: { type: 'string' },
  streams: { type: 'string' },
  scoreboards: { type: 'string' },
  'require-statements': { type: 'boolean' },
  'pooler-address': { type: 'string' },
  'connect-rate': { type: 'string' },
  cleanup: { type: 'boolean' },
  event: { type: 'string' },
  'event-schedule': { type: 'boolean' },
  probe: { type: 'boolean' }
} as const

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: false }>
>['values']

function required<T>(value: T | undefined, flag: string): T {
  if (value == null) throw new Error(`${flag} is required here`)
  return value
}

function count(
  value: string | undefined,
  flag: string,
  fallback?: number
): number {
  if (value == null) return required(fallback, flag)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} takes a number, not ${value}`)
  return parsed
}

export interface RunOptions {
  servers: string[]
  databaseUrl: string
  tokensPath: string
  users: number
  shard?: { index: number; count: number }
  games: number
  pitchSeconds: number
  restRate: number
  minutes: number
  streams: number
  scoreboards: number
  reportPath?: string
  requireStatements: boolean
  poolerAddress?: string
  connectRate: number
  eventSchedule: boolean
  log: (message: string) => void
}

/** Drives the run, then reports whatever it saw, even if every actor failed. */
export async function runLoad(options: RunOptions): Promise<ReportData> {
  const tokens = readTokens(options.tokensPath)
  const accounts = accountsForShard(tokens, options.users, options.shard)
  if (options.games > tokens.games.length)
    throw new Error(
      `--games ${options.games} is above the ${tokens.games.length} live games seeded for run ${tokens.runId}`
    )
  const games = tokens.games.slice(0, options.games)
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: 'dbload-sampler'
  })
  await client.connect()
  // A lost connection is reported by the read that needed it.
  client.on('error', () => undefined)
  let db: LoadDatabase | undefined
  const tally = new Tally()
  const actors: Actor[] = []
  const startedAt = Date.now()
  const sampler = new Sampler({
    client,
    poolerAddress: options.poolerAddress,
    requireStatements: options.requireStatements,
    onError: () => {
      tally.fail('sampler')
    }
  })
  try {
    await requireLoadDatabase(async text => await client.query(text))
    await sampler.start()

    const down = await reachable(options.servers)
    for (const _ of down) tally.fail('unreachable')
    if (down.length < options.servers.length) {
      const scorers = await startScorekeepers(options, tokens, games, tally)
      actors.push(...scorers)

      const viewers = accounts.map((account, index) => {
        const game = games[(account.gameIndex ?? 0) % games.length]
        return new SocketViewer(
          serverFor(options.servers, index),
          account,
          game.id,
          tally
        )
      })
      actors.push(...viewers)
      await paced(viewers, options.connectRate, viewer => {
        viewer.start()
      })

      for (let i = 0; i < options.scoreboards; i++) {
        const game = games[i % games.length]
        const account = accounts[i % accounts.length]
        const board = new SocketViewer(
          serverFor(options.servers, i),
          account,
          game.id,
          tally,
          `/api/v1/scoreboard/${game.id}/socket?timeline=1`
        )
        actors.push(board)
        board.start()
      }

      const readers = new RestReaders(
        options.servers,
        accounts,
        games,
        tally,
        options.restRate
      )
      actors.push(readers)
      readers.start()

      if (options.streams > 0) {
        const publishers = new Publishers(
          options.servers,
          tokens,
          tally,
          options.streams,
          Math.ceil(options.minutes * 60)
        )
        actors.push(publishers)
        await publishers.start()
      }

      const schedule = options.eventSchedule
        ? startEventSchedule(
            (db = openLoadDatabase(options.databaseUrl, { max: 2 })),
            tokens.runId,
            {
              log: options.log,
              onError: error => {
                options.log(`event failed: ${error.message}`)
                tally.fail('event')
              }
            }
          )
        : undefined

      await new Promise(done => {
        setTimeout(done, options.minutes * 60_000)
      })
      await schedule?.stop()
    }
  } finally {
    await Promise.all(actors.map(async actor => await actor.stop()))
    await sampler.stop().catch(() => undefined)
    await db?.destroy()
    await client.end()
  }
  return finish(options, tally, sampler, startedAt)
}

async function startScorekeepers(
  options: RunOptions,
  tokens: ReturnType<typeof readTokens>,
  games: ReturnType<typeof readTokens>['games'],
  tally: Tally
): Promise<Scorekeeper[]> {
  // Two rigs share one set of games, and only the first of them scores.
  if ((options.shard?.index ?? 0) !== 0) return []
  const keepers: Scorekeeper[] = []
  for (const [index, game] of games.entries()) {
    const account = tokens.accounts.find(row => row.label === game.scorekeeper)
    if (account == null)
      throw new Error(`${game.scorekeeper} is not in ${options.tokensPath}`)
    const keeper = new Scorekeeper(
      serverFor(options.servers, index),
      account,
      game,
      tally,
      options.pitchSeconds * 1000
    )
    try {
      await keeper.open()
      keeper.start()
      keepers.push(keeper)
    } catch (error) {
      tally.failure(error)
    }
  }
  return keepers
}

function finish(
  options: RunOptions,
  tally: Tally,
  sampler: Sampler,
  startedAt: number
): ReportData {
  const data = buildReport({
    title: `${options.users} users, ${options.games} games, ${options.servers.length} server(s)`,
    startedAt,
    finishedAt: Date.now(),
    measurements: tally,
    samples: sampler.samples,
    statements: sampler.statements(),
    sequentialScans: sampler.sequentialScans(),
    hasStatements: sampler.hasStatements
  })
  options.log(renderReport(data))
  if (options.reportPath != null) writeReport(options.reportPath, data)
  return data
}

/** Runs what the flags name, answering the process's exit code. */
export async function runMain(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true })
  const databaseUrl = required(values.database, '--database')

  if (values.scale != null) return await seed(values, databaseUrl, io)
  const tokensPath = required(values.tokens, '--tokens')

  if (values.cleanup === true) {
    const db = openLoadDatabase(databaseUrl)
    try {
      const { removed } = await cleanupRun(db, readTokens(tokensPath).runId)
      io.log(`removed ${JSON.stringify(removed)}`)
      return 0
    } finally {
      await db.destroy()
    }
  }

  if (values.event != null) {
    const db = openLoadDatabase(databaseUrl, { max: 2 })
    try {
      const result = await runEvent(
        db,
        readTokens(tokensPath).runId,
        values.event
      )
      io.log(
        `${result.event} copy ${result.copy}: ${result.ms.toFixed(0)} ms, ${result.detail}`
      )
      return 0
    } finally {
      await db.destroy()
    }
  }

  const servers = required(values.server, '--server')

  if (values.probe === true) {
    const db = openLoadDatabase(databaseUrl, { max: 2 })
    try {
      await requireLoadDatabase(
        async text =>
          await sql
            .raw<{ comment: string | null; name: string }>(text)
            .execute(db)
      )
      const results = await runProbes(db, servers[0], readTokens(tokensPath))
      const text = renderProbes(results)
      io.log(text)
      if (values.report != null) writeFileSync(values.report, text)
      return results.some(row => row.error != null) ? 1 : 0
    } finally {
      await db.destroy()
    }
  }

  const data = await runLoad({
    servers,
    databaseUrl,
    tokensPath,
    users: count(values.users, '--users'),
    shard: values.shard == null ? undefined : parseShard(values.shard),
    games: count(values.games, '--games', 1),
    pitchSeconds: count(values['pitch-seconds'], '--pitch-seconds', 15),
    restRate: count(values['rest-rate'], '--rest-rate', 0),
    minutes: count(values.minutes, '--minutes', 1),
    streams: count(values.streams, '--streams', 0),
    scoreboards: count(values.scoreboards, '--scoreboards', 0),
    reportPath: values.report,
    requireStatements: values['require-statements'] === true,
    poolerAddress: values['pooler-address'],
    connectRate: count(values['connect-rate'], '--connect-rate', 50),
    eventSchedule: values['event-schedule'] === true,
    log: io.log
  })
  // Nothing measured, or nothing connected, is a failed run and not a quiet one.
  return data.socketsOpened === 0 && data.posts === 0 ? 1 : 0
}

async function seed(
  values: Values,
  databaseUrl: string,
  io: Io
): Promise<number> {
  const db = openLoadDatabase(databaseUrl)
  try {
    const runId = values['run-id'] ?? newRunId()
    const overrides =
      values.accounts == null
        ? {}
        : { accounts: count(values.accounts, '--accounts') }
    const scale = values.scale as string
    const tokens = await seedFixture(db, {
      runId,
      scale,
      overrides,
      streams: count(values.streams, '--streams', 0),
      tokensPath: required(values.tokens, '--tokens'),
      log: io.log
    })
    const shapes = await describeShapes(db, runId, tokens)
    verifyShapes(shapes, amountsFor(scale, overrides))
    io.log(
      `run ${runId}: ${tokens.accounts.length} accounts, every shape present`
    )
    return 0
  } finally {
    await db.destroy()
  }
}

/* c8 ignore start */
const entry = process.argv[1] ?? ''
if (entry.endsWith('/dbLoad/main.ts')) {
  runMain(process.argv.slice(2), { log: console.log }).then(
    code => {
      process.exit(code)
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  )
}
/* c8 ignore stop */
