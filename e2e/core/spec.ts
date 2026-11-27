import type { AttachedHandle } from './attach'
import type { BrowserPage, Emulation } from './browserCdp'
import type { CheckpointSpec } from './checkpoint'
import type { FixtureAccount, FixtureManifest } from './fixtures'
import type { ServerError } from './invariants'
import type { JevControl, JevView } from './jevStub'

/** The contract every end-to-end and integration test declares. */
export const SURFACES = [
  'web-chromium',
  'web-safari-ios',
  'web-chrome-android',
  'ios-app',
  'android-app'
] as const
export type Surface = (typeof SURFACES)[number]

export type Hardware = 'none' | 'preferred' | 'required'

/** What a scenario needs of one device. Capabilities, never a device's name. */
export interface DeviceNeed {
  role: string
  needs: string[]
  /**
   * The old word for `simulator`, which only specs in the streaming freeze
   * still use; `validate --strict` rejects it anywhere else.
   */
  hardware?: Hardware
  /**
   * Whether a simulator or emulator may stand in when no device with the
   * needs is free (`e2e/core/capabilities.ts`). A role without it is treated
   * as `'never'`; `camera`, `push` and `gpu` always make it `'never'`.
   */
  simulator?: 'allowed' | 'never'
}

/** What a web surface's page does: `video` (in `codecs`) or `gpu` put it on the Mac. */
export interface BrowserNeed {
  role: string
  needs: string[]
  codecs?: string[]
}

export interface SurfaceNeeds {
  devices: DeviceNeed[]
  browser?: BrowserNeed
}

export type StackKind = 'seat' | 'isolated' | 'none'

/** The stacks a harness run gets: a pool stack of its own, or none. */
export type HarnessStackKind = 'isolated' | 'none'

/** What a pool stack is asked to supply beside the ref's API and web build. */
export const SERVICES = [
  'mail-capture',
  'push-capture',
  'real-model',
  'dictation-model',
  'reverse-proxy',
  'oauth-provider',
  'log-collector'
] as const

/** The names specs used before `SERVICES`, valid until M4 converts them. */
export const OLD_SERVICES = ['api', 'web', 'smtp', 'tess-model'] as const

/** Services an isolated stack does not have, so a scenario needing one blocks. */
export const SEAT_ONLY_SERVICES = [
  'smtp',
  'reverse-proxy',
  'oauth-provider',
  'tess-model',
  'dictation-model'
]

export interface Quarantine {
  reason: string
  since: string
  /** Only these scenarios; all of them when absent. */
  scenarios?: string[]
}

/** What a scenario is given. Later layers add to this, never the environment. */
export interface E2eContext {
  scenarioId: string
  surface: Surface
  runDir: string
  stack: StackHandle
  device: (role: string) => string
  secret: (name: string) => string
  artifact: (name: string) => string
  degrade: (reason: string) => void
  /** The fault this run proves, for a scenario whose fixture must carry it. */
  fault: string | undefined
  browser: (
    size: { width: number; height: number },
    emulation?: Emulation
  ) => Promise<WebSession>
  /** The device attached or opened last. */
  lastDevice: () => any
  /** Seeds a world for this scenario alone, under its own nonce. */
  fixture: (name: string) => Promise<FixtureManifest>
  /** Signs a role in through the surface's real password form. */
  signIn: (role: string, on?: any) => Promise<FixtureAccount>
  /** A fresh `+` address on the test mailbox, for anything that sends mail. */
  address: (label: string) => string
  /** Waits for what the app really sent to an address. Nothing is kept on disk. */
  mail: (address: string, from: string) => Promise<ReceivedMail>
  /** Attaches the device in `role` through maestro-d, for the run to detach. */
  attach: (role: string, options: Record<string, unknown>) => Promise<any>
  /**
   * The phone browser of a `web-safari-ios` or `web-chrome-android` surface,
   * on the device in `role`, opened at `url` (`e2e/rigs/mobileWeb.ts`).
   */
  mobileBrowser: (role: string, url: string) => Promise<any>
  /** Lets checkpoints look at a device a rig attached for itself. */
  watch: (device: any, info: WatchedDevice) => void
  /**
   * States what must be true of the screen. Looks at the device attached or opened
   * last, or at `on`.
   */
  checkpoint: (id: string, spec: CheckpointSpec, on?: any) => Promise<void>
}

export interface ReceivedMail {
  subject: string
  /** Reads the whole message, which is in memory only. */
  body: () => string
}

export interface WatchedDevice {
  deviceClass: string
  appId?: string
  /** The simulator, emulator or phone, for a fault that acts on it. */
  udid?: string
}

/** Where a scenario's server is, whichever kind that is. */
export interface StackHandle {
  kind: StackKind
  origin: string
  webDir: string | undefined
  /**
   * Puts the stack's proxy in front of a server the scenario started, and returns the
   * origin to reach it through, so its errors are seen and faults can reach it.
   */
  adopt: (origin: string) => Promise<string>
  /** Where this target's `baseline` manifest is, if it has one. */
  baselineManifest?: string
  /** Seeds a world on this target. */
  seedWorld?: (name: string) => Promise<FixtureManifest>
  /** The API's 5xx since a time, or undefined when nothing can see them. */
  serverErrors: (since: number) => Promise<ServerError[] | undefined>
  /** The handle of a stack the suite attached rather than started. */
  attached?: AttachedHandle
  /** Sets the proxy fault the stack's fault server applies, or clears it. */
  setFault?: (fault: string | null) => Promise<void>
  /** The Jev stand-in beside the stack's fault server, which `jev.baseUrl` names. */
  jev?: {
    read: () => Promise<JevView>
    /** Replaces its script, forgetting the requests seen so far. */
    set: (control: Partial<JevControl>) => Promise<JevView>
  }
}

