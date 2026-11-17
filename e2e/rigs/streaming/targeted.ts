import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import {
  type ClockBase,
  MIN_CONFIDENCE,
  readingEpochMs,
  type TileClock
} from './clockReader'
import { type OwnerApi, ownerApi } from './ownerApi'
import type { SoakSampler } from './soakRun'
import { signInApp } from './soakSignIn'
import {
  adbSampler,
  type CdpSender,
  chromeSampler,
  dropletSampler,
  xctraceSampler
} from './soakWiring'
import {
  ANDROID_MAX_HOLD_MS,
  DEVELOP_APP,
  type DeviceKit,
  deviceKit,
  openWorld,
  recordSessions,
  rtmpUrl,
  run,
  signInTv,
  type StreamingWorld,
  TV_APP,
  tvKit
} from './streamingSession'
import { ChromeSurface } from './surfaces/chrome'
import { MobileSafariSurface } from './surfaces/mobileSafari'
import { NativeAppSurface } from './surfaces/nativeApp'
import type { SoakSurfaceDriver } from './surfaces/surface'
import type { TvRemote } from './surfaces/tv'
import { SyntheticPublisher } from './syntheticPublisher'

/**
 * The targeted streaming scenarios' runner (`e2e/tests/streaming/targeted/`).
 * Each scenario aims at one behaviour the streaming fixes claim and the soak
 * never reaches: a world of labelled synthetic cameras only (simulated video,
 * at most four), the watchers it names signed in as the viewer (Chrome as the
 * owner where the camera panel is the subject), and steps that act and then
 * look. Every look is recorded to `targeted.jsonl` with its verdict, and the
 * scenario passes when no watcher failed a step.
 */

export type WatcherRole =
  | 'iphone'
  | 'android'
  | 'ipad'
  | 'chrome'
  | 'tv'
  /** The web app in an iPhone's Safari, watching one angle (`TargetedSetup.safariAngle`). */
  | 'safari'

/** What a scenario can do to a watcher beyond the soak's actions. */
export interface TargetedDriver extends SoakSurfaceDriver {
  togglePause?: () => Promise<void>
  readClocks?: () => Promise<TileClock[]>
}

/** The part of a Chrome DevTools session a scenario needs. */
export interface CdpLike {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  on: (event: string, listener: (params: any) => void) => unknown
}

/** The TV beyond its surface: launched cold, read, and signed in. */
export interface TvControl {
  coldLaunch: () => Promise<void>
  /** What the TV's accessibility dump shows now. */
  dump: () => Promise<string>
  /** Approves a sign-in code the TV shows; says whether one was shown. */
  approve: () => Promise<boolean>
}

export interface Watcher {
  role: WatcherRole
  surface: TargetedDriver
  /** A PNG of what it shows now, where the surface can take one. */
  screenshot?: () => Promise<Uint8Array>
  /** Chrome's DevTools session on the game's page. */
  cdp?: CdpLike
  /** Chrome's page, for reading what it shows. */
  evaluate?: (script: string) => Promise<unknown>
  /** Opens a link in this watcher's page or app. */
  open?: (link: string) => Promise<void>
  tv?: TvControl
}

/** One tile as a look saw it: moving or not, its notice, the moment its clock shows. */
export interface LookTile {
  angle: string
  advancing: boolean | null
  notice: string | null
  wallMs: number | null
}

export interface Look {
  atMs: number
  tiles: LookTile[] | null
  reason?: string
}

export type Verdict = 'passed' | 'failed' | 'blocked'

export interface StepRecord {
  atMs: number
  step: string
  surface: string
  expected: string
  observed: string
  verdict: Verdict
  screenshot?: string
}

/** The scrub fraction that puts the bar at `targetMs`, the take running from `startMs` to `nowMs`. */
export function fractionFor(
  targetMs: number,
  startMs: number,
  nowMs: number
): number {
  if (nowMs <= startMs) return 1
  return Math.min(1, Math.max(0, (targetMs - startMs) / (nowMs - startMs)))
}

/** The moments the tiles show, from confident readings only. */
export function tileMoments(
  clocks: TileClock[],
  atMs: number,
  baseOf: (angle: string) => ClockBase | undefined
): Map<string, number> {
  const out = new Map<string, number>()
  for (const { angle, reading } of clocks) {
    if (reading == null || reading.confidence < MIN_CONFIDENCE) continue
    const base = baseOf(angle)
    if (base != null) out.set(angle, readingEpochMs(reading, atMs, base))
  }
  return out
}

