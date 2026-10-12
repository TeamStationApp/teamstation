import { type Kysely, sql } from 'kysely'

import type { WallAnchor, WallTimeline } from '../../common/wallTimeline'
import type { Database } from '../db/database'

/** What the answer needs of the video itself. */
export interface WallTimelineVideo {
  id: string
  status: string
  startAt: Date | string | null
  syncOffsetSec: number
  /** `start_at_clock_offset_ms`: the start was measured onto the server's clock. */
  clockOffsetMs: number | null
}

/** A video's points, summed up: how many, and of what kind. */
export interface AnchorSummary {
  count: number
  /** Every point is a frame's own wall clock. */
  allSei: boolean
  /** Every point was stamped on the server's clock. */
  allCorrected: boolean
}

/**
 * A video's wall-clock timeline, from the points stored for it, or else from
 * its start.
 *
 * `afterMs` leaves out every point at or before it, so a live player that
 * already holds the timeline asks only for what has been added since.
 * `source` and `confidence` describe the whole video whatever it leaves out.
 */
export async function readWallTimeline(
  db: Kysely<Database>,
  video: WallTimelineVideo,
  afterMs?: number
): Promise<WallTimeline> {
  const summary = await db
    .selectFrom('video_wall_anchors')
    .select([
      sql<number>`count(*)::int`.as('count'),
      sql<boolean>`coalesce(bool_and(source = 'sei'), true)`.as('allSei'),
      sql<boolean>`coalesce(bool_and(corrected), true)`.as('allCorrected')
    ])
    .where('video_id', '=', video.id)
    .executeTakeFirstOrThrow()
  let query = db
    .selectFrom('video_wall_anchors')
    .select(['media_ms as mediaMs', 'wall'])
    .where('video_id', '=', video.id)
    .orderBy('media_ms')
  if (afterMs != null) query = query.where('media_ms', '>', afterMs)
  const stored =
    summary.count === 0
      ? []
      : (await query.execute()).map((row): WallAnchor => [
          row.mediaMs,
          new Date(row.wall).getTime()
        ])
  return wallTimelineOf(video, summary, stored, afterMs)
}

/**
 * The answer, from the summary and the points already read.
 *
 * | Points                    | `source`  | `confidence`  |
 * | ------------------------- | --------- | ------------- |
 * | SEI, all corrected        | `sei`     | `frame`       |
 * | SEI, any uncorrected      | `sei`     | `approximate` |
 * | Arrival (any at all)      | `arrival` | `approximate` |
 * | None, offset recorded     | `start`   | `clock`       |
 * | None, no offset           | `start`   | `approximate` |
 *
 * With no points, the one point is the video's start: media time zero at
 * `start_at` less the angle's sync offset, which is where the multi-camera
 * view already puts it. A video with no `start_at` has no point at all.
 */
export function wallTimelineOf(
  video: WallTimelineVideo,
  summary: AnchorSummary,
  stored: WallAnchor[],
  afterMs?: number
): WallTimeline {
  const startAt =
    video.startAt == null ? null : new Date(video.startAt).toISOString()
  const live = video.status === 'live'
  if (summary.count > 0) {
    const sei = summary.allSei
    return {
      anchors: stored,
      source: sei ? 'sei' : 'arrival',
      confidence: sei && summary.allCorrected ? 'frame' : 'approximate',
      live,
      startAt
    }
  }
  // The start's point is at media time zero, so any `afterMs` has it already.
  const anchors: WallAnchor[] =
    startAt == null || afterMs != null
      ? []
      : [[0, Date.parse(startAt) - video.syncOffsetSec * 1000]]
  return {
    anchors,
    source: 'start',
    confidence:
      startAt != null && video.clockOffsetMs != null ? 'clock' : 'approximate',
    live,
    startAt
  }
}
