import { type ChildProcess, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import { Client } from 'pg'

import type { AttachedHandle } from './attach'
import type { LegacyStack } from './legacyStack'
import { BlockedError, HarnessError } from './result'
import type { StreamingFixture } from './streaming'

/** What an attached stack's handle must carry for the streaming scripts. */
export interface StreamingHandle extends AttachedHandle {
  api: string
  /** `user@host` this Mac reaches over SSH with its own key; nothing is forwarded. */
  ssh: string
  /** The API's log on the droplet. */
  serverLog: string
  /** The HLS work directory on the droplet. */
  hlsRoot: string
  /** The droplet's Postgres over TLS, open to the bench address only. */
  databaseUrl: string
}

export function requireStreamingHandle(
  handle: AttachedHandle
): StreamingHandle {
  const missing = ['api', 'ssh', 'serverLog', 'hlsRoot', 'databaseUrl'].filter(
    name => typeof handle[name] !== 'string' || handle[name] === ''
  )
  if (missing.length > 0) {
    throw new HarnessError(
      `stack "${handle.id}" cannot run the streaming scripts: its handle has no ${missing.join(', ')}`
    )
  }
  return handle as StreamingHandle
}

/**
 * The handle's database URL for node's `pg`, which reads `sslmode=require` as
 * full certificate verification. The droplet's Postgres has a self-signed
 * certificate, so the URL gets libpq's meaning of `require`: encrypted,
 * unverified. psql and other libpq clients take the handle's URL as it is.
 */
export function nodeDatabaseUrl(url: string): string {
  if (!/[?&]sslmode=require\b/.test(url) || /[?&]uselibpqcompat=/.test(url))
    return url
  return `${url}&uselibpqcompat=true`
}

/**
 * Readies a throwaway stack for the next script: clears the sign-in code
 * limits (five codes an address may ask for in fifteen minutes, and the
 * scripts ask for the same fixture accounts), and ends every session but the
 * TV's, so an app or page a script finds signed in as an earlier one's
 * account signs in again as its own. TeamStation TV hangs on a revoked session.
 */
export async function clearCodeLimits(
  handle: StreamingHandle,
  connect: (url: string) => {
    connect: () => Promise<unknown>
    query: (sql: string) => Promise<unknown>
    end: () => Promise<unknown>
  } = url =>
    new Client({ connectionString: url, connectionTimeoutMillis: 15_000 })
): Promise<void> {
  const client = connect(nodeDatabaseUrl(handle.databaseUrl))
  await client.connect()
  try {
    await client.query("delete from rate_events where scope like 'emailCode.%'")
    await client.query(
      "update auth_sessions set revoked_at = now() where revoked_at is null and device_name is distinct from 'Apple TV'"
    )
  } finally {
    await client.end()
  }
}

/** Where the droplet's files are mirrored on this Mac. */
export interface Mirrors {
  serverLog: string
  hlsRoot: string
}

export function mirrorsIn(dir: string): Mirrors {
  return { serverLog: join(dir, 'api.log'), hlsRoot: join(dir, 'hls') }
}

/**
 * The variables the streaming scripts read, pointed at the attached stack:
 * its origins and database, and the local mirrors of its log and HLS files.
 */
export function streamingStackEnv(
  handle: StreamingHandle,
  mirrors: Mirrors
): Record<string, string> {
  const api = handle.api.replace(/\/$/, '')
  const host = api.replace(/\/api\/v1$/, '')
  return {
    TS_E2E_HOST: host,
    TS_E2E_WEB: handle.origin,
    TS_E2E_DATABASE_URL: nodeDatabaseUrl(handle.databaseUrl),
    TS_DATABASE: nodeDatabaseUrl(handle.databaseUrl),
    TS_E2E_SERVER_LOG: mirrors.serverLog,
    TS_STREAM_API: api,
    TS_STREAM_WEB: handle.origin,
    TS_STREAM_SERVER_LOG: mirrors.serverLog,
    TS_STREAM_HLS_ROOT: mirrors.hlsRoot,
    REPLAY_WEB_URL: handle.origin,
    REPLAY_API: api,
    REPLAY_SERVER_LOG: mirrors.serverLog,
    // The scripts launch the production app unless told otherwise; the
    // stack's builds are TeamStation Develop.
    TS_STREAM_APP_ID: 'app.teamstation.develop',
    ...(typeof handle.rtmp === 'string' ? { TS_STREAM_RTMP: handle.rtmp } : {})
  }
}

/** SSH options for an unattended outbound connection that forwards nothing. */
export const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ClearAllForwardings=yes'
]

