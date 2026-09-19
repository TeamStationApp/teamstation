/**
 * How a worker stops.
 *
 * A stop has three waits in it, and every one of them can hang: idle
 * keep-alive sockets that no browser is using, a request still in flight, and
 * the database pool, which does not come back until every client checked out
 * of it has been handed back. Each wait used to be unbounded, so one wedged
 * client held the worker past the primary's patience; the primary then
 * SIGKILLed it and exited non-zero, and an ordinary deploy was recorded as a
 * failed service.
 *
 * So the waits are bounded and the worker always leaves under its own power,
 * before the primary's deadline. Where it had got to is named in the log,
 * because the only thing the old behaviour reported was the time it gave up.
 */

/** The part of `http.Server` a stop uses. */
export interface StoppableServer {
  close: (done: () => void) => void
  closeIdleConnections: () => void
  closeAllConnections: () => void
}

/** Where a stop had got to, in the words the log uses. */
export type StopStage =
  | 'closing idle connections'
  | 'waiting for open requests'
  | 'closing the database'
  | 'done'

export interface StopWorkerOptions {
  server: StoppableServer
  /** Ends the database pool. Rejecting is not a reason to stay. */
  destroyDatabase: () => Promise<unknown>
  /** When to stop waiting for requests and cut the connections under them. */
  cutConnectionsMs: number
  /** When to go regardless of which wait is still outstanding. */
  deadlineMs: number
  exit: (code: number) => void
  log: (message: string) => void
}

/**
 * Stops `server`, then the database, then exits. Returns a function reporting
 * the stage reached, which is for the tests: nothing else needs to ask.
 */
export function stopWorker(options: StopWorkerOptions): () => StopStage {
  const { server, destroyDatabase, cutConnectionsMs, deadlineMs, exit, log } =
    options

  let stage: StopStage = 'closing idle connections'
  let cut: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let left = false

  // One way out, however we get here, and always zero: the worker was asked to
  // stop and it stopped. A pool that would not close is worth a line in the
  // log, not a service marked failed.
  //
  // Both timers are cleared rather than unreferenced, so the deadline is
  // certain to fire while a wait is outstanding and certain not to outlive one
  // that finished.
  const leave = (): void => {
    if (left) return
    left = true
    clearTimeout(cut)
    clearTimeout(deadline)
    stage = 'done'
    exit(0)
  }

  // An idle keep-alive socket is not work. A browser leaves one open for
  // minutes after the page has finished loading, and `close` waits for it like
  // any other connection, so closing them is what lets an idle worker stop at
  // once rather than sitting out the whole budget.
  server.closeIdleConnections()

  // Requests that were already running get until here to finish. After that
  // the connection under them goes, which is what lets `close` call back.
  cut = setTimeout(() => {
    stage = 'waiting for open requests'
    server.closeAllConnections()
  }, cutConnectionsMs)

  // The backstop. Whichever wait is outstanding, the worker leaves here, and
  // the line it writes names the wait — so the next time this happens the log
  // says which of the three it was instead of only that time ran out.
  deadline = setTimeout(() => {
    log(`stop deadline passed while ${stage}; going anyway`)
    leave()
  }, deadlineMs)

  server.close(() => {
    clearTimeout(cut)
    stage = 'closing the database'
    destroyDatabase().then(leave, error => {
      log(`the database pool did not close: ${String(error)}`)
      leave()
    })
  })

  return () => stage
}
