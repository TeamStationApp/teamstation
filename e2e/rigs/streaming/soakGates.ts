import {
  type ProbeTile,
  PUBLISHER_ANGLE,
  type RecordedEvent,
  type RecordedProbe
} from './soakRecords'
import { ACTION_KINDS, type SoakSurface, SYNTHETIC_ANGLE } from './soakSchedule'

/**
 * The soak's gates, judged per instance over what the run recorded. A probe the surface
 * could not answer is never a pass: an instance with nothing but such probes is
 * `blocked`. The run passes only when every instance passed.
 */

export type GateName =
  | 'continuousPlay'
  | 'seekRecovery'
  | 'reentry'
  | 'cameraCut'
  | 'surfaceSwitch'
  | 'syntheticOutage'
  | 'noStuckTile'
  | 'noCrash'

export type Verdict = 'passed' | 'failed' | 'blocked'

export interface GateInstance {
  gate: GateName
  surface: SoakSurface
  /** The action kind, or the gate's own name for gates no action starts. */
  kind: string
  atMs: number
  verdict: Verdict
  reason?: string
  /** How long recovery took, where there was one. */
  recoveredInMs?: number
  /** Set on a failure: does it recur across this surface and kind's repeats? */
  recurrence?: 'repeated' | 'single'
  screenshots?: string[]
}

export interface GateCount {
  surface: SoakSurface
  kind: string
  run: number
  passed: number
  failed: number
  blocked: number
}

export interface GateReport {
  verdict: Verdict
  instances: GateInstance[]
  counts: GateCount[]
}

export interface GateLimits {
  seekMs: number
  reentryMs: number
  cutMs: number
  switchMs: number
  outageRecoveryMs: number
  stuckMs: number
  /** After a cut starts, how long a watcher has to put up C's notice. */
  noticeGraceMs: number
}

export const GATE_LIMITS: GateLimits = {
  seekMs: 5000,
  reentryMs: 20000,
  cutMs: 5000,
  switchMs: 15000,
  outageRecoveryMs: 60000,
  stuckMs: 60000,
  noticeGraceMs: 10000
}

/** What C may truthfully say while its source is down. */
export const TRUTHFUL_NOTICE =
  /waiting|catching up|loading|not recording|stopped|reconnect|gap|offline/i
/** What a tile says when it is stuck. */
export const STUCK_NOTICE = /catching up|not available/i

const SEEK_KINDS = new Set([
  'scrubLeft',
  'scrubRight',
  'rapidScrub',
  'skip',
  'jumpToPresent',
  // A crawl ends with a release; normal play must resume as after a seek.
  'slowMotion'
])
const REENTRY_KINDS = new Set(['exitAndReenter', 'relaunch'])
const REJOINS = new Set(['exitAndReenter', 'relaunch', 'join'])
const ACTIONS = new Set<string>(ACTION_KINDS)

function gateFor(action: string): { gate: GateName; limit: keyof GateLimits } {
  if (SEEK_KINDS.has(action)) return { gate: 'seekRecovery', limit: 'seekMs' }
  if (REENTRY_KINDS.has(action)) return { gate: 'reentry', limit: 'reentryMs' }
  return { gate: 'cameraCut', limit: 'cutMs' }
}

interface Outage {
  atMs: number
  restoredMs: number
}

/** What the timeline says about when each angle is up. */
class Timeline {
  readonly starts = new Map<string, number>()
  readonly outages: Outage[] = []
  readonly stopMs: number
  readonly switches: RecordedEvent[]

  constructor(
    readonly events: RecordedEvent[],
    readonly limits: GateLimits
  ) {
    for (const event of events) {
      if (event.action === 'startPublisher') {
        const angle = PUBLISHER_ANGLE[event.target]
        if (angle != null) this.starts.set(angle, event.doneMs ?? event.atMs)
      }
      if (event.action === 'syntheticCut') {
        const seconds = Number(event.args?.seconds ?? 0)
        this.outages.push({
          atMs: event.atMs,
          restoredMs: event.doneMs ?? event.atMs + seconds * 1000
        })
      }
    }
    this.stopMs =
      events.find(event => event.action === 'stopPublishers')?.atMs ?? Infinity
    this.switches = events.filter(event => event.action === 'switchSurface')
  }

