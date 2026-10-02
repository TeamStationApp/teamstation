/**
 * A moment of a game, in wall-clock time, and where it falls in a recording.
 *
 * Every recording of one game has its own idea of zero: a camera switched on
 * late starts at a different instant from the one beside it, and a stream that
 * dropped out and came back does not even run at the same rate as the clock on
 * the wall. So nothing in the multi-camera view is expressed as "the same
 * number of seconds in". Positions are converted to an instant, and instants
 * are converted back, and this file is the only place either conversion is
 * written down.
 *
 * `angleSwitch.ts` warned about exactly this: two places computing "the same
 * moment" differently is a bug that hides, because getting the sign of
 * `syncOffsetSec` wrong lands out by twice the correction, which on a
 * well-synced pair looks like a rounding error and never gets fixed. So that
 * file's `sameMoment` is now built out of the two halves below rather than
 * carrying its own copy of the arithmetic, and its tests are the guard on the
 * split.
 */

export interface AngleVideo {
  /** When the recording started, in wall-clock time. Null when unknown. */
  startAt: string | null
  syncOffsetSec: number
  durationSec: number | null
}

/** The recording's start as an instant, or null when it has none we can read. */
export function startMs(video: AngleVideo): number | null {
  if (video.startAt == null) return null
  const parsed = Date.parse(video.startAt)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The instant `atSec` into this recording, in wall-clock time.
 *
 * Null when the recording cannot be placed on the clock at all, which is a
 * different answer from zero and has to stay distinguishable: a tile that
 * cannot be placed is shown and left alone, not dragged to the start of the
 * game.
 */
export function wallAt(video: AngleVideo, atSec: number): number | null {
  const start = startMs(video)
  if (start == null) return null
  return start + (atSec - video.syncOffsetSec) * 1000
}

/**
 * The position in this recording of a wall-clock instant.
 *
 * Deliberately **unclamped**. A negative answer means the instant is before
 * this camera was switched on, and an answer past the end means it stopped
 * before then; both are things the view has to be able to say, and clamping
 * here would turn them into a frozen frame pretending to be a camera.
 */
export function secondsAt(video: AngleVideo, wallMs: number): number | null {
  const start = startMs(video)
  if (start == null) return null
  return (wallMs - start) / 1000 + video.syncOffsetSec
}

/** When a recording stopped, as an instant. Null while it is still running. */
export function endMs(video: AngleVideo): number | null {
  const start = startMs(video)
  if (start == null || video.durationSec == null) return null
  return start + (video.durationSec - video.syncOffsetSec) * 1000
}

export interface Window {
  fromMs: number
  toMs: number
}

/**
 * The stretch of wall-clock time a set of recordings covers between them.
 *
 * This is the axis the multi-camera scrubber is drawn on, which is what makes
 * a camera that started three minutes late read as a bar that begins three
 * minutes in rather than as an unexplained gap. A recording still in progress
 * has no end of its own, so the caller passes what it knows — the furthest any
 * tile has actually played to.
 */
export function windowOf(
  videos: AngleVideo[],
  liveEdgeMs?: number
): Window | null {
  let fromMs = Number.POSITIVE_INFINITY
  let toMs = Number.NEGATIVE_INFINITY
  for (const video of videos) {
    const start = startMs(video)
    if (start == null) continue
    fromMs = Math.min(fromMs, start)
    const end = endMs(video)
    if (end != null) toMs = Math.max(toMs, end)
  }
  if (liveEdgeMs != null) toMs = Math.max(toMs, liveEdgeMs)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  // A window with no width is not a scrubber, it is a divide by zero.
  if (toMs <= fromMs) return { fromMs, toMs: fromMs + 1000 }
  return { fromMs, toMs }
}
