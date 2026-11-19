import {
  answerLimit,
  CANCELED,
  type EngineBuild,
  type EngineRequest,
  type EngineSession,
  failure,
  readEvent,
  readResult,
  wireRequest
} from './wire'

export * from './wire'

/**
 * The Auto-Scheduler's C++ engine in the browser: our own WebAssembly build
 * of the engine and HiGHS (`scripts/schedulerBuild.mjs wasm`), shipped
 * beside the bundle (`TS_SCHEDULER_WASM_URL`) and fetched only when a
 * schedule is first built, checked here against `TS_SCHEDULER_WASM_INTEGRITY`
 * (not by the browser, whose refusal reads as any failed fetch), then posted
 * to the worker
 * (`TS_SCHEDULER_WORKER_URL`, `src/app/platform/schedulerWorker.ts`), which
 * runs each build and streams its events back.
 *
 * At the time limit the worker's build waits (Asyncify) for the session's
 * answer, which goes back to the worker as a `decide` message; a `cancel`
 * answer, like Cancel, terminates the worker, and the next build starts a
 * fresh one. The page's other builds on that worker (a second screen's)
 * are not canceled with it: each starts again, from the beginning, on a
 * fresh worker. No `WebAssembly`, a page built without the module, or a
 * module that is not the one built is the `noSolver` failure for every
 * build of the page. A module that does not arrive (the network, a deploy
 * mid-fetch) is the `broken` failure for its build, and the next build
 * fetches it again. A worker that fails to load the module is `noSolver`
 * for its build; one that fails mid-build (a trap, out of memory, or a
 * death with no message) or answers a build with no result is `broken`,
 * with the worker's reason when it gives one, which is also logged. Either
 * way the next build starts another.
 */
declare const TS_SCHEDULER_WORKER_URL: string | undefined
declare const TS_SCHEDULER_WASM_URL: string | undefined
declare const TS_SCHEDULER_WASM_INTEGRITY: string | undefined

export type UnavailableReason =
  'noWebAssembly' | 'noModule' | 'fetchFailed' | 'integrity' | 'worker'

/** What the page says to a person, for each reason. */
const REASONS: Record<UnavailableReason, string> = {
  noWebAssembly: 'This browser has no WebAssembly',
  noModule: 'This page was built without the scheduler',
  fetchFailed: 'The scheduler module did not arrive. Try again.',
  integrity: 'The scheduler module is not the one this page was built with',
  worker: 'The scheduler stopped working'
}

export interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  postMessage: (message: unknown) => void
  terminate: () => void
}

export interface WebEngineOptions {
  hasWebAssembly?: () => boolean
  fetch?: (
    url: string
  ) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>
  digest?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
  createWorker?: (url: string) => WorkerLike
  workerUrl?: string
  wasmUrl?: string
  integrity?: string
  log?: (line: string) => void
  /** How long a worker may take to load the module. */
  readyMs?: number
}

export type EngineStatus = 'unknown' | 'ready' | 'unavailable'

export interface WebEngine {
  build: (
    request: EngineRequest,
    session?: EngineSession
  ) => Promise<EngineBuild>
  status: () => EngineStatus
}

/** The base64 of a digest, as an integrity string carries it. */
function base64(bytes: ArrayBuffer): string {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text)
}

/** A build waiting on a worker. */
interface Pending {
  settle: (result: string | null) => void
  /** Its worker was ended for another build's cancel: build again. */
  again: () => void
  progress: (event: string) => void
}

/** A started worker and the builds it owes. */
interface Running {
  worker: WorkerLike
  pending: Map<number, Pending>
  /** Why the worker failed, when it said. */
  reason?: string
}

