import Hls from 'hls.js'

import { liveRejoin } from './liveRejoin'
import { recoverLiveStalls } from './liveStallRecovery'
import { BEHIND_SEC } from './multiCam/buffering'
import type { BufferControl, PlayIntent } from './playIntent'
import { shouldResumeAfterRecovery } from './resumeAfterRecovery'
import type { VideoHandle } from './videoHandle'

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
  intent?: PlayIntent
): () => void {
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
    mediaSource: Hls.isSupported()
  })
  // Neither Media Source nor native HLS. The element is left alone rather
  // than handed a URL it cannot read.
  if (engine === 'none') return () => undefined
  const detach =
    engine === 'native'
      ? attachNativeHls(video, url, onGiveUp, intent)
      : attachHlsJs(handle, video, url, onGiveUp, intent)
  // A grid owns its tiles' positions and buffering; only the single live
  // viewer may step across a missing stretch on its own.
  const stopRecovery =
    intent?.isLive != null && intent.buffer == null
      ? recoverLiveStalls(video, intent.wantsToPlay)
      : undefined
  return () => {
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
 */
export function hlsEngine(browser: {
  /** `navigator.vendor`. */
  vendor: string
  /** `canPlayType` answered something other than `''` for HLS. */
  nativeHls: boolean
  /** hls.js can run here (`Hls.isSupported()`). */
  mediaSource: boolean
}): HlsEngine {
  const { vendor, nativeHls, mediaSource } = browser
  if (nativeHls && (vendor === APPLE_VENDOR || !mediaSource)) return 'native'
  if (mediaSource) return 'hls.js'
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
  currentTime: number
  readonly readyState: number
  load: () => void
  play: () => Promise<void>
  removeAttribute: (name: 'src') => void
  addEventListener: (
    type: 'error' | 'canplay' | 'loadedmetadata' | 'play' | 'pause',
    listener: () => void,
    options?: { once?: boolean }
  ) => void
  removeEventListener: (
    type: 'error' | 'canplay' | 'loadedmetadata' | 'play' | 'pause',
    listener: () => void
  ) => void
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

  // The same split as the hls.js path: a pause during a recovery is the
  // recovery's doing, any other is the viewer's.
  let ownWantsToPlay = !video.paused
  let recovering = false
  const wantsToPlay = (): boolean =>
    intent == null ? ownWantsToPlay : intent.wantsToPlay()
  const onPlay = (): void => {
    ownWantsToPlay = true
  }
  const onPause = (): void => {
    if (!recovering) ownWantsToPlay = false
  }

  const giveUp = (): void => {
    if (gaveUp) return
    gaveUp = true
    onGiveUp?.()
  }

  const seekBack = (): void => {
    if (resumeAtSec > 0) video.currentTime = resumeAtSec
  }

  const reload = (): void => {
    video.removeEventListener('loadedmetadata', seekBack)
    video.addEventListener('loadedmetadata', seekBack, { once: true })
    video.load()
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
    recovering = false
    resumeAtSec = 0
    if (wanted) video.play().catch(() => undefined)
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
    if (!recovering && video.currentTime > 0) resumeAtSec = video.currentTime
    recovering = true
    timer = clock.setTimeout(() => {
      timer = undefined
      if (clock.now() - firstFailureAt > patience) {
        giveUp()
        return
      }
      wait = Math.min(wait * 2, 10_000)
      reload()
    }, wait)
  }

  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  video.addEventListener('canplay', recovered)
  video.addEventListener('error', onError)
  video.src = url

  return () => {
    if (timer != null) clock.clearTimeout(timer)
    timer = undefined
    video.removeEventListener('play', onPlay)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('canplay', recovered)
    video.removeEventListener('error', onError)
    video.removeEventListener('loadedmetadata', seekBack)
    video.removeAttribute('src')
    video.load()
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
  const singleLive = intent?.isLive != null && limit == null
  const hls = new Hls({
    // A game is watched by seeking around it, not straight through, so there
    // is no point buffering minutes ahead of a position about to change.
    maxBufferLength: limit?.aheadSec ?? (singleLive ? 60 : 30),
    // Keep room for delayed playlist updates. A time-based live position
    // avoids letting one unusually long segment choose the viewer's delay.
    ...(singleLive ? { liveSyncDuration: 60 } : {}),
    ...(limit == null ? {} : { maxMaxBufferLength: limit.aheadSec }),
    // Left to itself hls.js keeps every second already played, and a long
    // game fills the browser's quota with the past until it refuses the
    // future. Two steps of ten seconds back still come from memory.
    backBufferLength: BEHIND_SEC
  })

  if (limit?.onControl != null) {
    limit.onControl(aheadControl(hls.config, limit.aheadSec))
  }

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

  hls.on(Hls.Events.ERROR, (event, data) => {
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      recovering = true
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
        onGiveUp?.()
      }
      return
    }
    if (timer != null) return
    recovering = true
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
            rejoining = true
            recovering = true
            hls.config.startPosition = following() ? -1 : video.currentTime
            hls.loadSource(url)
          }
        })
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    const { details } = data
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
  return () => {
    if (timer != null) clearTimeout(timer)
    rejoiner?.stop()
    handle.removeEventListener('play', onPlay)
    handle.removeEventListener('pause', onPause)
    video.removeEventListener('ended', onEnded)
    limit?.onControl?.(null)
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

/**
 * Moves a running hls.js player's limit on how far ahead it loads.
 *
 * hls.js reads both numbers afresh on every tick, so writing them is enough.
 * When an append is refused for want of room, hls.js halves its own
 * ceiling; putting the old one back on the next call would only be refused
 * again, so a cut it made stands as the new top.
 */
export function aheadControl(
  config: { maxBufferLength: number; maxMaxBufferLength: number },
  startSec: number
): BufferControl {
  let roomSec = Number.POSITIVE_INFINITY
  let askedSec = startSec
  return {
    setAheadSec: seconds => {
      if (config.maxMaxBufferLength < askedSec) {
        roomSec = config.maxMaxBufferLength
      }
      askedSec = Math.min(seconds, roomSec)
      config.maxBufferLength = askedSec
      config.maxMaxBufferLength = askedSec
    }
  }
}
