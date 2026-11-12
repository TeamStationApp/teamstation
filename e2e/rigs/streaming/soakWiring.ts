import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Client } from 'pg'

import { BlockedError } from '../../core/result'
import { loadSettings } from '../../core/settings'
import type { E2eContext } from '../../core/spec'
import {
  attachedLegacyStack,
  nodeDatabaseUrl,
  requireStreamingHandle,
  runOnStack,
  SSH_OPTIONS,
  type StreamingHandle
} from '../../core/streamingStack'
import { PhonePublisher } from './phonePublisher'
import { sampleMeminfo } from './samplers/adbMeminfo'
import { sampleChrome } from './samplers/chromeProcess'
import { sampleDroplet } from './samplers/droplet'
import type { Exec } from './samplers/sample'
import { exportTrace, recordArgs, samplesFromExport } from './samplers/xctrace'
import type { SoakFixtureManifest } from './soakFixture'
import type { MemorySample } from './soakRecords'
import type { SoakParts, SoakSampler } from './soakRun'
import type { SoakSchedule } from './soakSchedule'
import {
  approveTvCode,
  sessionToken,
  signInApp,
  type SignInStack,
  signInToken,
  tvCodeIn
} from './soakSignIn'
import { ChromeSurface } from './surfaces/chrome'
import { IphoneSurface } from './surfaces/iphone'
import { MobileSafariSurface } from './surfaces/mobileSafari'
import { NativeAppSurface } from './surfaces/nativeApp'
import { ndiCapture, remoteHelper, TvSurface } from './surfaces/tv'
import { SyntheticPublisher } from './syntheticPublisher'

export const DEVELOP_APP = 'app.teamstation.develop'
export const TV_APP = 'app.teamstation.tv'
/** The process name both apps run under, as Activity Monitor gives it. */
export const APP_PROCESS = 'TeamStation'

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
      : {})
  }
}

function localSoak(): unknown {
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

const run = promisify(execFile)
const exec: Exec = async (command, args) =>
  (await run(command, args, { maxBuffer: 512 * 1024 * 1024 })).stdout

/**
 * One device's Activity Monitor recording, read when the run ends. It records
 * every process, so it can start before the app does; the app's rows are
 * picked by name afterwards.
 */
export function xctraceSampler(
  options: {
    name: string
    udid: string
    dir: string
    webContentDuring?: () => Array<[number, number]>
    /** How long one recording runs before the next takes over. */
    pieceMs?: number
    /** How long a recording has to save once told to stop. */
    stopMs?: number
  },
  deps: {
    spawn: (command: string, args: string[]) => ChildProcess
    exec: Exec
    now: () => number
  } = {
    spawn: (command, args) => spawn(command, args, { stdio: 'ignore' }),
    exec,
    now: Date.now
  }
): SoakSampler {
  // An all-process recording exports some 60 MB every twenty minutes, so the
  // run is recorded in pieces, each read when it ends.
  const pieceMs = options.pieceMs ?? 15 * 60_000
  let piece = 0
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  let ended = false
  let startMs = 0
  const begin = (): void => {
    piece++
    startMs = deps.now()
    const output = join(options.dir, `${options.name}-${piece}.trace`)
    const [command, ...args] = [
      'xcrun',
      ...recordArgs({ udid: options.udid, output })
    ]
    const started = deps.spawn(command, args)
    child = started
    ended = false
    exited = new Promise(resolve => {
      started.once('exit', code => {
        ended = true
        resolve(code)
      })
    })
  }
  const finish = async (): Promise<MemorySample[]> => {
    if (child == null || exited == null) return []
    if (ended) {
      throw new Error(
        `${options.name}: the Activity Monitor recording ended early (${String(await exited)})`
      )
    }
    const from = startMs
    const trace = join(options.dir, `${options.name}-${piece}.trace`)
    child.kill('SIGINT')
    // A recording saves on SIGINT; one that has not after a minute is stuck
    // (the TV's has hung at full CPU), and its piece is lost.
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve =>
        setTimeout(() => {
          resolve(false)
        }, options.stopMs ?? 60_000)
      )
    ])
    if (!stopped) {
      child.kill('SIGKILL')
      child = undefined
      throw new Error(
        `${options.name}: the Activity Monitor recording would not stop`
      )
    }
    child = undefined
    const xml = await exportTrace(deps.exec, trace)
    return samplesFromExport(xml, {
      device: options.name,
      appName: APP_PROCESS,
      traceStartMs: from,
      ...(options.webContentDuring == null
        ? {}
        : { webContent: { during: options.webContentDuring() } })
    })
  }
  return {
    name: `${options.name}-xctrace`,
    start: async () => {
      mkdirSync(options.dir, { recursive: true })
      begin()
    },
    sample: async now => {
      if (child == null || now - startMs < pieceMs) return []
      try {
        return await finish()
      } finally {
        // A piece lost to a stuck stop is one piece: the next one starts anyway.
        begin()
      }
    },
    stop: finish
  }
}

