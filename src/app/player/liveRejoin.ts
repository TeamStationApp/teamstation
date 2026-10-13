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
 */

/** How often the playlist is looked at while it is closed. */
export const REJOIN_POLL_MS = 5000

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
  pollMs?: number
}): LiveRejoin {
  const { isLive, fetchPlaylist, rejoin } = options
  const clock = options.clock ?? realClock
  const pollMs = options.pollMs ?? REJOIN_POLL_MS
  let timer: unknown
  let waiting = false
  let stopped = false

  const later = (): void => {
    timer = clock.setTimeout(() => {
      timer = undefined
      check().catch(() => undefined)
    }, pollMs)
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
      check().catch(() => undefined)
    },
    stop: () => {
      stopped = true
      if (timer != null) clock.clearTimeout(timer)
      timer = undefined
    }
  }
}
