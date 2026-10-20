/**
 * Keeping four pictures on the same moment of one game.
 *
 * The measurements this was written against, on a Mac with four 1080p HEVC
 * tiles through Media Source: ten minutes of playback, 18 003 of 18 000
 * frames on every tile, not one dropped, and the gap between tiles went from
 * 17 ms to 19 ms — no drift detectable above the noise, bounded below roughly
 * 15 ms per hour. What the shorter runs had looked like was drift and was not:
 * every one of them showed the same spread at the end as at the beginning,
 * because four players attached a frame apart and then stayed a frame apart.
 *
 * Two things follow, and they are the whole design:
 *
 * - **A stagger is fixed once, not chased.** Alignment happens on events —
 *   attach, seek, stall recovery, unpark, a change of rate — and a slow
 *   watchdog catches anything else.
 * - **Nothing touches `playbackRate`.** Nudging the rate continuously was
 *   measured at 3.5% of frames dropped against 0.2% free-running, to buy an
 *   accuracy nobody can see. It also suppresses ManagedMediaSource's own
 *   load-shedding on an iPhone, because hls.js ignores `endstreaming` while a
 *   media element is seeking.
 *
 * The watchdog stays anyway, at 1 Hz, because the paths nobody has measured —
 * WebKit, a phone, a live tile that gets throttled — are exactly the ones
 * where a player can be moved somewhere the view never asked for.
 *
 * **A small gap is the exception to the second rule**, because outside
 * Chrome a seek is what costs. Measured with four 1080p HEVC tiles: on a
 * Pixel 10 a seek took 0.6–1.9 s to land, and in WebKit — Safari, on a Mac
 * and an iPhone — about 0.4 s, decoding from the keyframe before the target.
 * Either way the tile landed that far behind, was moved again at the next
 * look, and hitched every couple of seconds for as long as it played. A
 * player changes speed without a hitch, and a tile that is not heard makes no
 * sound doing it, so a gap under `NUDGE_MAX_SEC` is closed by speed
 * (`nudgeRate`) and only a larger one by a seek. In Chrome tiles stay within
 * the tolerance of each other, so this rarely moves a rate there at all.
 */

import { LIVE_DELAY_SEC } from '../liveDelay'
import { type AngleVideo, secondsAt, startMs } from '../wallClock'

/** How far out a follower may be before it is worth a seek. */
export const TOLERANCE_SEC = 0.1

/** How often the watchdog looks, when no event has prompted it. */
export const WATCHDOG_MS = 1000

/** Not paused, not seeking, and not moving: this long, and it has stalled. */
export const STALL_MS = 250

/**
 * How long a stalled master holds everything else before handing over.
 *
 * With this, a stall and an ending are the same rule with two triggers: a
 * master that stops for good is a master that stalled and never came back.
 */
export const HOLD_MS = 2000

/**
 * How near the end of its own media a recording counts as finished.
 *
 * An element stops a fraction short of its last frame and does not always say
 * `ended`: one recording here stops 0.16 s out. The slack exists so that two
 * questions — *has this tile finished?* and *does the take still expect a
 * picture from it?* — cannot answer differently about the same moment, which
 * is what wedged the clock the first two times this was written.
 */
export const END_SLACK_SEC = 0.25

/** The end to judge a recording by: what it holds, less the slack. */
export function endFor(mediaSec: number | null | undefined): number | null {
  return mediaSec == null ? null : mediaSec - END_SLACK_SEC
}

/** Has this tile reached the end of what it holds? */
export function isFinished(state: {
  /** What the element says for itself, which it does not always say. */
  ended: boolean
  atSec: number
  /** What it holds. Null for a live recording, which has no end yet. */
  mediaSec: number | null
}): boolean {
  if (state.ended) return true
  const end = endFor(state.mediaSec)
  return end != null && state.atSec >= end
}

/**
 * How long after this view moves a tile its silence is the view's own doing.
 *
 * A seeked element draws nothing for a moment. Counting that as a stall lets a
 * healthy tile be judged stuck in the seconds after its own seek; forgiving it
 * for ever lets a starved one be forgiven on every tick, because a starved
 * tile is exactly the one the alignment keeps seeking. So the amnesty is
 * bounded, and it is paired with `worthCorrecting` below: the two together are
 * what let the view tell *we moved it* from *it stopped*.
 */
export const SEEK_GRACE_MS = 1500

/** Is this tile's silence this view's own doing, just now? */
export function isOurSilence(
  nowMs: number,
  seekedAtMs: number | undefined
): boolean {
  if (seekedAtMs == null) return false
  return nowMs - seekedAtMs < SEEK_GRACE_MS
}

