import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import type { FixtureManifest } from './fixtures'
import { HarnessError } from './result'
import type { DumpAccount } from './spec'

/**
 * Dump worlds: a PostgreSQL dump (`pg_dump -Fc`) committed beside the
 * testing accounts it holds, `e2e/fixtures/dumps/<world>.dump` and
 * `<world>.accounts.json`. The runner restores one on the stack and runs
 * the ref's migrations forward; a test reads an account with
 * `ctx.account(role)`. Every value in them is invented.
 */
export const DUMPS_DIR = join('e2e', 'fixtures', 'dumps')

/** The cap on a world's size. A world that needs more is split, or seeds its bulk. */
export const MAX_DUMP_BYTES = 10 * 1024 * 1024

/** How far a dump may fall behind the newest migration before it is regenerated. */
export const DUMP_MAX_MIGRATIONS_BEHIND = 20

/** The log and transient tables: a dump keeps their schema and none of their rows. */
export const EXCLUDED_TABLES = [
  'analytics.events',
  'audit_log',
  'scoreboard_log',
  'chat_membership_log',
  'rate_events',
  'notification_events',
  'sync_idempotency',
  'creation_idempotency'
] as const

/**
 * The mailbox a dump world's accounts are made on. It is reserved and
 * invented, so a committed accounts file names no real mailbox, and no
 * mail sent to it can reach anyone.
 */
export const DUMP_MAILBOX = 'dumps@example.test'

export interface DumpAccounts {
  world: string
  /** The scripted world it was seeded from. */
  source: string
  /** The newest migration the dumped database had. */
  migration: string
  accounts: Record<string, DumpAccount>
}

/** What a dump world is made from, and what each account holds that tests rely on. */
export interface DumpWorld {
  source: string
  holds: (
    manifest: FixtureManifest
  ) => Record<string, Pick<DumpAccount, 'teams' | 'games' | 'people'>>
}

export const DUMP_WORLDS: Record<string, DumpWorld> = {
  /** `coach-game`'s home team, its coaches and its game, as a dump. */
  'coach-season-dump': {
    source: 'coach-game',
    holds: manifest => {
      const team = { id: manifest.ids.homeTeam, name: 'Hosts' }
      const game = { id: manifest.ids.game, name: 'Visitors at Hosts' }
      const lineup = Object.entries(manifest.ids)
        .filter(([name]) => name.startsWith('homePlayer'))
        .map(([name, id]) => ({ id, name }))
      return {
        coach: { teams: [team], games: [game], people: lineup },
        assistant: { teams: [team], games: [game], people: [] },
        scorekeeper: { teams: [team], games: [game], people: [] }
      }
    }
  }
}

export function dumpPath(root: string, world: string): string {
  return join(root, DUMPS_DIR, `${world}.dump`)
}

export function accountsPath(root: string, world: string): string {
  return join(root, DUMPS_DIR, `${world}.accounts.json`)
}

/** Whether `world` is a dump world: it has a committed dump. */
export function isDumpWorld(root: string, world: string): boolean {
  return existsSync(dumpPath(root, world))
}

export function readDumpAccounts(root: string, world: string): DumpAccounts {
  const path = accountsPath(root, world)
  if (!existsSync(path)) {
    throw new HarnessError(`dump world ${world} has no accounts file`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DumpAccounts
}

/** A role's account from the dump worlds a spec names, or why there is none. */
export function dumpAccount(
  root: string,
  worlds: string[],
  role: string
): DumpAccount {
  for (const world of worlds) {
    if (!existsSync(accountsPath(root, world))) continue
    const found = readDumpAccounts(root, world).accounts[role]
    if (found != null) return found
  }
  throw new HarnessError(
    `no account for role "${role}" in the dump worlds ${worlds.length === 0 ? '(none)' : worlds.join(', ')}`
  )
}

/** The accounts file `e2e dump` writes from a world's manifest. */
export function accountsFrom(
  world: string,
  definition: DumpWorld,
  manifest: FixtureManifest,
  migration: string
): DumpAccounts {
  const holds = definition.holds(manifest)
  const accounts: Record<string, DumpAccount> = {}
  for (const [role, account] of Object.entries(manifest.accounts)) {
    accounts[role] = {
      ...account,
      ...(holds[role] ?? { teams: [], games: [], people: [] })
    }
  }
  return { world, source: definition.source, migration, accounts }
}

/** `pg_dump`'s arguments: the custom format, rows of the excluded tables left out. */
export function dumpArgs(databaseUrl: string, out: string): string[] {
  return [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    ...EXCLUDED_TABLES.map(table => `--exclude-table-data=${table}`),
    `--file=${out}`,
    `--dbname=${databaseUrl}`
  ]
}

/** Runs a PostgreSQL client tool and answers what it printed. */
export type PgTool = (tool: string, args: string[]) => string

export const runPgTool: PgTool = (tool, args) =>
  execFileSync(tool, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })

/** The `schema.table` of each table a dump's listing carries rows for. */
export function tablesWithData(listing: string): string[] {
  const tables: string[] = []
  for (const line of listing.split('\n')) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line)
    if (match != null) tables.push(`${match[1]}.${match[2]}`)
  }
  return tables
}

/** Whether a listing's `schema.table` is the excluded `table` (`public` when bare). */
function isTable(qualified: string, table: string): boolean {
  return qualified === (table.includes('.') ? table : `public.${table}`)
}

/**
 * Every problem of the committed dump worlds, for `validate --strict`: a
 * dump over the cap, one carrying rows of an excluded table, one too far
 * behind the newest migration, and an accounts file naming a role whose
 * account is not in the dump.
 */
