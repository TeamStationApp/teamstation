import { PNG } from 'pngjs'

import type { Surface } from './spec'

/**
 * The checks every checkpoint makes, with no opt-out. A check a surface cannot make
 * reports `not-available`, so its absence is never read as a pass.
 */
export type InvariantVerdict = 'pass' | 'fail' | 'not-available'

export interface InvariantResult {
  verdict: InvariantVerdict
  detail?: string
}

export const INVARIANTS = [
  'errorText',
  'emptyHierarchy',
  'blankFrame',
  'consoleErrors',
  'foreground',
  'apiErrors'
] as const
export type InvariantName = (typeof INVARIANTS)[number]
export type InvariantReport = Record<InvariantName, InvariantResult>

/** What the app, React Native or a browser shows when something has gone wrong. */
export const ERROR_TEXTS = [
  'Something went wrong',
  'Unhandled JS Exception',
  'Render Error',
  "This site can't be reached",
  'Safari Cannot Open the Page',
  'Webpage not available'
]

/** The normalized tree a phone gives, or a browser's list of accessibility nodes. */
export interface TreeNode {
  id?: string
  text?: string
  children?: TreeNode[]
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: unknown }
  value?: { value?: unknown }
}
export type Tree = TreeNode | TreeNode[]

function saysOf(node: TreeNode): string[] {
  if (node.ignored === true || node.role?.value === 'RootWebArea') return []
  return [node.text, node.id, node.name?.value, node.value?.value].filter(
    (say): say is string => typeof say === 'string' && say !== ''
  )
}

function allSays(tree: Tree): string[] {
  if (Array.isArray(tree)) return tree.flatMap(allSays)
  return [...saysOf(tree), ...(tree.children ?? []).flatMap(allSays)]
}

export function findErrorText(tree: Tree): string | undefined {
  const says = allSays(tree)
  return ERROR_TEXTS.find(error => says.some(say => say.includes(error)))
}

/** No node names or says anything, which no drawn screen can do. */
export function hierarchyIsEmpty(tree: Tree): boolean {
  return allSays(tree).length === 0
}

const PNG_SIGNATURE = '89504e470d0a1a0a'
const BLANK_VARIANCE = 2

/** Luminance variance over every pixel, undefined when the bytes are not a PNG. */
export function frameVariance(bytes: Uint8Array): number | undefined {
  const buffer = Buffer.from(bytes)
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return undefined
  const { data, width, height } = PNG.sync.read(buffer)
  const count = width * height
  if (count === 0) return 0
  let sum = 0
  let squares = 0
  for (let at = 0; at < data.length; at += 4) {
    const luminance =
      0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]
    sum += luminance
    squares += luminance * luminance
  }
  const mean = sum / count
  return squares / count - mean * mean
}

/** One line of text on a white page still varies far more than this. */
export function isBlankFrame(variance: number): boolean {
  return variance < BLANK_VARIANCE
}

export interface ConsoleEntry {
  level?: string
  message?: string
}

const CLIENT_ERROR_LOAD =
  /Failed to load resource: the server responded with a status of 4\d\d/

/** A 4xx the page expected, such as the signed-out `/auth/me`, is not a failure. */
export function consoleErrorsIn(entries: ConsoleEntry[]): string[] {
  return entries
    .filter(
      entry =>
        (entry.level === 'error' || entry.level === 'exception') &&
        !CLIENT_ERROR_LOAD.test(entry.message ?? '')
    )
    .map(entry => entry.message ?? '')
}

export function parseConsoleLogs(data: unknown): ConsoleEntry[] {
  const value = typeof data === 'string' ? JSON.parse(data) : data
  return Array.isArray(value) ? (value as ConsoleEntry[]) : []
}

export interface ServerError {
  at: number
  method: string
  path: string
  status: number
}

/**
 * A seat serves several scenarios at once, so its 5xx fails this one only when it ran
 * alone or the request names one of its world's ids. Anything else goes to the report.
 */