/**
 * How far ahead of the moment a tile joining the others is sent, and held.
 *
 * A tile told to play from the moment starts behind it by however long its
 * player takes to decode from the keyframe before it — about 0.4 s in WebKit,
 * up to 1.9 s on a Pixel 10 — and in WebKit no change of speed closes that
 * afterwards. So a camera starting late, a tile coming back, or one too far
 * out to close by speed is sent this far ahead and kept on that still picture
 * until the game reaches it: the decoding happens while it waits, and it
 * starts on the moment.
 */
export const JOIN_LEAD_SEC = 1.5

/** The largest gap a tile closes by speed rather than by a seek. */
export const NUDGE_MAX_SEC = 1

/** How much faster or slower a tile runs per second it is out. */
export const NUDGE_GAIN = 0.2

/** The most a tile's speed is moved from normal, either way. */
export const NUDGE_LIMIT = 0.15

/**
 * The speed that brings a tile back to the moment, from how far out it
 * is (`errorSec`, positive when behind). Normal speed within the tolerance;
 * otherwise in proportion to the gap, so it slows as it closes and does not
 * overshoot.
 */
export function nudgeRate(
  errorSec: number,
  toleranceSec: number = TOLERANCE_SEC
): number {
  if (Math.abs(errorSec) <= toleranceSec) return 1
  const change = Math.max(
    -NUDGE_LIMIT,
    Math.min(NUDGE_LIMIT, errorSec * NUDGE_GAIN)
  )
  return 1 + change
}

/**
 * How far out a starved tile has to be before it is worth moving anyway.
 *
 * Bigger than the second a tile falls behind between two looks, so chasing the
 * drift of something that cannot draw is never mistaken for sending it
 * somewhere new.
 */
export const REPLACE_SEC = 3

/**
 * Whether it is worth moving this tile at all.
 *
 * An element with nothing in hand cannot show the position it is at, let alone
 * one it is nudged to, so chasing its drift achieves nothing — and it hides
 * the stall, because every seek is a fresh reason to forgive the silence that
 * follows. That is how a single dying camera used to drag a whole take down to
 * a quarter speed without a word.
 *
 * It is still *sent somewhere else* — a scrub, or coming back from the end of
 * its own recording — because that is a new place to buffer rather than a
 * nudge it cannot act on.
 */
export function worthCorrecting(readyState: number, errorSec: number): boolean {
  if (readyState >= 2) return true
  return Math.abs(errorSec) >= REPLACE_SEC
}

export type Correction =
  | { kind: 'hold' }
  | { kind: 'seek'; toSec: number }
  | { kind: 'park'; reason: ParkReason }

/**
 * Why a tile is held where it is: the moment is before its camera started,
 * after it stopped, or — live — past the newest footage it has yet.
 */
export type ParkReason = 'beforeStart' | 'afterEnd' | 'notYet'

export interface FollowerState {
  video: AngleVideo
  /** Where this follower's element is now. */
  atSec: number
  /**
   * How much media the element actually has, when it knows.
   *
   * The database's `duration_sec` is what somebody wrote down, and on real
   * recordings it runs several seconds past where the media stops — one of
   * ours declares 7344 s and holds 7337.9. A tile playing into that gap stops
   * without ever reporting `ended`, so a declared length means the view waits
   * for a moment that never comes.
   */
  mediaSec?: number | null
  /**
   * A live tile's newest footage, in its own seconds, by its mapping onto the
   * wall clock; null when it is not live or cannot say. A moment past it has
   * not reached this camera yet.
   */
  newestSec?: number | null
}

/**
 * What to do with one follower, given the instant the view is showing.
 *
 * `hold` for a recording that cannot be placed on the wall clock at all: it
 * has no start time, so there is no honest way to move it, and moving it
 * anyway would be a guess dressed up as synchronisation.
 */
export function correctionFor(options: {
  wallMs: number
  follower: FollowerState
  toleranceSec?: number
}): Correction {
  const { wallMs, follower, toleranceSec = TOLERANCE_SEC } = options
  const target = secondsAt(follower.video, wallMs)
  if (target == null) return { kind: 'hold' }
  if (target < 0) return { kind: 'park', reason: 'beforeStart' }
  if (
    follower.newestSec != null &&
    target > follower.newestSec + toleranceSec
  ) {
    return { kind: 'park', reason: 'notYet' }
  }
  // What the file holds wins over what the row says.
  const durationSec =
    follower.mediaSec != null && Number.isFinite(follower.mediaSec)
      ? follower.mediaSec
      : follower.video.durationSec
  if (durationSec != null && target > durationSec) {
    return { kind: 'park', reason: 'afterEnd' }
  }
  if (Math.abs(target - follower.atSec) > toleranceSec) {
    return { kind: 'seek', toSec: target }
  }
  return { kind: 'hold' }
}

