import { onExplicitSeek } from './explicitSeek'
import { joinLiveWithCushion } from './liveCushion'
import { reloadStalledLive } from './liveReload'
import { NativeVideoHandle } from './nativeVideoHandle'
import type { PlayIntent } from './playIntent'
import { addressIsWrong } from './videoError'
import type { VideoHandle } from './videoHandle'

/**
 * The same patience, over a player that already speaks HLS.
 *
 * Nothing here attaches anything. AVPlayer and ExoPlayer read a playlist
 * themselves — there is no Media Source to feed and no `hls.js` to hold — so
 * `VideoView.native.tsx` hands the URL straight to the player and this file is
 * left with the half that actually mattered: **a live game is watched while it
 * is being written, and the writer is allowed to stumble.** A segment named in
 * the playlist can be a moment from existing, a reconnect restarts the writer,
 * a phone at a field loses the network between innings. A player that gave up
 * at the first of those looks to a parent like a game that ended.
 *
 * So the ladder from the web file is kept, number for number: try again,
 * waiting longer each time up to ten seconds, for as long as five minutes.
 * Two things are different.
 *
 * **What "try again" means.** In a browser hls.js owns the segment loads and
 * can simply start loading again; here the player owns them, so the stream is
 * asked for a second time.
 *
 * **When to stop asking.** The web file can wait for the next error because
 * hls.js keeps producing them. A native player may raise one error for an
 * expired token and then sit there, so waiting for a second would mean waiting
 * for ever: the deadline is armed on the clock instead. And a failure that
 * names the *address* rather than the network escalates immediately, because
 * the same URL will never work and the caller's answer — a freshly signed one
 * — always will.
 */
