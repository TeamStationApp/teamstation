import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
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
 * outage, which a timeline hung from the start alone is not.
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
}

export const SCAN_FROM_START: ScanCursor = { segments: 0, startMs: 0 }

/**
 * The points of every segment listed since `cursor`, and the cursor after
 * them, on the playlist's time as `scanSegment` places it: a publisher that
 * drops out and reconnects, which starts its timestamps again behind a
 * discontinuity, continues the one timeline.
 *
 * A segment with no stamped frame gives one `arrival` point: its start on the
 * playlist, at `now` less its length, `now` being the moment it was found
 * listed. A directory with no playlist yet gives nothing.
 */
export async function scanNewSegments(
  directory: string,
  cursor: ScanCursor = SCAN_FROM_START,
  now: number = Date.now()
): Promise<{ points: StoredWallPoint[]; cursor: ScanCursor }> {
  let text: string
  try {
    text = await readFile(join(directory, LIVE_PLAYLIST_NAME), 'utf8')
  } catch {
    return { points: [], cursor }
  }
  const playlist = parseMediaPlaylist(text)
  const fresh = playlist.segments.slice(cursor.segments)
  if (fresh.length === 0) return { points: [], cursor }

  // The init segment as it is now, which is the current writer's: a
  // reconnect writes a new one under the same name.
  let track: VideoTrack | null = null
  try {
    track = videoTrackOf(
      await readFile(join(directory, playlist.map?.uri ?? 'init.mp4'))
    )
  } catch {
    // No init segment, so nothing can be read out of the segments: they are
    // placed by their arrival.
  }

  const points: StoredWallPoint[] = []
  let { startMs, last, placement } = cursor
  for (const segment of fresh) {
    const lengthMs = segment.durationSec * 1000
    let frames: ScannedFrame[] = []
    if (track != null) {
      const scanned = scanSegment(
        await readPart(join(directory, segment.uri)),
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
    }
    const kept = thinStamps(frames, last)
    if (frames.some(frame => frame.stamp != null)) {
      points.push(...kept.map(point => ({ ...point, source: 'sei' as const })))
      last = kept.at(-1) ?? last
    } else {
      points.push({
        mediaMs: Math.round(startMs),
        wallMs: Math.round(now - lengthMs),
        source: 'arrival',
        corrected: true
      })
    }
    startMs += lengthMs
  }
  return {
    points,
    cursor: {
      segments: cursor.segments + fresh.length,
      startMs,
      placement,
      last
    }
  }
}
