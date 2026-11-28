import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { testAddress } from '../../src/server/dev/fixtures/address'
import { crashApp, refuseUnreachable, styleScript } from '../faults/apply'
import { FAULTS } from '../faults/catalogue'
import { openMobileBrowser } from '../rigs/mobileWeb'
import {
  applyEmulation,
  browserFor,
  connectToMaestroChromium,
  type Emulation
} from './browserCdp'
import { placement, REAL_ONLY } from './capabilities'
import {
  type AiRuntime,
  Checkpoints,
  type CheckpointTarget,
  statusFromCheckpoints
} from './checkpoint'
import { detectRow } from './detectRow'
import { dumpAccount } from './dumps'
import {
  findAccount,
  type FixtureManifest,
  signInWithPassword,
  worldIdsOf
} from './fixtures'
import { browserClassOf, deviceClassOf, readGoldenSuite } from './goldens'
import type { ServerError } from './invariants'
import { Budget, judgeHasAuthority } from './judge'
import type { MaestroDevice } from './maestro'
import { ROOT } from './manifest'
import {
  BlockedError,
  HarnessError,
  type RunResult,
  type Status,
  writeResult
} from './result'
import type {
  BrowserNeed,
  E2eSpec,
  HarnessContext,
  HarnessScenario,
  HarnessSpec,
  HarnessStackHandle,
  HarnessStackKind,
  StackControl,
  Surface,
  WatchedDevice,
  WebSession
} from './spec'
import { goldensOf } from './visual'

/**
 * The harness entry: the devops runner procures the devices, the stack and
 * the browser, then hands them here by id. This runs one scenario on them
 * and writes `result.json`. It never leases, installs, boots, creates or
 * deletes a device, and drives every device through the client it is
 * handed, loading no maestro-d library of its own.
 */
export const HARNESS_VERSION = 1

export interface Handoff {
  version: number
  /** host:port of the hub every device is reached through. */
  hub: string
  /** The surface the scenario runs on. */
  surface: Surface
  devices: Record<string, { id: string; deviceClass: string; real: boolean }>
  /** App kind → the app id the caller passed. */
  apps: Record<string, string>
  /** The local maestro-d daemon that owns this machine's browser. */
  browser?: { daemon: string; placement: 'droplet' | 'mac' }
  stack: {
    kind: HarnessStackKind
    origin: string
    /** The stack's fault-server control routes. */
    control?: { url: string; token: string }
    services: string[]
    baselineManifest?: string
    /** The stack's second origin, its pages stand-in. */
    pagesOrigin?: string
  }
  /** Only the names the spec declared, as the caller passed them. */
  secrets: Record<string, string>
  /** `run --fault`: the catalogue fault this run proves. */
  fault?: string
  /** What this run's AI checks may spend in all. */
  aiBudgetUsd: number
  /** The goldens the runner fetched, `<goldensDir>/<goldenKey>.png`. */
  goldensDir?: string
  runDir: string
}

/** The runner's connected maestro-d client: a device it leased is attached by id. */
export interface MaestroClient {
  attach: (options: Record<string, unknown>) => Promise<MaestroDevice>
}

export interface Live {
  /** The client connected to `hub`. */
  maestro: MaestroClient
  /** The client of the local daemon `handoff.browser` names; `maestro` when absent. */
  browser?: MaestroClient
}

/** For tests: what the harness reaches outside the client it is handed. */
export interface HarnessDeps {
  root?: string
  fetchFn?: typeof fetch
  /** Reads the page of a browser maestro-d opened, for reading only. */
  connectPage?: typeof connectToMaestroChromium
  ref?: string
  /** How long `ctx.mail` waits, and how often it looks. */
  mailWaitMs?: number
  mailPollMs?: number
}

/** The mailbox a harness run's addresses are on: the stack's mail capture keeps it all. */
export const HARNESS_MAILBOX = 'e2e@example.test'

/** What a pool stack supplies beside the ref's API and web build. */
export const POOL_SERVICES = [
  'mail-capture',
  'push-capture',
  'real-model',
  'reverse-proxy',
  'log-collector'
]

/** The old service names, read through the mapping table until M4 converts them. */
const SERVICE_MAP: Record<string, string | null> = {
  api: null,
  web: null,
  smtp: 'mail-capture',
  'tess-model': 'real-model'
}

