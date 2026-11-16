import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AttachedHandle, StackEntry } from './attach'
import type { FixtureManifest } from './fixtures'
import type { ServerError } from './invariants'
import { ROOT } from './manifest'
import { BlockedError, HarnessError } from './result'
import type { StackHandle } from './spec'

/**
 * A stack on a droplet of its own, as the devops repo's e2e-stack makes it
 * (version 2 of the handle): its pool name and origin, the API, the observer's
 * SSH, the API's log and HLS root on the droplet, a Postgres URL this machine
 * reaches, and the fault server's control route, when the ref has it.
 */
export interface DropletHandle extends AttachedHandle {
  name: string
  api: string
  ssh: string
  serverLog: string
  hlsRoot: string
  databaseUrl: string
  faults?: { url: string; token: string }
}

/** The handle as a droplet stack's, or why it is not one. */
export function requireDropletHandle(handle: AttachedHandle): DropletHandle {
  if (handle.version < 2) {
    throw new HarnessError(
      `stack "${handle.id}" has a version ${handle.version} handle: take it down and bring it up again with stack up`
    )
  }
  const missing = [
    'name',
    'api',
    'ssh',
    'serverLog',
    'hlsRoot',
    'databaseUrl'
  ].filter(name => typeof handle[name] !== 'string' || handle[name] === '')
  if (missing.length > 0) {
    throw new HarnessError(
      `stack "${handle.id}" is not a droplet stack: its handle has no ${missing.join(', ')}`
    )
  }
  return handle as DropletHandle
}

/**
 * The handle's database URL for node's `pg`, with `sslmode=require` read as
 * libpq reads it: encrypted, without verifying the certificate, as psql and
 * other libpq clients take the handle's URL. `pg` alone would read it as
 * full verification.
 */
export function nodeDatabaseUrl(url: string): string {
  if (!/[?&]sslmode=require\b/.test(url) || /[?&]uselibpqcompat=/.test(url))
    return url
  return `${url}&uselibpqcompat=true`
}

/**
 * Runs a fixture script of this checkout against the stack's database, from
 * a scratch directory whose server config names that database, allows
 * fixtures, and adds `config`. Returns the JSON the script prints. The
 * fixtures read the database itself and refuse one holding a real address.
 */
export async function runOnStack(options: {
  cwd: string
  handle: { databaseUrl: string }
  script: string
  args: string[]
  scratch: string
  config?: Record<string, unknown>
}): Promise<unknown> {
  const { cwd, handle, script, args } = options
  mkdirSync(options.scratch, { recursive: true })
  // A directory of this call's own: two seeds at once in one process (run-many)
  // must not share a server config, or one seeds the other's database.
  const scratch = mkdtempSync(join(options.scratch, 'seed-'))
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
    rmSync(scratch, { recursive: true, force: true })
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
  rmSync(scratch, { recursive: true, force: true })
  if (status !== 0) {
    throw new HarnessError(`${script} failed: ${stderr.slice(-2000)}`)
  }
  return JSON.parse(stdout)
}

/** Seeds a fixture world on the stack's database, as `npm run fixtures` would on its own. */
export async function seedOnStack(
  handle: { id: string; databaseUrl: string },
  world: string,
  mailbox: string,
  cwd = ROOT
): Promise<FixtureManifest> {
  return (await runOnStack({
    cwd,
    handle,
    script: 'src/server/dev/fixtures/cli.ts',
    args: [world, '--json', '--mailbox', mailbox],
    scratch: join(tmpdir(), `e2e-seed-${handle.id}-${process.pid}`)
  })) as FixtureManifest
}

/** The fault server's control route on a droplet, by its token. */
export interface FaultControl {
  setFault: (fault: string | null) => Promise<void>
  serverErrors: (since: number) => Promise<ServerError[]>
}

export function faultControl(
  faults: { url: string; token: string },
  fetchFn: typeof fetch = fetch
): FaultControl {
  const base = faults.url.endsWith('/') ? faults.url : `${faults.url}/`
  const call = async (
    method: string,
    route: string,
    body?: unknown
  ): Promise<unknown> => {
    const reply = await fetchFn(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${faults.token}`,
        'content-type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    })
    if (!reply.ok) {
      throw new HarnessError(
        `the stack's fault server answered ${method} ${route} with ${reply.status}`
      )
    }
    return await reply.json()
  }
  return {
    setFault: async fault => {
      await call('PUT', 'fault', { fault })
    },
    serverErrors: async since =>
      (
        (await call('GET', `errors?since=${since}`)) as {
          errors: ServerError[]
        }
      ).errors
  }
}

/**
 * The handle a scenario gets for a droplet stack: it seeds worlds on the
 * droplet's database (on `mailbox`), and reads its 5xx and sets its fault
 * through the fault server, when the stack has one.
 */
export function dropletStackHandle(
  entry: StackEntry,
  options: { mailbox?: string; fetchFn?: typeof fetch; cwd?: string } = {}
): StackHandle {
  if (entry.handle == null) {
    throw new HarnessError(`stack "${entry.id}" has no handle`)
  }
  const handle = requireDropletHandle(entry.handle)
  const control =
    handle.faults == null
      ? undefined
      : faultControl(handle.faults, options.fetchFn)
  return {
    kind: 'isolated',
    origin: entry.origin,
    webDir: undefined,
    attached: handle,
    adopt: async origin => origin,
    ...(entry.baselineManifest == null
      ? {}
      : { baselineManifest: entry.baselineManifest }),
    seedWorld: async (name: string) => {
      if (options.mailbox == null) {
        throw new BlockedError(
          'no test mailbox: set mailbox in the local settings'
        )
      }
      return await seedOnStack(handle, name, options.mailbox, options.cwd)
    },
    serverErrors: async since => await control?.serverErrors(since),
    ...(control == null
      ? {}
      : {
          setFault: async (fault: string | null) => {
            await control.setFault(fault)
          }
        })
  }
}
