/** A child process the primary supervises, and stops on the way down. */
export interface Stoppable {
  stop: (signal?: NodeJS.Signals | string) => Promise<void>
}

/** The work one node does for all of them, from its primary. */
export interface BackgroundJobs<Child extends Stoppable> {
  reopenInterrupted: () => void
  startPurge: () => void
  startDiscardSweep: () => void
  /** Left out of the unclustered path, which has never swept these keys. */
  startKeySweep?: () => void
  startLocalCopyWarnings: () => void
  /**
   * Queues a reminder request for each event start in the window; answers
   * how to stop the sweep and close its queue client.
   */
  startRsvpReminders: () => Stoppable
  /**
   * Records each league admin's daily missing-umpires digest once it is due
   * and queues its push; answers how to stop the sweep and close its queue
   * client.
   */
  startUmpireDigests: () => Stoppable
  startChatAttachmentPurge: () => void
  startChatReconciler: () => void
  startRosterBumpPrune: () => void
  /**
   * The sponsor sweeps (`sponsors/sweeps.ts`), once a node: answers how to
   * stop their timers and close their own scoreboard store's connection.
   */
  startSponsorSweeps: () => Stoppable
  /** Forks and supervises the push sender (`push/sender/start.ts`). */
  startPushSender: () => Child
  startStatsBuilder: () => Child
}

/**
 * Starts this path's jobs where `backgroundJobs` is on, and none of them where
 * it is off. Answers what to stop on the way down, the reminder sweep, the
 * umpire digest sweep, the sponsor sweeps, the push sender and the stats
 * builder at once, or `off` in its place. Each job drains on start, so
 * whatever a node missed while it was away waits for it to return.
 */
export function startBackgroundJobs<Child extends Stoppable>(
  enabled: boolean,
  jobs: BackgroundJobs<Child>,
  off: Stoppable,
  log: (message: string) => void
): Stoppable {
  if (!enabled) {
    log('background jobs are switched off (backgroundJobs is false)')
    return off
  }
  jobs.reopenInterrupted()
  jobs.startPurge()
  jobs.startDiscardSweep()
  jobs.startKeySweep?.()
  jobs.startLocalCopyWarnings()
  const reminders = jobs.startRsvpReminders()
  const digests = jobs.startUmpireDigests()
  jobs.startChatAttachmentPurge()
  jobs.startChatReconciler()
  jobs.startRosterBumpPrune()
  const children = [
    reminders,
    digests,
    jobs.startSponsorSweeps(),
    jobs.startPushSender(),
    jobs.startStatsBuilder()
  ]
  return {
    stop: async signal => {
      await Promise.all(
        children.map(async child => {
          await child.stop(signal)
        })
      )
    }
  }
}

/**
 * A sweep a timer can start as often as it likes: a start while the last
 * one is still running is skipped, so a slow sweep never overlaps itself.
 */
export function skipWhileRunning(sweep: () => Promise<void>): () => void {
  let running = false
  return () => {
    if (running) return
    running = true
    sweep()
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }
}