/** The commands that keep the mirrors fresh: a follow of the log, and a copy of the HLS tree. */
export function mirrorCommands(
  handle: StreamingHandle,
  mirrors: Mirrors
): { tail: [string, string[]]; rsync: [string, string[]] } {
  return {
    // New lines only: a script looking for its own sign-in code must not
    // find an earlier run's for the same address.
    tail: [
      'ssh',
      [...SSH_OPTIONS, handle.ssh, 'tail', '-n', '0', '-F', handle.serverLog]
    ],
    rsync: [
      'rsync',
      [
        '-a',
        '--delete',
        '-e',
        ['ssh', ...SSH_OPTIONS].join(' '),
        `${handle.ssh}:${handle.hlsRoot.replace(/\/$/, '')}/`,
        `${mirrors.hlsRoot}/`
      ]
    ]
  }
}

type Spawn = (command: string, args: string[]) => ChildProcess

const spawnQuiet: Spawn = (command, args) =>
  spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * A legacy stack over an attached droplet: nothing is served from this Mac.
 * The API's log is followed and the HLS tree copied every `everyMs`, both
 * over outbound SSH. A script that would reseed or restart the API is
 * blocked, since those run on the droplet.
 */
export function attachedLegacyStack(
  handle: StreamingHandle,
  dir: string,
  options: { everyMs?: number; spawn?: Spawn } = {}
): LegacyStack {
  const run = options.spawn ?? spawnQuiet
  const mirrors = mirrorsIn(dir)
  mkdirSync(mirrors.hlsRoot, { recursive: true })
  writeFileSync(mirrors.serverLog, '')
  const commands = mirrorCommands(handle, mirrors)
  const log = createWriteStream(mirrors.serverLog, { flags: 'a' })
  let tail: ChildProcess | undefined
  const follow = (): void => {
    tail = run(...commands.tail)
    tail.stdout?.pipe(log, { end: false })
    tail.on('exit', () => {
      if (tail != null && !stopped) setTimeout(follow, 2000)
    })
  }
  let stopped = false
  let copying: Promise<void> | undefined
  const copy = async (): Promise<void> => {
    if (copying != null) {
      await copying
      return
    }
    copying = new Promise<void>(resolve => {
      const child = run(...commands.rsync)
      child.on('exit', () => {
        resolve()
      })
      child.on('error', () => {
        resolve()
      })
    })
    await copying
    copying = undefined
  }
  follow()
  const timer = setInterval(() => {
    copy().catch(() => undefined)
  }, options.everyMs ?? 5000)
  const elsewhere = (what: string) => () => {
    throw new BlockedError(`${what} runs on the attached stack's droplet`)
  }
  return {
    env: streamingStackEnv(handle, mirrors),
    apiLog: mirrors.serverLog,
    speech: false,
    reseed: elsewhere('reseeding'),
    restartApi: async () => {
      elsewhere('restarting the API')()
    },
    ensureApi: async () => {
      await copy()
    },
    stop: async () => {
      stopped = true
      clearInterval(timer)
      tail?.kill('SIGTERM')
      await copy()
      log.end()
    }
  }
}

/**
 * Runs a fixture script of this checkout against the attached stack's
 * database, from a scratch directory whose server config names that database,
 * allows fixtures, and adds `config`. Returns the JSON the script prints.
 */
export async function runOnStack(options: {
  cwd: string
  handle: StreamingHandle
  script: string
  args: string[]
  scratch: string
  config?: Record<string, unknown>
}): Promise<unknown> {
  const { cwd, handle, script, args, scratch } = options
  mkdirSync(scratch, { recursive: true })
  const config = join(scratch, 'serverConfig.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...options.config,
      testSettings: true,
      databaseUrl: nodeDatabaseUrl(handle.databaseUrl)
    }),
    { mode: 0o600 }
  )
  const register = join(cwd, 'node_modules/sucrase/register')
  if (!existsSync(dirname(register))) {
    rmSync(config, { force: true })
    throw new HarnessError(`no sucrase under ${cwd}: run npm install there`)
  }
  const child = spawn(
    process.execPath,
    ['-r', register, join(cwd, script), ...args],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (bytes: Buffer) => (stdout += String(bytes)))
  child.stderr.on('data', (bytes: Buffer) => (stderr += String(bytes)))
  const status = await new Promise<number | null>(resolve => {
    child.on('close', resolve)
  })
  // It names the database's password: gone as soon as the seed is.
  rmSync(config, { force: true })
  if (status !== 0) {
    throw new HarnessError(`${script} failed: ${stderr.slice(-2000)}`)
  }
  return JSON.parse(stdout)
}

/** Seeds the streaming world on the attached stack's database. */
export async function seedStreamingFixture(
  cwd: string,
  handle: StreamingHandle,
  mailbox: string,
  scratch: string
): Promise<StreamingFixture> {
  return (await runOnStack({
    cwd,
    handle,
    script: 'src/server/dev/fixtures/cli.ts',
    args: ['streaming', '--json', '--mailbox', mailbox],
    scratch
  })) as StreamingFixture
}