  /** Angles that should be advancing: started, not stopped, C outside its outage. */
  playable(atMs: number): string[] {
    if (atMs >= this.stopMs) return []
    return [...this.starts.entries()]
      .filter(([angle, start]) => {
        if (start > atMs) return false
        if (angle !== SYNTHETIC_ANGLE) return true
        return !this.outages.some(
          outage =>
            atMs >= outage.atMs &&
            atMs < outage.restoredMs + this.limits.outageRecoveryMs
        )
      })
      .map(([angle]) => angle)
  }

  /** Angles that are publishing, which a stuck tile is judged on. */
  publishing(atMs: number): string[] {
    if (atMs >= this.stopMs) return []
    return [...this.starts.entries()]
      .filter(([angle, start]) => {
        if (start > atMs) return false
        if (angle !== SYNTHETIC_ANGLE) return true
        return !this.outages.some(
          outage => atMs >= outage.atMs && atMs < outage.restoredMs
        )
      })
      .map(([angle]) => angle)
  }

  iphoneFront(atMs: number): SoakSurface {
    let front: SoakSurface = 'iphone-app'
    for (const change of this.switches) {
      if (change.atMs <= atMs) {
        front = change.args?.to === 'safari' ? 'iphone-safari' : 'iphone-app'
      }
    }
    return front
  }

  /** The surfaces watching at a moment. */
  watchers(atMs: number): SoakSurface[] {
    return [this.iphoneFront(atMs), 'android', 'ipad', 'tv', 'chrome']
  }
}

type Look = 'pass' | 'fail' | 'unknown'

function tileOf(probe: RecordedProbe, angle: string): ProbeTile | undefined {
  return probe.tiles?.find(tile => tile.angle === angle)
}

/** Every angle advancing: a missing tile is a failure, an unknown one no answer. */
function allAdvancing(probe: RecordedProbe, angles: string[]): Look {
  if (probe.tiles == null) return 'unknown'
  let look: Look = 'pass'
  for (const angle of angles) {
    const tile = tileOf(probe, angle)
    if (tile == null || tile.advancing === false) return 'fail'
    if (tile.advancing == null) look = 'unknown'
  }
  return look
}

interface Window {
  fromMs: number
  toMs: number
}

function within(probe: RecordedProbe, window: Window): boolean {
  return probe.atMs >= window.fromMs && probe.atMs <= window.toMs
}

/** The first probe in the window that passes; else a failure if one answered. */
function recovery(
  probes: RecordedProbe[],
  window: Window,
  look: (probe: RecordedProbe) => Look
): { verdict: Verdict; recoveredInMs?: number; screenshots?: string[] } {
  let failed: RecordedProbe | undefined
  for (const probe of probes) {
    if (!within(probe, window)) continue
    const seen = look(probe)
    if (seen === 'pass') {
      return { verdict: 'passed', recoveredInMs: probe.atMs - window.fromMs }
    }
    if (seen === 'fail') failed ??= probe
  }
  if (failed != null) {
    return { verdict: 'failed', screenshots: failed.screenshots }
  }
  return { verdict: 'blocked' }
}

function surfaceOfTarget(
  timeline: Timeline,
  event: RecordedEvent
): SoakSurface | undefined {
  const target = event.target
  if (target === 'iphone') return timeline.iphoneFront(event.atMs)
  if (
    target === 'iphone-app' ||
    target === 'iphone-safari' ||
    target === 'android' ||
    target === 'ipad' ||
    target === 'tv' ||
    target === 'chrome'
  ) {
    return target
  }
  return undefined
}

/** Where a surface is excused from continuous play: an action and its gate. */
function recoveryWindows(timeline: Timeline, surface: SoakSurface): Window[] {
  const { limits } = timeline
  const windows: Window[] = []
  for (const event of timeline.events) {
    const done = event.doneMs ?? event.atMs
    if (event.action === 'switchSurface') {
      if (surface === 'iphone-app' || surface === 'iphone-safari') {
        windows.push({ fromMs: event.atMs, toMs: done + limits.switchMs })
      }
      continue
    }
    if (surfaceOfTarget(timeline, event) !== surface) continue
    if (event.action === 'join') {
      windows.push({ fromMs: -Infinity, toMs: done + limits.reentryMs })
    } else if (ACTIONS.has(event.action) || event.action === 'cameraCutBack') {
      const { limit } = gateFor(event.action)
      windows.push({ fromMs: event.atMs, toMs: done + limits[limit] })
    }
  }
  return windows
}

function joinedAt(timeline: Timeline, surface: SoakSurface): number {
  if (surface === 'iphone-safari') {
    return (
      timeline.switches.find(change => change.args?.to === 'safari')?.atMs ??
      Infinity
    )
  }
  const join = timeline.events.find(
    event => event.action === 'join' && event.target === surface
  )
  return join?.atMs ?? Infinity
}

