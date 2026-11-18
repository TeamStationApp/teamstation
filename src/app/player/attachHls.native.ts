import { onExplicitSeek } from './explicitSeek'
import { joinLiveWithCushion } from './liveCushion'
import { readRealEndSec } from './livePlaylistEnd'
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
   * ending. A pause the viewer asked for still has to be honoured, and here
   * every `pause` is theirs or the end's: a reload pauses the player without
   * saying so, and a failed player's stop is not reported as one
   * (`NativeVideoHandle`), so one that arrives mid-recovery is honoured too.
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
   * The native progress revision at the last failure, until native samples
   * have played half a second on. Kept apart from `failed`, which a `canplay`
   * clears: iOS sends that whenever AVPlayer changes its mind about keeping
   * up, picture or not, and a failed AVPlayer raises no second error to set
   * it again. A reload's landing sample, a few milliseconds off where it was
   * put, is not playing on: counted, a stream failing at one point would
   * reset its ladder on every reload and never give up.
   */
  let failedAt: number | null = null
  /** The lowest native position reported since that failure. */
  let failedFrom = 0
  const failedHere = (): void => {
    if (failedAt != null) return
    failedAt = handle.progressRevision
    failedFrom = handle.reportedTime
  }
  const hasFailed = (): boolean => {
    if (failedAt == null) return false
    if (handle.progressRevision > failedAt) {
      failedFrom = Math.min(failedFrom, handle.reportedTime)
      if (handle.reportedTime > failedFrom + 0.5) failedAt = null
    }
    return failedAt != null
  }
  /** Where to put the playhead once a reloaded stream has opened. */
  let resumeAtSec: number | null = null
  let awaitingLoad = false
  let openingUntil = 0
  const putBack = (): void => {
    const at = resumeAtSec
    resumeAtSec = null
    awaitingLoad = false
    if (at != null) handle.currentTime = at
  }
  handle.addEventListener('loadedmetadata', putBack)
  // A seek of the viewer's own while the stream reopens is where they want to be.
  const stopExplicitSeek = onExplicitSeek(handle, seconds => {
    resumeAtSec = awaitingLoad ? seconds : null
  })
  /**
   * Hands the player its stream again, at the moment it had reached: a bare
   * reload opens a live game near its newest footage, which threw a viewer
   * watching an earlier inning to the end and replayed the last seconds to
   * one who was waiting at it.
   */
  const reloadKeepingPlace = (): void => {
    // Zero is a place only once something put the player there: a live
    // source still opening reads zero, which is the start of its window.
    if (handle.seeking || handle.currentTime > 0)
      resumeAtSec = handle.currentTime
    awaitingLoad = true
    // Opening and restoring a slow native source can take longer than the
    // ordinary stall deadline. Bound the attempt without canceling it early.
    openingUntil = Date.now() + 30_000
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
        // A loaded restoration seek has its own transfer-aware deadline.
        // Reset this watch's inactivity clock so completion also gets time
        // to produce its first advancing native sample.
        () => intent.wantsToPlay() && (awaitingLoad || !handle.seeking),
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
    wantsToPlay = false
  }
  handle.addEventListener('play', onPlay)
  handle.addEventListener('pause', onPause)

  /** Pictures again: the trouble has passed, and it may resume. */
  const recovered = (): void => {
    failed = false
    if (recovering && (intent?.wantsToPlay() ?? wantsToPlay) && handle.paused)
      handle.play().catch(() => undefined)
    if (hasFailed()) return
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
  // Every native sample says `timeupdate`; only one past the failure is news.
  const progressed = (): void => {
    if (!hasFailed()) recovered()
  }
  handle.addEventListener('timeupdate', progressed)

  const giveUp = (): void => {
    if (gaveUp) return
    gaveUp = true
    onGiveUp?.()
  }

  handle.onError = error => {
    openingUntil = 0
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
    failedHere()
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

  // Both grid and single players need a deadline when native reports one
  // failure and then goes quiet. Read native samples, never our own seeks.
  let observed = handle.reportedTime
  let lastAdvance = Date.now()
  let supervision: ReturnType<typeof setTimeout> | undefined
  const supervise = (): void => {
    // Native queues a seek until its replacement item is ready. The opening
    // deadline bounds that wait; the seek deadline starts when putBack reissues it.
    if (!awaitingLoad) handle.checkSeekTimeout()
    const now = Date.now()
    if (handle.reportedTime !== observed) {
      observed = handle.reportedTime
      lastAdvance = now
    }
    // Restoring a loaded item can legitimately take longer than the opening
    // grace. Its transfer-aware watchdog above still bounds a stalled seek;
    // a replacement that never loads remains subject to the opening deadline.
    if (!awaitingLoad && handle.seeking) lastAdvance = now
    const wanted =
      intent?.wantsRecovery?.() ?? intent?.wantsToPlay() ?? wantsToPlay
    // A tile its grid has paused (a buffering hold, a tile left out) cannot
    // advance, so standing still is no sign of a stall; only a failure is.
    const held = intent != null && !intent.wantsToPlay() && handle.paused
    if ((!wanted || held) && !failed) lastAdvance = now
    const silentReadyTile =
      wanted && !held && handle.readyState >= 3 && !handle.ended
    if (
      !singleLive &&
      !gaveUp &&
      now - lastAdvance >= 20_000 &&
      now >= openingUntil &&
      (failed || hasFailed() || silentReadyTile)
    ) {
      lastAdvance = now
      if (reloads >= MAX_RELOADS) giveUp()
      else {
        reloads++
        recovering = true
        failed = true
        failedHere()
        reloadKeepingPlace()
      }
    }
    supervision = setTimeout(supervise, 1000)
  }
  supervision = setTimeout(supervise, 1000)

  // AVPlayer has no live offset to set, so it is moved there on its first
  // play. ExoPlayer is given the cushion as its offset where the source is
  // built (`VideoView.native.tsx`), and starts far enough back to be left.
  const stopJoining =
    singleLive && intent.startAtLiveEdge !== false
      ? joinLiveWithCushion(handle, async () => await readRealEndSec(url))
      : undefined

  return () => {
    stopJoining?.()
    stopReloading?.()
    stopExplicitSeek()
    if (timer != null) clearTimeout(timer)
    if (supervision != null) clearTimeout(supervision)
    handle.removeEventListener('loadedmetadata', putBack)
    handle.removeEventListener('play', onPlay)
    handle.removeEventListener('pause', onPause)
    handle.removeEventListener('canplay', recovered)
    handle.removeEventListener('timeupdate', progressed)
    handle.onError = null
  }
}