/** The engine for this page; `buildSchedule` is the one the app uses. */
export function webEngine(options: WebEngineOptions = {}): WebEngine {
  const workerUrl =
    options.workerUrl ??
    (typeof TS_SCHEDULER_WORKER_URL === 'string'
      ? TS_SCHEDULER_WORKER_URL
      : undefined)
  const wasmUrl =
    options.wasmUrl ??
    (typeof TS_SCHEDULER_WASM_URL === 'string'
      ? TS_SCHEDULER_WASM_URL
      : undefined)
  const integrity =
    options.integrity ??
    (typeof TS_SCHEDULER_WASM_INTEGRITY === 'string'
      ? TS_SCHEDULER_WASM_INTEGRITY
      : undefined)
  const log =
    options.log ??
    (line => {
      console.warn(line)
    })
  let status: EngineStatus = 'unknown'
  /** Why the page cannot build at all, once that is known. */
  let refused: UnavailableReason | undefined
  let next = 0

  // A worker or a fetch that fails is tried again by the next build.
  const unavailable = (reason: UnavailableReason): UnavailableReason => {
    log(`scheduler unavailable: ${reason}`)
    if (reason !== 'worker' && reason !== 'fetchFailed') {
      refused = reason
      status = 'unavailable'
    }
    return reason
  }

  /** The module's bytes, fetched and checked once for the page. */
  let fetched: Promise<ArrayBuffer | UnavailableReason> | undefined
  const moduleBytes = async (): Promise<ArrayBuffer | UnavailableReason> => {
    const hasWebAssembly =
      options.hasWebAssembly ??
      (() =>
        typeof (globalThis as { WebAssembly?: { instantiate?: unknown } })
          .WebAssembly?.instantiate === 'function')
    if (!hasWebAssembly()) return unavailable('noWebAssembly')
    const fetcher =
      options.fetch ??
      (globalThis as { fetch?: WebEngineOptions['fetch'] }).fetch
    if (wasmUrl == null || workerUrl == null || fetcher == null)
      return unavailable('noModule')
    let bytes: ArrayBuffer
    try {
      // The digest is checked below, so that a module that is not the one
      // built is told from one that did not arrive.
      const response = await fetcher(wasmUrl)
      if (!response.ok) throw new Error('The module did not arrive')
      bytes = await response.arrayBuffer()
    } catch {
      return unavailable('fetchFailed')
    }
    const digest =
      options.digest ??
      (async (data: ArrayBuffer) => await crypto.subtle.digest('SHA-384', data))
    if (
      integrity == null ||
      `sha384-${base64(await digest(bytes))}` !== integrity
    )
      return unavailable('integrity')
    return bytes
  }

  /** Ends a worker: every build it owes answers `result`. */
  const end = (running: Running, result: string | null): void => {
    running.worker.onmessage = null
    running.worker.onerror = null
    running.worker.terminate()
    if (current === running) current = undefined
    for (const each of running.pending.values()) each.settle(result)
    running.pending.clear()
  }

  /**
   * Ends a worker for one build's cancel: that build is settled, and every
   * other build it owes starts again on a fresh worker.
   */
  const cancelOn = (running: Running, id: number): void => {
    const owed = [...running.pending.entries()]
    running.pending.clear()
    end(running, null)
    for (const [each, build] of owed)
      if (each === id) build.settle(null)
      else build.again()
  }

  /** A worker with the module loaded, or why there is none. */
  let current: Running | undefined
  let starting: Promise<Running | UnavailableReason> | undefined
  const start = async (): Promise<Running | UnavailableReason> => {
    fetched ??= moduleBytes()
    const bytes = await fetched
    // A module that did not arrive is fetched again next time.
    if (bytes === 'fetchFailed') fetched = undefined
    if (typeof bytes === 'string') return bytes
    let worker: WorkerLike
    try {
      worker = (
        options.createWorker ??
        (url =>
          new (
            globalThis as unknown as {
              Worker: new (script: string) => WorkerLike
            }
          ).Worker(url))
      )(String(workerUrl))
    } catch {
      return unavailable('worker')
    }
    const running: Running = { worker, pending: new Map() }
    return await new Promise<Running | UnavailableReason>(resolve => {
      let ready = false
      // A worker given up on is stopped, and nothing it says counts.
      const fail = (reason?: string): void => {
        clearTimeout(timer)
        if (reason != null && reason !== '') {
          running.reason = reason
          log(`scheduler worker failed: ${reason}`)
        }
        end(running, null)
        if (!ready) resolve(unavailable('worker'))
        else unavailable('worker')
      }
      const timer = setTimeout(() => {
        fail()
      }, options.readyMs ?? 60_000)
      worker.onerror = event => {
        const message = (event as { message?: unknown } | null)?.message
        fail(typeof message === 'string' ? message : undefined)
      }
      worker.onmessage = event => {
        const reply = event.data as {
          type?: string
          id?: number
          result?: unknown
          event?: unknown
          reason?: unknown
        }
        if (reply.type === 'ready') {
          clearTimeout(timer)
          ready = true
          status = 'ready'
          current = running
          resolve(running)
        } else if (reply.type === 'failed') {
          fail(typeof reply.reason === 'string' ? reply.reason : undefined)
        } else if (typeof reply.id === 'number') {
          const owed = running.pending.get(reply.id)
          if (reply.type === 'progress' && typeof reply.event === 'string')
            owed?.progress(reply.event)
          else if (reply.type === 'result') {
            running.pending.delete(reply.id)
            owed?.settle(typeof reply.result === 'string' ? reply.result : null)
          }
        }
      }
      // A copy, so the page keeps the bytes for the next worker.
      worker.postMessage({ type: 'init', bytes: bytes.slice(0) })
    })
  }

  const worker = async (): Promise<Running | UnavailableReason> => {
    if (refused != null) return refused
    if (current != null) return current
    starting ??= start().finally(() => {
      starting = undefined
    })
    return await starting
  }

  /** One build on one worker, or `again` when another's cancel ended it. */
  const buildOn = async (
    running: Running,
    request: EngineRequest,
    session: EngineSession
  ): Promise<EngineBuild | 'again'> => {
    const { signal, onProgress } = session
    const id = next++
    let canceled = false
    let again = false
    const stop = (): void => {
      canceled = true
      cancelOn(running, id)
    }
    signal?.addEventListener('abort', stop, { once: true })
    const text = await new Promise<string | null>(resolve => {
      running.pending.set(id, {
        settle: resolve,
        again: () => {
          again = true
          resolve(null)
        },
        progress: event => {
          const read = readEvent(event)
          if (read == null) return
          onProgress?.(read)
          if (read.kind === 'limit')
            answerLimit(read, session)
              .then(choice => {
                if (canceled || !running.pending.has(id)) return
                if (choice === 'cancel') stop()
                else running.worker.postMessage({ type: 'decide', id, choice })
              })
              .catch(() => undefined)
        }
      })
      running.worker.postMessage({
        type: 'build',
        id,
        request: JSON.stringify(wireRequest(request))
      })
    }).finally(() => {
      signal?.removeEventListener('abort', stop)
    })
    if (canceled) return CANCELED
    if (again) return 'again'
    // A build runs only on a worker that sent `ready`, so one that fails
    // under it is `broken`, with its reason when it gave one: a build too
    // large for this device, or a worker that died without a word, is told
    // from a browser that cannot build, which never loads (`noSolver`).
    if (text == null)
      return failure(
        'broken',
        running.reason == null
          ? REASONS.worker
          : `${REASONS.worker}: ${running.reason}`
      )
    return readResult(text, request.input)
  }

  const build = async (
    request: EngineRequest,
    session: EngineSession = {}
  ): Promise<EngineBuild> => {
    const { signal } = session
    // Read afresh each time: the abort may come while the worker loads.
    const aborted = (): boolean => signal?.aborted === true
    if (aborted()) return CANCELED
    // A build whose worker was ended for another's cancel starts again.
    for (;;) {
      const running = await worker()
      if (typeof running === 'string')
        return failure(
          running === 'fetchFailed' ? 'broken' : 'noSolver',
          REASONS[running]
        )
      // Ended while this build waited for it to load: start another.
      if (running !== current) continue
      if (aborted()) {
        // A worker loaded for this build alone goes with it; one that other
        // builds are using keeps them.
        if (running.pending.size === 0) end(running, null)
        return CANCELED
      }
      const answer = await buildOn(running, request, session)
      if (answer !== 'again') return answer
    }
  }

  return { build, status: () => status }
}

const page = webEngine()

/**
 * Builds a run's schedule options in this page's worker: up to three
 * options, the recommended one first; the blocking cause when no new game
 * fits; or a typed failure, `noSolver` when this browser cannot run it.
 */
export async function buildSchedule(
  request: EngineRequest,
  session?: EngineSession
): Promise<EngineBuild> {
  return await page.build(request, session)
}

export function engineStatus(): EngineStatus {
  return page.status()
}