function judgeActions(
  timeline: Timeline,
  bySurface: Map<SoakSurface, RecordedProbe[]>
): GateInstance[] {
  const { limits } = timeline
  const out: GateInstance[] = []
  for (const event of timeline.events) {
    if (!ACTIONS.has(event.action)) continue
    const surface = surfaceOfTarget(timeline, event)
    if (surface == null) continue
    const { gate, limit } = gateFor(event.action)
    const base = { gate, surface, kind: event.action, atMs: event.atMs }
    if (event.error != null) {
      out.push({
        ...base,
        verdict: 'blocked',
        reason: `action failed: ${event.error}`
      })
      continue
    }
    const fromMs = event.doneMs ?? event.atMs
    const window = { fromMs, toMs: fromMs + limits[limit] }
    const probes = bySurface.get(surface) ?? []
    const angles = timeline.playable(fromMs)
    let look: (probe: RecordedProbe) => Look = probe =>
      allAdvancing(probe, angles)
    if (gate === 'cameraCut') {
      const chosen =
        typeof event.args?.angle === 'string' ? event.args.angle : ''
      look = probe => {
        const own = allAdvancing(probe, [chosen])
        if (own !== 'pass') return own
        // The others keep playing where they are still on screen.
        const others = angles.filter(
          angle => angle !== chosen && tileOf(probe, angle) != null
        )
        return allAdvancing(probe, others)
      }
    }
    const judged = recovery(probes, window, look)
    out.push({
      ...base,
      ...judged,
      reason:
        judged.verdict === 'passed'
          ? undefined
          : judged.verdict === 'failed'
            ? `not every angle advanced within ${limits[limit] / 1000} s`
            : 'no probe answered within the gate'
    })
  }
  return out
}

function judgeSwitches(
  timeline: Timeline,
  bySurface: Map<SoakSurface, RecordedProbe[]>
): GateInstance[] {
  const { limits } = timeline
  return timeline.switches.map(event => {
    const surface: SoakSurface =
      event.args?.to === 'safari' ? 'iphone-safari' : 'iphone-app'
    const base = {
      gate: 'surfaceSwitch' as const,
      surface,
      kind: 'surfaceSwitch',
      atMs: event.atMs
    }
    if (event.error != null) {
      return {
        ...base,
        verdict: 'blocked' as const,
        reason: `switch failed: ${event.error}`
      }
    }
    if (event.outcome?.reloaded === true) {
      return {
        ...base,
        verdict: 'failed' as const,
        reason: 'the surface reloaded or reopened the game'
      }
    }
    const fromMs = event.doneMs ?? event.atMs
    const angles = timeline.playable(fromMs)
    const judged = recovery(
      bySurface.get(surface) ?? [],
      { fromMs, toMs: fromMs + limits.switchMs },
      probe => allAdvancing(probe, angles)
    )
    return {
      ...base,
      ...judged,
      reason:
        judged.verdict === 'passed'
          ? undefined
          : judged.verdict === 'failed'
            ? `not every angle advanced within ${limits.switchMs / 1000} s`
            : 'no probe answered within the gate'
    }
  })
}

