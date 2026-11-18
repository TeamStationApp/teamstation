import { endsAt } from '../../common/nextGame'

const QUIET_END_DELAY_MS = 10 * 60 * 1000

interface QuietStream {
  state: string
  lastReceivedAt: number | null
  opensAt: Date | string
  gameStartAt: Date | string | null
  gameEndAt: Date | string | null
}

/** Older snapshots use their last publish once, until the byte clock is saved. */
export function streamReceivedAt(
  status: unknown,
  lastPublishedAt: Date | string | null
): number | null {
  const received = (status as { ingress?: { lastReceivedAt?: unknown } } | null)
    ?.ingress?.lastReceivedAt
  if (received === undefined)
    return lastPublishedAt == null ? null : new Date(lastPublishedAt).getTime()
  return received === null || typeof received === 'number' ? received : NaN
}

/** Eligibility only: the controller also observes bytes and queued ingest work. */
export function quietStreamCanEnd(row: QuietStream, now: Date): boolean {
  const deadline = quietStreamEndsAt(row)
  return deadline != null && now.getTime() >= deadline
}

/** Ten minutes without bytes, and strictly after the effective game end. */
export function quietStreamEndsAt(row: QuietStream): number | undefined {
  if (row.state !== 'idle' && row.state !== 'publishing') return undefined
  const quietSince = row.lastReceivedAt ?? new Date(row.opensAt).getTime()
  const gameEnd = endsAt({
    startAt: isoOf(row.gameStartAt),
    endAt: isoOf(row.gameEndAt)
  })
  const deadline = Math.max(quietSince + QUIET_END_DELAY_MS, gameEnd + 1)
  return Number.isFinite(deadline) ? deadline : undefined
}

function isoOf(value: Date | string | null): string | null {
  if (!(value instanceof Date)) return value
  return Number.isNaN(value.getTime()) ? '' : value.toISOString()
}