export function dumpProblems(
  root: string,
  files: string[],
  migrations: string[],
  options: { pg?: PgTool; maxBehind?: number } = {}
): string[] {
  const pg = options.pg ?? runPgTool
  const maxBehind = options.maxBehind ?? DUMP_MAX_MIGRATIONS_BEHIND
  const problems: string[] = []
  const prefix = `${DUMPS_DIR}/`
  const worlds = files
    .filter(file => file.startsWith(prefix) && file.endsWith('.dump'))
    .map(file => file.slice(prefix.length, -'.dump'.length))
  for (const world of worlds) {
    const file = `${DUMPS_DIR}/${world}.dump`
    const dump = dumpPath(root, world)
    const size = statSync(dump).size
    if (size > MAX_DUMP_BYTES) {
      problems.push(
        `${file}: ${size} bytes is over the ${MAX_DUMP_BYTES}-byte cap on a dump world`
      )
    }
    let listing: string
    try {
      listing = pg('pg_restore', ['--list', dump])
    } catch (error) {
      problems.push(`${file}: pg_restore cannot list it: ${String(error)}`)
      continue
    }
    const carried = tablesWithData(listing)
    for (const table of EXCLUDED_TABLES) {
      if (carried.some(qualified => isTable(qualified, table))) {
        problems.push(
          `${file}: carries rows of ${table}, which a dump leaves out`
        )
      }
    }
    if (!existsSync(accountsPath(root, world))) {
      problems.push(`${file}: has no ${world}.accounts.json beside it`)
      continue
    }
    let accounts: DumpAccounts
    try {
      accounts = readDumpAccounts(root, world)
    } catch (error) {
      problems.push(
        `${file}: its accounts file is unreadable: ${String(error)}`
      )
      continue
    }
    const at = migrations.indexOf(accounts.migration)
    if (at < 0) {
      problems.push(
        `${file}: its migration ${accounts.migration} is not one of this checkout's`
      )
    } else if (migrations.length - 1 - at > maxBehind) {
      problems.push(
        `${file}: ${migrations.length - 1 - at} migrations behind the newest, more than ${maxBehind}: run e2e dump ${world}`
      )
    }
    const users = pg('pg_restore', [
      '--data-only',
      '--table=users',
      '--file=-',
      dump
    ])
    for (const [role, account] of Object.entries(accounts.accounts)) {
      if (account.userId == null || !users.includes(account.userId)) {
        problems.push(
          `${world}.accounts.json: role "${role}" has no account in the dump`
        )
      }
    }
  }
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith('.accounts.json')) continue
    const world = file.slice(prefix.length, -'.accounts.json'.length)
    if (!worlds.includes(world)) {
      problems.push(`${file}: names a world with no dump`)
    }
  }
  return problems
}

export interface MakeDumpOptions {
  root: string
  world: string
  /** The pool stack's database, which this machine reaches. */
  databaseUrl: string
  /** Seeds the source world on the stack's database, on `DUMP_MAILBOX`. */
  seed: (world: string, mailbox: string) => Promise<FixtureManifest>
  /** This checkout's migrations, oldest first. */
  migrations: string[]
  /** Where the dump is written before it replaces the committed one. */
  scratch: string
  pg?: PgTool
  write?: (path: string, data: string | Buffer) => void
}

/**
 * `e2e dump <world>`: seeds the world's scripted source on a fresh pool
 * stack, dumps that database there, and writes the dump and its accounts
 * file into the working tree to commit. Nothing touches this machine's own
 * Postgres; a stack that already holds an account is refused, so nothing
 * but the world's invented data is dumped.
 */
export async function makeDump(
  options: MakeDumpOptions
): Promise<{ dump: string; accounts: string; bytes: number }> {
  const definition = DUMP_WORLDS[options.world]
  if (definition == null) {
    throw new HarnessError(
      `no dump world "${options.world}": one of ${Object.keys(DUMP_WORLDS).join(', ')}`
    )
  }
  const pg = options.pg ?? runPgTool
  const psql = (sql: string): string =>
    pg('psql', [
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      `--command=${sql}`,
      `--dbname=${options.databaseUrl}`
    ]).trim()
  const users = Number(psql('select count(*) from users'))
  if (users !== 0) {
    throw new HarnessError(
      `the stack's database already holds ${users} accounts: dump on a fresh stack`
    )
  }
  const manifest = await options.seed(definition.source, DUMP_MAILBOX)
  const applied = psql('select name from schema_migrations')
    .split('\n')
    .filter(Boolean)
  const unknown = applied.filter(name => !options.migrations.includes(name))
  if (unknown.length > 0) {
    throw new HarnessError(
      `the stack ran migrations this checkout lacks: ${unknown.join(', ')}`
    )
  }
  const newest = options.migrations
    .filter(name => applied.includes(name))
    .at(-1)
  if (newest == null) throw new HarnessError('the stack ran no migrations')
  const out = join(options.scratch, `${options.world}.dump`)
  pg('pg_dump', dumpArgs(options.databaseUrl, out))
  const bytes = readFileSync(out)
  if (bytes.length > MAX_DUMP_BYTES) {
    throw new HarnessError(
      `${options.world} dumps to ${bytes.length} bytes, over the ${MAX_DUMP_BYTES}-byte cap: split it, or seed its bulk`
    )
  }
  const write =
    options.write ??
    ((path: string, data: string | Buffer) => {
      writeFileSync(path, data)
    })
  const dump = dumpPath(options.root, options.world)
  const accounts = accountsPath(options.root, options.world)
  mkdirSync(join(options.root, DUMPS_DIR), { recursive: true })
  write(dump, bytes)
  write(
    accounts,
    JSON.stringify(
      accountsFrom(options.world, definition, manifest, newest),
      null,
      2
    ) + '\n'
  )
  return { dump, accounts, bytes: bytes.length }
}