/** A service's name in the new vocabulary, or undefined when every pool stack serves it. */
export function mapService(name: string): string | undefined {
  if (!Object.hasOwn(SERVICE_MAP, name)) return name
  return SERVICE_MAP[name] ?? undefined
}

export interface NormalizedRole {
  role: string
  needs: string[]
  simulator: 'allowed' | 'never'
}

export interface NormalizedSurface {
  devices: NormalizedRole[]
  browser?: BrowserNeed & { placement: 'mac' | 'droplet' }
}

/** A spec's needs in the new vocabulary, which the runner procures against. */
export interface NormalizedNeeds {
  id: string
  stack: HarnessStackKind
  services: string[]
  fixtures: string[]
  apps: string[]
  secrets: string[]
  surfaces: Partial<Record<Surface, NormalizedSurface>>
  scenarios: string[]
  manual: boolean
  exclusive: boolean
  minutes: number
  costUsd: number
  faults: string[]
}

/**
 * The spec's needs through the mapping table: `tess-model` is
 * `real-model`, `smtp` is `mail-capture`, `api` and `web` go (every pool
 * stack serves them), `seat` is `isolated`, and a `none` stack naming a
 * service a pool stack supplies is `isolated`. A role without `simulator`
 * may not use one, and `camera`, `push`, `gpu` and `bench-webcam` never may. A web-chromium
 * surface always has a browser.
 */
export function normalizedNeeds(spec: E2eSpec | HarnessSpec): NormalizedNeeds {
  const services: string[] = []
  let pooled = false
  for (const name of spec.services) {
    if (SERVICE_MAP[name] === null) pooled = true
    const mapped = mapService(name)
    if (mapped == null) continue
    if (POOL_SERVICES.includes(mapped)) pooled = true
    if (!services.includes(mapped)) services.push(mapped)
  }
  const stack: HarnessStackKind =
    spec.stack === 'seat' || spec.stack === 'isolated' || pooled
      ? 'isolated'
      : 'none'
  const surfaces: Partial<Record<Surface, NormalizedSurface>> = {}
  for (const [surface, needs] of Object.entries(spec.surfaces)) {
    if (needs == null) continue
    const devices = needs.devices.map(need => ({
      role: need.role,
      needs: [...need.needs],
      simulator:
        need.needs.some(cap =>
          (REAL_ONLY as readonly string[]).includes(cap)
        ) || need.simulator !== 'allowed'
          ? ('never' as const)
          : ('allowed' as const)
    }))
    const browser =
      needs.browser ??
      (surface === 'web-chromium'
        ? ({ role: 'browser', needs: [] } satisfies BrowserNeed)
        : undefined)
    surfaces[surface as Surface] = {
      devices,
      ...(browser == null
        ? {}
        : { browser: { ...browser, placement: placement(browser) } })
    }
  }
  return {
    id: spec.id,
    stack,
    services,
    fixtures: [...spec.fixtures],
    apps: [...spec.apps],
    secrets: [...spec.secrets],
    surfaces,
    scenarios: Object.keys(spec.scenarios).sort(),
    manual: spec.manual,
    exclusive: spec.exclusive,
    minutes: spec.minutes,
    costUsd: spec.costUsd,
    faults: [...spec.faults]
  }
}

/** What in the handoff does not meet the needs, as the run's blocking reason. */
export function handoffProblem(
  needs: NormalizedNeeds,
  handoff: Handoff
): string | undefined {
  const surface = needs.surfaces[handoff.surface]
  if (surface == null) return `${needs.id} does not run on ${handoff.surface}`
  if (needs.manual) return 'manual: a person must act'
  for (const role of surface.devices) {
    if (handoff.devices[role.role] == null) {
      return `no device for role "${role.role}"`
    }
  }
  for (const kind of needs.apps) {
    if (handoff.apps[kind] == null) return `no app id for ${kind}`
  }
  if (needs.stack === 'isolated' && handoff.stack.kind !== 'isolated') {
    return 'needs a pool stack, and the run has none'
  }
  for (const service of needs.services) {
    if (!handoff.stack.services.includes(service)) {
      return `the stack does not supply ${service}`
    }
  }
  for (const name of needs.secrets) {
    if (handoff.secrets[name] == null) return `secret ${name} not supplied`
  }
  if (handoff.surface === 'web-chromium' && handoff.browser == null) {
    return 'no browser: the runner opened none for web-chromium'
  }
  return undefined
}

