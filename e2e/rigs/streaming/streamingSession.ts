import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Client } from 'pg'

import { isTestAddress } from '../../../src/server/dev/fixtures/address'
import { BlockedError, HarnessError } from '../../core/result'
import { loadSettings } from '../../core/settings'
import type { E2eContext } from '../../core/spec'
import {
  attachedLegacyStack,
  nodeDatabaseUrl,
  requireStreamingHandle,
  runOnStack,
  type StreamingHandle
} from '../../core/streamingStack'
import { recoveringDevice } from './recovering'
import type { Exec } from './samplers/sample'
import type { SoakFixtureManifest } from './soakFixture'
import {
  approveTvCode,
  sessionToken,
  type SignInStack,
  signInToken,
  tvCodeIn
} from './soakSignIn'
import { SAFARI } from './surfaces/mobileSafari'
import {
  ndiCapture,
  remoteHelper,
  type TvRemote,
  TvSurface
} from './surfaces/tv'

/**
 * What every streaming scenario on an attached stack shares: the bench
 * settings, the seeded world and its accounts, signing in by e-mailed link,
 * attaching the bench devices through maestro-d (re-attached when their
 * driver dies), handing a link to the develop app alone, and the TV's remote.
 * The two-hour soak (`soakWiring.ts`) and the targeted scenarios
 * (`targeted.ts`) are both built from these.
 */

export const DEVELOP_APP = 'app.teamstation.develop'
export const TV_APP = 'app.teamstation.tv'
/**
 * The longest one Android press may hold: UiAutomator2 answers a long click
 * only when it ends, and maestro-d gives up on the request after eight seconds.
 */
export const ANDROID_MAX_HOLD_MS = 7000

/**
 * Whom each device signs in as. The publishers film, so they are the game's
 * owner. Every watcher is the viewer, who may not end or remove a camera: a
 * watcher's press-grid tap that lands on the game page instead of the player
 * must not reach a camera's ⋯ menu. The TV stays the owner: its session is
 * never revoked (TeamStation TV hangs on "Connecting…" when it is), and the
 * TV app has no camera management.
 */
export const SIGN_IN_AS = {
  publisherA: 'owner',
  publisherB: 'owner',
  iphone: 'viewer',
  android: 'viewer',
  ipad: 'viewer',
  chrome: 'viewer',
  'iphone-safari': 'viewer',
  tv: 'owner'
} as const

/** The two accounts of the soak's world, or a harness error naming the one it lacks. */
export function soakAccounts(world: Pick<SoakFixtureManifest, 'accounts'>): {
  owner: string
  viewer: string
} {
  const { owner, viewer } = world.accounts
  if (owner == null || viewer == null) {
    throw new Error(
      `the soak world has no ${owner == null ? 'owner' : 'viewer'} account`
    )
  }
  return { owner: owner.email, viewer: viewer.email }
}

/**
 * Ends every session on the throwaway stack but the TV's, so a device that
 * holds any account's session, the owner's included, signs in afresh as the
 * account `SIGN_IN_AS` gives it.
 */
/**
 * Refuses a database holding anybody's address but the test mailbox's: the
 * soak signs every session out, and that must only ever be a throwaway
 * stack's. Read from the database, since a handle file can name any.
 */
export async function refuseRealAccounts(
  client: Pick<Client, 'query'>,
  mailbox: string
): Promise<void> {
  const { rows } = await client.query<{ email: string }>(
    'select email from user_emails'
  )
  const real = rows.filter(row => !isTestAddress(mailbox, row.email))
  if (real.length > 0) {
    throw new HarnessError(
      `the attached stack's database holds ${real.length} address(es) that are not test addresses`
    )
  }
}

export const REVOKE_SESSIONS =
  "update auth_sessions set revoked_at = now() where revoked_at is null and device_name is distinct from 'Apple TV'"

