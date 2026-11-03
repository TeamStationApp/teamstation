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
export function targetTime(
  timeline: WallTimeline,
  wall: number,
  duration: number
): { seconds: number; available: boolean } | null {
  const media = mediaAt(timeline.anchors, wall)
  if (media === null) return null
  const seconds = media / 1000
  return {
    seconds: Math.max(0, Math.min(duration, seconds)),
    available: seconds >= 0 && seconds < duration
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