function judgeOutages(
  timeline: Timeline,
  bySurface: Map<SoakSurface, RecordedProbe[]>
): GateInstance[] {
  const { limits } = timeline
  const out: GateInstance[] = []
  for (const outage of timeline.outages) {
    for (const surface of timeline.watchers(outage.atMs)) {
      const base = {
        gate: 'syntheticOutage' as const,
        surface,
        kind: 'syntheticOutage',
        atMs: outage.atMs
      }
      const probes = bySurface.get(surface) ?? []
      const excused = recoveryWindows(timeline, surface)
      const recoverBy = outage.restoredMs + limits.outageRecoveryMs
      const rejoined = timeline.events.some(
        event =>
          REJOINS.has(event.action) &&
          surfaceOfTarget(timeline, event) === surface &&
          event.atMs >= outage.atMs &&
          event.atMs <= recoverBy
      )
      if (rejoined) {
        out.push({
          ...base,
          verdict: 'blocked',
          reason: 'a rejoin overlapped the outage'
        })
        continue
      }
      const problems: string[] = []
      let answered = false
      let screenshots: string[] | undefined
      for (const probe of probes) {
        if (probe.atMs < outage.atMs || probe.atMs > outage.restoredMs) continue
        if (excused.some(window => within(probe, window))) continue
        const others = timeline
          .playable(probe.atMs)
          .filter(angle => angle !== SYNTHETIC_ANGLE)
        const look = allAdvancing(probe, others)
        if (look !== 'unknown') answered = true
        if (look === 'fail') {
          problems.push(
            `another angle stopped at +${probe.atMs - outage.atMs} ms`
          )
          screenshots ??= probe.screenshots
        }
        if (probe.atMs < outage.atMs + limits.noticeGraceMs) continue
        const tile =
          probe.tiles == null ? undefined : tileOf(probe, SYNTHETIC_ANGLE)
        if (probe.tiles == null || tile?.advancing === null) continue
        answered = true
        const truthful =
          tile != null &&
          !tile.advancing &&
          tile.notice != null &&
          TRUTHFUL_NOTICE.test(tile.notice)
        if (!truthful) {
          problems.push(
            `C showed ${tile == null ? 'no tile' : JSON.stringify(tile.notice)} at +${probe.atMs - outage.atMs} ms`
          )
          screenshots ??= probe.screenshots
        }
      }
      const back = recovery(
        probes,
        { fromMs: outage.restoredMs, toMs: recoverBy },
        probe => allAdvancing(probe, [SYNTHETIC_ANGLE])
      )
      if (back.verdict === 'failed') {
        problems.push(
          `C did not advance within ${limits.outageRecoveryMs / 1000} s of restore`
        )
        screenshots ??= back.screenshots
      }
      if (problems.length > 0) {
        out.push({
          ...base,
          verdict: 'failed',
          reason: problems.join('; '),
          screenshots
        })
      } else if (back.verdict === 'blocked' || !answered) {
        out.push({
          ...base,
          verdict: 'blocked',
          reason: 'no probe answered during the outage or its recovery'
        })
      } else {
        out.push({
          ...base,
          verdict: 'passed',
          recoveredInMs: back.recoveredInMs
        })
      }
    }
  }
  return out
}

function judgeContinuous(
  timeline: Timeline,
  surface: SoakSurface,
  probes: RecordedProbe[]
): GateInstance[] {
  const windows = recoveryWindows(timeline, surface)
  const out: GateInstance[] = []
  for (const probe of probes) {
    if (windows.some(window => within(probe, window))) continue
    const angles = timeline.playable(probe.atMs)
    if (angles.length === 0) continue
    const look = allAdvancing(probe, angles)
    const base = {
      gate: 'continuousPlay' as const,
      surface,
      kind: 'continuousPlay',
      atMs: probe.atMs
    }
    if (look === 'pass') out.push({ ...base, verdict: 'passed' })
    else if (look === 'fail') {
      out.push({
        ...base,
        verdict: 'failed',
        reason: 'an angle was not advancing',
        screenshots: probe.screenshots
      })
    } else {
      out.push({
        ...base,
        verdict: 'blocked',
        reason: probe.reason ?? 'the surface could not answer'
      })
    }
  }
  return out
}

function judgeStuck(
  timeline: Timeline,
  surface: SoakSurface,
  probes: RecordedProbe[]
): GateInstance[] {
  const { limits } = timeline
  const angles = [...timeline.starts.keys()]
  const from = joinedAt(timeline, surface) + limits.reentryMs
  return angles.map(angle => {
    let answered = false
    let spanStart: RecordedProbe | undefined
    let spanEnd: RecordedProbe | undefined
    const stuck: string[] = []
    let screenshots: string[] | undefined
    const close = (): void => {
      if (spanStart != null && spanEnd != null) {
        const length = spanEnd.atMs - spanStart.atMs
        if (length > limits.stuckMs) {
          stuck.push(
            `stuck ${Math.round(length / 1000)} s from ${spanStart.atMs}`
          )
          screenshots ??= spanEnd.screenshots
        }
      }
      spanStart = undefined
      spanEnd = undefined
    }
    let last: RecordedProbe | undefined
    for (const probe of probes) {
      if (probe.atMs < from) continue
      // A span never bridges the time this surface spent behind the other.
      const switched =
        last != null &&
        timeline.switches.some(
          change => change.atMs > last!.atMs && change.atMs <= probe.atMs
        )
      last = probe
      if (switched) close()
      if (!timeline.publishing(probe.atMs).includes(angle)) {
        close()
        continue
      }
      if (probe.tiles == null) continue
      const tile = tileOf(probe, angle)
      if (tile?.advancing === null) continue
      answered = true
      const bad =
        tile == null ||
        !tile.advancing ||
        (tile.notice != null && STUCK_NOTICE.test(tile.notice))
      if (bad) {
        spanStart ??= probe
        spanEnd = probe
      } else close()
    }
    close()
    const base = {
      gate: 'noStuckTile' as const,
      surface,
      kind: 'noStuckTile',
      atMs: from
    }
    if (stuck.length > 0) {
      return {
        ...base,
        verdict: 'failed' as const,
        reason: `${angle}: ${stuck.join('; ')}`,
        screenshots
      }
    }
    if (!answered) {
      return {
        ...base,
        verdict: 'blocked' as const,
        reason: `${angle}: never answered`
      }
    }
    return { ...base, verdict: 'passed' as const, reason: angle }
  })
}

