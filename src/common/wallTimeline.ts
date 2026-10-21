/**
 * A video's wall-clock timeline: where each position in it falls on the
 * server's clock.
 *
 * The server answers it as points, each `[mediaMs, wallMs]`: a position in
 * the video as a player reports it (playlist time, `currentTime` in ms) and
 * the server-clock instant of the frame there. Between points the video runs
 * at 1×, so one point at the start places a recording that never stopped,
 * and a later point is where something moved it: a stream that dropped out
 * and came back, or a frame whose own wall clock says it is somewhere else.
 *
 * Shared by the server, which builds it, and the players, which read the
 * scoreboard at the wall time of the frame on screen.
 */

/** `[mediaMs, wallMs]`, in media order. */
export type WallAnchor = [mediaMs: number, wallMs: number]

/**
 * Where the points came from.
 *
 * - `sei`: a wall clock carried in the frames themselves.
 * - `arrival`: when the server took each live segment in.
 * - `start`: no points; one made from the video's `start_at`.
 */
export type WallSource = 'sei' | 'arrival' | 'start'

/**
 * How far to trust it.
 *
 * - `frame`: every frame's own wall clock, on the server's clock.
 * - `clock`: a start moved onto the server's clock by a measured offset.
 * - `approximate`: anything else: segment arrival, a wall clock stamped
 *   without a measured offset, or a start only as good as the clock that
 *   said it.
 */
export type WallConfidence = 'frame' | 'clock' | 'approximate'

/** `GET /api/v1/videos/:videoId/wall-timeline`. */
export interface WallTimeline {
  anchors: WallAnchor[]
  source: WallSource
  confidence: WallConfidence
  /** Still streaming: more points will follow. */
  live: boolean
  /** The video's `start_at`, ISO 8601, or null when it has none. */
  startAt: string | null
}

/**
 * The server-clock instant of position `mediaMs`, or null with no points.
 *
 * The last point at or before it, plus the media time since, at 1×. A
 * position before the first point runs back from the first point, the
 * same way.
 */
export function wallAt(
  anchors: readonly WallAnchor[],
  mediaMs: number
): number | null {
  if (anchors.length === 0) return null
  // The last anchor at or before `mediaMs`, by halving: a live programme's
  // timeline gains a point every half second for hours.
  let low = 0
  let high = anchors.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (anchors[middle][0] <= mediaMs) low = middle
    else high = middle - 1
  }
  const [anchorMs, wallMs] = anchors[low]
  return wallMs + (mediaMs - anchorMs)
}

/**
 * Where in the media a wall-clock instant falls: the inverse of `wallAt`.
 *
 * Inside an anchored stretch, by its own offset. In a gap between two — the
 * wall clock jumped on while the media did not — at the first picture after
 * the gap, which is the nearest the recording comes to that moment. Before
 * the first anchor, and past the last, by the nearest one's offset.
 */
export function mediaAt(
  anchors: readonly WallAnchor[],
  wallMs: number
): number | null {
  if (anchors.length === 0) return null
  let low = 0
  let high = anchors.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (anchors[middle][1] <= wallMs) low = middle
    else high = middle - 1
  }
  const [anchorMs, anchorWall] = anchors[low]
  const next = anchors[low + 1]
  if (wallMs < anchorWall) return anchorMs + (wallMs - anchorWall)
  if (next != null && anchorMs + (wallMs - anchorWall) >= next[0]) {
    return next[0]
  }
  return anchorMs + (wallMs - anchorWall)
}
