import Hls from 'hls.js'

import type { SeekKind } from '../../common/observability/contract'
import { watchLivePlaylist } from './livePlaylistWatch'
import { liveRejoin, REJOIN_GIVE_UP_MS } from './liveRejoin'
import { observeLiveStalls } from './liveStallDiagnostics'
import { recoverLiveStalls } from './liveStallRecovery'
import { joinLiveOnFirstPlay, LIVE_DELAY_SEC } from './liveStart'
import { AHEAD_SEC, BEHIND_SEC } from './multiCam/buffering'
import { mediaSourceTakes } from './playable'
import {
  markSeek,
  playbackOf,
  startOf,
  startPlayback,
  surfaceOf,
  videoIdOf
} from './playbackSession'
import { type AttachIntent, type PlayIntent, playIntentOf } from './playIntent'
import { shouldResumeAfterRecovery } from './resumeAfterRecovery'
import { seekableEndOf, type VideoHandle } from './videoHandle'
import {
  type DatedFragment,
  fromFragments,
  fromStartDate,
  type WallMapping
} from './wallMapping'

/**
 * Whether a player's live stalls are reported: the viewer's own single live
 * player, not a grid tile (the grid watches its tiles) and not a card
 * preview, whose stalls would read as the viewer's.
 */
export function reportsLiveStalls(
  intent: PlayIntent | undefined
): intent is PlayIntent & { isLive: NonNullable<PlayIntent['isLive']> } {
  return (
    intent?.isLive != null && intent.buffer == null && intent.preview !== true
  )
}

/**
 * Points a `<video>` at an HLS playlist, whichever way this browser needs.
 *
 * Apple's engine plays HLS itself, with hardware decoding, and is given the
 * URL directly. That is Safari on a Mac, an iPhone and an iPad, and every
 * other browser on an iPhone or iPad, which all run it. WebKit offers Media
 * Source too, and hls.js would happily use it there, but WebKit's Media Source
 * decoder fails on open-GOP HEVC (CRA pictures with leading B-frames), which
 * is what every camera angle and the TS Director programme carry: "Media
 * failed to decode" a few seconds in, then a reset loop. Its own HLS player
 * plays the same files.
 *
 * Chrome and Firefox play no HLS at all without help; hls.js feeds them the
 * segments through Media Source Extensions, which is also where Chrome's HEVC
 * hardware decoding lives. One playlist, one set of files, both paths.
 *
 * Returns the teardown, which the caller must run: hls.js holds a worker and
 * buffers ahead, and leaking one per visited game would eat the tab.
 */

export function attachHls(
  handle: VideoHandle,
  url: string,
  /**
   * Called once when the player has stopped trying. The address itself is the
   * likeliest thing left to be wrong — a playback token that ran out, or one
   * minted by a server that has since restarted — and only the caller can ask
   * for a new one.
   */
  onGiveUp?: () => void,
  given?: AttachIntent
): () => void {
  const intent = playIntentOf(given)
  // The one place the seam is crossed. `VideoHandle` is what the six modules
  // that drive the picture agree on; `src`, `load`, `canPlayType`, the
  // element's `error` and the element hls.js is handed are the browser's own,
  // and they have no equivalent on a phone, which is why the whole of this
  // file has a native sibling rather than a branch inside it. The cast is
  // sound here and nowhere else: this file is only ever reached from the web
  // build, where the handle *is* the element.
  const video = handle as unknown as HTMLVideoElement

  const engine = hlsEngine({
    vendor: typeof navigator === 'undefined' ? '' : navigator.vendor,
    nativeHls: video.canPlayType(HLS_MIME_TYPE) !== '',
    mediaSource: Hls.isSupported(),
    codecSupported: mediaSourceTakes(given?.codecs)
  })
  const session = startPlayback(handle, {
    videoId: videoIdOf(url),
    engine:
      engine === 'native' ? 'native' : engine === 'hls.js' ? 'hlsjs' : 'none',
    surface: surfaceOf(intent, handle),
    live: intent?.isLive != null,
    start: startOf(intent)
  })
  // Nothing here can play it. The element is left alone rather than handed a
  // URL it cannot read, and the owner says so in place of the picture.
  if (engine === 'none') {
    session?.detach()
    intent?.onUnsupported?.()
    return () => undefined
  }
  const detach =
    engine === 'native'
      ? attachNativeHls(video, url, onGiveUp, intent)
      : attachHlsJs(handle, video, url, onGiveUp, intent)
  // A live grid tile only crosses a hole: where it plays is the grid's.
  const stopRecovery =
    intent?.isLive == null
      ? undefined
      : intent.buffer == null
        ? recoverLiveStalls(video, intent.wantsToPlay)
        : recoverLiveStalls(video, intent.wantsToPlay, undefined, {
            holesOnly: true
          })
  const stopJoining =
    intent?.isLive != null &&
    intent.buffer == null &&
    intent.startAtLiveEdge !== false
      ? joinLiveOnFirstPlay(video)
      : undefined
  const stopDiagnostics = reportsLiveStalls(intent)
    ? observeLiveStalls(video, {
        engine,
        isLive: intent.isLive,
        wantsToPlay: intent.wantsToPlay
      })
    : undefined
  return () => {
    // Before the player is emptied, so the closing tally carries where it was.
    session?.detach()
    stopDiagnostics?.()
    stopJoining?.()
    stopRecovery?.()
    detach()
  }
}