/** How far apart the tiles' moments are, or null with fewer than two. */
export function spreadMs(moments: Iterable<number>): number | null {
  const all = [...moments]
  if (all.length < 2) return null
  return Math.max(...all) - Math.min(...all)
}

/** The median of the moments, or null with none. */
export function medianMs(moments: Iterable<number>): number | null {
  const all = [...moments].sort((a, b) => a - b)
  if (all.length === 0) return null
  const mid = Math.floor(all.length / 2)
  return all.length % 2 === 1 ? all[mid] : (all[mid - 1] + all[mid]) / 2
}

/** Asks `check` until it says yes or `timeoutMs` passes; gives its last answer. */
export async function waitFor<T>(
  check: () => Promise<{ ok: boolean; value: T }>,
  options: {
    timeoutMs: number
    everyMs: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
): Promise<{ ok: boolean; value: T }> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  const end = now() + options.timeoutMs
  for (;;) {
    const answer = await check()
    if (answer.ok || now() >= end) return answer
    await sleep(options.everyMs)
  }
}

/**
 * Each surface's verdict from its steps: failed on any failure; else blocked
 * when some step was blocked every time it was taken, since a pass of one
 * check says nothing of another the harness could not tell; else passed. A
 * step taken again and again (a look every 30 s) is judged on the times it
 * could be told.
 */
export function verdicts(steps: StepRecord[]): Record<string, Verdict> {
  const out: Record<string, Verdict> = {}
  const surfaces = [...new Set(steps.map(step => step.surface))]
  for (const surface of surfaces) {
    const mine = steps.filter(step => step.surface === surface)
    const untold = [...new Set(mine.map(step => step.step))].some(name =>
      mine
        .filter(step => step.step === name)
        .every(step => step.verdict === 'blocked')
    )
    out[surface] = mine.some(step => step.verdict === 'failed')
      ? 'failed'
      : untold
        ? 'blocked'
        : 'passed'
  }
  return out
}

/** One verdict for a run: failed on any surface's failure, else blocked on any surface's block. */
export function overall(steps: StepRecord[]): Verdict {
  const states = Object.values(verdicts(steps))
  return states.includes('failed')
    ? 'failed'
    : states.includes('blocked') || states.length === 0
      ? 'blocked'
      : 'passed'
}

/** Records steps to `targeted.jsonl`, with a screenshot named for the step. */
export class Recorder {
  readonly steps: StepRecord[] = []
  private shots = 0

  constructor(
    private readonly file: string,
    private readonly saveShot: (name: string, png: Uint8Array) => string,
    private readonly now: () => number = Date.now
  ) {}

  async step(
    watcher: Pick<Watcher, 'role' | 'screenshot'> | { role: string },
    step: string,
    expected: string,
    observed: string,
    verdict: Verdict
  ): Promise<StepRecord> {
    const record: StepRecord = {
      atMs: this.now(),
      step,
      surface: watcher.role,
      expected,
      observed,
      verdict
    }
    const shoot = 'screenshot' in watcher ? watcher.screenshot : undefined
    if (shoot != null) {
      try {
        const picture = await shoot()
        record.screenshot = this.saveShot(
          `${step}-${watcher.role}-${++this.shots}.png`,
          picture
        )
      } catch {
        // A step's picture is evidence, not the step.
      }
    }
    this.steps.push(record)
    appendFileSync(this.file, `${JSON.stringify(record)}\n`)
    return record
  }

  async check(
    watcher: Pick<Watcher, 'role' | 'screenshot'> | { role: string },
    step: string,
    expected: string,
    observed: string,
    ok: boolean
  ): Promise<StepRecord> {
    return await this.step(
      watcher,
      step,
      expected,
      observed,
      ok ? 'passed' : 'failed'
    )
  }
}

/** What a scenario asks of its world and watchers. */
/**
 * What a run came to, for the scenario's own file to judge: the watchers that
 * failed a step, and where the steps are written.
 */
export interface TargetedOutcome {
  failed: string[]
  steps: string
}

export interface TargetedSetup {
  /** The synthetic cameras, by label: one to four. */
  synthetic: string[]
  watchers: WatcherRole[]
  /** Chrome's account: the viewer, or the owner when the camera panel is under test. */
  chromeAs?: 'viewer' | 'owner'
  /** How long the cameras publish before the watchers join. */
  leadMs?: number
  /** Sample the watchers' memory per process, and the stack's, while the scenario runs. */
  memory?: boolean
  /** The one camera Safari watches in the game page's player. */
  safariAngle?: string
}

