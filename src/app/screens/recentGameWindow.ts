/** How long after it started a played game is still Home's recent game. */
export const RECENT_GAME_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Whether a game that started at `startAt` is recent enough for Home's
 * Recent game card: it started, and less than three days ago. A start that
 * is missing, unreadable or still to come is not.
 */
export function recentGameIsCurrent(
  startAt: string | null | undefined,
  now: number
): boolean {
  if (startAt == null) return false
  const started = Date.parse(startAt)
  if (Number.isNaN(started)) return false
  const age = now - started
  return age >= 0 && age < RECENT_GAME_WINDOW_MS
}
