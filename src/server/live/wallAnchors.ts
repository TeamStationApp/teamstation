import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import {
  type MediaPlaylist,
  parseMediaPlaylist,
  type Placement,
  readPart,
  type ScannedFrame,
  scanSegment,
  thinStamps,
  type VideoTrack,
  videoTrackOf,
  type WallPoint
} from '../media/wallClockScan'
import type { StoredWallPoint } from '../media/wallTimeline'
import { LIVE_PLAYLIST_NAME } from './splitter'

/**
 * A live stream's wall-clock timeline, as it grows.
 *
 * The splitter writes the stream's HLS and is never told about any of this:
 * once a second the controller reads the playlist it writes, and every
 * segment listed there since the last look is read for the frames' own wall
 * clock. A listed segment is whole, because the splitter writes each under a
 * temporary name and lists it once it has been renamed.
 *
 * A stream carrying the SEI (TS Director's programme) gets frame-exact
 * points. Anything else gets one point per segment from when it arrived: late
 * by however long the publisher took to get it here, but right across an
 * outage, which a timeline hung from the start alone is not. Such a point is
 * never early, and never behind the one before it.
 */

/** How far a stream's scan has got. */
export interface ScanCursor {
  /** How many of the playlist's segments have been read. */
  segments: number
  /** Where the next segment starts on the playlist's time. */
  startMs: number
  /** Where the run the last segment was in sits on the playlist. */
  placement?: Placement
  /** The last SEI point kept, which the next segment's thinning carries on from. */
  last?: WallPoint
  /** The newest point of either kind, which an arrival point never goes behind. */
  latest?: { mediaMs: number; wallMs: number }
}

export const SCAN_FROM_START: ScanCursor = { segments: 0, startMs: 0 }

/**
 * How many segments one look reads at most. A stream writes one every few
 * seconds and the controller looks every second, so this is only ever reached
 * by a backlog, and the rest of it waits for the next tick rather than holding
 * up every other stream's.
 */
export const SEGMENTS_PER_SCAN = 8

/**
 * The points of every segment listed since `cursor`, and the cursor after
 * them, on the playlist's time as `scanSegment` places it: a publisher that
 * drops out and reconnects, which starts its timestamps again behind a
 * discontinuity, continues the one timeline.
 *
 * A segment with no stamped frame gives one `arrival` point: its start on the
 * playlist, at the moment it was found listed less its length. That moment
 * is read from `now` as soon as the playlist has been read, and not before:
 * a time taken earlier, ahead of a slow database or disk, would make a
 * segment listed meanwhile look as if it had arrived before it did. A point
 * is never earlier than the one before it plus the media time between them,
 * so segments found together, or a look that comes promptly after a slow
 * one, never run the timeline backwards. A directory with no playlist yet
 * gives nothing.
 *
 * A segment whose bytes cannot be read as a fragment, cut short or damaged,
 * is passed over and named in `unreadable`, and the scan goes on past it:
 * reading it again would fail the same way, and the stream's later segments
 * would never be placed. In a stream with stamps it adds no point, and the
 * timeline runs on at 1× from the stamp before it, which is closer than its
 * arrival would be; otherwise it is placed by its arrival like any segment
 * without a stamp. A segment that cannot be read from disk at all is not
 * passed over: that fails the scan, which the next look tries again.
 */
