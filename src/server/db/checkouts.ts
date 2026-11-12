import { AsyncLocalStorage } from 'node:async_hooks'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { Pool, PoolClient } from 'pg'

/**
 * Who a pool checkout is for: a request, named by its route's pattern, or a
 * piece of named background work. A label is a constant of the code, never a
 * value from a request, so it is safe to log.
 */
export interface CheckoutOwner {
  label: () => string
}

const owners = new AsyncLocalStorage<CheckoutOwner>()

/** The owner of checkouts made from here, if anybody said. */
export function checkoutOwner(): CheckoutOwner | undefined {
  return owners.getStore()
}

/** Runs `work` with its checkouts named `label`. */
export function runCheckoutsAs<T>(label: string, work: () => T): T {
  return owners.run({ label: () => label }, work)
}

/** Runs `work` with its checkouts owned by `owner`. */
export function runCheckoutsFor<T>(owner: CheckoutOwner, work: () => T): T {
  return owners.run(owner, work)
}

/** When a checkout is worth a line, and how often a line may be written. */
export interface CheckoutWatchOptions {
  /** A wait for a client at least this long is slow. */
  slowWaitMs?: number
  /** A checkout held at least this long is long. */
  longHoldMs?: number
  /** With this many waiting, the clients held are listed. */
  queueAt?: number
  /** At most one line this often. */
  everyMs?: number
  now?: () => number
  /** The event loop's delay since the last line, or nothing to say. */
  loopDelay?: LoopDelay | null
  /** The process's memory, in bytes. */
  memory?: () => { rss: number; heapUsed: number }
}

export interface LoopDelay {
  /** In nanoseconds, as `perf_hooks` measures. */
  percentile: (p: number) => number
  max: number
  reset: () => void
}

const SLOW_WAIT_MS = 1000
const LONG_HOLD_MS = 2000
const QUEUE_AT = 20
const EVERY_MS = 10_000
/** Rows per list in a line, and routes counted before the rest are `other`. */
const LISTED = 10
const ROUTES_COUNTED = 200

interface Held {
  owner: CheckoutOwner | undefined
  grantedAt: number
  /** Time with a statement outstanding, of those finished. */
  queryMs: number
  /** Statements outstanding, and since when the first of them. */
  inFlight: number
  inFlightSince: number
}

