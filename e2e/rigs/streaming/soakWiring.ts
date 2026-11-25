import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { E2eContext } from '../../core/spec'
import { SSH_OPTIONS, type StreamingHandle } from '../../core/streamingStack'
import { DropletPublisher, requirePublisher } from './dropletPublisher'
import { PhonePublisher } from './phonePublisher'
import { sampleMeminfo } from './samplers/adbMeminfo'
import { sampleChrome } from './samplers/chromeProcess'
import { sampleDroplet } from './samplers/droplet'
import type { Exec } from './samplers/sample'
import { exportTrace, recordArgs, samplesFromExport } from './samplers/xctrace'
import { pairSoakTv, signInSoakSurface } from './soakPassword'
import type { MemorySample } from './soakRecords'
import type { SoakParts, SoakSampler } from './soakRun'
import type { SoakSchedule } from './soakSchedule'
import {
  ANDROID_MAX_HOLD_MS,
  DEVELOP_APP,
  type DeviceKit,
  deviceKit,
  exec,
  recordSessions,
  rtmpUrl,
  seedStreamingWorld,
  SIGN_IN_AS,
  tvKit
} from './streamingSession'
import { ChromeSurface } from './surfaces/chrome'
import { IphoneSurface } from './surfaces/iphone'
import { MobileSafariSurface } from './surfaces/mobileSafari'
import { NativeAppSurface } from './surfaces/nativeApp'
import type { SoakSurfaceDriver } from './surfaces/surface'
import type { TvRemote } from './surfaces/tv'

export {
  ANDROID_MAX_HOLD_MS,
  DEVELOP_APP,
  gameLinks,
  REVOKE_SESSIONS,
  rtmpUrl,
  SIGN_IN_AS,
  soakAccounts,
  soakServerConfig,
  type SoakSettings,
  soakSettings,
  TV_APP
} from './streamingSession'

/** A separately installed Android test build can declare its own link scheme. */
export function soakAndroidApp(env: NodeJS.ProcessEnv): {
  id: string
  scheme: string
} {
  const id = env.SOAK_ANDROID_APP_ID ?? DEVELOP_APP
  const scheme = env.SOAK_ANDROID_SCHEME ?? 'teamstation-develop'
  if (
    !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) ||
    !/^[a-z][a-z0-9+.-]*$/.test(scheme)
  ) {
    throw new Error('Invalid Android soak application id or link scheme')
  }
  return { id, scheme }
}

export const APP_PROCESS = 'TeamStation Develop'
export const TV_PROCESS = 'TeamStationTV'

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
    /** The app's process, exactly as Activity Monitor names it. */
    appName?: string
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
  /** How the recording ended: its exit code, or why it could not run. */
  let exited: Promise<string> | undefined
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
    // Settled by either event: an xcrun that could not start may never exit.
    exited = new Promise(resolve => {
      started.once('exit', code => {
        ended = true
        resolve(String(code))
      })
      started.once('error', (error: Error) => {
        ended = true
        resolve(error.message)
      })
    })
  }
  const read = async (trace: string, from: number): Promise<MemorySample[]> =>
    samplesFromExport(await exportTrace(deps.exec, trace), {
      device: options.name,
      appName: options.appName ?? APP_PROCESS,
      traceStartMs: from,
      ...(options.webContentDuring == null
        ? {}
        : { webContent: { during: options.webContentDuring() } })
    })
  const finish = async (): Promise<MemorySample[]> => {
    if (child == null || exited == null) return []
    const from = startMs
    const trace = join(options.dir, `${options.name}-${piece}.trace`)
    if (ended) {
      // What it recorded before it ended is read all the same.
      child = undefined
      const why = await exited
      try {
        return await read(trace, from)
      } catch (error) {
        throw new Error(
          `${options.name}: the Activity Monitor recording ended early (${why}), and what it recorded could not be read: ${(error as Error).message}`
        )
      }
    }
    child.kill('SIGINT')
    // A recording saves on SIGINT; one that has not after a minute is stuck
    // (the TV's has hung at full CPU), and its piece is lost.
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          resolve(false)
        }, options.stopMs ?? 60_000)
      })
    ])
    clearTimeout(timer)
    if (!stopped) {
      child.kill('SIGKILL')
      child = undefined
      throw new Error(
        `${options.name}: the Activity Monitor recording would not stop`
      )
    }
    child = undefined
    return await read(trace, from)
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

export function adbSampler(
  name: string,
  serial: string,
  appId = DEVELOP_APP
): SoakSampler {
  return {
    name: `${name}-meminfo`,
    sample: async now =>
      await sampleMeminfo(exec, {
        device: name,
        serial,
        package: appId,
        now: () => now
      })
  }
}