export async function scanNewSegments(
  directory: string,
  cursor: ScanCursor = SCAN_FROM_START,
  now: () => number = Date.now,
  limit: number = SEGMENTS_PER_SCAN
): Promise<{
  points: StoredWallPoint[]
  cursor: ScanCursor
  /** Each segment passed over, and why. */
  unreadable: string[]
}> {
  const playlist = await readPlaylist(directory)
  const seenAt = now()
  if (playlist == null) return { points: [], cursor, unreadable: [] }
  const fresh = playlist.segments.slice(
    cursor.segments,
    cursor.segments + limit
  )
  if (fresh.length === 0) return { points: [], cursor, unreadable: [] }

  // No init segment, so nothing can be read out of the segments: they are
  // placed by their arrival.
  const track = await readTrack(directory, playlist)

  const points: StoredWallPoint[] = []
  const unreadable: string[] = []
  let { startMs, last, placement, latest } = cursor
  for (const segment of fresh) {
    const lengthMs = segment.durationSec * 1000
    let frames: ScannedFrame[] = []
    if (track != null) {
      const bytes = await readPart(join(directory, segment.uri))
      try {
        const scanned = scanSegment(
          bytes,
          track,
          {
            startMs,
            durationMs: lengthMs,
            discontinuity: segment.discontinuity
          },
          placement
        )
        frames = scanned.frames
        placement = scanned.placement
      } catch (error) {
        unreadable.push(`${segment.uri}: ${String(error)}`)
        if (last != null) {
          startMs += lengthMs
          continue
        }
      }
    }
    const kept = thinStamps(frames, last)
    if (frames.some(frame => frame.stamp != null)) {
      points.push(...kept.map(point => ({ ...point, source: 'sei' as const })))
      last = kept.at(-1) ?? last
      if (last != null) latest = { mediaMs: last.mediaMs, wallMs: last.wallMs }
    } else {
      const mediaMs = Math.round(startMs)
      const wallMs = Math.round(
        Math.max(
          seenAt - lengthMs,
          latest == null ? -Infinity : latest.wallMs + mediaMs - latest.mediaMs
        )
      )
      points.push({ mediaMs, wallMs, source: 'arrival', corrected: true })
      latest = { mediaMs, wallMs }
    }
    startMs += lengthMs
  }
  return {
    points,
    cursor: {
      segments: cursor.segments + fresh.length,
      startMs,
      placement,
      last,
      latest
    },
    unreadable
  }
}

/**
 * Where a stream's scan carries on from when this server has no cursor for
 * it, as after a restart: just after the newest point stored for its video,
 * so the segments already read are not read again. A stream can be hours
 * long, and reading all of it inside one tick held up every other stream's.
 *
 * The segment holding the newest point is the last starting at or before it.
 * An arrival point is its segment's start, so the scan carries on with the
 * segment after it. A stamped one is read again from the point on, which
 * keeps nothing it kept before: the point is the scan's `last`, and the
 * frames after it in that segment were under half a second from it. Its run
 * is placed again from the run's first segment, one read, as the scan placed
 * it the first time. With no point stored, the scan starts at the beginning.
 */
export async function resumeScan(
  db: Kysely<Database>,
  videoId: string,
  directory: string
): Promise<ScanCursor> {
  const newest = await db
    .selectFrom('video_wall_anchors')
    .select(['media_ms', 'wall', 'source', 'corrected'])
    .where('video_id', '=', videoId)
    .orderBy('media_ms', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (newest == null) return SCAN_FROM_START
  const playlist = await readPlaylist(directory)
  if (playlist == null) return SCAN_FROM_START

  const starts: number[] = []
  let endMs = 0
  for (const segment of playlist.segments) {
    starts.push(endMs)
    endMs += segment.durationSec * 1000
  }
  let held = -1
  while (held + 1 < starts.length && starts[held + 1] <= newest.media_ms) held++
  if (held < 0) return SCAN_FROM_START
  const latest = {
    mediaMs: newest.media_ms,
    wallMs: new Date(newest.wall).getTime()
  }
  if (newest.source === 'arrival')
    return { segments: held + 1, startMs: starts[held + 1] ?? endMs, latest }

  let runStart = held
  while (runStart > 0 && !playlist.segments[runStart].discontinuity) runStart--
  let placement: Placement | undefined
  if (runStart < held) {
    const track = await readTrack(directory, playlist)
    const first = playlist.segments[runStart]
    try {
      if (track != null)
        placement = scanSegment(
          await readPart(join(directory, first.uri)),
          track,
          {
            startMs: starts[runStart],
            durationMs: first.durationSec * 1000,
            discontinuity: true
          }
        ).placement
    } catch {
      // Gone or unreadable: the segment is placed on its own, at its place
      // on the playlist, which is off by no more than the run has drifted.
    }
  }
  return {
    segments: held,
    startMs: starts[held],
    placement,
    last: { ...latest, corrected: newest.corrected },
    latest
  }
}

/** The playlist the splitter writes, or null before it has written one. */
async function readPlaylist(directory: string): Promise<MediaPlaylist | null> {
  try {
    return parseMediaPlaylist(
      await readFile(join(directory, LIVE_PLAYLIST_NAME), 'utf8')
    )
  } catch {
    return null
  }
}

/**
 * The video track of the init segment as it is now, which is the current
 * writer's: a reconnect writes a new one under the same name. Null without
 * one.
 */
async function readTrack(
  directory: string,
  playlist: MediaPlaylist
): Promise<VideoTrack | null> {
  try {
    return videoTrackOf(
      await readFile(join(directory, playlist.map?.uri ?? 'init.mp4'))
    )
  } catch {
    return null
  }
}