/** What a browser that plays HLS itself answers `canPlayType` for. */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl'

/** `navigator.vendor` in every browser built on Apple's WebKit. */
export const APPLE_VENDOR = 'Apple Computer, Inc.'

/** Which player a playlist is handed to. */
export type HlsEngine = 'native' | 'hls.js' | 'none'

/**
 * Who plays the playlist in this browser.
 *
 * - Apple WebKit with native HLS: the browser itself, even where Media Source
 *   exists (iOS 17.1 and later, every Mac), because WebKit's Media Source
 *   decoder is what fails on open-GOP HEVC.
 * - Anything else with Media Source: hls.js. Chrome answers `maybe` for HLS
 *   whether or not it can actually play it, so `canPlayType` decides nothing
 *   outside WebKit.
 * - No Media Source but native HLS (an older iPhone): the browser.
 * - Nobody where the video cannot be decoded: a browser that is not Apple's
 *   needs the video's codec (HEVC or H.264) through Media Source, and Chrome
 *   answers `maybe` to HLS either way (`playable.ts`).
 */
export function hlsEngine(browser: {
  /** `navigator.vendor`. */
  vendor: string
  /** `canPlayType` answered something other than `''` for HLS. */
  nativeHls: boolean
  /** hls.js can run here (`Hls.isSupported()`). */
  mediaSource: boolean
  /** Media Source takes the video's codec (`mediaSourceTakes`). */
  codecSupported?: boolean
}): HlsEngine {
  const { vendor, nativeHls, mediaSource, codecSupported = true } = browser
  if (nativeHls && vendor === APPLE_VENDOR) return 'native'
  if (mediaSource && codecSupported) return 'hls.js'
  return 'none'
}

/**
 * The element as the native path drives it: the handle, plus the members only
 * a browser's `<video>` has.
 */
export interface NativeHlsVideo {
  src: string
  readonly error: { readonly code: number } | null
  readonly paused: boolean
  readonly ended: boolean
  muted: boolean
  currentTime: number
  readonly readyState: number
  readonly seekable: {
    readonly length: number
    start: (index: number) => number
    end: (index: number) => number
  }
  /** Still moving to where it was last sent (`seekStuck`). */
  readonly seeking?: boolean
  readonly buffered?: {
    readonly length: number
    start: (index: number) => number
    end: (index: number) => number
  }
  load: () => void
  play: () => Promise<void>
  pause: () => void
  removeAttribute: (name: 'src') => void
  addEventListener: (
    type: NativeHlsEvent,
    listener: () => void,
    options?: { once?: boolean }
  ) => void
  removeEventListener: (type: NativeHlsEvent, listener: () => void) => void
  /**
   * Safari's wall time for the start of the media: the first fragment's
   * program date-time, or NaN for a playlist without one.
   */
  getStartDate?: () => Date
}

type NativeHlsEvent =
  | 'error'
  | 'canplay'
  | 'loadedmetadata'
  | 'play'
  | 'pause'
  | 'ended'
  | 'seeking'
  | 'seeked'
  | 'emptied'
  | 'durationchange'
  | 'progress'

/**
 * A playlist's fragments as a wall-clock mapping, when every one of them is
 * dated; null otherwise.
 */
export function mappingOfFragments(
  fragments: ReadonlyArray<{
    start: number
    duration: number
    programDateTime?: number | null
  }>
): WallMapping | null {
  const dated: DatedFragment[] = []
  for (const frag of fragments) {
    const date = frag.programDateTime
    if (date == null || !Number.isFinite(date)) return null
    dated.push({
      start: frag.start,
      duration: frag.duration,
      programDateTime: date
    })
  }
  return dated.length === 0 ? null : fromFragments(dated)
}

/**
 * Hands Safari's mapping out as it grows: once it has metadata, and again
 * whenever the seekable end moves on, which is what a live join waits for.
 * Null once, when the playlist turns out to carry no dates.
 */
function reportStartDate(
  video: NativeHlsVideo,
  report: (mapping: WallMapping | null) => void
): () => void {
  let start: number | null = null
  let end: number | null = null
  let saidNone = false
  const look = (): void => {
    const date = video.getStartDate?.().getTime()
    if (date == null || !Number.isFinite(date)) {
      if (!saidNone && video.readyState >= 1) {
        saidNone = true
        report(null)
      }
      return
    }
    const now = seekableEndOf(video)
    if (date === start && (now ?? 0) <= (end ?? 0)) return
    start = date
    end = now
    report(fromStartDate(date, () => seekableEndOf(video)))
  }
  const events: NativeHlsEvent[] = [
    'loadedmetadata',
    'durationchange',
    'progress'
  ]
  for (const name of events) video.addEventListener(name, look)
  return () => {
    for (const name of events) video.removeEventListener(name, look)
  }
}

/** The clock the native path waits on, replaceable in a test. */
export interface RetryClock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const realClock: RetryClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/** `MediaError.MEDIA_ERR_ABORTED`: the load was stopped on purpose. */
const MEDIA_ERR_ABORTED = 1

