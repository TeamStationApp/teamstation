import { mediaAt, wallAt, type WallTimeline } from '../../common/wallTimeline'

export { type BoxStep, boxTimeline } from '../../common/replay/videoBoxTimeline'

export function timelineFor(startAt: string | null): WallTimeline {
  const start = Date.parse(startAt ?? '')
  return {
    anchors: Number.isFinite(start) ? [[0, start]] : [],
    source: 'start',
    confidence: 'approximate',
    live: false,
    startAt
  }
}
/**
 * How far past a wall instant a camera's next picture may be and still count
 * as showing it: segment-arrival points jitter by a fraction of a second, and
 * a longer stretch with no picture is a hole in the recording.
 *
 * Wider than the grid's `HOLE_SEC` (`multiCam/align.ts`) on purpose: the grid
 * holds a tile at a hole only past what playback speed closes, while the TV
 * changes no camera's speed and only needs to stay clear of that jitter.
 */
export const HOLE_MS = 2000
/**
 * Where `wall` falls in a camera's media. Inside a hole — the camera's stream
 * dropped out and came back — it is the first picture after it, and not
 * available: that camera has no picture of this moment.
 */
export function targetTime(
  timeline: WallTimeline,
  wall: number,
  duration: number
): { seconds: number; available: boolean } | null {
  const media = mediaAt(timeline.anchors, wall)
  if (media === null) return null
  const seconds = media / 1000
  const shown = wallAt(timeline.anchors, media)
  return {
    seconds: Math.max(0, Math.min(duration, seconds)),
    available:
      seconds >= 0 &&
      seconds < duration &&
      (shown === null || shown - wall <= HOLE_MS)
  }
}
export function commonStart(timelines: WallTimeline[]): number | null {
  const starts = timelines
    .map(t => wallAt(t.anchors, 0))
    .filter((n): n is number => n !== null)
  return starts.length === timelines.length && starts.length > 0
    ? Math.max(...starts)
    : null
}
