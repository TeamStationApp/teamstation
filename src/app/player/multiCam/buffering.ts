/**
 * How far ahead four pictures load, and when they may play.
 *
 * A grid that starts a tile the moment it has its next frame starts it with
 * nothing in hand: it runs dry a moment later, the grid holds everybody for
 * it, and the cycle repeats — which on the screen is a stutter that never
 * settles. So the grid plays the way a streaming app does: it waits until
 * **every** tile holds a few seconds, then lets them load on well ahead of
 * the picture, so a dip in the connection is absorbed by what is already
 * there instead of by the picture.
 *
 * Two numbers make the hysteresis: a tile must hold `START_AHEAD_SEC` before
 * the grid plays, and the grid only stops again when a tile is down to
 * `LOW_AHEAD_SEC`. Starting and stopping at the same level is the stutter.
 *
 * The other half is sharing the line. Four players asked to fill a deep buffer
 * all at once race each other for it, and the one that falls behind starves —
 * measured on a real take, four unrestrained players pulled 178 MB in their
 * first ten seconds. So no tile may load more than `LEAD_SEC` past the one
 * furthest behind: the leaders stop asking, and the line goes to the tile that
 * needs it. The ceiling climbs as the slowest tile fills, up to
 * `MAX_AHEAD_SEC`.
 */

import { HAVE_ENOUGH_DATA } from '../videoHandle'

/** What every tile must hold before the grid plays, or plays again. */
export const START_AHEAD_SEC = 5

/** A playing tile with less than this is about to run dry. */
export const LOW_AHEAD_SEC = 0.5

/** The deepest any tile loads ahead of its picture. */
export const MAX_AHEAD_SEC = 60

/** How far past the tile furthest behind any other tile may load. */
export const LEAD_SEC = 10

/**
 * What a player keeps of the picture it has already shown.
 *
 * Enough to step back ten seconds twice without asking the network again,
 * and no more: kept without limit, four tiles hold the whole game in memory
 * until the browser refuses to take any more.
 */
export const BEHIND_SEC = 30

/**
 * How long one tile may keep the rest of the grid waiting.
 *
 * A camera that cannot fill its few seconds in this long is not stumbling, it
 * is starved, and three pictures standing still for it is worse than three
 * pictures playing beside a tile that says it is catching up.
 */
export const LEAVE_OUT_MS = 10_000

/**
 * What a phone tile's player is told up front (`VideoView.native.tsx`).
 *
 * A phone's player cannot have its limit moved while it plays, so it is
 * given one, and the same rule for starting: it calls itself ready only once
 * it holds `START_AHEAD_SEC`, which is what the grid waits for.
 *
 * Shallower than a browser's, and nothing kept behind, because Android's
 * player keeps its buffer in the app's Java heap — 256 MB on a Pixel 10.
 * Four players told to hold a minute ahead and half a minute behind filled it
 * and took the app down. Half a minute ahead is about 21 MB a tile at 6 Mbit/s,
 * and `heapShare` stops each player loading at that fraction of the heap
 * whatever its seconds say, so a richer recording cannot do it again.
 */
export const TILE_BUFFER = {
  aheadSec: 30,
  startSec: START_AHEAD_SEC,
  behindSec: 0,
  heapShare: 0.15
}

/**
 * A gap in what a player holds that it plays straight across.
 *
 * WebKit reports what it holds as the stretches its audio and video share, so
 * a recording's first stretch starts at its first frame's timestamp — 0.021 s
 * on ours — rather than at nought, and fragments can meet with a sliver
 * between them. Counted strictly, a tile at the start of a recording held
 * nothing at all, and Safari's grid waited for it for ever. hls.js steps over
 * holes this size on its own (`maxBufferHole`), so they are counted as held.
 */
export const HOLE_SEC = 0.3

/**
 * Seconds held ahead of `atSec`, given the stretches a player holds in order.
 *
 * From the stretch it is in — or one starting within a hole of it — and on
 * across any that follow within a hole. Not the furthest stretch held: a tile
 * that has been moved holds stretches it is nowhere near, and counting those
 * is how a starving tile looks comfortable.
 */
export function heldAhead(
  ranges: Array<[number, number]>,
  atSec: number,
  holeSec: number = HOLE_SEC
): number {
  let end: number | null = null
  let from = atSec
  for (const [start, stop] of ranges) {
    if (end == null) {
      if (start - holeSec <= atSec && atSec <= stop) end = stop
      else if (atSec < start && start - atSec <= START_GAP_SEC) {
        // A hole at the very place it starts, which its player steps over:
        // it holds what is past the hole.
        end = stop
        from = start
      }
      continue
    }
    if (start - end > holeSec) break
    end = Math.max(end, stop)
  }
  return end == null ? 0 : Math.max(0, end - from)
}

/**
 * A held tile that holds nothing where it is measured, and stands somewhere
 * else: one to move there, since its player only loads around where it is.
 *
 * A live tile is placed by its recording's start until its stream's own dates
 * arrive, and the two can disagree by more than a segment. The grid then
 * measures it at the place the dates say, and a tile left where it stood
 * holds nothing there for ever.
 */
