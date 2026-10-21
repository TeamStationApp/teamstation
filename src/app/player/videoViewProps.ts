import { AHEAD_SEC } from './multiCam/buffering'
import type { VideoHandle } from './videoHandle'

/**
 * The picture's props, shared by both `VideoView` files.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin: Metro resolves `./VideoView` inside `VideoView.native.tsx` back to
 * `VideoView.native.tsx`, and the binding is `undefined` at run time. Anything
 * the two share sits here instead.
 */
export interface VideoViewProps {
  /**
   * The playlist to play, or null for nothing yet.
   *
   * On the web the source is attached by `attachHls`, which has to choose
   * between the element's own `src` and Media Source Extensions depending on
   * what the engine can do; on a phone the player takes a URL and gets on with
   * it. The prop is on both so the two call sites — the game screen and the
   * card — read the same on either platform.
   */
  source: string | null
  /** Called with the player when it exists, and with null when it goes. */
  onHandle: (handle: VideoHandle | null) => void
  /** The platform's own control bar. Off for the silent preview on a card. */
  controls?: boolean
  /**
   * The picture somebody is watching and listening to: the videos page's
   * player, or the heard tile of the grid. Only a phone reads it: it takes the
   * audio session and plays through the silent switch. Off, as for a card's
   * silent preview, it leaves whatever was already playing alone.
   */
  primary?: boolean
  /**
   * The control bar appeared or faded away.
   *
   * Only a phone answers this. The gesture layer above the picture is cut
   * around the player's own controls so a press on the scrubber reaches them
   * — but those controls are on screen for a few seconds at a time and gone
   * for the rest, and a hole cut in the gesture layer for a bar that is not
   * being drawn is simply a dead patch of picture. On Android that patch
   * covered most of the bottom-middle third, which is the square that runs
   * the film backwards, so reverse slow motion could not be started.
   *
   * A browser does not expose this at all, so the web never calls it and goes
   * on cutting the same rectangles it always did — which are the ones that
   * were actually measured.
   */
  onControlsVisible?: (visible: boolean) => void
  muted?: boolean
  /** `cover` crops to fill the box; `contain` fits the whole picture in it. */
  resizeMode?: 'cover' | 'contain'
  /** Faded in only once there are frames, so a card never flashes empty. */
  opacity?: number
  /**
   * How the phone's player buffers, for a caller driving several at once.
   *
   * Only a phone reads this. In a browser the buffer is hls.js's, set where
   * the source is attached (`attachHls`), and the multi-camera grid moves it
   * while it plays. A phone's player cannot be moved once it is built, so it
   * is told everything up front: load `aheadSec` ahead, start and restart
   * only once it holds `startSec`, keep `behindSec` of what it has shown,
   * and on Android stop loading at `heapShare` of the app's heap. Left out,
   * AVPlayer and ExoPlayer use their own defaults.
   */
  buffer?: {
    aheadSec: number
    startSec: number
    behindSec: number
    heapShare: number
  }
  /**
   * The source is a game still being written, watched on its own.
   *
   * Only a phone reads this. A browser's live settings are made where the
   * source is attached (`attachHls`). Read once per source: a game that ends
   * while it plays keeps the player it has rather than being loaded afresh.
   */
  live?: boolean
}

/**
 * How a phone's player shares the audio session: the primary picture takes
 * the focus and plays with the ring switch on silent; anything else obeys the
 * switch and leaves the session to whatever had it.
 */
export function audioSession(primary: boolean): {
  disableFocus: boolean
  ignoreSilentSwitch: 'ignore' | 'obey'
} {
  return primary
    ? { disableFocus: false, ignoreSilentSwitch: 'ignore' }
    : { disableFocus: true, ignoreSilentSwitch: 'obey' }
}

/**
 * How far ahead a phone's player loads, in seconds (AVPlayer's
 * `preferredForwardBufferDuration`): the caller's buffer, or the budget every
 * player has.
 */
export function forwardBufferSec(buffer?: { aheadSec: number }): number {
  return buffer?.aheadSec ?? AHEAD_SEC
}
