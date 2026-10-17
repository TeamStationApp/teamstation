import {
  type WallAnchor,
  wallAt,
  type WallTimeline
} from '../../../common/wallTimeline'
import { type AngleVideo, wallAt as startWallAt } from '../wallClock'

export { wallAt }

/**
 * A player's side of a video's wall-clock timeline: what it has been sent,
 * grown by what a live stream adds, and read at the frame on screen.
 *
 * The server answers points `[mediaMs, wallMs]` (`common/wallTimeline.ts`);
 * between them, and past the last, a video runs at 1×. So a live stream's
 * clock keeps going between polls, and after a publisher's outage the one
 * segment drawn before the next poll is drawn as if no time had passed, and
 * is put right by it.
 */

/**
 * The timeline after a poll for the points after the last one held: the new
 * points appended, and whether it is still live taken from the answer.
 *
 * A timeline held from the video's start is no point of the stream's own,
 * only a stand-in until one is stored, so it is never added to: the poll
 * asked for the whole timeline (`pollAfter`), and that answer replaces it.
 * Otherwise the stream's first point, which is at media time zero, would be
 * left out as no later than the stand-in's.
 */
export function appendPoll(
  held: WallTimeline,
  polled: WallTimeline
): WallTimeline {
  if (held.source === 'start') return polled
  const last = held.anchors.at(-1)?.[0] ?? Number.NEGATIVE_INFINITY
  const added = polled.anchors.filter(([mediaMs]) => mediaMs > last)
  return {
    ...polled,
    anchors: added.length === 0 ? held.anchors : [...held.anchors, ...added]
  }
}

/**
 * Where to ask for more points from: just after the last one held, or from
 * the beginning while what is held is only the video's start.
 */
export function pollAfter(timeline: WallTimeline): number | undefined {
  if (timeline.source === 'start') return undefined
  return timeline.anchors.at(-1)?.[0]
}

/**
 * The wall-clock instant a video's timeline starts at: where the board
 * timeline a player asks for begins. Null with no points.
 */
export function windowStart(timeline: WallTimeline | null): number | null {
  if (timeline == null) return null
  return wallAt(timeline.anchors, 0)
}

/** A video as `timeFrame` reads it. */
export interface FramedVideo {
  live: boolean
  /** Its wall timeline, or nothing while it has not arrived or never will. */
  timeline: WallTimeline | null | undefined
  /** Its length as the server has it, or nothing while it does not. */
  durationSec: number | null | undefined
}

/**
 * The wall-clock time frame some videos cover together, from the earliest
 * start to the latest end, `toMs` Infinity while any of them is live; null
 * while none of them can say. A video in this player shows the board from
 * its first frame when the game has an event in this frame.
 *
 * Only a live video is open-ended. A recording counts once it is placed: its
 * timeline has a point and the server has its length. One that is not yet,
 * or never will be, adds nothing, rather than an open end: counted as open,
 * warm-up footage would show a board, and a board shown is kept. Each
 * arrival can only widen the frame.
 */
export function timeFrame(
  videos: readonly FramedVideo[]
): { fromMs: number; toMs: number } | null {
  let fromMs = Number.POSITIVE_INFINITY
  let toMs = Number.NEGATIVE_INFINITY
  let open = false
  for (const video of videos) {
    const live = video.live || video.timeline?.live === true
    if (live) open = true
    const timeline = video.timeline ?? null
    const start = windowStart(timeline)
    if (timeline == null || start == null) continue
    if (!live) {
      if (video.durationSec == null) continue
      const end = wallAt(timeline.anchors, video.durationSec * 1000)
      if (end == null) continue
      toMs = Math.max(toMs, end)
    }
    fromMs = Math.min(fromMs, start)
  }
  if (fromMs === Number.POSITIVE_INFINITY) return null
  return { fromMs, toMs: open ? Number.POSITIVE_INFINITY : toMs }
}

/**
 * The server-clock instant of `atSec` into one angle of a grid: from its own
 * wall timeline where it has one, and from its start otherwise, as the grid
 * itself places it (`wallClock.ts`). Null when neither can say.
 */
export function angleWallMs(
  video: AngleVideo,
  timeline: WallTimeline | undefined,
  atSec: number
): number | null {
  const anchors: readonly WallAnchor[] = timeline?.anchors ?? []
  if (anchors.length > 0) return wallAt(anchors, atSec * 1000)
  return startWallAt(video, atSec)
}
