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
 */

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

/**
 * How far behind real time the take may fall before the view drops to two
 * angles, and over how long a look.
 *
 * The other way a connection fails. A tile that is starved outright stops
 * drawing and is caught by the stall rule; a connection that merely cannot
 * keep four streams going delivers them all slowly, so every tile draws, no
 * tile stalls, and the game plays at two thirds speed with nobody saying why.
 * The clock itself is the measure: it is meant to run at one second a second.
 */
export const BEHIND_RATE = 0.7
export const BEHIND_WINDOW_MS = 10_000

/** Is the take running slower than the game it is showing? */
/**
 * Whether a tile that has stopped drawing has stopped because it is starving.
 *
 * The difference decides whether dropping to two angles can possibly help. A
 * tile with nothing buffered has run out of stream and the line is the reason,
 * so taking two players off it is the remedy. A tile sitting on twenty seconds
 * of buffer that has stopped drawing is not short of bytes — its decoder is
 * wedged, or the tab was throttled — and dropping two other pictures relieves
 * nothing, which is how a gigabit connection ends up being told it cannot
 * carry four streams.
 */
export const STARVED_SEC = 2

export function isStarved(state: {
  /** Seconds of stream ahead of where this tile is playing. */
  bufferAheadSec: number
  readyState: number
}): boolean {
  // `HAVE_FUTURE_DATA` is 3: below it the element itself says it has nothing
  // to play next, whatever a byte count claims.
  return state.readyState < 3 || state.bufferAheadSec < STARVED_SEC
}

export function runningBehind(gainedMs: number, elapsedMs: number): boolean {
  if (elapsedMs < BEHIND_WINDOW_MS) return false
  return gainedMs / elapsedMs < BEHIND_RATE
}

/**
 * Climbing back to four angles after a demotion.
 *
 * Demotion used to be a one-way door: a stall or a slow minute dropped the
 * view to two tiles and nothing ever put the other two back, so a connection
 * that recovered in seconds left a viewer watching half a game for the rest
 * of the afternoon. The notice said "while the connection catches up", which
 * was a promise the view did not keep.
 *
 * So it climbs back on its own, once everything has been calm for a while —
 * no tile stalled and the clock running at its proper rate. Calm, not merely
 * quiet: the line that could not carry four streams a minute ago can still
 * carry two perfectly well, and two tiles behaving proves nothing about four.
 *
 * Each failed attempt doubles the wait, because a connection that has dropped
 * the view twice is telling us something, and re-attaching two streams costs
 * the two that are working. After `PROMOTION_TRIES` it stops asking: the
 * notice keeps its button, and going back to four becomes the viewer's
 * decision rather than ours.
 */
export const CALM_MS = 20_000
export const PROMOTION_TRIES = 3

/** How long the calm must last before the nth attempt, or null for no more. */
export function promotionWait(attempts: number): number | null {
  if (attempts >= PROMOTION_TRIES) return null
  return CALM_MS * 2 ** attempts
}

/** Whether the view should try four angles again. */
export function readyToPromote(state: {
  /** How long nothing has stalled and the clock has kept up. */
  calmForMs: number
  /** Demotions so far this sitting. */
  attempts: number
}): boolean {
  const wait = promotionWait(state.attempts)
  return wait != null && state.calmForMs >= wait
}

export type Correction =
  | { kind: 'hold' }
  | { kind: 'seek'; toSec: number }
  | { kind: 'park'; reason: 'beforeStart' | 'afterEnd' }

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

/**
 * Where four live tiles can agree to be.
 *
 * Each live tile arrives at its own live edge, and those differ by seconds —
 * hls.js holds back three segments, and a segment here is four, so about
 * twelve. Asking them all to show the instant the furthest-ahead one has
 * reached would ask the others for pictures that do not exist yet, so the view
 * holds back to the tile that is furthest behind.
 */
export function liveTargetMs(edges: Array<number | null>): number | null {
  let earliest: number | null = null
  for (const edge of edges) {
    if (edge == null) continue
    if (earliest == null || edge < earliest) earliest = edge
  }
  return earliest
}
