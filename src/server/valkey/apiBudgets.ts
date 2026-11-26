import { createHash, randomUUID } from 'node:crypto'

import type {
  Bucket,
  RateMode,
  Spend,
  SpendResult,
  StoreFault
} from '../middleware/apiRateLimits'
import type { ScoreboardClient } from '../scoreboard/scoreboardStore'
import {
  onceAMinute,
  runValkey,
  VALKEY_COMMAND_TIMEOUT_MS,
  ValkeyTimeout
} from './client'

// Store only the time at which each bucket will be full again. One script
// checks all applicable budgets before it debits any of them. Redis time
// keeps workers with different clocks in agreement.
export const SPEND_BUDGETS = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local debts = {}
local wait, limiting = 0, 0
for i, key in ipairs(KEYS) do
  local interval = tonumber(ARGV[3*i-2])
  local burst = tonumber(ARGV[3*i-1])
  local full = tonumber(redis.call('GET', key)) or now
  debts[i] = math.max(0, full - now) + interval * tonumber(ARGV[3*i])
  local excess = debts[i] - burst * interval
  if excess > wait then wait, limiting = excess, i end
end
if wait > 0 then return {math.ceil(wait / 1000), limiting} end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, now + debts[i], 'PX', debts[i])
end
return {0, 0}
`

const scriptHash = createHash('sha1').update(SPEND_BUDGETS).digest('hex')

// Keep the API usable during a cache outage. Never evict an active caller
// to admit a fresh identity; refuse new keys briefly when the table is full.
export function localBudgets(
  now: () => number = Date.now,
  maxKeys = 50000
): Spend {
  const fullAt = new Map<string, number>()
  let nextSweep = 0
  return async buckets => {
    const at = now()
    if (at >= nextSweep) {
      for (const [key, full] of fullAt) if (full <= at) fullAt.delete(key)
      nextSweep = at + 1000
    }
    let wait = 0
    let limiting = -1
    let newKeys = 0
    const updates = buckets.map(
      ({ key, budget: [interval, burst], units = 1 }, index) => {
        const full = fullAt.get(key)
        if (full == null) ++newKeys
        const next = Math.max(at, full ?? at) + interval * units
        const excess = next - at - interval * burst
        if (excess > wait) {
          wait = excess
          limiting = index
        }
        return { key, next }
      }
    )
    if (wait > 0)
      return {
        backend: 'local',
        retryAfterSec: Math.ceil(wait / 1000),
        limiting
      }
    if (fullAt.size + newKeys > maxKeys)
      return { backend: 'local', retryAfterSec: 1, limiting: -1 }
    for (const { key, next } of updates) fullAt.set(key, next)
    return { backend: 'local', retryAfterSec: 0, limiting: -1 }
  }
}

export function ratePrefix(deployment: string, mode: RateMode): string {
  return deployment + ':api-rate:v2:' + mode + ':'
}

const recoveryMs = 5000

/** Only these bounded classes leave the process. Command errors can contain keys. */
function storeFault(error: unknown): StoreFault {
  if (error instanceof ValkeyTimeout) return 'timeout'
  const message = error instanceof Error ? error.message : ''
  if (/^(CROSSSLOT|MOVED|ASK|CLUSTERDOWN)\b/i.test(message)) return 'cluster'
  if (
    /^(NOPERM|NOAUTH|WRONGPASS)\b|ACL failure|permissions? to (run|access)/i.test(
      message
    )
  )
    return 'permissions'
  if (/^READONLY\b|read.only replica/i.test(message)) return 'readOnly'
  if (/^ERR\b|^WRONGTYPE\b|^OOM\b/i.test(message)) return 'storeError'
  return 'unavailable'
}

const diagnostics: Record<StoreFault, string> = {
  unavailable: 'Valkey is unavailable. Check the writer connection',
  timeout: 'Valkey timed out. Check writer latency and connectivity',
  cluster:
    'the store cannot run the atomic multi-key check. Use one writable primary',
  readOnly: 'the endpoint is read-only. Use the writable primary',
  permissions:
    'check writer credentials and ACLs for EVALSHA, EVAL, TIME, GET, SET and all limiter keys',
  storeError:
    'Valkey rejected the script or its result. Check writer configuration and memory'
}

type State = 'off' | 'checking' | 'shared' | StoreFault
export interface RateStoreHealth {
  mode: RateMode
  readiness: 'off' | 'checking' | 'ready' | 'degraded' | 'failed'
  fault?: StoreFault
  degradedMs: number
}

export function sharedBudgets(
  client: ScoreboardClient,
  prefix: string,
  mode: RateMode,
  log: (message: string) => void,
  backendChanged?: (degraded: boolean) => void
): { spend: Spend; health: () => RateStoreHealth; close: () => void } {
  const local = localBudgets()
  const namespace = ratePrefix(prefix, mode)
  // Bound diagnostics even if the connection oscillates. Independent classes
  // ensure a connection outage cannot suppress a later configuration alert.
  const warn = new Map<StoreFault, (message: string) => boolean>()
  const cacheMiss = onceAMinute(log)
  const recovered = onceAMinute(log)
  let state: State = mode === 'off' ? 'off' : 'checking'
  let degradedAt: number | undefined
  let epoch = 0
  let closed = false
  let probing: Promise<void> | undefined

  function failed(fault: StoreFault): void {
    if (closed) return
    ++epoch
    state = fault
    degradedAt ??= performance.now()
    backendChanged?.(true)
    const say = warn.get(fault) ?? onceAMinute(log)
    warn.set(fault, say)
    say(
      'API rate limits: ' +
        diagnostics[fault] +
        '. Each worker grants a separate local allowance until the shared probe succeeds.'
    )
  }

  async function evaluate(
    keys: string[],
    args: string[]
  ): Promise<SpendResult> {
    const options = { keys, arguments: args }
    const deadline = Date.now() + VALKEY_COMMAND_TIMEOUT_MS
    let reply: unknown
    try {
      reply = await runValkey(
        client,
        async () => await client.evalSha(scriptHash, options)
      )
    } catch (error) {
      // Only a definite cache miss received inside the original command
      // deadline may load the script. A lost or late answer may have applied.
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message))
        throw error
      cacheMiss(
        'API rate limits: loading the budget script after a script-cache miss'
      )
      reply = await runValkey(
        client,
        async () => await client.eval(SPEND_BUDGETS, options),
        deadline - Date.now()
      )
    }
    const [retryAfterSec, position] = reply as [number, number]
    return { backend: 'shared', retryAfterSec, limiting: position - 1 }
  }

  function probe(): void {
    if (closed || probing != null) return
    const generation = epoch
    const id = ':probe:' + randomUUID()
    probing = (async () => {
      try {
        // Fresh, unrelated probe keys exercise the real multi-key script,
        // its server clock and expiring writes, outside every caller's keys.
        const keys = ['account', 'ip', 'guest'].flatMap(scope => {
          const key = namespace + scope + id
          const families = [key, key + ':aggregate', key + ':expensive']
          if (scope !== 'guest') families.push(key + ':schedule-rows')
          return families
        })
        const result = await evaluate(
          keys,
          keys.flatMap(() => ['1000', '1', '1'])
        )
        if (closed || generation !== epoch) return
        if (result.retryAfterSec !== 0 || result.limiting !== -1)
          throw new Error('ERR unexpected preflight response')
        state = 'shared'
        if (degradedAt != null)
          recovered('API rate limits: shared enforcement is ready again')
        degradedAt = undefined
        backendChanged?.(false)
      } catch (err) {
        if (generation === epoch) failed(storeFault(err))
      }
    })().finally(() => {
      probing = undefined
    })
  }
  function disconnected(error?: unknown): void {
    if (!client.isReady) failed(storeFault(error))
  }
  let retry: NodeJS.Timeout | undefined
  if (mode !== 'off') {
    client.on('ready', probe)
    client.on('error', disconnected)
    client.on('end', disconnected)
    probe()
    retry = setInterval(() => {
      if (state !== 'shared' && client.isReady) probe()
    }, recoveryMs)
    retry.unref()
  }
  async function spend(buckets: Bucket[]): Promise<SpendResult> {
    if (probing != null) await probing
    if (state === 'shared') {
      if (client.isReady) {
        try {
          return await evaluate(
            buckets.map(b => namespace + b.key),
            buckets.flatMap(b => [...b.budget, b.units ?? 1].map(String))
          )
        } catch (err) {
          failed(storeFault(err))
        }
      } else failed('unavailable')
    } else if (state === 'checking' && !client.isReady) failed('unavailable')
    return {
      ...(await local(buckets)),
      error:
        state === 'off' || state === 'checking' || state === 'shared'
          ? 'unavailable'
          : state
    }
  }
  function health(): RateStoreHealth {
    if (state === 'off' || state === 'checking' || state === 'shared')
      return {
        mode,
        readiness: state === 'shared' ? 'ready' : state,
        degradedMs: 0
      }
    return {
      mode,
      readiness:
        state === 'unavailable' || state === 'timeout' ? 'degraded' : 'failed',
      fault: state,
      degradedMs: Math.floor(
        performance.now() - (degradedAt ?? performance.now())
      )
    }
  }
  function close(): void {
    closed = true
    clearInterval(retry)
    client.off('ready', probe)
    client.off('error', disconnected)
    client.off('end', disconnected)
  }
  return { spend, health, close }
}