function adbSampler(name: string, serial: string): SoakSampler {
  return {
    name: `${name}-meminfo`,
    sample: async now =>
      await sampleMeminfo(exec, {
        device: name,
        serial,
        package: DEVELOP_APP,
        now: () => now
      })
  }
}

/** The stack's API and ingest, read over SSH: informational, never gated. */
function dropletSampler(handle: StreamingHandle): SoakSampler {
  const ssh: Exec = async (command, args) =>
    await exec('ssh', [...SSH_OPTIONS, handle.ssh, command, ...args])
  return {
    name: 'stack',
    sample: async now =>
      (
        await sampleDroplet({
          exec: ssh,
          processes: [
            // The cluster's primary is the oldest; one of its workers the newest.
            {
              process: 'api',
              pidCommand: ['pgrep', '-of', 'lib/server/index.js']
            },
            {
              process: 'apiWorker',
              pidCommand: ['pgrep', '-nf', 'lib/server/index.js']
            },
            {
              process: 'ingest',
              pidCommand: ['pgrep', '-of', 'lib/server/ingest/main.js']
            }
          ],
          now: () => now
        })
      ).map((row: MemorySample) => ({ ...row, device: 'stack' }))
  }
}

/**
 * One statement batch on the throwaway stack's database, over a connection of
 * its own: one left idle is dropped on the way to the droplet.
 */