export function attributeServerErrors(
  errors: ServerError[],
  options: { alone: boolean; worldIds: string[] }
): { attributed: ServerError[]; unattributed: ServerError[] } {
  if (options.alone) return { attributed: errors, unattributed: [] }
  const attributed: ServerError[] = []
  const unattributed: ServerError[] = []
  for (const error of errors) {
    const named = options.worldIds.some(id => error.path.includes(id))
    ;(named ? attributed : unattributed).push(error)
  }
  return { attributed, unattributed }
}

const NATIVE: Surface[] = ['ios-app', 'android-app']

export interface InvariantInputs {
  surface: Surface
  appId?: string
  device: {
    screenshot: () => Promise<Uint8Array>
    hierarchy: () => Promise<unknown>
    state: () => Promise<unknown>
    getConsoleLogs: (options: { output: string }) => Promise<{ data?: unknown }>
  }
  /** Undefined when nothing can see this stack's server errors. */
  serverErrors: () => Promise<ServerError[] | undefined>
  alone: boolean
  worldIds: string[]
  /** Console entries an earlier checkpoint already judged. */
  consoleSeen: number
}

export interface InvariantOutcome {
  report: InvariantReport
  frame: Uint8Array
  unattributed: ServerError[]
  consoleSeen: number
}

function failed(report: InvariantReport): InvariantName[] {
  return INVARIANTS.filter(name => report[name].verdict === 'fail')
}

export function failedInvariants(report: InvariantReport): string[] {
  return failed(report).map(name => {
    const detail = report[name].detail
    return detail == null ? name : `${name}: ${detail}`
  })
}

/** One screen's invariants. Never throws for what it finds: that is the report. */
export async function checkInvariants(
  inputs: InvariantInputs
): Promise<InvariantOutcome> {
  const { device, surface } = inputs
  const tree = (await device.hierarchy()) as Tree
  const errorText = findErrorText(tree)
  const frame = await device.screenshot()
  const variance = frameVariance(frame)

  let consoleErrors: InvariantResult = { verdict: 'not-available' }
  let consoleSeen = inputs.consoleSeen
  if (surface === 'web-chromium') {
    const logs = parseConsoleLogs(
      (await device.getConsoleLogs({ output: 'e2eConsoleLogs' })).data
    )
    const errors = consoleErrorsIn(logs.slice(consoleSeen))
    consoleSeen = logs.length
    consoleErrors =
      errors.length === 0
        ? { verdict: 'pass' }
        : { verdict: 'fail', detail: errors.join(' | ').slice(0, 500) }
  }

  let foreground: InvariantResult = { verdict: 'not-available' }
  if (NATIVE.includes(surface) && inputs.appId != null) {
    const state = (await device.state()) as { foregroundApp?: string }
    if (state.foregroundApp != null) {
      foreground =
        state.foregroundApp === inputs.appId
          ? { verdict: 'pass' }
          : { verdict: 'fail', detail: `${state.foregroundApp} is in front` }
    }
  }

  let apiErrors: InvariantResult = { verdict: 'not-available' }
  let unattributed: ServerError[] = []
  const errors = await inputs.serverErrors()
  if (errors != null) {
    const split = attributeServerErrors(errors, inputs)
    unattributed = split.unattributed
    apiErrors =
      split.attributed.length === 0
        ? { verdict: 'pass' }
        : {
            verdict: 'fail',
            detail: split.attributed
              .map(e => `${e.status} ${e.method} ${e.path}`)
              .join(', ')
              .slice(0, 500)
          }
  }

  return {
    report: {
      errorText:
        errorText == null
          ? { verdict: 'pass' }
          : { verdict: 'fail', detail: errorText },
      emptyHierarchy: hierarchyIsEmpty(tree)
        ? { verdict: 'fail', detail: 'the hierarchy says nothing' }
        : { verdict: 'pass' },
      blankFrame:
        variance == null
          ? { verdict: 'not-available' }
          : isBlankFrame(variance)
            ? { verdict: 'fail', detail: `variance ${variance.toFixed(2)}` }
            : { verdict: 'pass' },
      consoleErrors,
      foreground,
      apiErrors
    },
    frame,
    unattributed,
    consoleSeen
  }
}
