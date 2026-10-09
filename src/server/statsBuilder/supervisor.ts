import type { ForkOptions } from 'node:child_process'

const INITIAL_DELAY_MS = 1_000
const MAX_DELAY_MS = 60_000
const LIFE_RESET_MS = 60_000
const STOP_KILL_MS = 5_000

/** The part of a forked child the supervisor uses. */
export interface SupervisedChild {
  kill: (signal?: NodeJS.Signals | string) => boolean
  on: (
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ) => unknown
}

export type ForkFn = (
  modulePath: string,
  args: string[],
  options: ForkOptions
) => SupervisedChild

export type Clock = () => Date

export interface SuperviseStatsBuilderOptions {
  fork: ForkFn
  log: (message: string) => void
  clock: Clock
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export interface StatsBuilderSupervisor {
  stop: (signal?: NodeJS.Signals | string) => Promise<void>
}

/**
 * Forks the stats builder and keeps one running until asked to stop.
 *
 * A death it did not ask for is logged and followed by another fork after a
 * delay that starts at 1 s and doubles to 60 s. A child that has lived 60 s
 * resets that delay to 1 s. `stop` sends the signal, waits for the exit, and
 * SIGKILLs after 5 s; a second `stop` returns the same promise.
 */
export function superviseStatsBuilder(
  options: SuperviseStatsBuilderOptions
): StatsBuilderSupervisor {
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout

  let child: SupervisedChild | null = null
  let startedAt: Date | null = null
  let delayMs = INITIAL_DELAY_MS
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let stopPromise: Promise<void> | null = null
  let resolveStop: (() => void) | null = null

  const spawn = (): void => {
    if (stopping) return
    const modulePath = require.resolve('./start')
    child = options.fork(modulePath, [], {
      execArgv: process.execArgv,
      stdio: 'inherit'
    })
    startedAt = options.clock()
    const spawned = child
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      if (killTimer != null) {
        clearTimer(killTimer)
        killTimer = undefined
      }
      if (stopping) {
        resolveStop?.()
        resolveStop = null
        return
      }
      const livedMs =
        startedAt == null ? 0 : options.clock().getTime() - startedAt.getTime()
      if (livedMs >= LIFE_RESET_MS) delayMs = INITIAL_DELAY_MS
      const waitMs = delayMs
      options.log(
        `stats builder: exited (${signal ?? code}), restarting in ${
          waitMs / 1000
        }s`
      )
      delayMs = Math.min(delayMs * 2, MAX_DELAY_MS)
      restartTimer = setTimer(() => {
        restartTimer = undefined
        spawn()
      }, waitMs)
    })
  }

  spawn()

  return {
    // Not async: a second stop must return this same promise, not a wrapper.
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    stop(signal: NodeJS.Signals | string = 'SIGTERM'): Promise<void> {
      if (stopPromise != null) return stopPromise
      stopping = true
      if (restartTimer != null) {
        clearTimer(restartTimer)
        restartTimer = undefined
      }
      stopPromise = new Promise(resolve => {
        resolveStop = resolve
        const current = child
        if (current == null) {
          resolve()
          resolveStop = null
          return
        }
        current.kill(signal)
        if (signal !== 'SIGKILL') {
          killTimer = setTimer(() => {
            killTimer = undefined
            current.kill('SIGKILL')
          }, STOP_KILL_MS)
        }
      })
      return stopPromise
    }
  }
}