export function attachHls(
  handle: VideoHandle,
  url: string,
  onGiveUp?: () => void,
  /**
   * What the caller knows about the viewer's wish, for a caller that pauses
   * the player itself (the multi-camera grid). The buffer limit is the web's:
   * AVPlayer and ExoPlayer size their own.
   */
  intent?: PlayIntent
): () => void {
  if (!(handle instanceof NativeVideoHandle)) {
    // Nothing else can be driven from here. Silently doing nothing is better
    // than throwing inside a ref callback, but silence is also how a video
    // that never plays and never errors becomes an afternoon of guessing, so
    // it says so where anybody is listening.
    if (__DEV__) {
      console.warn('attachHls was handed something that is not a native player')
    }
    return () => undefined
  }

  // A phone's player reads no dates from the stream: the owner places it by
  // the server's wall timeline, or its start (`wallMapping.ts`).
  intent?.onWallMapping?.(null)

  const patience = 5 * 60_000
  /** After this many, the address is the suspect whatever the error said. */
  const MAX_RELOADS = 3
  let firstFailureAt = 0
  let gaveUp = false
  let wait = 1000
  let reloads = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * Whether the viewer wants this playing, so a reload can put it back.
   *
   * Handing a player its source again resets it, and a reset player is
   * **paused**. Nothing would put it back, so a stumble in the stream would
   * stop the picture and leave it stopped until somebody pressed play — which
   * on a game being watched by a parent is indistinguishable from the game
   * ending. A pause the viewer asked for still has to be honoured, so the two
   * are kept apart exactly as they are on the web: a pause that arrives while
   * a recovery is in flight is the recovery's doing, and any other is theirs.
   */
  let wantsToPlay = !handle.paused
  let recovering = false
  /**
   * The player reported an error and has not shown a picture since. A play
   * pressed now goes to a player that has given up: AVPlayer, once it has
   * failed a live stream, ignores its play button for good. So the press
   * loads the stream again first.
   */
  let failed = false
  /**
   * Where the player was when it last reported a failure, until it has played
   * on from there. Kept apart from `failed`, which a `canplay` clears: iOS
   * sends that whenever AVPlayer changes its mind about keeping up, picture or
   * not, and a failed AVPlayer raises no second error to set it again.
   */
  let failedAt: number | null = null
  const hasFailed = (): boolean => {
    if (failedAt == null) return false
    if (handle.currentTime > failedAt + 0.5) failedAt = null
    return failedAt != null
  }
  /** Where to put the playhead once a reloaded stream has opened. */
  let resumeAtSec: number | null = null
  const putBack = (): void => {
    const at = resumeAtSec
    resumeAtSec = null
    if (at != null && at > 0) handle.currentTime = at
  }
  handle.addEventListener('loadedmetadata', putBack)
  // A seek of the viewer's own while the stream reopens is where they want to be.
  const stopExplicitSeek = onExplicitSeek(handle, () => {
    resumeAtSec = null
  })
  /**
   * Hands the player its stream again, at the moment it had reached: a bare
   * reload opens a live game near its newest footage, which threw a viewer
   * watching an earlier inning to the end and replayed the last seconds to
   * one who was waiting at it.
   */
  const reloadKeepingPlace = (): void => {
    if (handle.currentTime > 0) resumeAtSec = handle.currentTime
    handle.reload()
  }
  /** Loads the stream again now, and plays it, in place of any reload due. */
  const restart = (): void => {
    failed = false
    if (timer != null) clearTimeout(timer)
    timer = undefined
    reloadKeepingPlace()
    handle.play().catch(() => undefined)
  }
  // Only the single live viewer: a grid owns its tiles, and a finished
  // recording has nothing to wait for.
  const singleLive = intent?.isLive != null && intent.buffer == null
  const stopReloading = singleLive
    ? reloadStalledLive(
        handle,
        () => intent.wantsToPlay(),
        restart,
        undefined,
        hasFailed
      )
    : undefined
  const onPlay = (): void => {
    wantsToPlay = true
    if (failed) restart()
  }
  const onPause = (): void => {
    if (!recovering) wantsToPlay = false
  }
  handle.addEventListener('play', onPlay)
  handle.addEventListener('pause', onPause)

  /** Pictures again: the trouble has passed, and it may resume. */
  const recovered = (): void => {
    failed = false
    // A reload still due belongs to trouble that has passed. Left to fire, it
    // would find no failure on the books and read that as patience run out.
    if (timer != null) clearTimeout(timer)
    timer = undefined
    firstFailureAt = 0
    wait = 1000
    reloads = 0
    if (!recovering) return
    const wanted = (intent?.wantsToPlay() ?? wantsToPlay) && handle.paused
    recovering = false
    if (wanted) handle.play().catch(() => undefined)
  }
  handle.addEventListener('canplay', recovered)

  const giveUp = (): void => {
    if (gaveUp) return
    gaveUp = true
    onGiveUp?.()
  }

  handle.onError = error => {
    // The address is what is wrong: asking again for it is thirty guaranteed
    // failures, and the caller can mint a new one.
    if (addressIsWrong(error)) {
      // Asking the same address again is pointless; the live watch stops too.
      // A give-up for want of patience leaves it running: the network may be
      // what failed, and it is what brings the picture back when it returns.
      stopReloading?.()
      giveUp()
      return
    }
    failed = true
    failedAt ??= handle.currentTime
    const now = Date.now()
    if (firstFailureAt === 0) firstFailureAt = now
    if (now - firstFailureAt > patience) {
      giveUp()
      return
    }
    if (timer != null) return
    recovering = true
    reloads += 1
    // Three tries at the same address and then the address is the suspect
    // anyway, whatever the error said.
    if (reloads > MAX_RELOADS) {
      giveUp()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      // Armed on the clock, not on the next error. A player that raises one
      // error and then goes quiet would otherwise never reach the end of its
      // patience, and the picture would stay frozen for good rather than for
      // five minutes.
      if (Date.now() - firstFailureAt > patience) {
        giveUp()
        return
      }
      wait = Math.min(wait * 2, 10_000)
      reloadKeepingPlace()
    }, wait)
  }

  // AVPlayer has no live offset to set, so it is moved there on its first
  // play. ExoPlayer is given the cushion as its offset where the source is
  // built (`VideoView.native.tsx`), and starts far enough back to be left.
  const stopJoining =
    singleLive && intent.startAtLiveEdge !== false
      ? joinLiveWithCushion(handle)
      : undefined

  return () => {
    stopJoining?.()
    stopReloading?.()
    stopExplicitSeek()
    if (timer != null) clearTimeout(timer)
    handle.removeEventListener('loadedmetadata', putBack)
    handle.removeEventListener('play', onPlay)
    handle.removeEventListener('pause', onPause)
    handle.removeEventListener('canplay', recovered)
    handle.onError = null
  }
}
