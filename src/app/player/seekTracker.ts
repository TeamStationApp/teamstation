/**
 * Whether to believe the player about where the playhead is.
 *
 * The native handle owns the playhead rather than reporting it, because the
 * quarter-speed crawl integrates against `currentTime` frame by frame and the
 * angle switch reads it at the instant of the swap. So when a seek is
 * outstanding, the four-times-a-second progress the player sends is still
 * describing where it *was*, and adopting it would undo the seek.
 *
 * Deciding when that stops being true is the whole of the difficulty, and it
 * is pure, so it lives here where it can be tested rather than inside a class
 * that cannot be loaded without a native player.
 *
 * Two things make it hard, and both are Android:
 *
 * - **ExoPlayer coalesces.** It keeps one `isSeeking` boolean, so ten seeks in
 *   ten frames — which is exactly what a crawl does — are answered once. A
 *   count of seeks outstanding would go up ten times and down once, stay
 *   permanently positive, and the playhead would freeze where the crawl left
 *   it for the life of the source. So this tracks a **target**, which a newer
 *   seek simply replaces.
 * - **It sometimes answers not at all**, when the seek was issued while paused
 *   *and* buffering — which is precisely a seek on a stalled live stream. So
 *   there is a deadline, after which the player is believed again regardless.
 *   One wrong second is better than a playhead wedged for ever.
 */

/** Near enough: inside a frame at 25fps, so the error is never visible. */
export const SEEK_TOLERANCE = 0.05

/**
 * How long to wait for a seek to be acknowledged before believing the player
 * again.
 */
export const SEEK_PATIENCE_MS = 1000

export interface ProgressDecision {
  /** Where the outstanding seek was aimed, or null if none is. */
  target: number | null
  /** What the player has just said the position is. */
  reported: number
  /** When the seek was sent. */
  sentAt: number
  now: number
}

/**
 * Whether the player's reported position should replace ours.
 *
 * True when nothing is outstanding; when the report has arrived at the target,
 * whether or not the player said so; or when the deadline has passed and no
 * answer is coming.
 */
export function shouldAdoptProgress(state: ProgressDecision): boolean {
  if (state.target == null) return true
  // Twice the tolerance: the seek is allowed to land within tolerance, and the
  // report is a sample taken some time after it did.
  if (Math.abs(state.reported - state.target) <= SEEK_TOLERANCE * 2) return true
  return state.now - state.sentAt > SEEK_PATIENCE_MS
}

/**
 * Whether an acknowledgement is the one we are waiting for.
 *
 * An unsolicited discontinuity — after a re-prepare, or a stream switching
 * rendition — is not an answer to anything that was asked, and clearing the
 * target on one would let the next progress report undo a seek still in
 * flight.
 */
export function answersSeek(target: number | null, seekedTo: number): boolean {
  if (target == null) return false
  return Math.abs(seekedTo - target) <= SEEK_TOLERANCE
}

/**
 * Whether a finished seek has to start the picture again.
 *
 * react-native-video on iOS pauses the player to seek, and while its own
 * controls are on it then takes that pause for what the viewer wants: the
 * seek's completion restores "paused", and a playing video stops on every
 * ±10 s. The state change it reports is marked as seeking, so the handle
 * never hears of it and still believes the video is playing. The seek event
 * arrives after that pause, so resuming there undoes it whenever playback is
 * what was wanted. On Android the player was never stopped and the resume is
 * a no-op.
 */
export function shouldResumeAfterSeek(state: {
  wantsPaused: boolean
}): boolean {
  return !state.wantsPaused
}