export interface Placeable {
  id: string
  video: AngleVideo
  /** False while a tile has no source attached, or has given up. */
  playable: boolean
  /** True once this tile has played to the end of what it holds. */
  ended?: boolean
}

/**
 * Which tile the others follow.
 *
 * The longest recording that can be placed on the clock and is actually
 * playing. Longest, because a master that ends halfway through the game hands
 * over halfway through the game, and every handover is a moment where the
 * view can visibly jump. Placeable, because a master with no start time cannot
 * tell anybody else where it is.
 *
 * Not the tile with the sound, which is what an earlier draft chose: the sound
 * follows the viewer's choice and the zoom, and tying the clock to it would
 * make picking a different tile's audio move everybody's picture.
 */
export function masterOf(
  tiles: Placeable[],
  /**
   * The tile the viewer is listening to, which is made the master wherever it
   * can be one.
   *
   * A follower is put back on the moment by setting `currentTime`, and a seek
   * on a stream fed through Media Source empties what it had buffered and
   * fetches again: a gap in the picture, and — the part somebody notices — a
   * break in the sound. The master is the one tile that is never corrected,
   * so the sound belongs on it. Everything else is moved around it instead,
   * which is silent by definition because nobody is listening to it.
   */
  audioId?: string | null
): string | null {
  const usable = (tile: Placeable): boolean =>
    tile.playable && tile.ended !== true && startMs(tile.video) != null

  const heard = tiles.find(tile => tile.id === audioId)
  if (heard != null && usable(heard)) return heard.id

  let best: Placeable | null = null
  for (const tile of tiles) {
    if (!usable(tile)) continue
    const length = tile.video.durationSec ?? Number.POSITIVE_INFINITY
    const bestLength = best?.video.durationSec ?? Number.POSITIVE_INFINITY
    if (best == null || length > bestLength) best = tile
  }
  return best?.id ?? null
}

/**
 * Whether the view has run out of masters, which is not the same as an error.
 *
 * Every recording of a game ends. When the last one does, the view says so
 * once, plainly, rather than parking four tiles and leaving somebody looking
 * at four still frames wondering what broke.
 */
export function everythingEnded(tiles: Placeable[]): boolean {
  return tiles.length > 0 && tiles.every(tile => tile.ended === true)
}

/**
 * A stall: a tile that is meant to be playing and is putting no pictures up.
 *
 * By what it has **decoded**, not by where its clock says it is. Two earlier
 * versions of this asked the wrong question. The `waiting` event fires on
 * every ordinary seek, and this view seeks on purpose all the time. And
 * `currentTime` is no better, because the alignment *itself* moves a starved
 * tile's clock forward every tick — so a picture frozen for two minutes went
 * on reporting a position that changed, and nothing ever noticed that not one
 * frame had been drawn.
 */
export function hasStalled(state: {
  paused: boolean
  /** Whether it has decoded a picture since the last look. */
  progressed: boolean
  unchangedForMs: number
}): boolean {
  if (state.paused) return false
  if (state.progressed) return false
  return state.unchangedForMs >= STALL_MS
}

/**
 * A hold that has gone on long enough to be an ending rather than a stumble.
 *
 * What it decides: when a tile has been stuck this long, the view stops taking
 * the moment from it and hands the clock to whichever tile is still moving. A
 * picture that has stopped is not a clock, however healthy its connection
 * looks.
 */
export function holdExpired(heldForMs: number): boolean {
  return heldForMs >= HOLD_MS
}

/** How long a live grid waits for its slower tiles before opening without them. */
export const LIVE_OPEN_WAIT_MS = 3000

/**
 * The moment a grid of live angles opens on.
 *
 * A live grid has no moment of its own to open on — not the take's beginning,
 * which is hours ago — so it takes one from its tiles: `LIVE_DELAY_SEC`
 * behind the newest footage the slowest of them has (each tile's
 * `newestWall`), where every one of them has pictures and the single player
 * would be too. Until one has said, there is nothing to start from.
 *
 * `at` is each playable live tile's newest footage, null until its mapping
 * can say. The grid waits for all of them, but not for longer than
 * `LIVE_OPEN_WAIT_MS` after the first: a camera that never maps is left out,
 * and the gate deals with it as anywhere else.
 */
export function liveOpeningMs(
  at: Array<number | null>,
  waitedMs: number
): number | null {
  let slowest: number | null = null
  let missing = false
  for (const one of at) {
    if (one == null) missing = true
    else if (slowest == null || one < slowest) slowest = one
  }
  if (slowest == null) return null
  if (missing && waitedMs < LIVE_OPEN_WAIT_MS) return null
  return slowest - LIVE_DELAY_SEC * 1000
}
