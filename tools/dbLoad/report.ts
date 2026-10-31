import { writeFileSync } from 'node:fs'

import type { Sample, SequentialScan, Statement } from './sampler'

/** One timed request, as the actors record them. */
export interface RequestTiming {
  route: string
  accountKind: string
  ms: number
}

/** What the actors measured over a run. */
export interface Measurements {
  /** `POST /games/:id/events`, in ms. */
  postMs: number[]
  /** From a post being sent to its change reaching a socket, in ms. */
  deliveryLagMs: number[]
  requests: RequestTiming[]
  framesDelivered: number
  /** Failures by kind: `http-503`, `socket-close-1012`, `unreachable`. */
  errors: Record<string, number>
  /** New sockets by whole second of the run, which shows a reconnect storm. */
  socketOpensBySecond: Record<number, number>
  socketsOpened: number
  streamsStarted: number
  /** When each of `postMs` ended, in ms since the epoch. */
  postAt: number[]
  /** Each whole second, since the epoch, in which a frame arrived. */
  frameSeconds: number[]
}

/** A worst-case event that ran during the load, in ms since the epoch. */
export interface EventWindow {
  event: string
  startedAt: number
  ms: number
}

/** What delivering the load cost the rig itself, which any lag has to be read against. */
export interface RigLoad {
  /** Of one core: the rig's event loop saturates near 100. */
  cpuPercent: number
  /** How late its timers ran at p95, in ms: frames wait at least this long. */
  loopDelayP95Ms: number
}

export interface ReportInput {
  title: string
  startedAt: number
  finishedAt: number
  measurements: Measurements
  samples: Sample[]
  statements: Statement[]
  sequentialScans: SequentialScan[]
  hasStatements: boolean
  events?: EventWindow[]
  rig?: RigLoad
}

/** A percentile, or null when nothing was measured: never a zero that reads as good. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]
}

/** How the rig's own connections name themselves. */
const RIG_APPLICATION_PREFIX = 'dbload-'

export interface ConnectionFigures {
  /** Most backends seen at once, in all. */
  peak: number
  /** The same, reached through the pooler and directly. */
  peakPooled: number
  peakDirect: number
  /** Direct backends other than the rig's own, which no server holds. */
  peakDirectServers: number
  /** Most at once under each application name. */
  peakByApplication: Record<string, number>
  /** Most at once in each state. */
  peakByState: Record<string, number>
}

export function connectionFigures(samples: Sample[]): ConnectionFigures {
  const figures: ConnectionFigures = {
    peak: 0,
    peakPooled: 0,
    peakDirect: 0,
    peakDirectServers: 0,
    peakByApplication: {},
    peakByState: {}
  }
  for (const sample of samples) {
    let total = 0
    let pooled = 0
    let directServers = 0
    const byApplication: Record<string, number> = {}
    const byState: Record<string, number> = {}
    for (const backend of sample.backends) {
      total += backend.count
      if (backend.pooled) pooled += backend.count
      else if (!backend.applicationName.startsWith(RIG_APPLICATION_PREFIX))
        directServers += backend.count
      byApplication[backend.applicationName] =
        (byApplication[backend.applicationName] ?? 0) + backend.count
      byState[backend.state] = (byState[backend.state] ?? 0) + backend.count
    }
    figures.peak = Math.max(figures.peak, total)
    figures.peakPooled = Math.max(figures.peakPooled, pooled)
    figures.peakDirect = Math.max(figures.peakDirect, total - pooled)
    figures.peakDirectServers = Math.max(
      figures.peakDirectServers,
      directServers
    )
    for (const [name, count] of Object.entries(byApplication))
      figures.peakByApplication[name] = Math.max(
        figures.peakByApplication[name] ?? 0,
        count
      )
    for (const [state, count] of Object.entries(byState))
      figures.peakByState[state] = Math.max(
        figures.peakByState[state] ?? 0,
        count
      )
  }
  return figures
}

export interface SlowRoute {
  route: string
  accountKind: string
  count: number
  p95Ms: number
}

