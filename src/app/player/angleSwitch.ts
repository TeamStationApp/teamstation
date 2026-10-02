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

export type { AngleVideo } from './wallClock'

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
  const wallMs = wallAt(from, atSec)
  const there = wallMs == null ? null : secondsAt(to, wallMs)
  const target = there ?? atSec

  if (target < 0) return 0
  if (to.durationSec != null && target > to.durationSec) return to.durationSec
  return target
}
