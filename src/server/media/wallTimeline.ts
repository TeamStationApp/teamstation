import { type Kysely, type RawBuilder, sql } from 'kysely'

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

/** A video's points, summed up: whether it has any, and of what kind. */
export interface AnchorSummary {
  /** The video has at least one point. */
  any: boolean
  /** Every point is a frame's own wall clock. */
  allSei: boolean
  /** Every point was stamped on the server's clock. */
  allCorrected: boolean
}

/**
 * The summary, in one statement of three `exists`.
 *
 * Counting or aggregating the points would read every one of them, twenty
 * thousand in a three-hour programme, on each live player's poll every few
 * seconds. Instead the first point on the key says whether there are any,
 * and the two partial indexes of migration 060, which hold only the points
 * that are not a corrected SEI frame, say whether any is not SEI and whether
 * any is uncorrected. The conditions are written as the indexes' own, never
 * as parameters, so the planner can match them.
 */
export async function anchorSummary(
  db: Kysely<Database>,
  videoId: string
): Promise<AnchorSummary> {
  const { rows } = await anchorSummaryQuery(videoId).execute(db)
  const [row] = rows
  return { any: row.any, allSei: row.allSei, allCorrected: row.allCorrected }
}

export function anchorSummaryQuery(videoId: string): RawBuilder<AnchorSummary> {
  return sql<AnchorSummary>`
    select
      exists (
        select 1 from video_wall_anchors where video_id = ${videoId}
      ) as "any",
      not exists (
        select 1 from video_wall_anchors
        where video_id = ${videoId} and source <> 'sei'
      ) as "allSei",
      not exists (
        select 1 from video_wall_anchors
        where video_id = ${videoId} and not corrected
      ) as "allCorrected"`
}

/**
 * A video's wall-clock timeline, from the points stored for it, or else from
 * its start.
 *
 * `afterMs` leaves out every point at or before it, so a live player that
 * already holds the timeline asks only for what has been added since.
 * `source` and `confidence` describe the whole video whatever it leaves out,
 * and cost the same few index pages however many points the video has.
 */
export async function readWallTimeline(
  db: Kysely<Database>,
  video: WallTimelineVideo,
  afterMs?: number
): Promise<WallTimeline> {
  const summary = await anchorSummary(db, video.id)
  let query = db
    .selectFrom('video_wall_anchors')
    .select(['media_ms as mediaMs', 'wall'])
    .where('video_id', '=', video.id)
    .orderBy('media_ms')
  if (afterMs != null) query = query.where('media_ms', '>', afterMs)
  const stored = !summary.any
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
  if (summary.any) {
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