interface Tally {
  n: number
  maxMs: number
  /** For a hold: the longest part of one spent with no statement running. */
  maxIdleMs: number
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10
const megabytes = (bytes: number): number => Math.round(bytes / 1048576)

function tallyInto(
  tallies: Map<string, Tally>,
  route: string,
  ms: number,
  idleMs = 0
): void {
  const key =
    tallies.has(route) || tallies.size < ROUTES_COUNTED ? route : 'other'
  const tally = tallies.get(key) ?? { n: 0, maxMs: 0, maxIdleMs: 0 }
  tally.n++
  tally.maxMs = Math.max(tally.maxMs, ms)
  tally.maxIdleMs = Math.max(tally.maxIdleMs, idleMs)
  tallies.set(key, tally)
}

function topOf(
  tallies: Map<string, Tally>,
  idle: boolean
): Array<Record<string, number | string>> {
  return [...tallies]
    .sort(([, a], [, b]) => (b.n !== a.n ? b.n - a.n : b.maxMs - a.maxMs))
    .slice(0, LISTED)
    .map(([route, tally]) => ({
      route,
      n: tally.n,
      maxMs: tenths(tally.maxMs),
      ...(idle ? { maxIdleMs: tenths(tally.maxIdleMs) } : {})
    }))
}

const labelOf = (owner: CheckoutOwner | undefined): string =>
  owner?.label() ?? 'unattributed'

/**
 * Watches every checkout of `pool`: how long it waited for a client, how long
 * it held one, how much of that a statement was running, and whose it was.
 * `check`, run with the pool's other checks, writes one `db-checkout` line
 * when there is something to say, at most once every `everyMs`:
 *
 * - `slowWaits`: by route, the checkouts that waited `slowWaitMs` or more for
 *   a client, those that gave up (`timedOut`) included;
 * - `longHolds`: by route, those that held one `longHoldMs` or more, with the
 *   longest stretch of one with no statement running (`maxIdleMs`);
 * - `held`, only while `queueAt` or more are waiting: the clients held now,
 *   oldest first, each with its route, age, statement time and whether a
 *   statement is running this moment.
 *
 * With the event loop's delay and the process's memory beside them, a line
 * tells a pool short of clients because the database is slow (statements
 * running), because the process holds clients between statements (a
 * transaction waiting on something else), or because the process itself is
 * too busy to get back to them (a long loop delay). Nothing in it comes from a
 * request but its route's pattern.
 */
export function watchCheckouts(
  pool: Pool,
  role: string,
  log: (message: string) => void,
  options: CheckoutWatchOptions = {}
): { check: () => void; stop: () => void } {
  const now = options.now ?? (() => performance.now())
  const slowWaitMs = options.slowWaitMs ?? SLOW_WAIT_MS
  const longHoldMs = options.longHoldMs ?? LONG_HOLD_MS
  const queueAt = options.queueAt ?? QUEUE_AT
  const everyMs = options.everyMs ?? EVERY_MS
  const memory = options.memory ?? (() => process.memoryUsage())
  let loopDelay: LoopDelay | null
  let stopLoopDelay = (): void => undefined
  if (options.loopDelay !== undefined) loopDelay = options.loopDelay
  else {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    loopDelay = histogram
    stopLoopDelay = () => {
      histogram.disable()
    }
  }

  const held = new Map<PoolClient, Held>()
  let slowWaits = new Map<string, Tally>()
  let longHolds = new Map<string, Tally>()
  let timedOut = 0
  let loggedAt = Number.NEGATIVE_INFINITY

  const granted = (
    client: PoolClient,
    owner: CheckoutOwner | undefined,
    askedAt: number
  ): void => {
    const at = now()
    const waited = at - askedAt
    if (waited >= slowWaitMs) tallyInto(slowWaits, labelOf(owner), waited)
    held.set(client, {
      owner,
      grantedAt: at,
      queryMs: 0,
      inFlight: 0,
      inFlightSince: 0
    })
  }
  const refused = (owner: CheckoutOwner | undefined, askedAt: number): void => {
    const waited = now() - askedAt
    timedOut++
    tallyInto(slowWaits, labelOf(owner), waited)
  }

  const connect = pool.connect.bind(pool) as (
    callback?: (error: Error | undefined, client?: PoolClient) => void
  ) => Promise<PoolClient> | undefined
  ;(pool as { connect: unknown }).connect = (
    callback?: (
      error: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void
    ) => void
  ): Promise<PoolClient> | undefined => {
    const owner = owners.getStore()
    const askedAt = now()
    if (typeof callback === 'function') {
      ;(connect as (cb: typeof callback) => undefined)(
        (error, client, done) => {
          if (error == null && client != null) granted(client, owner, askedAt)
          else refused(owner, askedAt)
          callback(error, client, done)
        }
      )
      return
    }
    return connect()!.then(
      client => {
        granted(client, owner, askedAt)
        return client
      },
      (error: unknown) => {
        refused(owner, askedAt)
        throw error
      }
    )
  }

  pool.on('connect', client => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown
    ;(client as { query: unknown }).query = (...args: unknown[]): unknown => {
      const holding = held.get(client)
      if (holding == null) return query(...args)
      if (holding.inFlight++ === 0) holding.inFlightSince = now()
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        if (--holding.inFlight === 0)
          holding.queryMs += now() - holding.inFlightSince
      }
      const last = args.length - 1
      const callback = args[last]
      if (typeof callback === 'function')
        args[last] = (...answer: unknown[]): unknown => {
          done()
          return callback(...answer)
        }
      const result = query(...args)
      if (result instanceof Promise) result.then(done, done)
      else if (typeof callback !== 'function') done()
      return result
    }
  })
  pool.on('release', (_error, client) => {
    const holding = held.get(client)
    if (holding == null) return
    held.delete(client)
    const at = now()
    const holdMs = at - holding.grantedAt
    if (holdMs < longHoldMs) return
    const queryMs =
      holding.queryMs + (holding.inFlight > 0 ? at - holding.inFlightSince : 0)
    tallyInto(
      longHolds,
      labelOf(holding.owner),
      holdMs,
      Math.max(0, holdMs - queryMs)
    )
  })

  return {
    stop: stopLoopDelay,
    check() {
      const at = now()
      if (at - loggedAt < everyMs) return
      const starving = pool.waitingCount >= queueAt
      if (!starving && slowWaits.size === 0 && longHolds.size === 0) return
      loggedAt = at
      const { rss, heapUsed } = memory()
      const line: Record<string, unknown> = {
        role,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        rssMb: megabytes(rss),
        heapMb: megabytes(heapUsed)
      }
      if (loopDelay != null) {
        line.loopDelayMs = {
          p99: tenths(loopDelay.percentile(99) / 1e6),
          max: tenths(loopDelay.max / 1e6)
        }
        loopDelay.reset()
      }
      if (slowWaits.size > 0) {
        line.slowWaits = topOf(slowWaits, false)
        line.timedOut = timedOut
      }
      if (longHolds.size > 0) line.longHolds = topOf(longHolds, true)
      if (starving)
        line.held = [...held.values()]
          .sort((a, b) => a.grantedAt - b.grantedAt)
          .slice(0, LISTED)
          .map(holding => ({
            route: labelOf(holding.owner),
            ms: tenths(at - holding.grantedAt),
            queryMs: tenths(
              holding.queryMs +
                (holding.inFlight > 0 ? at - holding.inFlightSince : 0)
            ),
            inQuery: holding.inFlight > 0
          }))
      slowWaits = new Map()
      longHolds = new Map()
      timedOut = 0
      log(`db-checkout ${JSON.stringify(line)}`)
    }
  }
}