/**
 * How long a live position put back after a reload has to start playing
 * before the player rejoins the live point instead.
 */
export const RESTORE_PROGRESS_MS = 10_000

/** How often a live player that ran out looks for footage after where it stopped. */
export const RAN_OUT_POLL_MS = 2000
/** How often, meanwhile, it reads its playlist to see whether it was closed. */
export const RAN_OUT_FETCH_MS = 10_000
/**
 * How far past where it stopped the playlist must reach before there is
 * footage to go on with: a segment. A game that really ended can leave the
 * seekable end a hair past the stop, and playing there only ends again.
 */
export const RAN_OUT_AHEAD_SEC = 4
/** How long a seek may stand unfinished before it is taken for one that never will. */
export const SEEK_STUCK_MS = 3000
/** The furthest a stuck seek's retry goes back: a segment. */
export const RETRY_BACK_SEC = 4
/** How near a `seeking` must land to this file's own last seek to be taken for it. */
const OWN_SEEK_SLACK_SEC = 0.5

/**
 * The browser's own HLS player, with the same patience as hls.js gets.
 *
 * The browser loads the segments, refreshes a live playlist and rides out a
 * slow network itself; what it does not do is come back from an error. So the
 * ladder from the hls.js path is kept, number for number — try again, waiting
 * longer each time up to ten seconds, for as long as five minutes — and "try
 * again" means loading the playlist afresh and putting the playhead back where
 * it was. A native player can raise one error for an expired token and then
 * sit there, so the deadline is armed on the clock rather than on the next
 * error, and three reloads that never get as far as a picture make the
 * address the suspect: the caller is asked for a new one.
 *
 * How far ahead it loads is the browser's business here. A grid's buffer
 * control is never handed out, so the grid leaves this tile's limit alone.
 */