export interface TargetedSession {
  world: StreamingWorld
  watchers: Watcher[]
  publishers: Map<string, PublisherLike>
  owner: OwnerApi
  record: Recorder
  /** When the cameras started publishing. */
  takeStartMs: number
  /** Where a camera's burned clock starts, by its label. */
  clockBase: (label: string) => ClockBase | undefined
  streamId: (label: string) => string
  /** A look at a watcher: its probe, with each tile's clock where the surface reads clocks. */
  look: (watcher: Watcher) => Promise<Look>
  /** Seeks a watcher's bar to a wall moment, refined by reading the clocks back; gives where it landed. */
  seekTo: (watcher: Watcher, targetMs: number) => Promise<number | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** The module that makes the network conditioner, from the local settings, when they give one. */
  shaper?: string
  /** Each watcher role's address on a test network, from the local settings. */
  shapedIps: Record<string, string>
  /** The memory samplers, when the scenario asked for them. */
  memory?: SoakSampler[]
  /** Writes a text file into the run directory. */
  writeArtifact: (name: string, text: string) => void
}

/**
 * Memory samplers for a run's watchers: Activity Monitor recordings on the iOS
 * devices, `dumpsys meminfo` on Android, Chrome's renderer and heap through
 * DevTools, and the stack's processes.
 */
export function memorySamplers(
  ctx: E2eContext,
  world: Pick<StreamingWorld, 'handle'>,
  roles: WatcherRole[],
  chrome?: { browser: CdpSender; page: CdpSender }
): SoakSampler[] {
  const traces = ctx.artifact('traces')
  const out: SoakSampler[] = []
  for (const role of roles) {
    if (role === 'iphone' || role === 'ipad') {
      out.push(
        xctraceSampler({
          name: role,
          udid: ctx.device(role),
          dir: traces,
          // The iPad's all-process recording takes minutes to save.
          ...(role === 'ipad' ? { stopMs: 10 * 60_000 } : {})
        })
      )
    } else if (role === 'android') {
      out.push(adbSampler('android', ctx.device('android')))
    } else if (role === 'chrome' && chrome != null) {
      out.push(chromeSampler(chrome.browser, chrome.page))
    }
  }
  out.push(dropletSampler(world.handle))
  return out
}

const realSleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Combines a probe's tiles with the clocks read beside it. */
export function lookFrom(
  probe: Awaited<ReturnType<SoakSurfaceDriver['probe']>>,
  clocks: TileClock[],
  atMs: number,
  baseOf: (angle: string) => ClockBase | undefined
): Look {
  if (probe.tiles == null) {
    return {
      atMs,
      tiles: null,
      ...(probe.reason == null ? {} : { reason: probe.reason })
    }
  }
  const moments = tileMoments(clocks, atMs, baseOf)
  return {
    atMs,
    tiles: probe.tiles.map(tile => ({
      angle: tile.angle,
      advancing: tile.advancing,
      notice: tile.notice,
      wallMs: moments.get(tile.angle) ?? null
    }))
  }
}

/** A synthetic camera as the runner drives it. */
export interface PublisherLike {
  start: () => Promise<void>
  stop: () => Promise<void>
  cut: (seconds: number) => Promise<void>
  /** Where its burned clock starts, once it has started. */
  clockBase: () => ClockBase | undefined
}

