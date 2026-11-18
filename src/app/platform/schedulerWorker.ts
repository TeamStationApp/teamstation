/**
 * The web's scheduler: a worker the page starts only when it builds a
 * schedule (`src/common/scheduler/engine.web.ts`), running the C++ engine and
 * HiGHS as our own WebAssembly (`scripts/schedulerBuild.mjs wasm`). The page
 * fetches the module, checks its integrity and posts its bytes here first;
 * the worker instantiates them through Emscripten's `instantiateWasm`, so it
 * fetches nothing itself. The glue (`createSchedulerModule`) is the first
 * thing in this worker's bundle (`src/build.mjs`). Each build then comes as
 * the request's JSON and goes back as the result's, with each event the
 * engine reports on the way. At the time limit the build waits, through
 * Asyncify, for the page's `decide` message; builds therefore run one at a
 * time, each after the one before has answered. A module that traps (out
 * of memory) answers `failed`: the page drops this worker and starts
 * another for the next build.
 */

export type SchedulerRequest =
  | { type: 'init'; bytes: ArrayBuffer }
  | { type: 'build'; id: number; request: string }
  | { type: 'decide'; id: number; choice: 'continue' | 'use' | 'cancel' }

export type SchedulerReply =
  | { type: 'ready' }
  | { type: 'failed'; reason: string }
  | { type: 'progress'; id: number; event: string }
  | { type: 'result'; id: number; result: string }

type Post = (reply: SchedulerReply) => void

/** What the glue's module offers this worker, and the hooks the engine calls. */
export interface SchedulerModule {
  stringToNewUTF8: (text: string) => number
  UTF8ToString: (pointer: number) => string
  /** `scheduler_build` through Asyncify: a promise when the build pauses. */
  ccall: (
    name: 'scheduler_build',
    returns: 'number',
    args: ['number'],
    values: [number],
    options: { async: true }
  ) => number | Promise<number>
  _scheduler_free: (answer: number) => void
  _free: (pointer: number) => void
  /** Each event of the running build, as the engine's JSON. */
  onSchedulerEvent?: (event: string) => void
  /** The answer at the time limit: 0 continue, 1 use, 2 cancel. */
  schedulerDecide?: () => Promise<number>
}

const CHOICES: Record<string, number> = { continue: 0, use: 1, cancel: 2 }

export type SchedulerLoader = (options: object) => Promise<SchedulerModule>

declare const createSchedulerModule: SchedulerLoader | undefined

/** An `ArrayBuffer` from any realm, as a posted one may come from another. */
const isBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/** The answer for a build the worker cannot run: no module yet. */
const NOT_LOADED = JSON.stringify({
  kind: 'failure',
  failure: 'noSolver',
  message: 'The scheduler module is not loaded'
})

/** The glue this bundle carries, or nothing outside a built worker. */
function bundledLoader(): SchedulerLoader | undefined {
  return typeof createSchedulerModule === 'function'
    ? createSchedulerModule
    : undefined
}

/** One worker's state: the loaded module, once the page has posted it. */
export function schedulerWorker(
  load: SchedulerLoader | undefined = bundledLoader()
): {
  answer: (request: unknown, post: Post) => Promise<void>
} {
  let module: SchedulerModule | undefined
  /** The build running now, which events and decisions belong to. */
  let running: number | undefined
  /** The paused build's wait for its answer, or an answer said early. */
  let waiting: ((choice: number) => void) | undefined
  let early: number | undefined
  /** Builds in turn: Asyncify runs one at a time. */
  let queue: Promise<void> = Promise.resolve()
  const answer = async (request: unknown, post: Post): Promise<void> => {
    const message = request as {
      type?: unknown
      id?: unknown
      bytes?: unknown
      request?: unknown
      choice?: unknown
    } | null
    if (message?.type === 'decide') {
      const choice = CHOICES[String(message.choice)]
      if (message.id !== running || choice == null) return
      if (waiting == null) early = choice
      else {
        const resolve = waiting
        waiting = undefined
        resolve(choice)
      }
      return
    }
    if (message?.type === 'init' && isBuffer(message.bytes)) {
      const bytes: ArrayBuffer = message.bytes
      if (load == null) {
        post({ type: 'failed', reason: 'No scheduler glue in this worker' })
        return
      }
      try {
        module = await load({
          // Only a name for the glue to hold: the bytes come from the page.
          locateFile: () => 'scheduler.wasm',
          instantiateWasm: (
            imports: WebAssembly.Imports,
            done: (instance: WebAssembly.Instance) => void
          ) => {
            // A module that will not instantiate (WebAssembly blocked, or
            // no memory) never calls `done`: the page hears so at once.
            WebAssembly.instantiate(bytes, imports).then(
              result => {
                done(result.instance)
              },
              (error: unknown) => {
                post({ type: 'failed', reason: String(error) })
              }
            )
            return {}
          }
        })
        post({ type: 'ready' })
      } catch (error) {
        post({ type: 'failed', reason: String(error) })
      }
      return
    }
    if (
      message?.type !== 'build' ||
      typeof message.id !== 'number' ||
      typeof message.request !== 'string'
    )
      return
    const { id } = message
    const text = message.request
    const turn = queue.then(async () => {
      await build(id, text, post)
    })
    queue = turn
    await turn
  }

  const build = async (
    id: number,
    request: string,
    post: Post
  ): Promise<void> => {
    const loaded = module
    if (loaded == null) {
      post({ type: 'result', id, result: NOT_LOADED })
      return
    }
    running = id
    early = undefined
    loaded.onSchedulerEvent = event => {
      post({ type: 'progress', id, event })
    }
    loaded.schedulerDecide = async () => {
      if (early != null) {
        const choice = early
        early = undefined
        return choice
      }
      return await new Promise<number>(resolve => {
        waiting = resolve
      })
    }
    let text: string
    try {
      const pointer = loaded.stringToNewUTF8(request)
      let answered = 0
      try {
        answered = await loaded.ccall(
          'scheduler_build',
          'number',
          ['number'],
          [pointer],
          { async: true }
        )
      } finally {
        loaded._free(pointer)
      }
      if (answered === 0) throw new Error('The scheduler ran out of memory')
      text = loaded.UTF8ToString(answered)
      loaded._scheduler_free(answered)
    } catch (error) {
      // A trap leaves the module unusable: this worker is done.
      module = undefined
      post({ type: 'failed', reason: String(error) })
      return
    } finally {
      running = undefined
      waiting = undefined
    }
    post({ type: 'result', id, result: text })
  }
  return { answer }
}

const scope = globalThis as unknown as {
  WorkerGlobalScope?: unknown
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: Post
}
if (scope.WorkerGlobalScope != null) {
  const { answer } = schedulerWorker()
  scope.onmessage = event => {
    answer(event.data, reply => {
      scope.postMessage(reply)
    }).catch(() => undefined)
  }
}
