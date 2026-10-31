import type { BrowserPage, Emulation } from './browserCdp'
import type { CheckpointSpec } from './checkpoint'
import type { FixtureAccount, FixtureManifest } from './fixtures'
import type { ServerError } from './invariants'

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
  hardware: Hardware
}

export interface SurfaceNeeds {
  devices: DeviceNeed[]
}

export type StackKind = 'seat' | 'isolated' | 'none'

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
}

export interface WebSession {
  m: any
  /** For reading what maestro-d cannot, never for acting on the UI. */
  page: BrowserPage
  deviceClass: string
  close: () => Promise<void>
}

export type Scenario = (ctx: E2eContext) => Promise<void>

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
