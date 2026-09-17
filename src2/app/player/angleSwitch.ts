/**
 * Where you are in one recording, in another recording of the same game.
 *
 * Today our two recordings of a game start together, so copying the position
 * across would work. That will not always be true, so the app does not assume
 * it: the position becomes a wall-clock instant and then a position in the
 * other video.
 *
 * The arithmetic is the inverse of the highlights', deliberately. That file
 * defines an offset as
 *
 *     offset = (wallMs − videoStartMs) / 1000 + syncOffsetSec
 *
 * and two places computing "the same moment" differently is a bug that hides:
 * get the sign of `syncOffsetSec` wrong and it lands out by twice the
 * correction, which on a well-synced pair looks like a rounding error and
 * never gets fixed.
 */

export interface AngleVideo {
  /** When the recording started, in wall-clock time. Null when unknown. */
  startAt: string | null
  syncOffsetSec: number
  durationSec: number | null
}

/**
 * The position in `to` that is the same instant as `atSec` in `from`.
 *
 * Falls back to the position unchanged when either side has no start — the
 * same-instant assumption, made explicitly rather than by accident — and
 * clamps into the other recording, which may have started later or stopped
 * earlier than the moment being asked for.
 */
export function sameMoment(
  from: AngleVideo,
  to: AngleVideo,
  atSec: number
): number {
  const fromStart = from.startAt == null ? null : Date.parse(from.startAt)
  const toStart = to.startAt == null ? null : Date.parse(to.startAt)

  let target: number
  if (
    fromStart == null ||
    toStart == null ||
    Number.isNaN(fromStart) ||
    Number.isNaN(toStart)
  ) {
    target = atSec
  } else {
    const wallMs = fromStart + (atSec - from.syncOffsetSec) * 1000
    target = (wallMs - toStart) / 1000 + to.syncOffsetSec
  }

  if (target < 0) return 0
  if (to.durationSec != null && target > to.durationSec) return to.durationSec
  return target
}
