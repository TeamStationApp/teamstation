/**
 * How long the picture and the end of what the player can reach must both
 * have stood still before the playlist on the server is looked at.
 */
export const STALE_PLAYLIST_SEC = 20
/**
 * How much further the server's playlist must reach than the player's before
 * the player is taken to have stopped reading it. More than the three
 * segments a live player holds back from the end, so a player that is merely
 * keeping its distance is never mistaken for one that has stopped.
 */
export const BEHIND_PLAYLIST_SEC = 20
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

/** The playlist as the server has it now, or undefined if it cannot be read. */
async function fetchPlaylist(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return response.ok ? await response.text() : undefined
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
  if (playlist.includes('#EXT-X-STREAM-INF')) return undefined
  let total = 0
  for (const match of playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
    total += Number(match[1])
  }
  return total > 0 ? total : undefined
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
 * playlist on the server. If the server's reaches well past the player's, the
 * player has stopped reading it and `reload` is called; if not, the game
 * itself is waiting — the camera at the field is away — and nothing is done.
 * A player on a line slower than the game keeps reading its playlist, so its
 * end keeps moving and it is never reloaded. The waits between reloads double,
 * to a minute, while the player stays behind.
 */
export function watchLivePlaylist(
  video: WatchedVideo,
  options: {
    url: string
    wantsToPlay: () => boolean
    reload: () => void
    fetchText?: (url: string) => Promise<string | undefined>
    clock?: PlaylistWatchClock
  }
): () => void {
  const { url, wantsToPlay, reload } = options
  const fetchText = options.fetchText ?? fetchPlaylist
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

  const seekableEnd = (): number | null => {
    const ranges = video.seekable
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : null
  }

  const check = async (end: number): Promise<void> => {
    checking = true
    try {
      const text = await fetchText(url)
      if (stopped) return
      const serverSec = text == null ? undefined : playlistSeconds(text)
      if (serverSec != null && serverSec - end > BEHIND_PLAYLIST_SEC) {
        reload()
        // A reloaded player starts its clocks again.
        movedAt = clock.now()
        endMovedAt = clock.now()
        lastEnd = null
        nextCheckAt = clock.now() + wait
        wait = Math.min(wait * 2, MAX_PLAYLIST_RELOAD_SEC * 1000)
      } else {
        nextCheckAt = clock.now() + TICK_MS * 2
      }
    } finally {
      checking = false
    }
  }

  const tick = (): void => {
    const now = clock.now()
    const at = video.currentTime
    const end = seekableEnd()
    if (end != null && (lastEnd == null || end > lastEnd + 0.5)) {
      lastEnd = end
      endMovedAt = now
    }
    if (!wantsToPlay() || video.paused || video.ended || at > lastAt + 0.1) {
      movedAt = now
      wait = STALE_PLAYLIST_SEC * 1000
    } else if (
      !checking &&
      end != null &&
      now >= nextCheckAt &&
      now - movedAt >= STALE_PLAYLIST_SEC * 1000 &&
      now - endMovedAt >= STALE_PLAYLIST_SEC * 1000
    ) {
      check(end).catch(() => undefined)
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
