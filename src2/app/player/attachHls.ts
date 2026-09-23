import Hls from 'hls.js'

import { shouldResumeAfterRecovery } from './resumeAfterRecovery'
import type { VideoHandle } from './videoHandle'

/**
 * Points a `<video>` at an HLS playlist, whichever way this browser needs.
 *
 * Safari plays HLS itself, and does it with hardware decoding on iOS and the
 * Mac, so it is given the URL directly. Chrome and Firefox play no HLS at all
 * without help; hls.js feeds them the same segments through Media Source
 * Extensions, which is also where Chrome's HEVC hardware decoding lives. One
 * playlist, one set of files, both paths.
 *
 * Returns the teardown, which the caller must run: hls.js holds a worker and
 * buffers ahead, and leaking one per visited game would eat the tab.
 */
export interface PlayIntent {
  /**
   * Whether the **viewer** wants this playing, as the caller understands it.
   *
   * Supplied only by a caller that pauses this element itself. The multi-camera
   * view does: it holds three tiles while a fourth stalls, and it pauses them
   * all while a tile that was not recording yet is parked. Without this the
   * pause below reads every one of those as the viewer pressing pause, and the
   * recovery this file exists to guarantee never fires again for that tile —
   * silently, and only on the stream that has already gone wrong once.
   *
   * A caller that never pauses the element from outside leaves this out, and
   * the element's own pause events remain the whole story, exactly as before.
   */
  wantsToPlay: () => boolean
  /**
   * How much this player may run ahead, for a caller driving several at once.
   *
   * Left out, hls.js is allowed what it likes, which is the right answer for
   * one player: it asks for 30 seconds, then grows the target as the line
   * allows until it is holding 60 MB. Four players doing that at once is
   * **240 MB, asked for at the same moment** — measured on a real take, the
   * grid pulled 178 MB in its first ten seconds for a game whose four streams
   * carry 11 Mbit/s between them. On a line that cannot serve that in ten
   * seconds the four spend the opening minutes starving each other, which is
   * how a camera stops drawing and takes the sound down with it.
   *
   * So a grid says what it may have, and the four together ask for less than
   * the single player does on its own.
   */
  buffer?: { seconds: number; megabytes: number }
}

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
  // that drive the picture agree on; the three lines below — `src`, `load`,
  // `canPlayType` — and the element hls.js is handed are the browser's own,
  // and they have no equivalent on a phone, which is why the whole of this
  // file has a native sibling rather than a branch inside it. The cast is
  // sound here and nowhere else: this file is only ever reached from the web
  // build, where the handle *is* the element.
  const video = handle as unknown as HTMLVideoElement

  // Media Source first, which is the order hls.js itself recommends, and not
  // `canPlayType`: Chrome answers `maybe` for HLS whether or not it can
  // actually play it, so that answer decides nothing. Anything without Media
  // Source — iOS Safari — falls through to the native path below, which is
  // what it wants anyway.
  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl') === '') {
      // Neither MSE nor native HLS. The element is left alone rather than
      // handed a URL it cannot read.
      return () => undefined
    }
    video.src = url
    return () => {
      video.removeAttribute('src')
      video.load()
    }
  }

  // `maxBufferLength` is where hls.js starts, not where it stops: it loads
  // whenever the buffer is shorter than this and grows the target from there
  // as bandwidth allows. A ceiling needs the other two as well.
  const limit = intent?.buffer
  const hls = new Hls({
    // A game is watched by seeking around it, not straight through, so there
    // is no point buffering minutes ahead of a position about to change.
    maxBufferLength: limit?.seconds ?? 30,
    ...(limit == null
      ? {}
      : {
          maxMaxBufferLength: limit.seconds,
          maxBufferSize: limit.megabytes * 1024 * 1024
        })
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
  const onPlay = (): void => {
    ownWantsToPlay = true
  }
  const onPause = (): void => {
    if (!recovering) ownWantsToPlay = false
  }
  handle.addEventListener('play', onPlay)
  handle.addEventListener('pause', onPause)

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

  hls.loadSource(url)
  hls.attachMedia(video)
  return () => {
    if (timer != null) clearTimeout(timer)
    handle.removeEventListener('play', onPlay)
    handle.removeEventListener('pause', onPause)
    hls.destroy()
  }
}
