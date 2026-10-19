/** How long a live phone player may sit still, wanting to play, before it is loaded again. */
export const LIVE_RELOAD_MS = 20_000
/** The longest wait between two loads while the stream stays away. */
export const MAX_LIVE_RELOAD_MS = 60_000
/**
 * The most a reopened stream replays before the point where it stopped:
 * AVPlayer opens three segments (twelve seconds) from the end.
 */
export const REPLAY_SEC = 20

/**
 * The clock the watch runs on, replaceable in a test. The browser's
 * `RetryClock` has the same shape; it is spelled out here because a phone's
 * `./attachHls` is the native file, which has none.
 */
export interface ReloadClock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const realClock: ReloadClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/**
 * Loads a live game again on a phone whose player has stopped for good.
 *
 * AVPlayer gives a live playlist about three-quarters of a minute to change.
 * When the publisher at the field is away for longer — a Starlink dish that
 * loses the sky, an iPad that restarts — it fails the stream ("Stream ended
 * unexpectedly") and never asks for the playlist again, though the game comes
 * back seconds later. Measured on an iPhone: the picture held its last frame
 * for as long as anybody watched, the play button did nothing, and only
 * leaving the game and coming back brought it back. The error ladder in
 * `attachHls.native.ts` reloads it, but a reload made while the publisher is
 * still away fails the same way, and then nothing is left to try again.
 *
 * So the picture is watched as well as the errors: while the viewer wants it
 * playing, it has not moved for twenty seconds and it has failed, `restart`
 * is called. A player that has not failed is left alone, however long it
 * waits: AVPlayer on a line slower than the game waits until it has about
 * fifty seconds in hand and then plays, and reloading it every minute (as
 * this once did) kept it from ever getting there.
 * While the game stays away the waits double, to a minute. A restart puts the
 * player back where it was, and only movement past that point counts as the
 * game having come back, so a player that replays a few seconds it already
 * had is not mistaken for one that recovered. A viewer who pauses, or does
 * not want it playing, starts the count again.
 */
export function reloadStalledLive(
  player: { readonly currentTime: number; readonly ended?: boolean },
  wantsToPlay: () => boolean,
  restart: () => void,
  clock: ReloadClock = realClock,
  /**
   * Whether the player has given up — reported an error and shown nothing
   * since. Only such a player is loaded again: one that is merely waiting for
   * footage, on a line slower than the game, is filling its buffer, and a
   * reload would throw that away.
   */
  hasFailed: () => boolean = () => true
): () => void {
  let lastAt = player.currentTime
  let lastProgress = clock.now()
  let wait = LIVE_RELOAD_MS
  /** Where the last restart found it, until it has played past there. */
  let mustPass: number | null = null
  let timer: unknown

  const tick = (): void => {
    const at = player.currentTime
    const now = clock.now()
    // Well back from where it stopped is the viewer watching something else
    // while the game is away, not a replay of the last few seconds.
    if (mustPass != null && at < mustPass - REPLAY_SEC) mustPass = null
    const moved = at > lastAt + 0.1 && (mustPass == null || at > mustPass + 0.1)
    if (!wantsToPlay() || player.ended === true || moved) {
      lastProgress = now
      wait = LIVE_RELOAD_MS
      mustPass = null
    } else if (now - lastProgress >= wait && hasFailed()) {
      mustPass = Math.max(at, mustPass ?? at)
      restart()
      lastProgress = now
      wait = Math.min(wait * 2, MAX_LIVE_RELOAD_MS)
    }
    lastAt = player.currentTime
    timer = clock.setTimeout(tick, 1000)
  }
  timer = clock.setTimeout(tick, 1000)
  return () => {
    clock.clearTimeout(timer)
  }
}