async function onStackDatabase(
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

export interface SoakRunInputs {
  ctx: E2eContext
  schedule: SoakSchedule
  cwd: string
}

/**
 * Seeds the soak's world on the attached stack, signs every surface in, and
 * gives `runSoak` its parts. `cleanup` stops what this made outside the run:
 * the log mirror and the synthetic camera's URL file.
 */
export async function soakParts(
  inputs: SoakRunInputs
): Promise<{ parts: SoakParts; cleanup: () => Promise<void> }> {
  const { ctx, schedule, cwd } = inputs
  if (ctx.stack.attached == null) {
    throw new BlockedError('the soak needs an attached stack: e2e stack attach')
  }
  const handle = requireStreamingHandle(ctx.stack.attached)
  const settings = soakSettings(localSoak())
  const mailbox = loadSettings().mailbox
  if (mailbox == null) throw new BlockedError('local settings name no mailbox')

  const world = (await runOnStack({
    cwd,
    handle,
    script: 'e2e/rigs/streaming/soakFixture.ts',
    args: ['--json', '--mailbox', mailbox],
    scratch: join(tmpdir(), `soak-fixture-${process.pid}`),
    config: soakServerConfig(handle)
  })) as SoakFixtureManifest
  const email = Object.values(world.accounts)[0]?.email
  if (email == null) throw new Error('the soak world has no account')
  const links = gameLinks(handle.origin, world.gameId)

  const mirror = attachedLegacyStack(handle, ctx.artifact('mirror'))
  // The mirror follows new lines only: let its SSH connect before the first
  // request whose line it must catch.
  await new Promise(resolve => setTimeout(resolve, 5000))
  const stack: SignInStack = {
    api: handle.api,
    serverLog: mirror.apiLog,
    // A connection of its own each time: one left idle between sign-ins is
    // dropped on the way to the droplet, and its next read times out.
    resetLimits: async () => {
      await onStackDatabase(handle, async client => {
        await client.query(
          "delete from rate_events where scope like 'emailCode.%'"
        )
      })
    }
  }
  // Devices keep sessions for earlier runs' accounts, and a signed-in app or
  // page ignores a sign-in link: on this throwaway stack every other account's
  // session ends, so each surface signs in afresh as the soak's owner. The TV's
  // stays, since TeamStation TV hangs on "Connecting…" when its session is revoked.
  await onStackDatabase(handle, async client => {
    await client.query(
      "update auth_sessions set revoked_at = now() where revoked_at is null and user_id <> $1 and device_name is distinct from 'Apple TV'",
      [world.accounts.owner.userId]
    )
  })
  const token = await sessionToken(stack, email)
  const link = async (): Promise<string> => await signInToken(stack, email)

  const attachIos = async (role: string): Promise<any> =>
    await ctx.attach(role, {
      platform: 'ios',
      appId: DEVELOP_APP,
      appFile: settings.iosApp
    })
  const attachAndroid = async (role: string): Promise<any> =>
    await ctx.attach(role, { platform: 'android', appId: DEVELOP_APP })
  // The develop build and production TeamStation share the teamstation://
  // scheme, so each link goes to the develop app by its id, not through the
  // system's choice of app.
  const openIn =
    (role: string, platform: 'ios' | 'android') =>
    async (link: string): Promise<void> => {
      const id = ctx.device(role)
      if (platform === 'ios') {
        await run('xcrun', [
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
        await run('adb', [
          '-s',
          id,
          'shell',
          `am start -W -a android.intent.action.VIEW -d '${link}' ${DEVELOP_APP}`
        ])
      }
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  const saveShot = (name: string, png: Uint8Array): string => {
    writeFileSync(ctx.artifact(name), png)
    return name
  }

  const publisherA = await attachIos('publisherA')
  const publisherB = await attachAndroid('publisherB')
  const iphone = await attachIos('iphone')
  const android = await attachAndroid('android')
  const ipad = await attachIos('ipad')
  for (const [role, device, platform] of [
    ['publisherA', publisherA, 'ios'],
    ['publisherB', publisherB, 'android'],
    ['iphone', iphone, 'ios'],
    ['android', android, 'android'],
    ['ipad', ipad, 'ios']
  ] as const) {
    await signInApp(device, DEVELOP_APP, link, {
      openIn: openIn(role, platform)
    })
  }

  const web = await ctx.browser({ width: 1440, height: 900 }, { h264: true })
  await web.m.openLink({
    link: `${handle.origin}/signin/${await link()}`
  })
  // Safari keeps its own sign-in: opened once here, before minute 0.
  await iphone.openLink({ link: `${handle.origin}/signin/${await link()}` })

  const tv = new TvSurface({
    remote: remoteHelper(
      {
        command: settings.tvRemote.command,
        env: { ...settings.tvRemote.env, TV_DEVICE_UDID: ctx.device('tv') }
      },
      async (command, args, options) =>
        await run(command, args, { env: options.env })
    ),
    capture: ndiCapture(
      { command: settings.ndiCapture.command, out: ctx.artifact('tv-ndi.png') },
      async (command, args) => await run(command, args),
      path => readFileSync(path)
    ),
    bundleId: TV_APP,
    appName: 'TeamStation',
    joinSteps: settings.tvJoinSteps
  })
  const tvRemote = remoteHelper(
    {
      command: settings.tvRemote.command,
      env: { ...settings.tvRemote.env, TV_DEVICE_UDID: ctx.device('tv') }
    },
    async (command, args, options) =>
      await run(command, args, { env: options.env })
  )
  // A TV signed in already holds this stack's soak owner: every run on a
  // stack shares that account, and a new stack's TV shows its code. Its own
  // Sign out cannot be reached by the remote, since the dump marks no focus.
  const shown = await tvRemote([`app:${TV_APP}`, 'wait:4', 'dump'])
  const code = tvCodeIn(shown)
  if (code != null) await approveTvCode(stack, token, code)

  const app = new NativeAppSurface({
    name: 'iphone-app',
    device: iphone,
    appId: DEVELOP_APP,
    gameLink: links.app,
    openIn: openIn('iphone', 'ios'),
    saveShot
  })
  const safari = new MobileSafariSurface({
    name: 'iphone-safari',
    device: iphone,
    gameUrl: links.web,
    saveShot
  })
  const phone = new IphoneSurface({ device: iphone, app, safari })
  const safariWindows: Array<[number, number]> = []
  const iphoneFront = {
    get surface() {
      return phone.surface
    },
    switchTo: async (to: 'app' | 'safari') => {
      const switched = await phone.switchTo(to)
      if (to === 'safari') safariWindows.push([Date.now(), Infinity])
      else {
        const open = safariWindows.at(-1)
        if (open != null) open[1] = Date.now()
      }
      return switched
    }
  }

  const urlFile = join(tmpdir(), `soak-rtmp-${process.pid}`)
  const synthetic = world.streams.find(stream => stream.label === 'Synthetic')
  if (synthetic == null)
    throw new Error('the soak world has no Synthetic camera')
  writeFileSync(urlFile, rtmpUrl(handle, synthetic.key), { mode: 0o600 })

  const page = web.page
  const browserCdp = await page.browser().target().createCDPSession()
  const pageCdp = await page.createCDPSession()
  const traces = ctx.artifact('traces')

  const parts: SoakParts = {
    schedule,
    runDir: ctx.artifact('soak'),
    surfaces: {
      'iphone-app': app,
      'iphone-safari': safari,
      android: new NativeAppSurface({
        name: 'android',
        device: android,
        appId: DEVELOP_APP,
        gameLink: links.app,
        openIn: openIn('android', 'android'),
        saveShot
      }),
      ipad: new NativeAppSurface({
        name: 'ipad',
        device: ipad,
        appId: DEVELOP_APP,
        gameLink: links.app,
        openIn: openIn('ipad', 'ios'),
        saveShot
      }),
      tv,
      chrome: new ChromeSurface({
        device: web.m,
        page: {
          evaluate: async (script: string) => await page.evaluate(script)
        },
        gameUrl: links.web
      })
    },
    iphone: iphoneFront,
    publishers: {
      publisherA: new PhonePublisher({
        device: publisherA,
        appId: DEVELOP_APP,
        gameLink: links.app,
        angle: 'PhoneA',
        openIn: openIn('publisherA', 'ios')
      }),
      publisherB: new PhonePublisher({
        device: publisherB,
        appId: DEVELOP_APP,
        gameLink: links.app,
        angle: 'PhoneB',
        openIn: openIn('publisherB', 'android')
      }),
      publisherC: new SyntheticPublisher({
        ffmpeg: settings.ffmpeg,
        urlFile,
        label: 'Synthetic',
        ...(settings.offsetMinutes == null
          ? {}
          : { offsetMinutes: settings.offsetMinutes })
      })
    },
    samplers: [
      xctraceSampler({
        name: 'publisherA',
        udid: ctx.device('publisherA'),
        dir: traces
      }),
      xctraceSampler({
        name: 'iphone',
        udid: ctx.device('iphone'),
        dir: traces,
        webContentDuring: () =>
          safariWindows.map(([from, to]) => [
            from,
            Number.isFinite(to) ? to : Date.now()
          ])
      }),
      xctraceSampler({
        name: 'ipad',
        udid: ctx.device('ipad'),
        dir: traces,
        // Its all-process recording takes minutes to save; the sampling runs
        // beside the schedule, so the wait costs only the gap until the next piece.
        stopMs: 10 * 60_000
      }),
      xctraceSampler({
        name: 'tv',
        udid: ctx.device('tv'),
        dir: traces,
        stopMs: 10 * 60_000
      }),
      adbSampler('publisherB', ctx.device('publisherB')),
      adbSampler('android', ctx.device('android')),
      {
        name: 'chrome',
        sample: async now =>
          await sampleChrome({
            browser: async (method: string) =>
              await browserCdp.send(method as never),
            page: async (method: string) => await pageCdp.send(method as never),
            exec,
            now: () => now
          })
      },
      dropletSampler(handle)
    ],
    provenance: {
      stack: handle.id,
      origin: handle.origin,
      ...(handle.ref == null ? {} : { serverRef: handle.ref }),
      build: process.env.SOAK_BUILD ?? null,
      schedule: { seed: schedule.seed, layout: schedule.layout }
    }
  }
  return {
    parts,
    cleanup: async () => {
      rmSync(urlFile, { force: true })
      await mirror.stop()
      await web.close()
    }
  }
}
