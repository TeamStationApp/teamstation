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
}

/** A percentile, or null when nothing was measured: never a zero that reads as good. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]
}

export interface ConnectionFigures {
  /** Most backends seen at once, in all. */
  peak: number
  /** The same, reached through the pooler and directly. */
  peakPooled: number
  peakDirect: number
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
    peakByApplication: {},
    peakByState: {}
  }
  for (const sample of samples) {
    let total = 0
    let pooled = 0
    const byApplication: Record<string, number> = {}
    const byState: Record<string, number> = {}
    for (const backend of sample.backends) {
      total += backend.count
      if (backend.pooled) pooled += backend.count
      byApplication[backend.applicationName] =
        (byApplication[backend.applicationName] ?? 0) + backend.count
      byState[backend.state] = (byState[backend.state] ?? 0) + backend.count
    }
    figures.peak = Math.max(figures.peak, total)
    figures.peakPooled = Math.max(figures.peakPooled, pooled)
    figures.peakDirect = Math.max(figures.peakDirect, total - pooled)
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
  socketsOpened: number
  peakSocketOpensPerSecond: number
  streamsStarted: number
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
    socketsOpened: m.socketsOpened,
    peakSocketOpensPerSecond: Math.max(
      0,
      ...Object.values(m.socketOpensBySecond)
    ),
    streamsStarted: m.streamsStarted,
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
    `sockets opened: ${data.socketsOpened}, peak ${data.peakSocketOpensPerSecond} a second`,
    `streams started: ${data.streamsStarted}`,
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

/** Writes the report for people, and its figures beside it as JSON. */
export function writeReport(path: string, data: ReportData): void {
  writeFileSync(path, renderReport(data))
  writeFileSync(`${path}.json`, JSON.stringify(data, null, 2))
}