/** Requests by route and account kind, slowest first. */
export function slowestRequests(
  requests: RequestTiming[],
  limit = 10
): SlowRoute[] {
  const groups = new Map<string, RequestTiming[]>()
  for (const request of requests) {
    const key = `${request.route}\u0000${request.accountKind}`
    groups.set(key, [...(groups.get(key) ?? []), request])
  }
  return [...groups.values()]
    .map(group => ({
      route: group[0].route,
      accountKind: group[0].accountKind,
      count: group.length,
      p95Ms: percentile(
        group.map(request => request.ms),
        95
      ) as number
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, limit)
}

export interface ReportData {
  title: string
  seconds: number
  connections: ConnectionFigures
  peakLockWaiters: number
  peakObjectLockWaiters: number
  oldestTransactionSeconds: number
  posts: number
  postP50Ms: number | null
  postP95Ms: number | null
  deliveryLagP50Ms: number | null
  deliveryLagP95Ms: number | null
  framesDelivered: number
  /** The longest time no frame arrived at all, which a lost feed shows as. */
  longestDeliveryGapSeconds: number | null
  socketsOpened: number
  peakSocketOpensPerSecond: number
  streamsStarted: number
  /** Everything that could have answered 503: requests, and socket opens. */
  answers: number
  rig: RigLoad | null
  events: EventFigures[]
  /** Statements in the database for each scoring post: one pitch's delivery. */
  statementsPerDelivery: number | null
  statementsPerFrame: number | null
  statementsTotal: number | null
  errors: Record<string, number>
  errorTotal: number
  slowestRequests: SlowRoute[]
  topStatements: Statement[]
  sequentialScans: SequentialScan[]
}

/** A worst-case event, and how scoring went while it had its effect. */
export interface EventFigures extends EventWindow {
  postsDuring: number
  postP95DuringMs: number | null
}

/** A shorter event still has this long to show in scoring, as its notices land. */
const EVENT_EFFECT_MS = 30_000

export function eventFigures(
  events: EventWindow[],
  postMs: number[],
  postAt: number[]
): EventFigures[] {
  return events.map(event => {
    const end = event.startedAt + Math.max(event.ms, EVENT_EFFECT_MS)
    const during = postMs.filter(
      (_, i) => postAt[i] >= event.startedAt && postAt[i] <= end
    )
    return {
      ...event,
      postsDuring: during.length,
      postP95DuringMs: percentile(during, 95)
    }
  })
}

/** The widest space between seconds that had a frame, or null with none at all. */
export function longestGap(
  seconds: number[],
  finishedAt: number
): number | null {
  if (seconds.length === 0) return null
  const inOrder = [...seconds].sort((a, b) => a - b)
  let gap = 0
  // From the last frame to the end counts: a feed that never came back is a gap.
  // The start does not, since nothing is scored until the rig has connected.
  for (let i = 1; i < inOrder.length; i++)
    gap = Math.max(gap, inOrder[i] - inOrder[i - 1])
  return Math.max(
    gap,
    Math.floor(finishedAt / 1000) - inOrder[inOrder.length - 1]
  )
}

export function buildReport(input: ReportInput): ReportData {
  const { measurements: m, samples, hasStatements } = input
  const statementsTotal = hasStatements
    ? input.statements.reduce((sum, row) => sum + row.calls, 0)
    : null
  const per = (count: number): number | null =>
    statementsTotal == null || count === 0 ? null : statementsTotal / count
  return {
    title: input.title,
    seconds: (input.finishedAt - input.startedAt) / 1000,
    connections: connectionFigures(samples),
    peakLockWaiters: Math.max(0, ...samples.map(row => row.lockWaiters)),
    peakObjectLockWaiters: Math.max(
      0,
      ...samples.map(row => row.objectLockWaiters)
    ),
    oldestTransactionSeconds: Math.max(
      0,
      ...samples.map(row => row.oldestTransactionSeconds)
    ),
    posts: m.postMs.length,
    postP50Ms: percentile(m.postMs, 50),
    postP95Ms: percentile(m.postMs, 95),
    deliveryLagP50Ms: percentile(m.deliveryLagMs, 50),
    deliveryLagP95Ms: percentile(m.deliveryLagMs, 95),
    framesDelivered: m.framesDelivered,
    longestDeliveryGapSeconds: longestGap(m.frameSeconds, input.finishedAt),
    socketsOpened: m.socketsOpened,
    peakSocketOpensPerSecond: Math.max(
      0,
      ...Object.values(m.socketOpensBySecond)
    ),
    streamsStarted: m.streamsStarted,
    answers: m.requests.length + m.socketsOpened,
    rig: input.rig ?? null,
    events: eventFigures(input.events ?? [], m.postMs, m.postAt),
    statementsPerDelivery: per(m.postMs.length),
    statementsPerFrame: per(m.framesDelivered),
    statementsTotal,
    errors: m.errors,
    errorTotal: Object.values(m.errors).reduce((sum, n) => sum + n, 0),
    slowestRequests: slowestRequests(m.requests),
    topStatements: input.statements.slice(0, 10),
    sequentialScans: input.sequentialScans.slice(0, 10)
  }
}

const ms = (value: number | null): string =>
  value == null ? 'no data' : `${value.toFixed(1)} ms`
const figure = (value: number | null): string =>
  value == null ? 'no data' : value.toFixed(1)

/** A report a person reads, one figure a line. */
export function renderReport(data: ReportData): string {
  const lines = [
    `# ${data.title}`,
    `seconds: ${data.seconds.toFixed(0)}`,
    '',
    '## Connections',
    `peak backends: ${data.connections.peak} (pooled ${data.connections.peakPooled}, direct ${data.connections.peakDirect})`,
    ...Object.entries(data.connections.peakByApplication)
      .sort(([, a], [, b]) => b - a)
      .map(
        ([name, count]) => `  ${name === '' ? '(unnamed)' : name}: ${count}`
      ),
    ...Object.entries(data.connections.peakByState)
      .sort(([, a], [, b]) => b - a)
      .map(([state, count]) => `  state ${state}: ${count}`),
    `peak lock waiters: ${data.peakLockWaiters} (Lock:object ${data.peakObjectLockWaiters})`,
    `oldest transaction: ${data.oldestTransactionSeconds.toFixed(1)} s`,
    '',
    '## Latency',
    `POST /games/:id/events: ${data.posts} posts, p50 ${ms(data.postP50Ms)}, p95 ${ms(data.postP95Ms)}`,
    `socket delivery lag: ${data.framesDelivered} frames, p50 ${ms(data.deliveryLagP50Ms)}, p95 ${ms(data.deliveryLagP95Ms)}`,
    data.rig == null
      ? 'rig: no data'
      : `rig: CPU ${data.rig.cpuPercent.toFixed(0)}% of one core, event loop delay p95 ${data.rig.loopDelayP95Ms.toFixed(1)} ms`,
    `longest time with no frame: ${data.longestDeliveryGapSeconds ?? 'no data'} s`,
    `sockets opened: ${data.socketsOpened}, peak ${data.peakSocketOpensPerSecond} a second`,
    `streams started: ${data.streamsStarted}`,
    ...data.events.map(
      row =>
        `event ${row.event}: ${row.ms.toFixed(0)} ms, ${row.postsDuring} posts during it, p95 ${ms(row.postP95DuringMs)}`
    ),
    '',
    '## Statements',
    `total: ${figure(data.statementsTotal)}`,
    `per delivery (each scoring post): ${figure(data.statementsPerDelivery)}`,
    `per frame sent: ${figure(data.statementsPerFrame)}`,
    '',
    '## Errors',
    `total: ${data.errorTotal}`,
    ...Object.entries(data.errors)
      .sort(([, a], [, b]) => b - a)
      .map(([kind, count]) => `  ${kind}: ${count}`),
    '',
    '## Slowest requests (p95)',
    ...data.slowestRequests.map(
      row =>
        `  ${row.p95Ms.toFixed(1)} ms  ${row.route}  ${row.accountKind}  (${row.count})`
    ),
    '',
    '## Top statements by total time',
    ...data.topStatements.map(
      row =>
        `  ${row.totalMs.toFixed(0)} ms  ${row.calls} calls  ${row.rows} rows  ${row.query.replace(/\s+/g, ' ').slice(0, 100)}`
    ),
    '',
    '## Large tables read by sequential scan',
    ...data.sequentialScans.map(
      row => `  ${row.table}: ${row.scans} scans of ${row.rows} rows`
    )
  ]
  return `${lines.join('\n')}\n`
}

/** The limits of the load target, which `--assert` holds a run to. */
export const THRESHOLDS = {
  directConnections: 5,
  rate503: 0.001,
  postP95Ms: 500,
  deliveryLagP95Ms: 1000,
  recoverySeconds: 60,
  eventPostP95Ms: 1000,
  transactionSeconds: 60
} as const

export interface AssertOptions {
  /** What the pool allows: the server connections no peak may pass. */
  poolLimit?: number
  /** Times `too many clients` appears in the servers' logs. */
  tooManyClients?: number
}

/**
 * Each limit a run missed, in words. Nothing measured misses: a figure with no
 * data never reads as a pass, so a run that scored nothing cannot succeed.
 */
export function assertThresholds(
  data: ReportData,
  options: AssertOptions = {}
): string[] {
  const missed: string[] = []
  const limit = THRESHOLDS
  if (options.poolLimit == null)
    missed.push('server connections: no --pool-limit to hold them to')
  else if (data.connections.peakPooled > options.poolLimit)
    missed.push(
      `server connections: peak ${data.connections.peakPooled}, above the pool's ${options.poolLimit}`
    )
  if (data.connections.peakDirectServers > limit.directConnections)
    missed.push(
      `direct connections: peak ${data.connections.peakDirectServers}, above ${limit.directConnections}`
    )
  const refused =
    (data.errors['too-many-clients'] ?? 0) + (options.tooManyClients ?? 0)
  if (refused > 0) missed.push(`too many clients: seen ${refused} times`)
  const unavailable = Object.entries(data.errors)
    .filter(([kind]) => /(^|-)503$/.test(kind))
    .reduce((sum, [, count]) => sum + count, 0)
  if (data.answers === 0) missed.push('503 rate: no requests answered')
  else if (unavailable / data.answers >= limit.rate503)
    missed.push(
      `503 rate: ${unavailable} of ${data.answers}, not below ${limit.rate503 * 100}%`
    )
  if (data.postP95Ms == null) missed.push('p95 POST: no data')
  else if (data.postP95Ms >= limit.postP95Ms)
    missed.push(
      `p95 POST: ${data.postP95Ms.toFixed(0)} ms, not below ${limit.postP95Ms} ms`
    )
  if (data.deliveryLagP95Ms == null) missed.push('p95 delivery lag: no data')
  else if (data.deliveryLagP95Ms >= limit.deliveryLagP95Ms)
    missed.push(
      `p95 delivery lag: ${data.deliveryLagP95Ms.toFixed(0)} ms, not below ${limit.deliveryLagP95Ms} ms`
    )
  if (data.longestDeliveryGapSeconds == null)
    missed.push('recovery: no frames at all')
  else if (data.longestDeliveryGapSeconds > limit.recoverySeconds)
    missed.push(
      `recovery: ${data.longestDeliveryGapSeconds} s with no frame, above ${limit.recoverySeconds} s`
    )
  for (const event of data.events) {
    if (
      event.postP95DuringMs != null &&
      event.postP95DuringMs > limit.eventPostP95Ms
    )
      missed.push(
        `event ${event.event}: p95 scoring ${event.postP95DuringMs.toFixed(0)} ms while it ran, above ${limit.eventPostP95Ms} ms`
      )
    if (event.ms > limit.transactionSeconds * 1000)
      missed.push(
        `event ${event.event}: ${(event.ms / 1000).toFixed(0)} s, above the ${limit.transactionSeconds} s limit`
      )
  }
  if (data.oldestTransactionSeconds > limit.transactionSeconds)
    missed.push(
      `oldest transaction: ${data.oldestTransactionSeconds.toFixed(0)} s, above ${limit.transactionSeconds} s`
    )
  return missed
}

/** Writes the report for people, and its figures beside it as JSON. */
export function writeReport(path: string, data: ReportData): void {
  writeFileSync(path, renderReport(data))
  writeFileSync(`${path}.json`, JSON.stringify(data, null, 2))
}