export function attachNativeHls(
  video: NativeHlsVideo,
  url: string,
  onGiveUp?: () => void,
  intent?: PlayIntent,
  clock: RetryClock = realClock
): () => void {
  const patience = 5 * 60_000
  /** After this many, the address is the suspect whatever the error said. */
  const MAX_RELOADS = 3
  let firstFailureAt = 0
  let gaveUp = false
  let wait = 1000
  let reloads = 0
  let timer: unknown
  /** Where the playhead was when the trouble started, to put it back. */
  let resumeAtSec = 0
  /** Where a live reload put the playhead back, until it is seen to play. */
  let restoredAt: number | null = null
  let restoreTimer: unknown
  const live = intent?.isLive != null

  // The same split as the hls.js path: a pause during a recovery is the
  // recovery's doing, any other is the viewer's.
  let ownWantsToPlay = !video.paused
  let recovering = false
  /** Whether a recovery is under way, told to the owner as it changes. */
  const setRecovering = (now: boolean): void => {
    if (recovering === now) return
    recovering = now
    intent?.onRecovery?.(now)
  }
  const wantsToPlay = (): boolean =>
    intent == null ? ownWantsToPlay : intent.wantsToPlay()
  /**
   * Where this file's own last seek went — a retry, the way back after a
   * reload, a jump to the live point, a rejoin — until its `seeking`, which
   * Safari fires later, as a task, is heard. A `seeking` is taken for this
   * file's own by where it went, not by count: two seeks in one moment are
   * heard as one `seeking`, at the later one's place. Only a seek the viewer
   * or the grid makes starts the seek watch's count afresh (`onSeeking`).
   */
  let ownSeekTarget: number | null = null
  const seekTo = (sec: number, kind: SeekKind): void => {
    markSeek(video, kind)
    ownSeekTarget = sec
    video.currentTime = sec
  }
  /** To the live point, `LIVE_DELAY_SEC` behind the newest footage; false when there is no live range to go to. */
  /** The live point, `LIVE_DELAY_SEC` behind the newest footage; null without a live range to go to. */
  const livePoint = (): number | null => {
    const ranges = video.seekable
    if (ranges.length === 0) return null
    const index = ranges.length - 1
    const start = ranges.start(index)
    const end = ranges.end(index)
    if (!Number.isFinite(end) || end <= start) return null
    return Math.max(start, end - LIVE_DELAY_SEC)
  }

  /** The reload under way is the seek watch's: it goes back to the seek's target and stays there. */
  let seekWatchReload = false
  const onPlay = (): void => {
    ownWantsToPlay = true
    // A play, the viewer's or its own, settles any run-out (below).
    stopRanOut()
  }
  const onPause = (): void => {
    if (!recovering) ownWantsToPlay = false
  }

  /**
   * A live single player that ran out of footage during a long camera cut
   * (#327). Safari plays to the end of what it has, pauses and says `ended`,
   * and its owner — whose wish follows the element's pauses — reads that
   * pause as the viewer's. The playlist then carries on under it and nothing
   * plays it again, through this cut and every later one.
   *
   * So `ended` while live is the player running out, not the game ending.
   * Once there is footage after where it stopped, it goes on from there, or
   * from the live point when the game has moved further than the cushion,
   * and plays when it is wanted — or not wanted only because of the end's
   * own pause, unchanged since (`wantedAtEnd`, as the hls.js path keeps it).
   * A playlist the server actually closed is handed to `liveRejoin`, which
   * waits for it to open again and loads it afresh.
   */
  // The viewer's own single player only: a card preview (`preview`) is left
  // to end, as its stalls are left unreported.
  const runOutIsLive =
    intent?.buffer == null && intent?.preview !== true
      ? intent?.isLive
      : undefined
  const watchesRunOut = runOutIsLive != null
  let ranOut:
    { endedAt: number; wantedAtEnd: boolean; sinceMs: number } | undefined
  /** An episode's `wantedAtEnd`, kept for `liveRejoin`'s rejoin. */
  let handedWanted: boolean | undefined
  let lookTimer: unknown
  let lastReadMs = 0
  const stopRanOut = (): void => {
    ranOut = undefined
    handedWanted = undefined
    if (lookTimer != null) clock.clearTimeout(lookTimer)
    lookTimer = undefined
  }
  const playIfWanted = (wantedAtEnd: boolean | undefined): void => {
    if (wantsToPlay() || wantedAtEnd === false)
      video.play().catch(() => undefined)
  }
  const readPlaylist = async (): Promise<string> => {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`playlist ${response.status}`)
    return await response.text()
  }
  const rejoiner =
    runOutIsLive == null
      ? undefined
      : liveRejoin({
          isLive: runOutIsLive,
          fetchPlaylist: readPlaylist,
          clock,
          rejoin: () => {
            playbackOf(video)?.recovery('rejoin')
            const wanted = handedWanted
            handedWanted = undefined
            noteResumeAt()
            setRecovering(true)
            reload()
            if (!wantsToPlay() && wanted === false)
              video.play().catch(() => undefined)
          }
        })
  const lookAfterRunOut = (): void => {
    lookTimer = undefined
    const episode = ranOut
    if (episode == null) return
    const now = clock.now()
    if (now - episode.sinceMs > REJOIN_GIVE_UP_MS) {
      ranOut = undefined
      return
    }
    const end = seekableEndOf(video) ?? NaN
    if (Number.isFinite(end) && end > episode.endedAt + RAN_OUT_AHEAD_SEC) {
      ranOut = undefined
      playbackOf(video)?.recovery('rejoin')
      seekTo(Math.max(episode.endedAt, end - LIVE_DELAY_SEC), 'cushion_join')
      playIfWanted(episode.wantedAtEnd)
      return
    }
    if (now - lastReadMs >= RAN_OUT_FETCH_MS) {
      lastReadMs = now
      readPlaylist()
        .then(text => {
          if (ranOut !== episode || !text.includes('#EXT-X-ENDLIST')) return
          ranOut = undefined
          if (lookTimer != null) clock.clearTimeout(lookTimer)
          lookTimer = undefined
          handedWanted = episode.wantedAtEnd
          rejoiner?.ended()
        })
        .catch(() => undefined)
    }
    lookTimer = clock.setTimeout(lookAfterRunOut, RAN_OUT_POLL_MS)
  }
  const onEnded = (): void => {
    if (!watchesRunOut) return
    stopRanOut()
    const now = clock.now()
    ranOut = {
      endedAt: video.currentTime,
      wantedAtEnd: wantsToPlay(),
      sinceMs: now
    }
    lastReadMs = now
    lookTimer = clock.setTimeout(lookAfterRunOut, RAN_OUT_POLL_MS)
  }

  /**
   * Where a reload puts it back: where it stands, unless it stands where a
   * recovery put it. A restored position that has played on since is the
   * viewer's again: a second error in the restore's check went back to the
   * first restore point, and the viewer saw those seconds again.
   */
  const noteResumeAt = (): void => {
    if (video.currentTime <= 0) return
    if (
      !recovering ||
      (restoredAt != null && video.currentTime - restoredAt >= 1)
    ) {
      resumeAtSec = video.currentTime
    }
  }

  const giveUp = (): void => {
    if (gaveUp) return
    gaveUp = true
    playbackOf(video)?.recovery('give_up', reloads)
    onGiveUp?.()
  }

  const cancelRestoreCheck = (): void => {
    if (restoreTimer != null) clock.clearTimeout(restoreTimer)
    restoreTimer = undefined
    restoredAt = null
  }

  /**
   * The restored live position has had its time. A publisher cut leaves a
   * hole in the timeline where the player stood, and Safari reloaded there
   * waits in it for good, black — paused or "playing" — while only a jump to
   * live brought the picture back. So a position that has not played on is
   * given up for the live point; one that has (a viewer's rewind) is kept, and
   * so is one the viewer has since moved.
   */
  const checkRestored = (): void => {
    restoreTimer = undefined
    const at = restoredAt
    restoredAt = null
    if (at == null) return
    const wanted = wantsToPlay()
    if (wanted && Math.abs(video.currentTime - at) < 1) {
      const point = livePoint()
      if (point != null) {
        playbackOf(video)?.recovery('restore_abandoned')
        seekTo(point, 'cushion_join')
      }
    }
    const resume = shouldResumeAfterRecovery({
      recovering,
      wantsToPlay: wanted,
      paused: video.paused
    })
    setRecovering(false)
    resumeAtSec = 0
    if (resume) video.play().catch(() => undefined)
  }

  const seekBack = (): void => {
    // A seek the watch reloaded for was the viewer's or the grid's own
    // choice, not a camera's hole: it is gone back to and left there, never
    // moved to the live point. Read, and cleared, whatever happens next, so
    // no later reload takes it for the watch's.
    const forSeek = seekWatchReload
    seekWatchReload = false
    if (resumeAtSec <= 0) return
    seekTo(resumeAtSec, 'reload_restore')
    if (!live || forSeek) return
    cancelRestoreCheck()
    restoredAt = resumeAtSec
    restoreTimer = clock.setTimeout(checkRestored, RESTORE_PROGRESS_MS)
  }

  const reload = (): void => {
    cancelRestoreCheck()
    video.removeEventListener('loadedmetadata', seekBack)
    video.addEventListener('loadedmetadata', seekBack, { once: true })
    // Asked before the load: a reset element is paused.
    const wanted = wantsToPlay()
    video.load()
    // An iPhone loads nothing into an element that has not been played: a
    // reload left there sat blank, paused and without an error for good, and
    // its `canplay` — which `recovered` waits on to play it — never came.
    if (wanted) video.play().catch(() => undefined)
  }

  /** Pictures again: the trouble has passed, and it may resume. */
  const recovered = (): void => {
    firstFailureAt = 0
    wait = 1000
    reloads = 0
    if (!recovering) return
    const wanted = shouldResumeAfterRecovery({
      recovering,
      wantsToPlay: wantsToPlay(),
      paused: video.paused
    })
    // A restored live position stays a recovery until it is seen to play,
    // so a pause in it is still the reload's and not the viewer's.
    if (restoredAt == null) {
      setRecovering(false)
      resumeAtSec = 0
    }
    if (wanted) video.play().catch(() => undefined)
  }

  /**
   * A seek Safari starts and never finishes (#326). Sent 0.2 s before the end
   * of the one segment it held, Safari's player began the seek and stood
   * there for good: `seeking`, nothing drawn, nothing more loaded, while the
   * playlist grew under it — and no other recovery here looks at a seek.
   *
   * So a seek that has stood `SEEK_STUCK_MS` with nothing arriving — each
   * `progress` starts the count again, so a seek a slow network is still
   * loading is left to finish — is retried once from up to a segment
   * (`RETRY_BACK_SEC`) before it, within the buffered range that holds it:
   * footage Safari already has, which it can draw without fetching anything;
   * one that still stands,
   * or that no buffered range holds, reloads the player, which goes back to
   * where it was. At most once a seek: the reload's own seek back can be
   * retried but never reloads again. If that one wedges as well, the watch
   * stops there: it ends the recovery, so the viewer's own pause and play
   * count again, and moves a live player to the live point, where its
   * footage is still arriving. A reload already scheduled for an error, or a
   * player that gave up, is left to that path. Every Safari player: the
   * single one, a grid tile, a recording.
   */
  let seekTimer: unknown
  /** Whether this seek is already a retry. */
  let seekRetried = false
  /** Whether the next `seeking` is the retry's own. */
  let retrySeek = false
  /** Whether this seek has already reloaded the player. */
  let seekReloaded = false
  /**
   * The watch took its last step for this seek: its own seeks are no longer
   * watched until a seek of the viewer's or the grid's, or one finishes.
   */
  let seekGaveUp = false
  /** Whether the seek being watched is this file's own. */
  let watchedOwn = false
  const stopSeekWatch = (): void => {
    if (seekTimer != null) clock.clearTimeout(seekTimer)
    seekTimer = undefined
  }
  const seekStuck = (): void => {
    seekTimer = undefined
    if (video.seeking !== true) return
    const target = video.currentTime
    const ranges = video.buffered
    let from: number | null = null
    if (ranges != null) {
      for (let index = 0; index < ranges.length; index++) {
        if (ranges.start(index) <= target && target <= ranges.end(index))
          from = ranges.start(index)
      }
    }
    if (!seekRetried && from != null && from < target) {
      seekRetried = true
      retrySeek = true
      // Back to the segment it is in, never further: a buffered range runs
      // across every segment Safari holds in a row, and its start can be
      // minutes behind.
      seekTo(Math.max(from, target - RETRY_BACK_SEC), 'stall_recovery')
      return
    }
    seekRetried = false
    // An error's reload is on its way, or the player gave up: theirs.
    if (timer != null || gaveUp) return
    if (seekReloaded) {
      // The way back after this seek's reload wedged too: the last step.
      lastResort()
      return
    }
    seekReloaded = true
    // Only the viewer's or the grid's seek is left where it went: a
    // recovery's own way back keeps the restore check it would have had.
    seekWatchReload = !watchedOwn
    // Back to the stuck seek's own target, which is the viewer's or the
    // grid's choice — not to where a recovery under way last put it.
    if (target > 0) resumeAtSec = target
    setRecovering(true)
    playbackOf(video)?.recovery('stall_reload')
    reload()
  }
  /**
   * The watch's last step for one seek: the recovery ends, so a pause or a
   * play is the viewer's again, and a live player goes to the live point,
   * where footage is still arriving rather than where it would not come.
   */
  const lastResort = (): void => {
    seekGaveUp = true
    setRecovering(false)
    resumeAtSec = 0
    const point = live ? livePoint() : null
    if (point != null) seekTo(point, 'cushion_join')
  }
  const watchSeek = (): void => {
    stopSeekWatch()
    seekTimer = clock.setTimeout(seekStuck, SEEK_STUCK_MS)
  }
  /** Something arrived: a seek still under way is loading, not stuck. */
  const onProgress = (): void => {
    if (seekTimer != null) watchSeek()
  }
  /** Loaded afresh: a seek still pending is gone, and so is its `seeking`. */
  const onEmptied = (): void => {
    stopSeekWatch()
    ownSeekTarget = null
    retrySeek = false
  }
  /** A seek finished: whatever it took, the next one starts afresh. */
  const onSeeked = (): void => {
    stopSeekWatch()
    seekReloaded = false
    seekRetried = false
    seekGaveUp = false
  }
  const onSeeking = (): void => {
    // A seek of the viewer's or the grid's counts afresh; the retry's own
    // is the one retry.
    if (retrySeek) retrySeek = false
    else seekRetried = false
    // Only the viewer's or the grid's seek starts afresh: one of this
    // file's own — the way back after the watch's reload, a jump to live —
    // is the same seek, and may not reload again.
    const own =
      ownSeekTarget != null &&
      Math.abs(video.currentTime - ownSeekTarget) < OWN_SEEK_SLACK_SEC
    ownSeekTarget = null
    watchedOwn = own
    if (!own) {
      seekReloaded = false
      seekGaveUp = false
      // The viewer moved it: a run-out's rejoin would undo where they went.
      stopRanOut()
    }
    if (seekGaveUp) return
    watchSeek()
  }

  const onError = (): void => {
    // A load this file or the caller stopped on purpose is not trouble.
    if (video.error == null || video.error.code === MEDIA_ERR_ABORTED) return
    if (gaveUp || timer != null) return
    const now = clock.now()
    if (firstFailureAt === 0) firstFailureAt = now
    reloads += 1
    if (reloads > MAX_RELOADS || now - firstFailureAt > patience) {
      giveUp()
      return
    }
    noteResumeAt()
    // The reload this schedules arms a check of its own; the last one, firing
    // first, would clear where it is to go back to.
    cancelRestoreCheck()
    setRecovering(true)
    timer = clock.setTimeout(() => {
      timer = undefined
      if (clock.now() - firstFailureAt > patience) {
        giveUp()
        return
      }
      wait = Math.min(wait * 2, 10_000)
      playbackOf(video)?.recovery('reload', reloads)
      reload()
    }, wait)
  }

  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  video.addEventListener('ended', onEnded)
  video.addEventListener('seeking', onSeeking)
  video.addEventListener('seeked', onSeeked)
  video.addEventListener('emptied', onEmptied)
  video.addEventListener('progress', onProgress)
  video.addEventListener('canplay', recovered)
  video.addEventListener('error', onError)
  const onWallMapping = intent?.onWallMapping
  const stopDates =
    onWallMapping == null ? undefined : reportStartDate(video, onWallMapping)
  video.src = url
  playbackOf(video)?.sourceSet()
  const stopPriming =
    intent?.buffer == null
      ? undefined
      : primeSilently(video, wantsToPlay, intent.onSoundHeld, intent.muted)

  // Safari can stop reading a live playlist without an error to say so; only
  // the single live viewer is watched for it, as the phones are.
  const stopWatching =
    intent?.isLive != null && intent.buffer == null
      ? watchLivePlaylist(video, {
          url,
          wantsToPlay,
          reload: () => {
            if (timer != null) return
            playbackOf(video)?.recovery('playlist_watch_reload')
            noteResumeAt()
            setRecovering(true)
            reload()
          },
          clock
        })
      : undefined

  return () => {
    stopPriming?.()
    stopDates?.()
    stopWatching?.()
    if (timer != null) clock.clearTimeout(timer)
    timer = undefined
    cancelRestoreCheck()
    setRecovering(false)
    video.removeEventListener('play', onPlay)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('ended', onEnded)
    video.removeEventListener('seeking', onSeeking)
    video.removeEventListener('seeked', onSeeked)
    video.removeEventListener('emptied', onEmptied)
    video.removeEventListener('progress', onProgress)
    video.removeEventListener('canplay', recovered)
    video.removeEventListener('error', onError)
    video.removeEventListener('loadedmetadata', seekBack)
    stopRanOut()
    stopSeekWatch()
    rejoiner?.stop()
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * Plays a grid tile on WebKit's own player once, silently, to its first frame,
 * and stops it there unless the grid wants it playing by then — then silent,
 * its sound left for a tap (`onSoundHeld`).
 *
 * An iPhone loads nothing into an element that has not been played, and the
 * grid holds a tile paused until it holds a few seconds: opened without a tap
 * — a reload of the player, a shared address — the tile said it was loading
 * for ever. A silent play is one Safari allows without a tap. A tile it stops
 * gets its sound back as it was; the grid asks for that again when it starts
 * it.
 */
function primeSilently(
  video: NativeHlsVideo,
  wantsToPlay: () => boolean,
  onSoundHeld?: () => void,
  wantsMuted?: () => boolean
): () => void {
  if (!video.paused) return () => undefined
  const before = video.muted
  /** The sound to put back: what the owner wants now, else what it had. */
  const sound = (): boolean => wantsMuted?.() ?? before
  let done = false
  const finish = (reached: boolean): void => {
    if (done) return
    done = true
    video.removeEventListener('canplay', primed)
    if (reached && wantsToPlay()) {
      // Left playing, and silent: an iPhone pauses a player that started
      // silently and is unmuted without a tap, so its sound waits for one.
      if (!sound()) onSoundHeld?.()
      return
    }
    if (reached) video.pause()
    video.muted = sound()
  }
  const primed = (): void => {
    finish(true)
  }
  video.addEventListener('canplay', primed)
  video.muted = true
  video.play().catch(() => {
    finish(false)
  })
  return () => {
    finish(false)
  }
}

/** hls.js over Media Source: every browser that is not Apple's. */
function attachHlsJs(
  handle: VideoHandle,
  video: HTMLVideoElement,
  url: string,
  onGiveUp?: () => void,
  intent?: PlayIntent
): () => void {
  // `maxBufferLength` is where hls.js starts, not where it stops: it loads
  // whenever the buffer is shorter than this and grows the target from there
  // as bandwidth allows, up to `maxMaxBufferLength`. A ceiling is the two set
  // to the same number.
  const limit = intent?.buffer
  const live = intent?.isLive != null
  const hls = new Hls({
    // A game is watched by seeking around it, not straight through, so there
    // is no point buffering minutes ahead of a position about to change:
    // half a minute, for every player, a grid's tiles included. The same
    // number twice is a ceiling.
    maxBufferLength: limit?.aheadSec ?? AHEAD_SEC,
    // Keep room for delayed playlist updates, on every live player, a grid's
    // tiles included. A time-based live position avoids letting one
    // unusually long segment choose the viewer's delay.
    ...(live ? { liveSyncDuration: LIVE_DELAY_SEC } : {}),
    maxMaxBufferLength: limit?.aheadSec ?? AHEAD_SEC,
    // Where its owner has already placed it, if it has.
    ...(intent?.startSec == null ? {} : { startPosition: intent.startSec }),
    // Left to itself hls.js keeps every second already played, and a long
    // game fills the browser's quota with the past until it refuses the
    // future. Two steps of ten seconds back still come from memory.
    backBufferLength: BEHIND_SEC
  })

  /**
   * A live game is watched while it is being written, and the writer is
   * allowed to stumble: a segment named in the playlist can be a moment from
   * existing, a reconnect restarts the writer, a phone at a field loses the
   * network for a minute. hls.js stops dead on a fatal error unless it is told
   * to carry on, and a player that stopped dead looks to a parent like a game
   * that ended.
   *
   * So it is tried again, waiting longer each time up to ten seconds, for as
   * long as five minutes — long enough to ride out a field losing its signal
   * between innings, and short enough that a token which has genuinely run out
   * is not retried for the rest of the afternoon. It is never destroyed here:
   * that empties the frame and sends the position back to nought, which is a
   * worse thing to be looking at than a picture that has stopped.
   */
  const patience = 5 * 60_000
  let firstFailureAt = 0
  let gaveUp = false
  let wait = 1000
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * Whether the viewer wants this playing, so a recovery can put it back.
   *
   * `recoverMediaError` detaches the media element and attaches it again, and
   * detaching calls `load()` — which resets the element, and a reset element is
   * **paused**. Nothing put it back, so a stumble in the stream stopped the
   * picture and left it stopped until somebody pressed play. On a game being
   * watched by a parent that is indistinguishable from the game ending.
   *
   * A pause the viewer asked for still has to be honoured, so the two are kept
   * apart: a pause that arrives while a recovery is in flight is the recovery's
   * doing, and any other is theirs.
   */
  let ownWantsToPlay = !handle.paused
  let recovering = false
  /** The caller's answer where there is one, and ours where there is not. */
  const wantsToPlay = (): boolean =>
    intent == null ? ownWantsToPlay : intent.wantsToPlay()
  /**
   * Whether to play once a live game has been rejoined: whether it was
   * playing when it ran out, which is a pause of its own, not the viewer's.
   */
  let playAfterRejoin = !handle.paused
  /**
   * What the caller wanted the moment it ran out, read once the end's own
   * pause has been heard by everybody. A caller whose intent follows the
   * element's pauses — the single player's does — reads the end as a pause,
   * and that is not the viewer stopping it. One whose intent goes from
   * wanting to not wanting after the end — a grid the viewer paused, which
   * leaves an already paused tile without a pause event — has been stopped,
   * and the rejoin leaves it stopped.
   */
  let wantedAtEnd: boolean | undefined
  const onPlay = (): void => {
    ownWantsToPlay = true
    playAfterRejoin = true
    wantedAtEnd = undefined
  }
  const onEnded = (): void => {
    wantedAtEnd = wantsToPlay()
  }
  const onPause = (): void => {
    if (recovering) return
    ownWantsToPlay = false
    if (!video.ended) playAfterRejoin = false
  }
  handle.addEventListener('play', onPlay)
  handle.addEventListener('pause', onPause)
  // The web element's own event: no native player is handed this path.
  video.addEventListener('ended', onEnded)

  /** Puts it back to playing, if that is what it was doing. */
  const resume = (): void => {
    if (!recovering) return
    const wanted = shouldResumeAfterRecovery({
      recovering,
      wantsToPlay: wantsToPlay(),
      paused: handle.paused
    })
    recovering = false
    if (!wanted) return
    // A promise, and a rejected one is not an error worth showing: an autoplay
    // policy that refuses here would have refused the first play too.
    handle.play().catch(() => undefined)
  }

  const session = playbackOf(handle)
  hls.on(Hls.Events.ERROR, (event, data) => {
    session?.hlsError(data.type, data.details, data.fatal)
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      recovering = true
      session?.recovery('media_recover')
      hls.recoverMediaError()
      return
    }
    if (data.type !== Hls.ErrorTypes.NETWORK_ERROR) {
      hls.stopLoad()
      return
    }
    const now = Date.now()
    if (firstFailureAt === 0) firstFailureAt = now
    if (now - firstFailureAt > patience) {
      hls.stopLoad()
      if (!gaveUp) {
        gaveUp = true
        session?.recovery('give_up')
        onGiveUp?.()
      }
      return
    }
    if (timer != null) return
    recovering = true
    session?.recovery('network_retry')
    timer = setTimeout(() => {
      timer = undefined
      wait = Math.min(wait * 2, 10_000)
      hls.startLoad()
    }, wait)
  })
  // Anything that loads is proof the trouble has passed, so the next one
  // starts from a short wait again rather than from wherever this one ended.
  hls.on(Hls.Events.FRAG_LOADED, () => {
    firstFailureAt = 0
    wait = 1000
    session?.bandwidth(hls.bandwidthEstimate)
  })
  hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    const bitrate = hls.levels[data.level]?.bitrate
    if (bitrate != null) session?.bitrate(bitrate)
  })
  // Buffered, not merely loaded: there are now pictures to show, which is the
  // moment it is worth asking the element to play them again.
  hls.on(Hls.Events.FRAG_BUFFERED, resume)
  hls.on(Hls.Events.MEDIA_ATTACHED, resume)

  /**
   * A live game whose playlist was closed under it, while the game still
   * lists the video as live: wait for the playlist to open again, then load
   * it afresh. Where the player was following the game it rejoins the live
   * edge; where somebody was watching an earlier moment it stays there.
   *
   * Following is where the playhead is, not whether the playlist was live:
   * at the end of the closed playlist, or within the distance hls.js itself
   * keeps a live player behind that end, and a segment more.
   */
  let closedAt: { edgeSec: number; targetSec: number } | undefined
  const following = (): boolean =>
    video.ended ||
    (closedAt != null &&
      atLiveEdge(
        video.currentTime,
        closedAt.edgeSec,
        closedAt.targetSec,
        hls.config.liveSyncDurationCount,
        hls.config.liveSyncDuration
      ))
  let rejoining = false
  const isLive = intent?.isLive
  const rejoiner =
    isLive == null
      ? undefined
      : liveRejoin({
          isLive,
          fetchPlaylist: async () =>
            await (await fetch(url, { cache: 'no-store' })).text(),
          rejoin: () => {
            session?.recovery('rejoin')
            rejoining = true
            recovering = true
            hls.config.startPosition = following() ? -1 : video.currentTime
            hls.loadSource(url)
          }
        })
  // The playlist's dates, each time it is read: a live one grows.
  const onWallMapping = intent?.onWallMapping
  if (onWallMapping != null) {
    const dates = (
      _event: unknown,
      data: { details: { fragments: Parameters<typeof mappingOfFragments>[0] } }
    ): void => {
      onWallMapping(mappingOfFragments(data.details.fragments))
    }
    hls.on(Hls.Events.LEVEL_LOADED, dates)
    hls.on(Hls.Events.LEVEL_UPDATED, dates)
  }
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    const { details } = data
    session?.targetDuration(details.targetduration)
    if (details.live) return
    closedAt =
      Number.isFinite(details.edge) && Number.isFinite(details.targetduration)
        ? { edgeSec: details.edge, targetSec: details.targetduration }
        : undefined
    rejoiner?.ended()
  })
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    if (!rejoining) return
    rejoining = false
    recovering = false
    const stillWanted = wantsToPlay() || wantedAtEnd === false
    if (playAfterRejoin && stillWanted) handle.play().catch(() => undefined)
  })

  hls.loadSource(url)
  hls.attachMedia(video)
  session?.sourceSet()
  return () => {
    if (timer != null) clearTimeout(timer)
    rejoiner?.stop()
    handle.removeEventListener('play', onPlay)
    handle.removeEventListener('pause', onPause)
    video.removeEventListener('ended', onEnded)
    hls.destroy()
  }
}

/**
 * Whether a playhead is following a live playlist that ends at `edgeSec`:
 * no further behind it than hls.js keeps a live player (`syncCount` target
 * durations), and one segment more for the one it was waiting on.
 */
export function atLiveEdge(
  currentSec: number,
  edgeSec: number,
  targetSec: number,
  syncCount: number,
  syncSec?: number
): boolean {
  return edgeSec - currentSec <= (syncSec ?? syncCount * targetSec) + targetSec
}
