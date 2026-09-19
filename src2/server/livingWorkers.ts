/**
 * Which workers are still running.
 *
 * `cluster.workers` is not a count of what is alive. An entry is kept until
 * the worker's IPC channel has closed, and that can happen after the process
 * itself has exited — so during a stop the primary can hold four entries for
 * four processes that have all gone. Asking each entry whether it is dead is
 * the question with one answer.
 *
 * The primary used to decide it was finished by finding `cluster.workers`
 * empty at the moment a worker exited. That is one edge, and a stop that
 * missed it had nothing left to try: every worker was gone, no further exit
 * was coming, and the primary waited out its whole force budget over an empty
 * process table before killing nothing and exiting non-zero.
 */

/** The part of a cluster worker this asks about. */
export interface MortalWorker {
  isDead: () => boolean
}

export function livingWorkers<T extends MortalWorker>(
  workers: Record<string, T | undefined> | undefined
): T[] {
  return Object.values(workers ?? {}).filter(
    (worker): worker is T => worker != null && !worker.isDead()
  )
}
