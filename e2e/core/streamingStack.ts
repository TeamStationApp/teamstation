import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AttachedHandle } from './attach'
import { nodeDatabaseUrl, runOnStack } from './dropletStack'
import { BlockedError, HarnessError } from './result'
import type { StreamingFixture } from './streaming'

export { nodeDatabaseUrl, runOnStack }

/** What the streaming scripts drive on a stack. */
export interface LegacyStack {
  /** Variables every legacy script sees while the stack is up. */
  env: Record<string, string>
  apiLog: string
  /** Whether the API has an xAI speech key. */
  speech: boolean
  /** Seeds the accounts again, after something dropped the database. */
  reseed: () => void
  /** Restarts the API, with `speech` left out of its config when `speech` is false. */
  restartApi: (options?: { speech?: boolean }) => Promise<void>
  /**
   * Starts the stack's own API again when a script stopped it and left a
   * server of its own on the API port (scoreboardServer's restart).
   */
  ensureApi: () => Promise<void>
  stop: () => Promise<void>
}

/** What an attached stack's handle must carry for the streaming scripts. */
export interface StreamingHandle extends AttachedHandle {
  api: string
  /** `user@host` this Mac reaches over SSH with its own key; nothing is forwarded. */
  ssh: string
  /** The API's log on the stack's server. */
  serverLog: string
  /** The HLS work directory on the stack's server. */
  hlsRoot: string
  /** A Postgres URL this Mac can reach. */
  databaseUrl: string
  /** The publisher droplet that sends the synthetic cameras, and its token. */
  publisher?: { url: string; token: string }
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
    // Read and dropped: a pipe nobody reads fills, and its writer stops.
    tail.stderr?.resume()
    // A tail that ends, or that could not start, is started again.
    let again = false
    const retry = (): void => {
      if (again || stopped) return
      again = true
      setTimeout(follow, 2000)
    }
    tail.on('exit', retry)
    tail.on('error', retry)
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
      // A live tree loses segments mid-copy, and rsync says so for each one:
      // unread, that fills its pipe and the copy never ends.
      child.stdout?.resume()
      child.stderr?.resume()
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