export function strayed(
  ranges: Array<[number, number]>,
  atSec: number,
  targetSec: number,
  holeSec: number = HOLE_SEC
): boolean {
  if (Math.abs(atSec - targetSec) <= holeSec) return false
  return !ranges.some(
    ([start, stop]) => start - holeSec <= targetSec && targetSec <= stop
  )
}

/**
 * A hole where a tile is to start that its player steps over on its own:
 * hls.js moves a start in a gap to the footage after it. A live stream that
 * was cut and carried on can begin its first segment's pictures a segment
 * late, and a grid waiting for the hole to fill waited for ever.
 */
export const START_GAP_SEC = 5

/**
 * The hole a recording's player steps over where it starts. hls.js allows
 * twice the target duration only on a live level; on a recording, once a
 * parsed fragment's start has moved to its first picture, the hole is no
 * longer inside it and only `MAX_START_GAP_JUMP` is jumped.
 */
export const RECORDED_START_GAP_SEC = 2

/**
 * Where a recording's tile standing in a start hole its player will not jump
 * — wider than `RECORDED_START_GAP_SEC`, up to `START_GAP_SEC` — is to be
 * sent: the start of the footage after it. Null when it is not in one.
 */
export function acrossStartHole(
  ranges: Array<[number, number]>,
  atSec: number,
  holeSec: number = HOLE_SEC
): number | null {
  for (const [start, stop] of ranges) {
    if (start - holeSec <= atSec && atSec <= stop) return null
    const gap = start - atSec
    if (gap > RECORDED_START_GAP_SEC && gap <= START_GAP_SEC) return start
  }
  return null
}

/** `HAVE_FUTURE_DATA`: the next frame is there, if not much after it. */
const HAVE_FUTURE_DATA = 3

/** Short of the end by this much still counts as holding everything. */
const END_SLACK_SEC = 0.25

/** What one tile has in hand. */
export interface TileBuffer {
  /**
   * Seconds loaded ahead of where it is playing.
   *
   * Null where the player does not say. A phone's player keeps its own
   * buffer and reports only whether it is ready to play, which on Android is
   * set to mean "holds `START_AHEAD_SEC`" (see `VideoView.native.tsx`) and on
   * iOS is AVPlayer's own judgement; `readyState` carries that answer.
   */
  aheadSec: number | null
  /**
   * How much more there is to load at all: to the end of the recording, or
   * to the live edge. Null when that is not known yet.
   */
  leftSec: number | null
  readyState: number
}

/** What a tile must hold to play: the usual few seconds, or all there is. */
export function neededSec(tile: TileBuffer): number {
  const left = tile.leftSec ?? Number.POSITIVE_INFINITY
  return Math.min(START_AHEAD_SEC, Math.max(0, left - END_SLACK_SEC))
}

/** Holds enough to play without stopping again straight away. */
export function isReady(tile: TileBuffer): boolean {
  if (tile.aheadSec == null) return tile.readyState >= HAVE_ENOUGH_DATA
  return tile.aheadSec >= neededSec(tile)
}

/**
 * About to stop for want of pictures.
 *
 * Not a tile at the end of what there is: running out of a recording that
 * has ended, or reaching the live edge, is not a shortage the grid can wait
 * out.
 */
export function isDry(tile: TileBuffer): boolean {
  if (tile.aheadSec == null) return tile.readyState < HAVE_FUTURE_DATA
  if (tile.aheadSec >= LOW_AHEAD_SEC) return false
  return tile.leftSec == null || tile.leftSec - tile.aheadSec > LOW_AHEAD_SEC
}

/** Every tile holds enough. An empty grid has nothing to wait for. */
export function canStart(tiles: TileBuffer[]): boolean {
  return tiles.every(isReady)
}

/**
 * How far ahead every tile may load right now.
 *
 * The tile furthest behind plus `LEAD_SEC`, up to `MAX_AHEAD_SEC`. A tile
 * that already holds everything there is to hold is not short of anything and
 * is left out of the reckoning, and so is one whose player does not say.
 */
export function ceilingSec(tiles: TileBuffer[]): number {
  let lowest = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    if (tile.aheadSec == null) continue
    if (tile.leftSec != null && tile.leftSec - tile.aheadSec <= LOW_AHEAD_SEC) {
      continue
    }
    lowest = Math.min(lowest, tile.aheadSec)
  }
  if (!Number.isFinite(lowest)) return MAX_AHEAD_SEC
  return Math.min(MAX_AHEAD_SEC, lowest + LEAD_SEC)
}

/**
 * Which of the tiles the grid is waiting for have kept it waiting too long.
 *
 * Only while another tile is ready: with nobody ready there is no picture to
 * play instead, and leaving tiles out would only start the grid on whichever
 * of them happened to fill first.
 */
export function toLeaveOut(
  tiles: Array<{ id: string; ready: boolean; waitingSinceMs: number }>,
  nowMs: number
): string[] {
  if (!tiles.some(tile => tile.ready)) return []
  return tiles
    .filter(tile => !tile.ready && nowMs - tile.waitingSinceMs >= LEAVE_OUT_MS)
    .map(tile => tile.id)
}
