import type { MemorySample } from './soakRecords'

/**
 * Memory verdicts per device and process. A process grows when the median of its final
 * window is more than 15 % above that of its first window after warm-up, or when its
 * least-squares slope is at or above 30 MB/h for an app (60 MB/h for a browser tab).
 * A relaunch starts a new process, so each lifetime is judged apart and the verdict is
 * the longest one's, if it lasted 20 minutes. MB here is 10^6 bytes.
 */

export type MemoryVerdict = 'passed' | 'failed' | 'blocked' | 'informational'
export type ProcessKind = 'app' | 'browser' | 'server'

export interface MemoryLimits {
  growth: number
  appSlopeMBh: number
  browserSlopeMBh: number
  minLifetimeMs: number
}

export const MEMORY_LIMITS: MemoryLimits = {
  growth: 0.15,
  appSlopeMBh: 30,
  browserSlopeMBh: 60,
  minLifetimeMs: 20 * 60_000
}

/** Offsets from the run's start, in ms; each [from, to). */
export interface MemoryWindows {
  baseline: [number, number]
  final: [number, number]
  slope: [number, number]
}

const MIN = 60_000

export const FULL_WINDOWS: MemoryWindows = {
  baseline: [10 * MIN, 15 * MIN],
  final: [110 * MIN, 120 * MIN],
  slope: [15 * MIN, 120 * MIN]
}

export interface Lifetime {
  startMs: number
  endMs: number
  samples: MemorySample[]
}

export interface ProcessVerdict {
  device: string
  process: string
  kind: ProcessKind
  verdict: MemoryVerdict
  reason?: string
  baselineMedian?: number
  finalMedian?: number
  growth?: number
  slopeMBh?: number
  lifetimes: Array<{ startMs: number; endMs: number; samples: number }>
  /** Which lifetime was judged. */
  judged?: number
}

export interface MemoryOptions {
  runStartMs: number
  windows?: MemoryWindows
  limits?: MemoryLimits
  /** When each device's app was relaunched, from the event log. */
  relaunches?: Record<string, number[]>
  /**
   * Where a process is judged only while in front: `device/process` → [from, to) in
   * epoch ms. The iPhone's app and Safari's WebContent each have their own.
   */
  foreground?: Record<string, Array<[number, number]>>
  kindOf?: (sample: MemorySample) => ProcessKind
}

export function defaultKind(sample: MemorySample): ProcessKind {
  if (sample.device === 'stack') return 'server'
  if (/webcontent|renderer|jsheap|chrome|safari/i.test(sample.process)) {
    return 'browser'
  }
  return 'app'
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Least-squares slope of bytes over time, in MB per hour. */
export function slopeMBh(samples: MemorySample[]): number | undefined {
  if (samples.length < 2) return undefined
  const xs = samples.map(sample => sample.atMs / 3_600_000)
  const ys = samples.map(sample => sample.bytes / 1e6)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? undefined : num / den
}

/** Splits a process's samples where it was relaunched or its pid changed. */
export function splitLifetimes(
  samples: MemorySample[],
  relaunches: number[] = []
): Lifetime[] {
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs)
  const lifetimes: Lifetime[] = []
  let current: MemorySample[] = []
  const flush = (): void => {
    if (current.length > 0) {
      lifetimes.push({
        startMs: current[0].atMs,
        endMs: current[current.length - 1].atMs,
        samples: current
      })
    }
    current = []
  }
  for (const sample of sorted) {
    const previous = current.at(-1)
    if (previous != null) {
      const relaunched = relaunches.some(
        at => at > previous.atMs && at <= sample.atMs
      )
      const newPid =
        previous.pid != null &&
        sample.pid != null &&
        previous.pid !== sample.pid
      if (relaunched || newPid) flush()
    }
    current.push(sample)
  }
  flush()
  return lifetimes
}

function inRange(atMs: number, range: [number, number]): boolean {
  return atMs >= range[0] && atMs < range[1]
}

function inAny(atMs: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(range => inRange(atMs, range))
}

interface Judged {
  verdict: MemoryVerdict
  reason?: string
  baselineMedian?: number
  finalMedian?: number
  growth?: number
  slopeMBh?: number
}

/**
 * The windows one lifetime is judged on. One that covers the plan's windows uses them;
 * one that starts later (after a relaunch) is judged against its own first five minutes,
 * and one that ends early against its own last ten.
 */
function lifetimeWindows(
  life: Lifetime,
  baselineRange: [number, number],
  finalRange: [number, number]
): { baseline: [number, number]; final: [number, number] } {
  return {
    baseline:
      life.startMs <= baselineRange[0]
        ? baselineRange
        : [life.startMs, life.startMs + 5 * MIN],
    final:
      life.endMs >= finalRange[1] - MIN
        ? finalRange
        : [life.endMs - 10 * MIN, life.endMs + 1]
  }
}

/**
 * Judged on its own time in front: the first window is the plan's when that is in
 * front, else five to ten minutes into its first stretch there; the last is the final
 * ten minutes of its last stretch.
 */
function foregroundWindows(
  life: Lifetime,
  front: Array<[number, number]>,
  baselineRange: [number, number]
): { baseline: [number, number]; final: [number, number] } {
  const stretches = front.filter(
    ([from, to]) => to > life.startMs && from <= life.endMs
  )
  const first = stretches[0]
  const last = stretches[stretches.length - 1]
  const baseline: [number, number] =
    baselineRange[0] >= first[0] && baselineRange[1] <= first[1]
      ? baselineRange
      : [first[0] + 5 * MIN, first[0] + 10 * MIN]
  const finalEnd = Math.min(last[1], life.endMs + 1)
  return { baseline, final: [finalEnd - 10 * MIN, finalEnd] }
}