/** The bench pieces only this Mac knows, from the local settings' `soak` block. */
export interface SoakSettings {
  tvRemote: { command: string[]; env: Record<string, string> }
  ndiCapture: { command: string[] }
  /** From TeamStation TV's home to the game's multi-camera player. */
  tvJoinSteps: string[]
  /** The suite's pinned ffmpeg, which can encode HEVC with drawtext. */
  ffmpeg: string
  /** The bench clock's offset from UTC, in minutes. */
  offsetMinutes?: number
  /** The installed TeamStation Develop build, which iOS attaches name so no other is put in its place. */
  iosApp: string
  /** The module that makes the network conditioner (`loadShaper`), for a watcher's outage; receiver-outage is blocked without it. */
  shaper?: string
  /** Each watcher role's address on a test network, for an outage through the conditioner. */
  shapedIps?: Record<string, string>
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Reads the `soak` block, or blocks the run naming what it lacks. */
export function soakSettings(raw: unknown): SoakSettings {
  const soak = (raw ?? {}) as Record<string, unknown>
  const remote = (soak.tvRemote ?? {}) as Record<string, unknown>
  const capture = (soak.ndiCapture ?? {}) as Record<string, unknown>
  const missing = [
    strings(remote.command) && remote.command.length > 0
      ? ''
      : 'tvRemote.command',
    strings(capture.command) && capture.command.length > 0
      ? ''
      : 'ndiCapture.command',
    strings(soak.tvJoinSteps) ? '' : 'tvJoinSteps',
    typeof soak.ffmpeg === 'string' ? '' : 'ffmpeg',
    typeof soak.iosApp === 'string' ? '' : 'iosApp'
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new BlockedError(
      `the local settings' soak block has no ${missing.join(', ')}`
    )
  }
  return {
    tvRemote: {
      command: remote.command as string[],
      env: (remote.env ?? {}) as Record<string, string>
    },
    ndiCapture: { command: capture.command as string[] },
    tvJoinSteps: soak.tvJoinSteps as string[],
    ffmpeg: soak.ffmpeg as string,
    iosApp: soak.iosApp as string,
    ...(typeof soak.offsetMinutes === 'number'
      ? { offsetMinutes: soak.offsetMinutes }
      : {}),
    ...(typeof soak.shaper === 'string' && soak.shaper !== ''
      ? { shaper: soak.shaper }
      : {}),
    ...(soak.shapedIps != null && typeof soak.shapedIps === 'object'
      ? {
          shapedIps: Object.fromEntries(
            Object.entries(soak.shapedIps as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        }
      : {})
  }
}

export function localSoak(): unknown {
  const file =
    process.env.E2E_LOCAL_SETTINGS ??
    join(homedir(), '.config/teamstation-e2e/local.json')
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { soak?: unknown }).soak
  } catch {
    return undefined
  }
}

/** Where each surface opens the soak's game. */
export function gameLinks(
  origin: string,
  gameId: string
): { app: string; web: string; tvApp: string } {
  return {
    app: `teamstation://games/${gameId}?tab=watch`,
    web: `${origin.replace(/\/$/, '')}/games/${gameId}?tab=watch`,
    tvApp: `teamstation-tv://games/${gameId}`
  }
}

/** The handle's server settings the soak world's stream keys are minted with. */
export function soakServerConfig(
  handle: StreamingHandle
): Record<string, unknown> {
  const config = handle.serverConfig as Record<string, unknown> | undefined
  if (typeof config?.sessionSecret !== 'string' || config.live == null) {
    throw new BlockedError(
      `stack "${handle.id}" has no serverConfig with sessionSecret and live: the soak cannot mint stream keys`
    )
  }
  return { sessionSecret: config.sessionSecret, live: config.live }
}

/** The RTMP address with the key, for the synthetic camera only. */
export function rtmpUrl(handle: StreamingHandle, key: string): string {
  if (typeof handle.rtmp !== 'string') {
    throw new BlockedError(`stack "${handle.id}" names no rtmp ingest`)
  }
  const base = handle.rtmp.replace(/\/$/, '')
  // The server names its ingest as rtmp://host:port; publishers send to its live app.
  const app = /^rtmp:\/\/[^/]+$/.test(base) ? `${base}/live` : base
  return `${app}/${key}`
}

export const run = promisify(execFile)
export const exec: Exec = async (command, args) =>
  (await run(command, args, { maxBuffer: 512 * 1024 * 1024 })).stdout

/**
 * One statement batch on the throwaway stack's database, over a connection of
 * its own: one left idle is dropped on the way to the droplet.
 */
export async function onStackDatabase(
  handle: StreamingHandle,
  work: (client: Client) => Promise<void>
): Promise<void> {
  const client = new Client({
    connectionString: nodeDatabaseUrl(handle.databaseUrl),
    connectionTimeoutMillis: 15_000
  })
  await client.connect()
  try {
    await work(client)
  } finally {
    await client.end()
  }
}

/** The seeded world on the attached stack, signed-in helpers, and how to let go of it. */
export interface StreamingWorld {
  handle: StreamingHandle
  settings: SoakSettings
  world: SoakFixtureManifest
  emails: { owner: string; viewer: string }
  links: ReturnType<typeof gameLinks>
  stack: SignInStack
  /** The owner's session token, for the TV's code and the owner's API calls. */
  ownerToken: string
  /** A fresh one-time sign-in token for the account. */
  link: (who: 'owner' | 'viewer') => () => Promise<string>
  /** Ends the log mirror. */
  close: () => Promise<void>
}

/**
 * Seeds a world on the attached stack (the soak's, or `synthetic` labelled
 * cameras only), starts mirroring its log for the e-mailed codes, ends every
 * session but the TV's, and signs the owner in through the API.
 */
/** What `openWorld` reaches outside this process; the real ones unless a test stands in. */
export interface WorldDeps {
  runOnStack: typeof runOnStack
  mirror: (
    handle: StreamingHandle,
    dir: string
  ) => { apiLog: string; stop: () => Promise<void> }
  onDatabase: (
    handle: StreamingHandle,
    work: (client: Client) => Promise<void>
  ) => Promise<void>
  sessionToken: typeof sessionToken
  signInToken: typeof signInToken
  mailbox: () => string | undefined
  settings: () => unknown
  sleep: (ms: number) => Promise<void>
}

export const realWorldDeps: WorldDeps = {
  runOnStack,
  mirror: (handle, dir) => attachedLegacyStack(handle, dir),
  onDatabase: onStackDatabase,
  sessionToken,
  signInToken,
  mailbox: () => loadSettings().mailbox ?? undefined,
  settings: localSoak,
  sleep: async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

export async function openWorld(
  options: {
    ctx: E2eContext
    cwd: string
    synthetic?: string[]
  },
  deps: WorldDeps = realWorldDeps
): Promise<StreamingWorld> {
  const { ctx, cwd } = options
  if (ctx.stack.attached == null) {
    throw new BlockedError(
      'a streaming scenario needs a stack: npm run -s e2e -- stack up --ref <ref>, then --stack <id>'
    )
  }
  const handle = requireStreamingHandle(ctx.stack.attached)
  const settings = soakSettings(deps.settings())
  const mailbox = deps.mailbox()
  if (mailbox == null) throw new BlockedError('local settings name no mailbox')

  const world = (await deps.runOnStack({
    cwd,
    handle,
    script: 'e2e/rigs/streaming/soakFixture.ts',
    args: [
      '--json',
      '--mailbox',
      mailbox,
      ...(options.synthetic == null
        ? []
        : ['--synthetic', options.synthetic.join(',')])
    ],
    scratch: join(tmpdir(), `soak-fixture-${process.pid}`),
    config: soakServerConfig(handle)
  })) as SoakFixtureManifest
  const emails = soakAccounts(world)
  const links = gameLinks(handle.origin, world.gameId)

  const mirror = deps.mirror(handle, ctx.artifact('mirror'))
  try {
    // The mirror follows new lines only: let its SSH connect before the first
    // request whose line it must catch.
    await deps.sleep(5000)
    const stack: SignInStack = {
      api: handle.api,
      serverLog: mirror.apiLog,
      // A connection of its own each time: one left idle between sign-ins is
      // dropped on the way to the droplet, and its next read times out.
      resetLimits: async () => {
        await deps.onDatabase(handle, async client => {
          await client.query(
            "delete from rate_events where scope like 'emailCode.%'"
          )
        })
      }
    }
    // Devices keep sessions for earlier runs' accounts, and a signed-in app or
    // page ignores a sign-in link: every session but the TV's ends, so each
    // surface signs in afresh as the account SIGN_IN_AS gives it.
    await deps.onDatabase(handle, async client => {
      await refuseRealAccounts(client, mailbox)
      await client.query(REVOKE_SESSIONS)
    })
    const ownerToken = await deps.sessionToken(stack, emails.owner)
    return {
      handle,
      settings,
      world,
      emails,
      links,
      stack,
      ownerToken,
      link: who => async () => await deps.signInToken(stack, emails[who]),
      close: async () => {
        await mirror.stop()
      }
    }
  } catch (error) {
    // A world that never opened lets go of its mirror before it says why.
    await mirror.stop().catch(() => undefined)
    throw error
  }
}

/** One word to a POSIX shell, whatever it holds. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`
}

/** Attaching and addressing bench devices for one run. */
export interface DeviceKit {
  attachIos: (role: string) => Promise<any>
  /** An iPhone driven in Safari alone: the develop app is neither installed nor launched. */
  attachSafari: (role: string) => Promise<any>
  attachAndroid: (role: string) => Promise<any>
  /** Hands a link to the develop app alone, on the role's device. */
  openIn: (
    role: string,
    platform: 'ios' | 'android'
  ) => (link: string) => Promise<void>
  /** Stores a screenshot in the run directory and returns its name. */
  saveShot: (name: string, png: Uint8Array) => string
}

export function deviceKit(
  ctx: E2eContext,
  settings: SoakSettings,
  deps: {
    run: (command: string, args: string[]) => Promise<unknown>
    write: (file: string, data: Uint8Array) => void
    log: (line: string) => void
    settleMs?: number
  } = {
    run: async (command, args) => await run(command, args),
    write: (file, data) => {
      writeFileSync(file, data)
    },
    log: line => {
      console.log(line)
    }
  }
): DeviceKit {
  const settleMs = deps.settleMs ?? 3000
  // A device whose driver dies is attached again, and the run says when.
  const recovering = async (
    role: string,
    options: Record<string, unknown>
  ): Promise<any> =>
    await recoveringDevice({
      role,
      attach: async () => await ctx.attach(role, options),
      onRecovery: recovery => {
        deps.log(
          `${role}: driver lost in ${recovery.call}; ${recovery.recoveredMs == null ? `not recovered: ${recovery.reattachError ?? 'within the cooldown'}` : 'attached again'}`
        )
        appendFileSync(
          ctx.artifact('recoveries.jsonl'),
          `${JSON.stringify(recovery)}\n`
        )
      }
    })
  return {
    attachIos: async role =>
      await recovering(role, {
        platform: 'ios',
        appId: DEVELOP_APP,
        appFile: settings.iosApp
      }),
    attachSafari: async role =>
      await recovering(role, { platform: 'ios', appId: SAFARI }),
    attachAndroid: async role =>
      await recovering(role, { platform: 'android', appId: DEVELOP_APP }),
    // The develop build and production TeamStation share the teamstation://
    // scheme, so each link goes to the develop app by its id, not through the
    // system's choice of app.
    openIn: (role, platform) => async link => {
      const id = ctx.device(role)
      if (platform === 'ios') {
        await deps.run('xcrun', [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          id,
          '--payload-url',
          link,
          DEVELOP_APP
        ])
      } else {
        // The device's shell reads the command: the link is one quoted word.
        await deps.run('adb', [
          '-s',
          id,
          'shell',
          `am start -W -a android.intent.action.VIEW -d ${shellQuote(link)} ${DEVELOP_APP}`
        ])
      }
      await new Promise(resolve => setTimeout(resolve, settleMs))
    },
    saveShot: (name, png) => {
      deps.write(ctx.artifact(name), png)
      return name
    }
  }
}

/** The TV's surface and its remote, from the bench settings. */
export function tvKit(
  ctx: E2eContext,
  settings: SoakSettings,
  exec: (
    command: string,
    args: string[],
    options: { env?: Record<string, string | undefined> }
  ) => Promise<{ stdout: string }> = async (command, args, options) =>
    await run(command, args, { env: options.env })
): { tv: TvSurface; remote: TvRemote } {
  const remote = remoteHelper(
    {
      command: settings.tvRemote.command,
      env: { ...settings.tvRemote.env, TV_DEVICE_UDID: ctx.device('tv') }
    },
    exec
  )
  const tv = new TvSurface({
    remote,
    capture: ndiCapture(
      { command: settings.ndiCapture.command, out: ctx.artifact('tv-ndi.png') },
      async (command, args) => await exec(command, args, {}),
      path => readFileSync(path)
    ),
    bundleId: TV_APP,
    appName: 'TeamStation',
    joinSteps: settings.tvJoinSteps
  })
  return { tv, remote }
}

/** TeamStation TV past sign-in: its home (which offers Sign out) or its player. */
const TV_SIGNED_IN = /'tv-player'|tv-page-(?:home|player)|label: 'Sign out'/

/**
 * Signs TeamStation TV in as the owner, approving the code it shows. A TV
 * signed in already holds this stack's owner: every run on a stack shares
 * that account, and a new stack's TV shows its code. Its own Sign out cannot
 * be reached by the remote, since the dump marks no focus. A cold launch
 * shows its brand screen before the code, so the TV is looked at again
 * until it shows its home or its player. Says whether a code was approved; throws when
 * the TV is still signing in after `tries` looks.
 */
export async function signInTv(
  remote: TvRemote,
  world: Pick<StreamingWorld, 'stack' | 'ownerToken'>,
  tries = 8
): Promise<boolean> {
  let approved = false
  let steps = [`app:${TV_APP}`, 'wait:4', 'dump']
  for (let i = 0; i < tries; i++) {
    const shown = await remote(steps)
    steps = [`app:${TV_APP}`, 'wait:5', 'dump']
    const code = tvCodeIn(shown)
    if (code != null) {
      await approveTvCode(world.stack, world.ownerToken, code)
      approved = true
      continue
    }
    if (TV_SIGNED_IN.test(shown)) return approved
  }
  throw new Error(`the TV is still signing in after ${tries} looks`)
}

/**
 * Which account each live session holds, for the run's record: a watcher
 * session of the owner's would let a stray tap end a camera.
 */
export async function recordSessions(
  world: Pick<StreamingWorld, 'handle' | 'world'>,
  file: string,
  onDatabase: WorldDeps['onDatabase'] = onStackDatabase
): Promise<void> {
  const owners = new Map([
    [world.world.accounts.owner.userId, 'owner'],
    [world.world.accounts.viewer.userId, 'viewer']
  ])
  await onDatabase(world.handle, async client => {
    const live = await client.query(
      'select user_id, device_name, user_agent, created_at from auth_sessions where revoked_at is null order by created_at'
    )
    writeFileSync(
      file,
      JSON.stringify(
        live.rows.map(row => ({
          account: owners.get(row.user_id) ?? 'other',
          device: row.device_name,
          userAgent: row.user_agent,
          createdAt: row.created_at
        })),
        null,
        2
      )
    )
  })
}
