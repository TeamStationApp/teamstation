import type { VideoSummary } from '../../common/api'

/** How many cameras the TV plays at once: each is a native decoder. */
export const MOUNTED_CAMERAS = 4

/** A single camera's recording or stream that can be played. */
export function selectableCamera(video: VideoSummary): boolean {
  return (
    video.numCameras <= 1 &&
    video.durationSec !== 0 &&
    (video.status === 'ready' || video.status === 'live')
  )
}

/**
 * The cameras to open first, at most `limit`, in the game's order: live ones
 * before recordings, and the newest of each, so a game with many earlier
 * recordings still opens on what is being filmed now.
 */
export function openingCameras(
  videos: readonly VideoSummary[],
  limit = MOUNTED_CAMERAS
): VideoSummary[] {
  const order = new Map(videos.map((video, i) => [video.id, i]))
  // Unknown starts sort before every known one (oldest).
  const startOf = (video: VideoSummary): number => {
    const start = Date.parse(video.startAt ?? '')
    return Number.isFinite(start) ? start : Number.MIN_SAFE_INTEGER
  }
  const newestFirst = (a: VideoSummary, b: VideoSummary): number => {
    const live = Number(b.status === 'live') - Number(a.status === 'live')
    if (live !== 0) return live
    const start = startOf(b) - startOf(a)
    return start !== 0 ? start : order.get(b.id)! - order.get(a.id)!
  }
  const chosen = new Set([...videos].sort(newestFirst).slice(0, limit))
  return videos.filter(video => chosen.has(video))
}

/**
 * The player a camera chosen in the panel takes over when every player is in
 * use: one not on screen, then one with nothing to show at this moment, then
 * the last picture on screen that is not enlarged.
 */
export function replacedSlot(slots: {
  count: number
  visible: readonly number[]
  full: number | null
  showing: (slot: number) => boolean
}): number {
  const all = Array.from({ length: slots.count }, (_, i) => i)
  return (
    all.find(i => !slots.visible.includes(i)) ??
    all.find(i => i !== slots.full && !slots.showing(i)) ??
    [...slots.visible].reverse().find(i => i !== slots.full) ??
    slots.count - 1
  )
}
