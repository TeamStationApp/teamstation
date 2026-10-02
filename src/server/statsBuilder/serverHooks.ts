/**
 * How the API process starts and waits for the stats builder.
 *
 * Kept out of `index.ts` because importing that file starts the server, and
 * tests cannot load it. `index.ts` only calls these.
 */

export interface StatsBuilderHandle {
  stop: (signal?: NodeJS.Signals | string) => Promise<void>
}

export interface StartStatsBuilderOptions {
  enabled: boolean
  /** Called when enabled; returns the running supervisor. */
  supervise: () => StatsBuilderHandle
  log: (message: string) => void
}

/**
 * Starts the supervised builder, or a no-op when `statsBuilder` is false.
 */
export function startStatsBuilder(
  options: StartStatsBuilderOptions
): StatsBuilderHandle {
  if (!options.enabled) {
    options.log('stats builder is switched off (statsBuilder is false)')
    return {
      stop: async () => undefined
    }
  }
  return options.supervise()
}

/**
 * An `exit` that waits for a graceful builder stop before leaving.
 */
export function exitAfterBuilder(
  builder: StatsBuilderHandle,
  exit: (code: number) => void
): (code: number) => void {
  return (code: number) => {
    builder.stop('SIGTERM').then(
      () => {
        exit(code)
      },
      (error: unknown) => {
        console.error('stats builder: stop failed', error)
        exit(code)
      }
    )
  }
}

/** How long forceStop waits for the child exit before leaving anyway. */
export const FORCE_STOP_DEADLINE_MS = 2_000

/**
 * An `exit` that asks the supervisor to stop, then leaves.
 * A stop already in progress keeps its first signal; the supervisor's own
 * timer is what escalates that stop to SIGKILL. This deadline only bounds
 * how long we wait before leaving anyway.
 */
export function forceStop(
  builder: StatsBuilderHandle,
  exit: (code: number) => void,
  deadlineMs: number = FORCE_STOP_DEADLINE_MS
): (code: number) => void {
  return (code: number) => {
    const timedOut = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, deadlineMs)
      if (typeof timer === 'object' && timer != null && 'unref' in timer) {
        timer.unref()
      }
    })
    const leave = (): void => {
      exit(code)
    }
    Promise.race([
      builder.stop('SIGKILL').catch((_error: unknown) => undefined),
      timedOut
    ]).then(leave, leave)
  }
}