export interface WebSession {
  m: any
  /** For reading what maestro-d cannot, never for acting on the UI. */
  page: BrowserPage
  deviceClass: string
  /** Emulates another window size, keeping the page and what it holds. */
  resize: (size: { width: number; height: number }) => Promise<void>
  close: () => Promise<void>
}

export type Scenario = (ctx: E2eContext) => Promise<void>

/** A dump world's committed testing account (`e2e/fixtures/dumps/<world>.accounts.json`). */
export interface DumpAccount extends FixtureAccount {
  /** The teams, games and people the account holds that a test relies on. */
  teams: Array<{ id: string; name: string }>
  games: Array<{ id: string; name: string }>
  people: Array<{ id: string; name: string }>
}

/** The stack's fault-server control routes, over HTTPS. */
export interface StackControl {
  seed: (world: string) => Promise<FixtureManifest>
  rateLimits: (body?: unknown) => Promise<unknown>
  restartApi: () => Promise<unknown>
  serverLog: (since: number) => Promise<ServerError[]>
  setFault: (fault: string | null) => Promise<void>
  jev: {
    read: () => Promise<JevView>
    set: (control: Partial<JevControl>) => Promise<JevView>
  }
  remux: (body: unknown) => Promise<unknown>
  mail: (address: string, since: number) => Promise<unknown>
  push: (since: number) => Promise<unknown>
  pages: {
    script: (pages: Record<string, unknown>) => Promise<unknown>
    requests: (since: number) => Promise<unknown>
  }
  /**
   * Any other control route, such as the stand-ins' (`model/script`,
   * `model/calls`, `speech`, `beacon`, `delay`, `requests`): `route` is
   * relative to `/__e2e/`.
   */
  call: (method: string, route: string, body?: unknown) => Promise<any>
  /** Runs a setup statement on the stack's own database, never through the API. */
  sql: (
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>
}

/** A stack under the harness: a handle with the control routes, when it has them. */
export interface HarnessStackHandle extends StackHandle {
  control?: StackControl
  /** The stack's second origin, for pages outside the app. */
  pagesOrigin?: string
}

/**
 * What `runScenario` gives a scenario (`e2e/core/harness.ts`): an
 * `E2eContext`, so an unconverted scenario runs on it, with the devices
 * already attached and the caller's app ids.
 */
export interface HarnessContext extends E2eContext {
  stack: HarnessStackHandle
  /** The maestro-d device attached for `role`. */
  attached: (role: string) => any
  /** The app id the caller passed for `kind`. */
  app: (kind: string) => string
  /** A dump world's testing account for `role`. */
  account: (role: string) => DumpAccount
}

export type HarnessScenario = (ctx: HarnessContext) => Promise<void>

export interface HarnessSpec extends Omit<E2eSpec, 'scenarios'> {
  scenarios: Record<string, HarnessScenario>
}

/** Whether a scenario is running under `runScenario`, given the caller's app ids. */
export function isHarnessContext(
  ctx: E2eContext | HarnessContext
): ctx is HarnessContext {
  return typeof (ctx as Partial<HarnessContext>).app === 'function'
}

export interface E2eSpec {
  id: string
  title: string
  kind: 'e2e' | 'integration'
  covers: string[]
  stack: StackKind
  fixtures: string[]
  exclusive: boolean
  surfaces: Partial<Record<Surface, SurfaceNeeds>>
  services: string[]
  apps: string[]
  secrets: string[]
  costUsd: number
  minutes: number
  guards: string[]
  faults: string[]
  manual: boolean
  /** Marks a scenario that sends no mail, so it may use `example.test` addresses. */
  sendsNoMail?: boolean
  quarantine?: Quarantine
  scenarios: Record<string, Scenario>
}

const ID = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/
const SCENARIO = /^[a-z0-9-]+$/

/** Every way a spec can be wrong, so `validate` can name them all at once. */
export function specProblems(spec: E2eSpec): string[] {
  const problems: string[] = []
  if (!ID.test(spec.id)) {
    problems.push(`id "${spec.id}" is not category/feature/behaviour`)
  }
  if (spec.title.trim() === '') problems.push('title is empty')
  if (spec.covers.length === 0) problems.push('covers is empty')
  const surfaces = Object.keys(spec.surfaces)
  if (surfaces.length === 0) problems.push('no surfaces')
  for (const surface of surfaces) {
    if (!SURFACES.includes(surface as Surface)) {
      problems.push(`unknown surface "${surface}"`)
    }
  }
  const names = Object.keys(spec.scenarios)
  if (names.length === 0) problems.push('no scenarios')
  for (const name of names) {
    if (!SCENARIO.test(name)) problems.push(`bad scenario name "${name}"`)
  }
  if (!(spec.minutes > 0)) problems.push('minutes must be positive')
  return problems
}

export function defineE2e(spec: E2eSpec): E2eSpec {
  return spec
}

/** A spec whose scenarios run under `runScenario` alone. */
export function defineHarness(spec: HarnessSpec): HarnessSpec {
  return spec
}
