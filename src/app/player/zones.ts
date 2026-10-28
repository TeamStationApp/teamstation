/**
 * What a press does: the actions, the hold, and the ten-second step, shared
 * by the press grid (`pressGrid.ts`) and the keyboard.
 */
import { seekTo } from './explicitSeek'
import type { VideoHandle } from './videoHandle'

export type Zone = 'seekBack' | 'seekForward' | 'toggle'

/** What a press ends up doing: a zone's own action, or the crawl. */
export type GestureAction = Zone | 'slowForward'

/**
 * What a tap and what a hold do on each square.
 *
 * A tap is the square's own action. A hold is slow motion on the +10 s square
 * only — the finger is already where the eye is following the play, and the
 * crawl lasts exactly as long as it stays down — and nothing anywhere else, so
 * a press that lingers on the picture does not pause it when the finger lifts.
 * There is no crawl backwards.
 */
export function gestureAction(
  zone: Zone,
  kind: 'tap' | 'hold'
): GestureAction | null {
  if (kind === 'tap') return zone
  return zone === 'seekForward' ? 'slowForward' : null
}

/** A press, or the Right arrow, becomes a hold at half a second. */
export const HOLD_MS = 500

/**
 * How far a press may wander, as a share of the screen's width, and still be
 * held still; one that goes further before `HOLD_MS` is a drag.
 */
export const STILL_FRACTION = 0.05

/**
 * How far a finger may slip, in pixels, and still have made a tap.
 *
 * Every touch tap carries a pixel or two, so a press that moved less than
 * this is the ordinary tap rather than the odd one; one that moved further is
 * a drag, on a tile or on the black around them alike.
 */
export const TAP_SLOP_PX = 8

/** Whether a finger has moved this far from where it came down. */
export function beyondSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) >= TAP_SLOP_PX || Math.abs(dy) >= TAP_SLOP_PX
}

/** How far a tap on the sides, or an arrow key, moves. */
export const STEP_SECONDS = 10

/** Seek, clamped, without changing whether it is playing. */
export function seekBy(video: VideoHandle, delta: number): void {
  const duration = Number.isFinite(video.duration)
    ? video.duration
    : video.currentTime + Math.max(0, delta)
  const next = video.currentTime + delta
  seekTo(video, Math.min(Math.max(0, next), duration))
}
