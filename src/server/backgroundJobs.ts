/** The work one node does for all of them, from its primary. */
export interface BackgroundJobs<Builder> {
  reopenInterrupted: () => void
  startPurge: () => void
  startDiscardSweep: () => void
  /** Left out of the unclustered path, which has never swept these keys. */
  startKeySweep?: () => void
  startLocalCopyWarnings: () => void
  startChatAttachmentPurge: () => void
  startChatReconciler: () => void
  startRosterBumpPrune: () => void
  startStatsBuilder: () => Builder
}

/**
 * Starts this path's jobs where `backgroundJobs` is on, and none of them where
 * it is off. Answers the builder to stop on the way down, or `off` in its
 * place. Each job drains on start, so whatever a node missed while it was away
 * waits for it to return.
 */
export function startBackgroundJobs<Builder>(
  enabled: boolean,
  jobs: BackgroundJobs<Builder>,
  off: Builder,
  log: (message: string) => void
): Builder {
  if (!enabled) {
    log('background jobs are switched off (backgroundJobs is false)')
    return off
  }
  jobs.reopenInterrupted()
  jobs.startPurge()
  jobs.startDiscardSweep()
  jobs.startKeySweep?.()
  jobs.startLocalCopyWarnings()
  jobs.startChatAttachmentPurge()
  jobs.startChatReconciler()
  jobs.startRosterBumpPrune()
  return jobs.startStatsBuilder()
}