/** What `runTargeted` reaches outside this process; the real ones unless a test stands in. */
export interface TargetedDeps {
  openWorld: (
    options: Parameters<typeof openWorld>[0]
  ) => Promise<StreamingWorld>
  deviceKit: (
    ctx: E2eContext,
    settings: StreamingWorld['settings']
  ) => DeviceKit
  tvKit: (
    ctx: E2eContext,
    settings: StreamingWorld['settings']
  ) => { tv: TargetedDriver; remote: TvRemote }
  signInTv: typeof signInTv
  signInApp: typeof signInApp
  recordSessions: (world: StreamingWorld, file: string) => Promise<void>
  memorySamplers: typeof memorySamplers
  publisher: (
    options: ConstructorParameters<typeof SyntheticPublisher>[0]
  ) => PublisherLike
  run: (command: string, args: string[]) => Promise<unknown>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const realTargetedDeps: TargetedDeps = {
  openWorld: async options => await openWorld(options),
  deviceKit: (ctx, settings) => deviceKit(ctx, settings),
  tvKit: (ctx, settings) => tvKit(ctx, settings),
  signInTv,
  signInApp,
  recordSessions: async (world, file) => {
    await recordSessions(world, file)
  },
  memorySamplers,
  publisher: options => new SyntheticPublisher(options),
  run: async (command, args) => await run(command, args),
  now: Date.now,
  sleep: realSleep
}

/**
 * Opens a targeted session, runs `body`, writes the summary and lets go of
 * everything. The scenario fails when a watcher failed a step, and is blocked
 * when every watcher was.
 */
export async function runTargeted(
  ctx: E2eContext,
  cwd: string,
  setup: TargetedSetup,
  body: (session: TargetedSession) => Promise<void>,
  deps: TargetedDeps = realTargetedDeps
): Promise<TargetedOutcome> {
  const world = await deps.openWorld({ ctx, cwd, synthetic: setup.synthetic })
  const kit = deps.deviceKit(ctx, world.settings)
  const record = new Recorder(ctx.artifact('targeted.jsonl'), kit.saveShot)
  const watchers: Watcher[] = []
  const urlFiles: string[] = []
  const publishers = new Map<string, PublisherLike>()
  let closeBrowser: (() => Promise<void>) | undefined
  let chromeCdp: { browser: CdpSender; page: CdpSender } | undefined
  try {
    for (const role of setup.watchers) {
      if (role === 'chrome') {
        const web = await ctx.browser(
          { width: 1440, height: 900 },
          { h264: true }
        )
        closeBrowser = async () => {
          await web.close()
        }
        await web.m.openLink({
          link: `${world.handle.origin}/signin/${await world.link(setup.chromeAs ?? 'viewer')()}`
        })
        const cdp = await web.page.createCDPSession()
        if (setup.memory === true) {
          chromeCdp = {
            browser: await web.page.browser().target().createCDPSession(),
            page: cdp
          }
        }
        watchers.push({
          role,
          surface: new ChromeSurface({
            device: web.m,
            page: {
              evaluate: async (script: string) =>
                await web.page.evaluate(script)
            },
            gameUrl: world.links.web
          }),
          screenshot: async () => await web.m.screenshot(),
          cdp: {
            send: async (method, params) =>
              await cdp.send(method as never, params as never),
            on: (event, listener) => cdp.on(event as never, listener)
          },
          evaluate: async script => await web.page.evaluate(script),
          open: async link => {
            await web.m.openLink({ link })
          }
        })
      } else if (role === 'tv') {
        const { tv, remote } = deps.tvKit(ctx, world.settings)
        try {
          await deps.signInTv(remote, world)
        } catch (error) {
          // A TV that never gets past signing in is the TV's failure, not the
          // run's: the other watchers carry on without it.
          await record.step(
            { role },
            'sign-in',
            'TeamStation TV opens and signs in',
            (error as Error).message,
            'failed'
          )
          continue
        }
        watchers.push({
          role,
          surface: tv,
          tv: {
            coldLaunch: async () => {
              await deps.run('xcrun', [
                'devicectl',
                'device',
                'process',
                'launch',
                '--device',
                ctx.device('tv'),
                '--terminate-existing',
                TV_APP
              ])
            },
            dump: async () => await remote([`app:${TV_APP}`, 'wait:1', 'dump']),
            approve: async () => await deps.signInTv(remote, world)
          }
        })
      } else if (role === 'safari') {
        const device = await kit.attachSafari(role)
        await device.openLink({
          link: `${world.handle.origin}/signin/${await world.link('viewer')()}`
        })
        watchers.push({
          role,
          surface: new MobileSafariSurface({
            name: role,
            device,
            gameUrl: world.links.web,
            ...(setup.safariAngle == null ? {} : { angle: setup.safariAngle }),
            saveShot: kit.saveShot
          }),
          screenshot: async () => await device.screenshot()
        })
      } else {
        const platform = role === 'android' ? 'android' : 'ios'
        const device =
          platform === 'android'
            ? await kit.attachAndroid(role)
            : await kit.attachIos(role)
        await deps.signInApp(device, DEVELOP_APP, world.link('viewer'), {
          openIn: kit.openIn(role, platform)
        })
        watchers.push({
          role,
          surface: new NativeAppSurface({
            name: role,
            device,
            appId: DEVELOP_APP,
            gameLink: world.links.app,
            openIn: kit.openIn(role, platform),
            saveShot: kit.saveShot,
            ...(role === 'android' ? { maxHoldMs: ANDROID_MAX_HOLD_MS } : {})
          }),
          screenshot: async () => await device.screenshot()
        })
      }
    }
    await deps.recordSessions(world, ctx.artifact('sessions.json'))

    for (const stream of world.world.streams) {
      const urlFile = join(
        tmpdir(),
        `targeted-rtmp-${process.pid}-${stream.label}`
      )
      writeFileSync(urlFile, rtmpUrl(world.handle, stream.key), { mode: 0o600 })
      urlFiles.push(urlFile)
      publishers.set(
        stream.label,
        deps.publisher({
          ffmpeg: world.settings.ffmpeg,
          urlFile,
          label: stream.label,
          ...(world.settings.offsetMinutes == null
            ? {}
            : { offsetMinutes: world.settings.offsetMinutes })
        })
      )
    }
    const takeStartMs = deps.now()
    for (const publisher of publishers.values()) await publisher.start()
    await deps.sleep(setup.leadMs ?? 60_000)
    // A watcher whose player never opened is left out of the steps: its
    // blocked join is its whole verdict.
    for (const watcher of [...watchers]) {
      try {
        // TeamStation TV's home lists the games as they were when it opened, so it opens afresh with the cameras live.
        await watcher.tv?.coldLaunch()
        await watcher.surface.join()
      } catch (error) {
        await record.step(
          watcher,
          'join',
          'the multi-angle player opens',
          (error as Error).message,
          'blocked'
        )
        watchers.splice(watchers.indexOf(watcher), 1)
      }
    }

    const clockBase = (label: string): ClockBase | undefined =>
      publishers.get(label)?.clockBase()
    const look = async (watcher: Watcher): Promise<Look> => {
      const atMs = deps.now()
      const probe = await watcher.surface.probe()
      let clocks: TileClock[] = []
      try {
        clocks = (await watcher.surface.readClocks?.()) ?? []
      } catch {
        // No clocks is a look without moments, not a failed look.
      }
      return lookFrom(probe, clocks, atMs, clockBase)
    }
    const session: TargetedSession = {
      world,
      watchers,
      publishers,
      owner: ownerApi({ api: world.handle.api, token: world.ownerToken }),
      record,
      takeStartMs,
      clockBase,
      streamId: label => {
        const stream = world.world.streams.find(s => s.label === label)
        if (stream == null) throw new Error(`no synthetic camera "${label}"`)
        return stream.id
      },
      look,
      now: deps.now,
      ...(world.settings.shaper == null
        ? {}
        : { shaper: world.settings.shaper }),
      shapedIps: world.settings.shapedIps ?? {},
      ...(setup.memory === true
        ? {
            memory: deps.memorySamplers(ctx, world, setup.watchers, chromeCdp)
          }
        : {}),
      writeArtifact: (name, text) => {
        writeFileSync(ctx.artifact(name), text)
      },
      seekTo: async (watcher, targetMs) => {
        let fraction = fractionFor(targetMs, takeStartMs, deps.now())
        let landed: number | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          await watcher.surface.scrub(fraction)
          await deps.sleep(2500)
          const seen = await look(watcher)
          landed = medianMs(
            (seen.tiles ?? [])
              .map(tile => tile.wallMs)
              .filter((at): at is number => at != null)
          )
          if (landed == null || Math.abs(landed - targetMs) < 2000) break
          fraction = Math.min(
            1,
            Math.max(
              0,
              fraction + (targetMs - landed) / (deps.now() - takeStartMs)
            )
          )
        }
        return landed
      },
      sleep: deps.sleep
    }
    await body(session)
  } finally {
    for (const publisher of publishers.values()) {
      await publisher.stop().catch(() => undefined)
    }
    for (const file of urlFiles) rmSync(file, { force: true })
    await closeBrowser?.().catch(() => undefined)
    await world.close().catch(() => undefined)
    const summary = verdicts(record.steps)
    writeFileSync(
      ctx.artifact('targeted-summary.json'),
      JSON.stringify({ verdicts: summary, steps: record.steps.length }, null, 2)
    )
  }
  const summary = verdicts(record.steps)
  const states = Object.values(summary)
  if (states.length === 0 || states.every(state => state === 'blocked')) {
    throw new BlockedError(
      `every watcher was blocked: see ${ctx.artifact('targeted.jsonl')}`
    )
  }
  return {
    failed: Object.entries(summary)
      .filter(([, state]) => state === 'failed')
      .map(([surface]) => surface),
    steps: ctx.artifact('targeted.jsonl')
  }
}
