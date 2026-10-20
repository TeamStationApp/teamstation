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

import type { WallMapping } from './wallMapping'

export interface AngleVideo {
  /** When the recording started, in wall-clock time. Null when unknown. */
  startAt: string | null
  syncOffsetSec: number
  durationSec: number | null
  /**
   * The player's own mapping onto the wall clock, when it has a better one
   * than the start time: the stream's program date-times, or the server's
   * wall timeline (`wallMapping.ts`). Read afresh at every conversion, since
   * a live playlist's grows. Without it, or where it cannot say, the start
   * time and the sync offset place the recording.
   */
  clock?: () => WallMapping | null
}

/** Where a lone recording with no start of its own is put: its own media time. */
export const MEDIA_AXIS_START = new Date(0).toISOString()

/**
 * The angles, with a lone one that has no start put on its own media-time
 * axis: zero at the epoch, so its wall time is `sec·1000`.
 *
 * A recording with no start cannot be placed beside another, and with two or
 * more angles it stays unplaceable. Alone there is nothing to place it beside,
 * and it is watched as itself: the take is `[0, durationSec·1000]`, the bar
 * and a drag scrub it, and a moment converts back to the same seconds. No
 * board step falls at the epoch, so it has no board.
 */
export function placedAlone<T extends AngleVideo>(videos: T[]): T[] {
  if (videos.length !== 1 || startMs(videos[0]) != null) return videos
  return [{ ...videos[0], startAt: MEDIA_AXIS_START, syncOffsetSec: 0 }]
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
  const mapped = video.clock?.()?.wallAt(atSec)
  if (mapped != null) return mapped
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
  const mapped = video.clock?.()?.secAt(wallMs)
  if (mapped != null) return mapped
  const start = startMs(video)
  if (start == null) return null
  return (wallMs - start) / 1000 + video.syncOffsetSec
}

/** When a recording stopped, as an instant. Null while it is still running. */
export function endMs(video: AngleVideo): number | null {
  if (startMs(video) == null || video.durationSec == null) return null
  return wallAt(video, video.durationSec)
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
    // Where its first picture is on the wall, by its mapping if it has one.
    const start = startMs(video) == null ? null : wallAt(video, 0)
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

/**
 * Where to put a recording back for the wall time the full-screen player had
 * reached: its position at that instant, kept inside the recording, which
 * may have started after it or stopped before it. `durationSec` is the
 * player's own length, when it knows it.
 */
export function resumeSecondsAt(
  video: AngleVideo | undefined,
  wallMs: number | undefined,
  durationSec: number
): number {
  if (video == null || wallMs == null) return 0
  const at = secondsAt(placedAlone([video])[0], wallMs) ?? 0
  const end =
    Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : (video.durationSec ?? Number.POSITIVE_INFINITY)
  return Math.min(Math.max(at, 0), end)
}