/** The stack's fault-server control routes, as the `ctx.stack.control` a test calls. */
export function stackControl(
  control: { url: string; token: string },
  fetchFn: typeof fetch = fetch
): StackControl {
  const base = control.url.endsWith('/') ? control.url : `${control.url}/`
  const call = async (
    method: string,
    route: string,
    body?: unknown
  ): Promise<any> => {
    const reply = await fetchFn(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${control.token}`,
        'content-type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!reply.ok) {
      const text = await reply.text().catch(() => '')
      throw new HarnessError(
        `the stack's control answered ${method} ${route} with ${reply.status}${text === '' ? '' : `: ${text.slice(0, 300)}`}`
      )
    }
    return await reply.json()
  }
  return {
    seed: async world =>
      (await call('POST', 'seed', {
        world,
        mailbox: HARNESS_MAILBOX
      })) as FixtureManifest,
    rateLimits: async body => await call('POST', 'rate-limits', body ?? {}),
    restartApi: async () => await call('POST', 'restart-api', {}),
    serverLog: async since =>
      (
        (await call('GET', `errors?since=${since}`)) as {
          errors: ServerError[]
        }
      ).errors,
    setFault: async fault => {
      await call('PUT', 'fault', { fault })
    },
    jev: {
      read: async () => await call('GET', 'jev'),
      set: async next => await call('PUT', 'jev', next)
    },
    remux: async body => await call('POST', 'remux', body),
    mail: async (address, since) =>
      await call(
        'GET',
        `mail?to=${encodeURIComponent(address)}&since=${since}`
      ),
    push: async since => await call('GET', `push?since=${since}`),
    pages: {
      script: async pages => await call('PUT', 'pages', pages),
      requests: async since =>
        await call('GET', `pages/requests?since=${since}`)
    },
    sql: async (text, values = []) =>
      await call('POST', 'sql', { text, values }),
    call: async (method, route, body) =>
      await call(method, route.replace(/^\/+/, ''), body)
  }
}

