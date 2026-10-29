/** Both the publisher and the scheduled game must be over by ten minutes. */
const QUIET_END_DELAY_MS = 10 * 60 * 1000

/** Eligibility only: the controller must also check the ingest before ending. */
export function quietStreamCanEnd(
  row: {
    state: string
    lastPublishedAt: Date | string | null
    opensAt: Date | string
    gameEndAt: Date | string | null
  },
  now: Date
): boolean {
  if (row.state !== 'idle' || row.gameEndAt == null) return false
  const quietSince = new Date(row.lastPublishedAt ?? row.opensAt).getTime()
  const gameEnd = new Date(row.gameEndAt).getTime()
  return (
    now.getTime() - quietSince >= QUIET_END_DELAY_MS &&
    now.getTime() - gameEnd >= QUIET_END_DELAY_MS
  )
}