/** The stack's API and ingest, read over SSH: informational, never gated. */
export function dropletSampler(handle: StreamingHandle): SoakSampler {
  const ssh: Exec = async (command, args) =>
    await exec('ssh', [...SSH_OPTIONS, handle.ssh, command, ...args])
  return {
    name: 'stack',
    informational: true,
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

/** The part of a DevTools session a memory sample sends. */
export interface CdpSender {
  send: (method: never) => Promise<unknown>
}

/** Chrome's renderer and JS heap, read through its browser and page DevTools sessions. */
export function chromeSampler(
  browserCdp: CdpSender,
  pageCdp: CdpSender
): SoakSampler {
  return {
    name: 'chrome',
    sample: async now =>
      await sampleChrome({
        browser: async (method: string) =>
          await browserCdp.send(method as never),
        page: async (method: string) => await pageCdp.send(method as never),
        exec,
        now: () => now
      })
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
 * the browser and the synthetic camera's URL file.
 */
/** What `soakParts` reaches outside this process; the real ones unless a test stands in. */
type SoakWorld = Awaited<ReturnType<typeof seedStreamingWorld>>

export interface SoakPartsDeps {
  openWorld: (
    options: Parameters<typeof seedStreamingWorld>[0]
  ) => Promise<SoakWorld>
  deviceKit: (ctx: E2eContext, settings: SoakWorld['settings']) => DeviceKit
  tvKit: (
    ctx: E2eContext,
    settings: SoakWorld['settings']
  ) => { tv: SoakSurfaceDriver; remote: TvRemote; signOut: () => Promise<void> }
  signInTv: typeof pairSoakTv
  signIn: typeof signInSoakSurface
  recordSessions: (world: SoakWorld, file: string) => Promise<void>
}

export const realSoakPartsDeps: SoakPartsDeps = {
  openWorld: async options =>
    await seedStreamingWorld({ ...options, freshAccounts: true }),
  deviceKit: (ctx, settings) =>
    deviceKit(ctx, settings, undefined, soakAndroidApp(process.env)),
  tvKit: (ctx, settings) => {
    const kit = tvKit(ctx, settings)
    return {
      ...kit,
      signOut: async () => {
        await kit.tv.focusAndSelect('Sign out', true)
      }
    }
  },
  signInTv: pairSoakTv,
  signIn: signInSoakSurface,
  recordSessions: async (world, file) => {
    await recordSessions(world, file)
  }
}

export async function soakParts(
  inputs: SoakRunInputs,
  deps: SoakPartsDeps = realSoakPartsDeps
): Promise<{ parts: SoakParts; cleanup: () => Promise<void> }> {
  const { ctx, schedule, cwd } = inputs
  const opened = await deps.openWorld({ ctx, cwd })
  const urlFile = join(tmpdir(), `soak-rtmp-${process.pid}`)
  let closeWeb: (() => Promise<void>) | undefined
  try {
    const { handle, settings, world, links } = opened
    const androidId = soakAndroidApp(process.env).id
    // Before any device: a stack with no publisher droplet has no cameras.
    const publisher = requirePublisher(handle)
    const { attachIos, attachAndroid, openIn, saveShot } = deps.deviceKit(
      ctx,
      settings
    )

    const publisherA = await attachIos('publisherA')
    const publisherB = await attachAndroid('publisherB')
    const iphone = await attachIos('iphone')
    const android = await attachAndroid('android')
    const ipad = await attachIos('ipad')
    for (const [role, device, appId] of [
      ['publisherA', publisherA, DEVELOP_APP],
      ['publisherB', publisherB, androidId],
      ['iphone', iphone, DEVELOP_APP],
      ['android', android, androidId],
      ['ipad', ipad, DEVELOP_APP]
    ] as const) {
      await device.launchApp({ appId, stopApp: true })
      await deps.signIn(
        device,
        world.accounts[SIGN_IN_AS[role]],
        role === 'android' || role === 'publisherB'
      )
    }

    const web = await ctx.browser({ width: 1440, height: 900 }, { h264: true })
    closeWeb = async () => {
      await web.close()
    }
    const signInUrl = new URL('/sign-in', handle.origin).href
    await web.m.openLink({ link: signInUrl })
    await deps.signIn(web.m, world.accounts[SIGN_IN_AS.chrome])
    await iphone.openLink({ link: signInUrl })
    await deps.signIn(iphone, world.accounts[SIGN_IN_AS['iphone-safari']])

    const { tv, remote, signOut } = deps.tvKit(ctx, settings)
    await deps.signInTv(remote, signOut, publisherA, async () => {
      await openIn('publisherA', 'ios')('teamstation-develop://account/tv')
    })
    await deps.recordSessions(opened, ctx.artifact('sessions.json'))

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
          appId: androidId,
          gameLink: links.app,
          openIn: openIn('android', 'android'),
          saveShot,
          maxHoldMs: ANDROID_MAX_HOLD_MS
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
          appId: androidId,
          gameLink: links.app,
          angle: 'PhoneB',
          openIn: openIn('publisherB', 'android')
        }),
        publisherC: new DropletPublisher({
          publisher,
          urlFile,
          label: 'Synthetic'
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
        // The TV's all-process recording has hung at full CPU and ignored
        // SIGINT in every run so far, holding the run's end for up to 40 min,
        // and never gave a sample: SOAK_TV_MEMORY=off leaves it out.
        ...(process.env.SOAK_TV_MEMORY === 'off'
          ? []
          : [
              xctraceSampler({
                name: 'tv',
                udid: ctx.device('tv'),
                dir: traces,
                stopMs: 10 * 60_000,
                appName: TV_PROCESS
              })
            ]),
        adbSampler('publisherB', ctx.device('publisherB'), androidId),
        adbSampler('android', ctx.device('android'), androidId),
        chromeSampler(browserCdp, pageCdp),
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
        await web.close()
      }
    }
  } catch (error) {
    // Parts that never came together let go of what they had made so far.
    rmSync(urlFile, { force: true })
    await closeWeb?.().catch(() => undefined)
    throw error
  }
}
