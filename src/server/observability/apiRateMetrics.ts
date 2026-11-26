import { createHmac, randomBytes } from 'node:crypto'

import type { Property } from '../../common/observability/contract'
import type {
  Bucket,
  RateMode,
  RateScope,
  RateTier,
  SpendResult,
  Transport
} from '../middleware/apiRateLimits'
import { emitLog } from './logging'

type Report = (
  event:
    | 'api_rate_decisions'
    | 'api_rate_demand'
    | 'api_rate_store'
    | 'api_rate_upgrade_identity_missed',
  properties: Record<string, Property>
) => void
export interface RateMetrics {
  missedUpgradeIdentity: () => void
  record: (
    buckets: Bucket[],
    tier: RateTier,
    transport: Transport,
    result: SpendResult,
    elapsedMs: number
  ) => void
}

interface Sample {
  scope: RateScope
  tier: RateTier
  second: number
  tenSeconds: number
  count1: number
  count10: number
  peak1: number
  peak10: number
  total: number
}

/** One minute of fixed-label counters per worker. Only numeric distributions
 * leave the worker. Sampled bucket keys are keyed digests with a fresh salt
 * each interval, kept only in this bounded, in-memory table. */
export function rateMetrics(
  mode: RateMode,
  report: Report = emitLog,
  now: () => number = () => performance.now()
): RateMetrics & {
  flush: () => void
  storeDegraded: (degraded: boolean) => void
} {
  const decisions = new Map<
    string,
    {
      labels: Record<string, string>
      n: number
      units: number
      admittedUnits: number
      le1: number
      le5: number
      le20: number
      le100: number
    }
  >()
  const samples = new Map<string, Sample>()
  let salt = randomBytes(16)
  let localSince: number | undefined
  let degradedMs = 0
  let missedIdentities = 0

  function sample(bucket: Bucket, at: number): void {
    const hash = createHmac('sha256', salt).update(bucket.key).digest()
    // A stable 1/8 sample within each interval; bound memory even during a burst.
    if (hash[0] >= 32) return
    const id = hash.toString('base64url')
    let s = samples.get(id)
    const second = Math.floor(at / 1000)
    const tenSeconds = Math.floor(at / 10000)
    if (s == null) {
      if (samples.size >= 1024) return
      s = {
        scope: bucket.scope,
        tier: bucket.tier,
        second,
        tenSeconds,
        count1: 0,
        count10: 0,
        peak1: 0,
        peak10: 0,
        total: 0
      }
      samples.set(id, s)
    }
    const units = bucket.units ?? 1
    s.count1 = (s.second === second ? s.count1 : 0) + units
    s.count10 = (s.tenSeconds === tenSeconds ? s.count10 : 0) + units
    s.second = second
    s.tenSeconds = tenSeconds
    s.peak1 = Math.max(s.peak1, s.count1)
    s.peak10 = Math.max(s.peak10, s.count10)
    s.total += units
  }

  const record: RateMetrics['record'] = (
    buckets,
    tier,
    transport,
    result,
    elapsedMs
  ) => {
    const at = now()
    const limited = result.retryAfterSec > 0
    const bucket = buckets[result.limiting] ?? buckets[0]
    const labels = {
      mode,
      tier,
      transport,
      backend: result.backend,
      scope: limited && result.limiting < 0 ? 'store' : bucket.scope,
      limitingTier: limited && result.limiting >= 0 ? bucket.tier : 'none',
      decision: limited ? 'refused' : 'admitted',
      fault: result.error ?? 'none'
    }
    const key = Object.values(labels).join('/')
    let row = decisions.get(key)
    if (row == null) {
      row = {
        labels,
        n: 0,
        units: 0,
        admittedUnits: 0,
        le1: 0,
        le5: 0,
        le20: 0,
        le100: 0
      }
      decisions.set(key, row)
    }
    const units = buckets[0].units ?? 1
    row.n++
    row.units += units
    if (!limited) row.admittedUnits += units
    if (elapsedMs <= 1) row.le1++
    if (elapsedMs <= 5) row.le5++
    if (elapsedMs <= 20) row.le20++
    if (elapsedMs <= 100) row.le100++
    for (const b of buckets) sample(b, at)
  }

  const storeDegraded = (degraded: boolean): void => {
    const at = now()
    if (degraded) localSince ??= at
    else if (localSince != null) {
      degradedMs += at - localSince
      localSince = undefined
    }
  }
  const flush = (): void => {
    for (const { labels, ...counts } of decisions.values())
      report('api_rate_decisions', { ...labels, ...counts })
    decisions.clear()
    if (missedIdentities > 0) {
      report('api_rate_upgrade_identity_missed', { n: missedIdentities })
      missedIdentities = 0
    }
    if (localSince != null) {
      const at = now()
      degradedMs += at - localSince
      localSince = at
    }
    if (degradedMs > 0) report('api_rate_store', { mode, degradedMs })
    degradedMs = 0
    const groups = new Map<string, Sample[]>()
    for (const s of samples.values()) {
      const key = s.scope + '/' + s.tier
      const group = groups.get(key)
      if (group == null) groups.set(key, [s])
      else group.push(s)
    }
    for (const group of groups.values()) {
      const { scope, tier } = group[0]
      for (const [windowSec, field] of [
        [1, 'peak1'],
        [10, 'peak10'],
        [60, 'total']
      ] as const) {
        const values = group.map(s => s[field]).sort((a, b) => a - b)
        const n = values.length
        report('api_rate_demand', {
          mode,
          scope,
          tier,
          windowSec,
          n,
          p50: values[Math.ceil(n * 0.5) - 1],
          p95: values[Math.ceil(n * 0.95) - 1],
          max: values[n - 1]
        })
      }
    }
    samples.clear()
    salt = randomBytes(16)
  }
  return {
    record,
    flush,
    storeDegraded,
    missedUpgradeIdentity: () => {
      ++missedIdentities
    }
  }
}
