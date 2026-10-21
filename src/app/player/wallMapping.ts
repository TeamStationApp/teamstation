import { mediaAt, type WallAnchor, wallAt } from '../../common/wallTimeline'
import type { AngleVideo } from './wallClock'

/**
 * How one player's position maps onto the wall clock, from the best account
 * of it that player has.
 *
 * The server's wall timeline (`timeline`) comes first where it has one: it is
 * placed by the frames' own wall clocks, across a reconnect too. A stream's
 * own program date-times (`pdt`) follow its holes and discontinuities, but
 * they are when each segment was written — on a live ingest seconds after its
 * pictures, and after a camera stalled later by the stall — so they serve
 * until the timeline arrives. Then a recording's start time (`start`); and a
 * lone recording with no start at all, its own media time (`media`).
 */
export interface WallMapping {
  /** The wall time of `sec` into the media; null when it cannot say. */
  wallAt: (sec: number) => number | null
  /** The media position of a wall-clock instant; null when it cannot say. */
  secAt: (wallMs: number) => number | null
  /** The wall time of the newest picture this player has been offered. */
  newestWall: () => number | null
  source: 'pdt' | 'timeline' | 'start' | 'media'
}

/**
 * How long a player placing a moment waits for the stream to say whether it
 * carries dates, and for the server's wall timeline, before placing by the
 * start.
 */
export const MAPPING_WAIT_MS = 2000

/** One fragment of a dated playlist: seconds into the media, ms on the wall. */
export interface DatedFragment {
  start: number
  duration: number
  programDateTime: number
}

/**
 * From a playlist's fragments and their program date-times: piecewise, one
 * second a second inside each, so a gap or a discontinuity between two is
 * where the wall clock jumps. A wall instant in a gap maps to the first
 * picture after it.
 */
export function fromFragments(
  fragments: readonly DatedFragment[]
): WallMapping {
  const frags = [...fragments].sort((a, b) => a.start - b.start)
  /**
   * The index of the last fragment whose `key` is at or before `value`, by
   * halving — a three-hour game at two-second segments is thousands of them,
   * asked every frame on every tile — or the first's when none is. Program
   * dates rise with the start within a playlist, so either key is in order.
   */
  const lastAtOrBefore = (
    key: (frag: DatedFragment) => number,
    value: number
  ): number => {
    let low = 0
    let high = frags.length - 1
    let found = 0
    while (low <= high) {
      const middle = (low + high) >> 1
      if (key(frags[middle]) <= value) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found
  }
  const at = (sec: number): DatedFragment | undefined =>
    frags[lastAtOrBefore(frag => frag.start, sec)]
  return {
    source: 'pdt',
    wallAt: sec => {
      const frag = at(sec)
      return frag == null
        ? null
        : frag.programDateTime + (sec - frag.start) * 1000
    },
    secAt: wallMs => {
      if (frags.length === 0) return null
      const index = lastAtOrBefore(frag => frag.programDateTime, wallMs)
      const found = frags[index]
      const inside = found.start + (wallMs - found.programDateTime) / 1000
      const next = frags[index + 1]
      if (
        next != null &&
        wallMs >= found.programDateTime &&
        inside >= found.start + found.duration
      ) {
        return next.start
      }
      return inside
    },
    newestWall: () => {
      const last = frags.at(-1)
      return last == null ? null : last.programDateTime + last.duration * 1000
    }
  }
}

/**
 * From Safari's own start date (`getStartDate`), which is the first
 * fragment's program date-time: one second a second from there. The newest
 * picture is read off the seekable end each time it is asked.
 */
export function fromStartDate(
  startDate: number,
  seekableEnd: () => number | null
): WallMapping {
  return {
    source: 'pdt',
    wallAt: sec => startDate + sec * 1000,
    secAt: wallMs => (wallMs - startDate) / 1000,
    newestWall: () => {
      const end = seekableEnd()
      return end == null ? null : startDate + end * 1000
    }
  }
}

/**
 * From the server's wall timeline for the video: its anchors, and media past
 * the newest anchor up to the seekable end.
 */
export function fromAnchors(
  anchors: readonly WallAnchor[],
  seekableEnd: () => number | null = () => null
): WallMapping {
  return {
    source: 'timeline',
    wallAt: sec => wallAt(anchors, sec * 1000),
    secAt: wallMs => {
      const ms = mediaAt(anchors, wallMs)
      return ms == null ? null : ms / 1000
    },
    newestWall: () => {
      const last = anchors.at(-1)
      if (last == null) return null
      const end = seekableEnd()
      const past = end == null ? 0 : Math.max(0, end * 1000 - last[0])
      return last[1] + past
    }
  }
}

/** From the recording's start time and its sync offset. */
export function fromStart(
  video: AngleVideo,
  seekableEnd: () => number | null = () => null
): WallMapping {
  const start = (): number | null => {
    if (video.startAt == null) return null
    const parsed = Date.parse(video.startAt)
    return Number.isNaN(parsed) ? null : parsed
  }
  return {
    source: 'start',
    wallAt: sec => {
      const at = start()
      return at == null ? null : at + (sec - video.syncOffsetSec) * 1000
    },
    secAt: wallMs => {
      const at = start()
      return at == null ? null : (wallMs - at) / 1000 + video.syncOffsetSec
    },
    newestWall: () => {
      const at = start()
      const end = seekableEnd()
      return at == null || end == null
        ? null
        : at + (end - video.syncOffsetSec) * 1000
    }
  }
}

/** A lone recording with no start: its own media time, `sec·1000`. */
export function fromMedia(
  seekableEnd: () => number | null = () => null
): WallMapping {
  return {
    source: 'media',
    wallAt: sec => sec * 1000,
    secAt: wallMs => wallMs / 1000,
    newestWall: () => {
      const end = seekableEnd()
      return end == null ? null : end * 1000
    }
  }
}