function judgeLifetime(
  life: Lifetime,
  kind: ProcessKind,
  windows: { baseline: [number, number]; final: [number, number] },
  slopeRange: [number, number],
  limits: MemoryLimits
): Judged {
  const bytes = (range: [number, number]): number[] =>
    life.samples.filter(s => inRange(s.atMs, range)).map(s => s.bytes)
  const baselineMedian = median(bytes(windows.baseline))
  const finalMedian = median(bytes(windows.final))
  const slope = slopeMBh(life.samples.filter(s => inRange(s.atMs, slopeRange)))
  if (baselineMedian == null || finalMedian == null || slope == null) {
    return { verdict: 'blocked', reason: 'no samples in a window' }
  }
  const growth = (finalMedian - baselineMedian) / baselineMedian
  const limit = kind === 'browser' ? limits.browserSlopeMBh : limits.appSlopeMBh
  const problems: string[] = []
  if (growth > limits.growth) {
    problems.push(
      `grew ${(growth * 100).toFixed(1)} % (limit ${limits.growth * 100} %)`
    )
  }
  if (slope >= limit) {
    problems.push(`slope ${slope.toFixed(1)} MB/h (limit ${limit})`)
  }
  const verdict: MemoryVerdict =
    kind === 'server'
      ? 'informational'
      : problems.length > 0
        ? 'failed'
        : 'passed'
  return {
    verdict,
    reason: problems.length > 0 ? problems.join('; ') : undefined,
    baselineMedian,
    finalMedian,
    growth,
    slopeMBh: slope
  }
}

function lifetimeMs(
  life: Lifetime,
  foreground?: Array<[number, number]>
): number {
  if (foreground == null) return life.endMs - life.startMs
  // Time in front, so a process behind the other surface is not credited with it.
  return foreground.reduce(
    (sum, [from, to]) =>
      sum +
      Math.max(0, Math.min(to, life.endMs) - Math.max(from, life.startMs)),
    0
  )
}

export function judgeMemory(
  samples: MemorySample[],
  options: MemoryOptions
): ProcessVerdict[] {
  const limits = options.limits ?? MEMORY_LIMITS
  const relative = options.windows ?? FULL_WINDOWS
  const at = (range: [number, number]): [number, number] => [
    options.runStartMs + range[0],
    options.runStartMs + range[1]
  ]
  const kindOf = options.kindOf ?? defaultKind
  const groups = new Map<string, MemorySample[]>()
  for (const sample of samples) {
    const key = `${sample.device}/${sample.process}`
    groups.set(key, [...(groups.get(key) ?? []), sample])
  }
  const out: ProcessVerdict[] = []
  for (const [key, group] of groups) {
    const { device, process } = group[0]
    const kind = kindOf(group[0])
    const front = options.foreground?.[key]
    const kept = front == null ? group : group.filter(s => inAny(s.atMs, front))
    const lifetimes = splitLifetimes(kept, options.relaunches?.[device])
    const summary = lifetimes.map(life => ({
      startMs: life.startMs,
      endMs: life.endMs,
      samples: life.samples.length
    }))
    let judged = -1
    let longest = -1
    lifetimes.forEach((life, index) => {
      const length = lifetimeMs(life, front)
      if (length > longest) {
        longest = length
        judged = index
      }
    })
    if (judged < 0 || longest < limits.minLifetimeMs) {
      out.push({
        device,
        process,
        kind,
        verdict: kind === 'server' ? 'informational' : 'blocked',
        reason: 'no process lifetime lasted 20 minutes',
        lifetimes: summary
      })
      continue
    }
    const life = lifetimes[judged]
    const windows =
      front == null
        ? lifetimeWindows(life, at(relative.baseline), at(relative.final))
        : foregroundWindows(life, front, at(relative.baseline))
    out.push({
      device,
      process,
      kind,
      lifetimes: summary,
      judged,
      ...judgeLifetime(life, kind, windows, at(relative.slope), limits)
    })
  }
  return out
}

/** Memory curves, one row per sample, minutes from the run's start. */
export function memoryCsv(samples: MemorySample[], runStartMs: number): string {
  const rows = [...samples].sort((a, b) => {
    const device = a.device.localeCompare(b.device)
    if (device !== 0) return device
    const process = a.process.localeCompare(b.process)
    return process !== 0 ? process : a.atMs - b.atMs
  })
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return (
    [
      'device,process,minute,bytes,pid',
      ...rows.map(row =>
        [
          quote(row.device),
          quote(row.process),
          ((row.atMs - runStartMs) / MIN).toFixed(2),
          String(row.bytes),
          row.pid == null ? '' : String(row.pid)
        ].join(',')
      )
    ].join('\n') + '\n'
  )
}

/** The windows a schedule's phases give, in ms from the start. */
export function windowsFromPhases(phases: {
  baselineWindow: [number, number]
  finalWindow: [number, number]
  slopeRange: [number, number]
}): MemoryWindows {
  const ms = (range: [number, number]): [number, number] => [
    range[0] * 1000,
    range[1] * 1000
  ]
  return {
    baseline: ms(phases.baselineWindow),
    final: ms(phases.finalWindow),
    slope: ms(phases.slopeRange)
  }
}