function judgeCrash(
  timeline: Timeline,
  surface: SoakSurface,
  probes: RecordedProbe[]
): GateInstance {
  const { limits } = timeline
  const excused: Window[] = []
  for (const event of timeline.events) {
    const done = event.doneMs ?? event.atMs
    if (event.action === 'switchSurface') {
      excused.push({ fromMs: event.atMs, toMs: done + limits.switchMs })
    } else if (
      (event.action === 'relaunch' || event.action === 'join') &&
      surfaceOfTarget(timeline, event) === surface
    ) {
      excused.push({ fromMs: event.atMs, toMs: done + limits.reentryMs })
    }
  }
  const base = {
    gate: 'noCrash' as const,
    surface,
    kind: 'noCrash',
    atMs: probes[0]?.atMs ?? 0
  }
  let answered = false
  for (const probe of probes) {
    if (excused.some(window => within(probe, window))) continue
    if (probe.sessionLost === true) {
      return {
        ...base,
        verdict: 'failed',
        atMs: probe.atMs,
        reason: 'the session was lost',
        screenshots: probe.screenshots
      }
    }
    if (probe.foreground == null) continue
    answered = true
    if (!probe.foreground) {
      return {
        ...base,
        verdict: 'failed',
        atMs: probe.atMs,
        reason: probe.reason ?? 'it left the foreground',
        screenshots: probe.screenshots
      }
    }
  }
  return answered
    ? { ...base, verdict: 'passed' }
    : { ...base, verdict: 'blocked', reason: 'foreground was never observable' }
}

function count(instances: GateInstance[]): GateCount[] {
  const rows = new Map<string, GateCount>()
  for (const instance of instances) {
    const key = `${instance.surface}\u0000${instance.kind}`
    const row = rows.get(key) ?? {
      surface: instance.surface,
      kind: instance.kind,
      run: 0,
      passed: 0,
      failed: 0,
      blocked: 0
    }
    row.run++
    row[instance.verdict]++
    rows.set(key, row)
  }
  return [...rows.values()]
}

/** Marks each failure repeated when its surface and kind failed more than once. */
function classify(instances: GateInstance[], counts: GateCount[]): void {
  for (const instance of instances) {
    if (instance.verdict !== 'failed') continue
    const row = counts.find(
      count =>
        count.surface === instance.surface && count.kind === instance.kind
    )!
    instance.recurrence = row.failed > 1 ? 'repeated' : 'single'
  }
}

export function overallVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('failed')) return 'failed'
  if (verdicts.includes('blocked')) return 'blocked'
  return 'passed'
}

export function evaluateGates(
  events: RecordedEvent[],
  probes: RecordedProbe[],
  limits: GateLimits = GATE_LIMITS
): GateReport {
  const timeline = new Timeline(
    [...events].sort((a, b) => a.atMs - b.atMs),
    limits
  )
  const bySurface = new Map<SoakSurface, RecordedProbe[]>()
  for (const probe of [...probes].sort((a, b) => a.atMs - b.atMs)) {
    const list = bySurface.get(probe.surface) ?? []
    list.push(probe)
    bySurface.set(probe.surface, list)
  }
  const instances: GateInstance[] = [
    ...judgeActions(timeline, bySurface),
    ...judgeSwitches(timeline, bySurface),
    ...judgeOutages(timeline, bySurface)
  ]
  for (const [surface, list] of bySurface) {
    instances.push(
      ...judgeContinuous(timeline, surface, list),
      ...judgeStuck(timeline, surface, list),
      judgeCrash(timeline, surface, list)
    )
  }
  const counts = count(instances)
  classify(instances, counts)
  return {
    verdict:
      instances.length === 0
        ? 'blocked'
        : overallVerdict(instances.map(instance => instance.verdict)),
    instances,
    counts
  }
}
