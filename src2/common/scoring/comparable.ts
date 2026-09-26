import { copyState } from './state'

/**
 * A play as it can be compared with one the server stored: without the times
 * it was scored at, the half's outs the server writes onto its last play, the
 * team a credit is filed under, which the server rewrites from `home` or
 * `away` to a team id, and the `source` the server does not keep. Nothing
 * else changes. Server code compares with it too, so it lives beside the
 * library rather than in a test.
 */
export function comparablePlay<T>(play: T): T {
  if (play == null) return play
  const copy = copyState(play) as Record<string, unknown>
  delete copy.source
  const about = copy.about as Record<string, unknown> | undefined
  if (about != null) {
    delete about.startTime
    delete about.endTime
    delete about.halfOuts
  }
  if (Array.isArray(copy.credits))
    for (const credit of copy.credits as Array<Record<string, unknown>>)
      delete credit.teamId
  return copy as T
}
