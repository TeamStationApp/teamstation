/**
 * How long the picture and the end of what the player can reach must both
 * have stood still before the playlist on the server is looked at.
 */
export const STALE_PLAYLIST_SEC = 20
/** The longest wait between two reloads while the player stays behind. */
export const MAX_PLAYLIST_RELOAD_SEC = 60

/** How often the watch looks. */
const TICK_MS = 5000

export interface PlaylistWatchClock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const realClock: PlaylistWatchClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/** The server's answer for the playlist, or undefined if none came. */
export interface PlaylistAnswer {
  status: number
  text?: string
}

async function fetchPlaylist(url: string): Promise<PlaylistAnswer | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return {
      status: response.status,
      text: response.ok ? await response.text() : undefined
    }
  } catch {
    return undefined
  }
}

/**
 * How long a media playlist runs, by its segments' durations. Undefined for
 * anything else: a master playlist names other playlists, not footage.
 */
export function playlistSeconds(playlist: string): number | undefined {
  if (!playlist.startsWith('#EXTM3U')) return undefined
  let total = 0
  for (const match of playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
    total += Number(match[1])
  }
  return total > 0 ? total : undefined
}

/** A playlist's `EXT-X-TARGETDURATION`, or four seconds if it gives none. */
export function targetSeconds(playlist: string): number {
  const match = /^#EXT-X-TARGETDURATION:(\d+)/m.exec(playlist)
  return match == null ? 4 : Number(match[1])
}

export interface WatchedVideo {
  readonly currentTime: number
  readonly paused: boolean
  readonly ended: boolean
  readonly seekable: { readonly length: number; end: (index: number) => number }
}

/**
 * Loads a live game again in Safari once Safari has stopped reading its
 * playlist.
 *
 * Safari plays the game's HLS itself, and refreshes the live playlist on its
 * own. When that refresh fails for long enough — measured on an iPhone, nine
 * 502s while the server restarted, or a minute of the phone's own connection
 * gone — it stops asking for the playlist for good. It raises no error, so
 * the error ladder never hears of it: the picture plays what it has and then
 * stands still at the end, `readyState` saying it has enough, while the game
 * carries on without it. Only reloading the page brought it back.
 *
 * So while a viewer wants the game playing, a picture that has stood still as
 * long as the end of what the player can reach is checked against the
 * playlist on the server, twice. If the server's has grown by two segments
 * between the looks while the player's end has not moved, the player has
 * stopped reading it and `reload` is called. If it has not grown, the game
 * itself is waiting — the camera at the field is away — and nothing is done,
 * however far behind the player holds itself: that distance is three
 * segments, and segments are as long as the publisher's keyframes make them.
 * A player on a line slower than the game keeps reading its playlist, so its
 * end keeps moving and it is never looked at. A refused address is reloaded
 * too, so the error ladder can ask for a new one. The waits between reloads
 * double, to a minute, while it stays behind; a gap in the ticks — a Mac that
 * slept — starts the clocks again.
 */
export function watchLivePlaylist(
  video: WatchedVideo,
  options: {
    url: string
    wantsToPlay: () => boolean
    reload: () => void
    fetch?: (url: string) => Promise<PlaylistAnswer | undefined>
    clock?: PlaylistWatchClock
  }
): () => void {
  const { url, wantsToPlay, reload } = options
  const fetchText = options.fetch ?? fetchPlaylist
  const clock = options.clock ?? realClock
  let stopped = false
  let timer: unknown
  let lastAt = video.currentTime
  let movedAt = clock.now()
  let lastEnd: number | null = null
  let endMovedAt = clock.now()
  let wait = STALE_PLAYLIST_SEC * 1000
  let nextCheckAt = 0
  let checking = false
  /** The server's length at the first look since the player stood still. */
  let baseline: number | null = null
  let lastTick = clock.now()

  const seekableEnd = (): number | null => {
    const ranges = video.seekable
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : null
  }

  const reloadNow = (): void => {
    reload()
    // A reloaded player starts its clocks again.
    movedAt = clock.now()
    endMovedAt = clock.now()
    lastEnd = null
    baseline = null
    nextCheckAt = clock.now() + wait
    wait = Math.min(wait * 2, MAX_PLAYLIST_RELOAD_SEC * 1000)
  }

  const check = async (): Promise<void> => {
    checking = true
    try {
      const answer = await fetchText(url)
      if (stopped) return
      if (answer?.status === 401 || answer?.status === 403) {
        reloadNow()
        return
      }
      nextCheckAt = clock.now() + TICK_MS * 2
      const text = answer?.text
      const serverSec = text == null ? undefined : playlistSeconds(text)
      if (text == null || serverSec == null) return
      if (baseline == null) {
        baseline = serverSec
      } else if (serverSec - baseline >= Math.max(8, 2 * targetSeconds(text))) {
        reloadNow()
      }
    } finally {
      checking = false
    }
  }

  const tick = (): void => {
    const now = clock.now()
    const at = video.currentTime
    const end = seekableEnd()
    // Timers that did not run — a sleeping Mac, a tab put away — say nothing
    // about the player, which catches up by itself on waking.
    const slept = now - lastTick > TICK_MS * 3
    lastTick = now
    if (slept) {
      movedAt = now
      endMovedAt = now
      baseline = null
    }
    if (end != null && (lastEnd == null || end > lastEnd + 0.5)) {
      lastEnd = end
      endMovedAt = now
      baseline = null
    }
    if (!wantsToPlay() || video.paused || video.ended || at > lastAt + 0.1) {
      movedAt = now
      wait = STALE_PLAYLIST_SEC * 1000
      baseline = null
    } else if (
      !checking &&
      end != null &&
      now >= nextCheckAt &&
      now - movedAt >= STALE_PLAYLIST_SEC * 1000 &&
      now - endMovedAt >= STALE_PLAYLIST_SEC * 1000
    ) {
      check().catch(() => undefined)
    }
    lastAt = video.currentTime
    timer = clock.setTimeout(tick, TICK_MS)
  }
  timer = clock.setTimeout(tick, TICK_MS)
  return () => {
    stopped = true
    clock.clearTimeout(timer)
  }
}
