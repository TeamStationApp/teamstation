/**
 * Picks a live game up again after its playlist was closed under the player.
 *
 * The server keeps a live playlist open while its publisher may come back, so
 * a phone that loses its signal for half a minute costs the people watching a
 * stall, not the game. Past a minute it is closed, and every player reads that
 * `EXT-X-ENDLIST` as the end of the broadcast and stops asking for more, for
 * good. The game is not over, though — the camera can still come back and
 * carry on in the same playlist — and the server still lists the video as
 * live. So while it does, the playlist is looked at every few seconds, and
 * the moment it is open again the player is told to load it afresh and rejoin.
 *
 * A video the server no longer lists as live has finished, and is left to end
 * as it always has.
 *
 * The looks back off, from every 5 s to every 30 s, and stop once the
 * playlist has been closed for ten minutes on top of the minute's grace: a
 * phone that tapped Stop without End leaves its video listed as live for as
 * long as nobody ends it, and every open player asking about it every few
 * seconds for ever is a load on the server for nothing. A camera that comes
 * back after that is picked up by loading the game again.
 */

/** How long after the playlist closed the first look waits. */
export const REJOIN_POLL_MS = 5000
/** The longest wait between two looks. */
export const REJOIN_MAX_POLL_MS = 30_000
/** How long a closed playlist is waited for before the player gives up. */
export const REJOIN_GIVE_UP_MS = 10 * 60_000

/**
 * The wait before look number `attempt` (from 0): `firstMs`, doubling up to
 * `maxMs`. Undefined once the waits so far add up to `giveUpMs`.
 */
export function backoffDelay(
  attempt: number,
  firstMs: number,
  maxMs: number,
  giveUpMs: number
): number | undefined {
  let waited = 0
  for (let index = 0; ; index++) {
    const delay = Math.min(firstMs * 2 ** index, maxMs)
    if (waited + delay > giveUpMs) return undefined
    if (index === attempt) return delay
    waited += delay
  }
}

/** The timer the wait runs on, replaceable in a test. */
export interface RejoinClock {
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const realClock: RejoinClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/** The first wait before a live video with no files yet is asked for again. */
export const LIVE_PLAYBACK_RETRY_MS = 2000

/**
 * How long a game page waits before asking again for a live video the server
 * has no files for, after `asks` asks: 2 s, since its first segment is
 * written a few seconds after the stream starts publishing, backing off to
 * 30 s. Undefined after ten minutes: a publish that was refused never writes
 * one, and the page stops asking.
 */
export function livePlaybackRetryDelay(asks: number): number | undefined {
  return backoffDelay(
    asks,
    LIVE_PLAYBACK_RETRY_MS,
    REJOIN_MAX_POLL_MS,
    REJOIN_GIVE_UP_MS
  )
}

/**
 * Whether a playlist is a media playlist that is still being written: it
 * lists segments and has not been closed. A multivariant playlist lists no
 * segments, and is never taken for an open one.
 */
export function isOpenPlaylist(text: string): boolean {
  return text.includes('#EXTINF') && !text.includes('#EXT-X-ENDLIST')
}

export interface LiveRejoin {
  /** The player has read a closed playlist. */
  ended: () => void
  /** The player is going; nothing more is looked at or done. */
  stop: () => void
}

export function liveRejoin(options: {
  /** Whether the server still lists the video as live. */
  isLive: () => boolean | Promise<boolean>
  /** The playlist as it is now, never from a cache. */
  fetchPlaylist: () => Promise<string>
  /** Load the playlist afresh and rejoin the game. */
  rejoin: () => void
  clock?: RejoinClock
  /** The first wait; the rest back off from it. */
  pollMs?: number
}): LiveRejoin {
  const { isLive, fetchPlaylist, rejoin } = options
  const clock = options.clock ?? realClock
  const pollMs = options.pollMs ?? REJOIN_POLL_MS
  let timer: unknown
  let waiting = false
  let stopped = false
  /** Looks scheduled since the playlist last closed. */
  let attempts = 0

  const later = (): void => {
    const delay = backoffDelay(
      attempts,
      pollMs,
      REJOIN_MAX_POLL_MS,
      REJOIN_GIVE_UP_MS
    )
    // Closed for long enough: the camera is not coming back to this player.
    // `waiting` stays set, so nothing starts the looks again.
    if (delay == null) return
    attempts += 1
    timer = clock.setTimeout(() => {
      timer = undefined
      check().catch(() => undefined)
    }, delay)
  }

  const check = async (): Promise<void> => {
    // A server that cannot be asked has not said the game is over.
    const live = await Promise.resolve()
      .then(isLive)
      .catch(() => true)
    if (stopped) return
    if (!live) {
      waiting = false
      return
    }
    const open = await fetchPlaylist()
      .then(isOpenPlaylist)
      .catch(() => false)
    if (stopped) return
    if (!open) {
      later()
      return
    }
    waiting = false
    rejoin()
  }

  return {
    ended: () => {
      if (waiting || stopped) return
      waiting = true
      attempts = 0
      check().catch(() => undefined)
    },
    stop: () => {
      stopped = true
      if (timer != null) clock.clearTimeout(timer)
      timer = undefined
    }
  }
}