function headRef(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** A hub device's id, `<id>@<hub>`. */
export function hubId(id: string, hub: string): string {
  return id.includes('@') ? id : `${id}@${hub}`
}

/** The maestro-d platform of a device class. */
export function platformOf(deviceClass: string): string | undefined {
  if (['ios-phone', 'ipad', 'apple-tv'].includes(deviceClass)) return 'ios'
  if (deviceClass.startsWith('android-')) return 'android'
  return undefined
}

/** The app kind a platform's device launches, among the spec's. */
function appKindFor(
  apps: string[],
  platform: string | undefined
): string | undefined {
  if (platform == null) return undefined
  const kinds = apps.filter(kind => kind.endsWith(`-${platform}`))
  return kinds.length === 1 ? kinds[0] : undefined
}

/** A check that failed, as opposed to the test itself breaking. */
function isAssertion(error: Error): boolean {
  return (
    error.name === 'AssertionError' ||
    error.name === 'MaestroError' ||
    error.message.startsWith('Checkpoint "')
  )
}

async function keepEvidence(
  targets: CheckpointTarget[],
  runDir: string
): Promise<void> {
  for (const [index, target] of targets.entries()) {
    try {
      writeFileSync(
        join(runDir, `failure-${index}.png`),
        await target.device.screenshot()
      )
      writeFileSync(
        join(runDir, `failure-${index}.json`),
        JSON.stringify(await target.device.hierarchy(), null, 2)
      )
    } catch (error) {
      console.error(`No failure evidence: ${String(error)}`)
    }
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Runs `scenario` of `spec` on what the handoff names, and writes and
 * answers its `result.json`: checks the handoff against the spec's needs,
 * attaches each device by id through `live.maestro`, builds the context,
 * runs the scenario, and detaches whatever happened.
 */
export async function runScenario(
  spec: HarnessSpec | E2eSpec,
  scenario: string,
  handoff: Handoff,
  live: Live,
  deps: HarnessDeps = {}
): Promise<RunResult> {
  const root = deps.root ?? ROOT
  const started = Date.now()
  const runDir = handoff.runDir
  mkdirSync(runDir, { recursive: true })
  const degradations: string[] = []
  const budget = new Budget(Math.max(0, handoff.aiBudgetUsd ?? 0))
  let checkpoints: Checkpoints | undefined
  let deviceClass: string | undefined
  let failureKind: RunResult['failureKind']
  let serverErrors: ServerError[] = []
  const id = `${spec.id}#${scenario}`
  const finish = (status: Status, reason?: string): RunResult => {
    const records = checkpoints?.records ?? []
    const result: RunResult = {
      scenario: id,
      surface: handoff.surface,
      ref: deps.ref ?? headRef(root),
      deviceClass: deviceClass ?? handoff.surface,
      status,
      ...(reason == null ? {} : { reason }),
      durationMs: Date.now() - started,
      costUsd: budget.spentUsd,
      degradations,
      target: { kind: handoff.stack?.kind ?? 'none' },
      ...(handoff.fault == null ? {} : { fault: handoff.fault }),
      ...(failureKind == null ? {} : { failureKind }),
      ...(serverErrors.length === 0 ? {} : { serverErrors }),
      checkpoints: records,
      ...(checkpoints == null || checkpoints.unattributed.length === 0
        ? {}
        : { unattributedServerErrors: checkpoints.unattributed }),
      ...(handoff.goldensDir == null ? {} : { goldens: goldensOf(records) })
    }
    if (handoff.fault != null) {
      result.detect = detectRow(result, {
        scenario: id,
        surface: handoff.surface,
        fault: handoff.fault
      })
    }
    writeResult(runDir, result)
    return result
  }

  // What the run opened, closed whatever ends it: browsers first, then
  // the devices, last attached first.
  const sessions: WebSession[] = []
  const detaches: Array<() => Promise<void>> = []
  let faultSet: StackControl | undefined
  try {
    if (handoff?.version !== HARNESS_VERSION) {
      throw new HarnessError(
        `the handoff is version ${String(handoff?.version)}; this harness reads version ${HARNESS_VERSION}`
      )
    }
    const run = spec.scenarios[scenario] as HarnessScenario | undefined
    if (run == null)
      throw new HarnessError(`${spec.id} has no scenario "${scenario}"`)
    const needs = normalizedNeeds(spec)
    const problem = handoffProblem(needs, handoff)
    if (problem != null) throw new BlockedError(problem)
    const surface = handoff.surface
    if (handoff.fault != null) refuseUnreachable(handoff.fault, surface)
    if (handoff.goldensDir != null) {
      try {
        readGoldenSuite(root)
      } catch (error) {
        throw new HarnessError((error as Error).message)
      }
    }
    const fetchFn = deps.fetchFn ?? fetch
    const control =
      handoff.stack.control == null
        ? undefined
        : stackControl(handoff.stack.control, fetchFn)
    let attemptStarted = Date.now()
    const worlds: FixtureManifest[] = []
    const targets: CheckpointTarget[] = []
    const byRole = new Map<string, CheckpointTarget>()
    const watch = (device: any, info: WatchedDevice): CheckpointTarget => {
      const target = { device, consoleSeen: 0, ...info }
      targets.push(target)
      deviceClass ??= info.deviceClass
      return target
    }

    // Each role's device, in the order the spec lists them, by its id.
    for (const role of needs.surfaces[surface]?.devices ?? []) {
      const given = handoff.devices[role.role]
      const platform = platformOf(given.deviceClass)
      const kind = appKindFor(needs.apps, platform)
      const appId = kind == null ? undefined : handoff.apps[kind]
      const device = await live.maestro.attach({
        device: hubId(given.id, handoff.hub),
        ...(platform == null ? {} : { platform }),
        ...(appId == null ? {} : { appId })
      })
      detaches.unshift(async () => {
        await device.detach()
      })
      if (!given.real && typeof device.setStatusBar === 'function') {
        // A simulator's status bar reads the same every run, so a golden can include it.
        await device.setStatusBar('demo').catch((error: unknown) => {
          degradations.push(`no demo status bar: ${String(error)}`)
        })
      }
      const info =
        typeof device.platformInfo === 'function'
          ? await device.platformInfo()
          : undefined
      byRole.set(
        role.role,
        watch(device, {
          deviceClass: info == null ? given.deviceClass : deviceClassOf(info),
          udid: hubId(given.id, handoff.hub),
          ...(appId == null ? {} : { appId })
        })
      )
    }

    const ai: AiRuntime = {
      budget,
      authoritative: judgeHasAuthority(root, 'waterfall')
    }
    checkpoints = new Checkpoints({
      scenarioId: id,
      surface,
      runDir,
      root,
      settings: {},
      serverErrors: async () => await control?.serverLog(attemptStarted),
      alone: true,
      worldIds: () => worldIdsOf(worlds),
      ai,
      ...(handoff.goldensDir == null ? {} : { goldensDir: handoff.goldensDir })
    })
    const running = checkpoints

    const stack: HarnessStackHandle = {
      kind: handoff.stack.kind,
      origin: handoff.stack.origin,
      webDir: undefined,
      adopt: async origin => origin,
      ...(handoff.stack.baselineManifest == null
        ? {}
        : { baselineManifest: handoff.stack.baselineManifest }),
      ...(handoff.stack.pagesOrigin == null
        ? {}
        : { pagesOrigin: handoff.stack.pagesOrigin }),
      serverErrors: async since => await control?.serverLog(since),
      ...(control == null
        ? {}
        : {
            control,
            seedWorld: control.seed,
            setFault: control.setFault,
            jev: control.jev
          })
    }

    if (handoff.fault != null && FAULTS[handoff.fault]?.how === 'proxy') {
      if (control == null) {
        throw new BlockedError(
          `${handoff.fault} needs a stack with a fault server, and this one has no control routes`
        )
      }
      await control.setFault(handoff.fault)
      faultSet = control
    }

    const targetFor = (on: any): CheckpointTarget | undefined =>
      on == null
        ? targets[targets.length - 1]
        : targets.find(row => row.device === on)
    const fault = handoff.fault
    const applyFault = async (target: CheckpointTarget): Promise<void> => {
      if (fault == null) return
      const script = styleScript(fault)
      if (script != null) {
        await target.device.evalBrowserScript({ script })
        return
      }
      if (fault === 'app-crash' && target.appId != null) {
        await crashApp(target.device, target.appId)
      }
    }

    const ctx: HarnessContext = {
      scenarioId: id,
      surface,
      runDir,
      stack,
      device: role => {
        const given = handoff.devices[role]
        if (given == null)
          throw new BlockedError(`no device for role "${role}"`)
        return hubId(given.id, handoff.hub)
      },
      attached: role => {
        const target = byRole.get(role)
        if (target == null) {
          throw new HarnessError(`no device is attached for role "${role}"`)
        }
        return target.device
      },
      app: kind => {
        const app = handoff.apps[kind]
        if (app == null) throw new BlockedError(`no app id for ${kind}`)
        return app
      },
      account: role => dumpAccount(root, spec.fixtures, role),
      secret: name => {
        if (!spec.secrets.includes(name)) {
          throw new HarnessError(`secret ${name} is not one the spec declares`)
        }
        const value = handoff.secrets[name]
        if (value == null) throw new BlockedError(`secret ${name} not supplied`)
        return value
      },
      artifact: name => join(runDir, name),
      degrade: reason => {
        degradations.push(reason)
      },
      fault,
      browser: async (size, emulation: Emulation = {}) => {
        if (handoff.browser == null) {
          throw new BlockedError('no browser: the runner opened none')
        }
        const client = live.browser ?? live.maestro
        const name = `web-${randomUUID().slice(0, 8)}`
        const profile = join(runDir, 'browser-profiles', name)
        mkdirSync(profile, { recursive: true })
        const blank = `about:blank#${name}`
        const m = await client.attach({
          device: name,
          platform: 'web',
          url: blank,
          appId: blank,
          extra: {
            browser: await browserFor(emulation),
            windowSize: `${size.width}x${size.height}`,
            headed: false,
            userDataDir: profile
          }
        })
        let connected:
          Awaited<ReturnType<typeof connectToMaestroChromium>> | undefined
        const close = async (): Promise<void> => {
          await connected?.browser.disconnect().catch(() => undefined)
          await m.detach().catch(() => undefined)
        }
        try {
          connected = await (deps.connectPage ?? connectToMaestroChromium)(
            profile,
            blank,
            emulation.observeNetwork
          )
          const { browser, page } = connected
          await applyEmulation(page, emulation)
          const session: WebSession = {
            m,
            page,
            deviceClass: browserClassOf(await browser.version(), size),
            resize: async next => {
              await page.setViewport(next)
            },
            close
          }
          sessions.push(session)
          watch(m, { deviceClass: session.deviceClass })
          return session
        } catch (error) {
          await close()
          throw error
        }
      },
      lastDevice: () => {
        const target = targets[targets.length - 1]
        if (target == null) throw new HarnessError('No device is attached yet')
        return target.device
      },
      fixture: async name => {
        if (control == null) {
          throw new BlockedError('this stack has no seed route')
        }
        const manifest = await control.seed(name)
        worlds.push(manifest)
        return manifest
      },
      signIn: async (role, on) => {
        let account
        try {
          account = findAccount(role, worlds, undefined)
        } catch {
          account = dumpAccount(root, spec.fixtures, role)
        }
        const target = targetFor(on)
        if (target == null) {
          throw new HarnessError(`Signing in "${role}" has no device to use`)
        }
        await signInWithPassword(target.device, account)
        return account
      },
      address: label => testAddress(HARNESS_MAILBOX, label),
      mail: async (address, from) => {
        if (control == null) {
          throw new BlockedError('this stack has no mail capture to read')
        }
        const until = Date.now() + (deps.mailWaitMs ?? 120_000)
        for (;;) {
          const reply = (await control.mail(address, attemptStarted)) as {
            messages?: Array<{ from: string; subject: string; body: string }>
          }
          const found = (reply.messages ?? []).find(row =>
            row.from.includes(from)
          )
          if (found != null) {
            return { subject: found.subject, body: () => found.body }
          }
          if (Date.now() > until) {
            throw new Error(`No mail from ${from} reached ${address}`)
          }
          await sleep(deps.mailPollMs ?? 2000)
        }
      },
      attach: async (role, options) => {
        const target = byRole.get(role)
        if (target == null) {
          throw new HarnessError(
            `role "${role}" has no device: the spec does not list it on ${surface}`
          )
        }
        if (typeof options.appId === 'string') target.appId = options.appId
        targets.splice(targets.indexOf(target), 1)
        targets.push(target)
        return target.device
      },
      mobileBrowser: async (role, url) =>
        await openMobileBrowser(
          surface,
          async options => await ctx.attach(role, options),
          url
        ),
      watch: (device, info) => {
        watch(device, info)
      },
      checkpoint: async (checkpoint, checkpointSpec, on) => {
        const target = targetFor(on)
        if (target == null) {
          throw new HarnessError(
            `Checkpoint "${checkpoint}" has no device to look at`
          )
        }
        await applyFault(target)
        await running.check(checkpoint, checkpointSpec, target)
      }
    }

    attemptStarted = Date.now()
    let failure: Error | undefined
    try {
      await run(ctx)
    } catch (error) {
      if (error instanceof BlockedError || error instanceof HarnessError) {
        throw error
      }
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (failure != null) {
      await keepEvidence(targets, runDir)
      failureKind = isAssertion(failure) ? 'assertion' : 'crash'
      serverErrors =
        (await control?.serverLog(attemptStarted).catch(() => [])) ?? []
      throw failure
    }
    const verdict = statusFromCheckpoints(running.records)
    if (verdict.status !== 'passed')
      return finish(verdict.status, verdict.reason)
    return finish(degradations.length > 0 ? 'passed-degraded' : 'passed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof BlockedError) return finish('blocked', message)
    if (error instanceof HarnessError) return finish('harness-error', message)
    if (failureKind == null) return finish('harness-error', message)
    const quarantine = spec.quarantine
    const quarantined =
      quarantine != null &&
      (quarantine.scenarios == null || quarantine.scenarios.includes(scenario))
    return finish(quarantined ? 'quarantined' : 'failed', message)
  } finally {
    for (const session of sessions.splice(0)) {
      await session.close().catch(() => undefined)
    }
    for (const detach of detaches.splice(0)) {
      await detach().catch(() => undefined)
    }
    // Cleared whatever happened, so the stack's next run finds no fault set.
    await faultSet?.setFault(null).catch((error: unknown) => {
      console.error(`could not clear the stack's fault: ${String(error)}`)
    })
  }
}
