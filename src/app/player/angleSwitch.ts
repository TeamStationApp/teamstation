/**
 * Where you are in one recording, in another recording of the same game.
 *
 * Today our two recordings of a game start together, so copying the position
 * across would work. That will not always be true, so the app does not assume
 * it: the position becomes a wall-clock instant and then a position in the
 * other video.
 *
 * The arithmetic itself lives in `wallClock.ts` and is not repeated here. It
 * used to be, with a comment warning that two places computing "the same
 * moment" differently is a bug that hides — and then the multi-camera view
 * needed the same conversion for four recordings at once, which is exactly the
 * second place that comment was afraid of. So there is one conversion, used
 * twice, and the tests beside this file are what hold the two together.
 *
 * What stays here is the *policy* an angle switch wants and the multi-camera
 * view does not: a recording that cannot be placed on the clock copies the
 * position rather than refusing, and a moment outside the other recording
 * lands at its nearest end rather than outside it. Four tiles need the
 * opposite — they have to know a camera was not running yet — which is why
 * `secondsAt` answers honestly and the clamping is done by whoever wants it.
 */

import type { AngleVideo } from './wallClock'
import { secondsAt, wallAt } from './wallClock'
import type { WallMapping } from './wallMapping'

export type { AngleVideo } from './wallClock'

/** Kept inside the recording, which may have started late or stopped early. */
function inside(to: AngleVideo, sec: number): number {
  if (sec < 0) return 0
  if (to.durationSec != null && sec > to.durationSec) return to.durationSec
  return sec
}

/**
 * The wall time the old angle is showing at `atSec`, by the old source's own
 * mapping where it has one (`wallMapping.ts`), by its start otherwise.
 */
export function switchTarget(
  from: AngleVideo,
  fromMapping: WallMapping | null,
  atSec: number
): number | null {
  return fromMapping?.wallAt(atSec) ?? wallAt(from, atSec)
}

/**
 * Where in `to` a wall time falls, by its mapping where it has one, kept
 * inside the recording. A live angle whose newest footage is behind that
 * moment lands on its newest footage instead: the moment has not reached it
 * yet. Null when `to` cannot be placed at all.
 */
export function landingSec(
  to: AngleVideo,
  toMapping: WallMapping | null,
  wallMs: number,
  live = false
): number | null {
  let target = toMapping?.secAt(wallMs) ?? secondsAt(to, wallMs)
  if (target == null) return null
  if (live && toMapping != null) {
    const newest = toMapping.newestWall()
    if (newest != null && wallMs > newest) {
      target = toMapping.secAt(newest) ?? target
    }
  }
  return inside(to, target)
}

/** A recording with no start, which only its own media time places. */
function unplaced(video: AngleVideo, mapping: WallMapping | null): boolean {
  return video.startAt == null || mapping?.source === 'media'
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
  atSec: number,
  mappings: { from?: WallMapping | null; to?: WallMapping | null } = {}
): number {
  const fromMapping = mappings.from ?? null
  const toMapping = mappings.to ?? null
  if (unplaced(from, fromMapping) || unplaced(to, toMapping)) {
    return inside(to, atSec)
  }
  const wallMs = switchTarget(from, fromMapping, atSec)
  const there = wallMs == null ? null : landingSec(to, toMapping, wallMs)
  return there ?? inside(to, atSec)
}
