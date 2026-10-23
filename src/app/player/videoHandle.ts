/**
 * The player, as the rest of the app is allowed to see it.
 *
 * Six modules drive the picture — `zones`, `slowMotion`, `useVideoAspect`,
 * `attachHls`, `PlayerSurface` and the watch half of `GameScreen` — and every
 * one of them was written against `HTMLVideoElement`, because in a browser
 * that is what a player is. On a phone it is an `AVPlayer` or an `ExoPlayer`
 * behind a React component, and the two have almost nothing in common.
 *
 * So this is the shape they agree on: **exactly** the members those six
 * modules use, and not one more. `HTMLVideoElement` satisfies it without being
 * told to, so the web keeps driving the real element and nothing about its
 * behaviour changes; `nativeVideoHandle.ts` implements the same shape over a
 * `react-native-video` ref. The modules themselves are shared, unchanged apart
 * from the name of this type.
 *
 * Keeping the surface this small is the whole trick. Every member here is one
 * more thing the native side has to fake convincingly, and some of them —
 * `currentTime`, read synchronously, immediately after being written — are
 * genuinely hard to fake. See `nativeVideoHandle.ts`.
 */

/**
 * The events the app listens for.
 *
 * A closed union rather than `string`, so a listener for an event no native
 * player can raise cannot be added by accident. Each has a native source:
 *
 * - `loadedmetadata` — the length and the shape are known, so a seek will land
 * - `timeupdate` — the playhead moved
 * - `play` / `pause` — what it is doing now, including when it was not asked
 * - `canplay` / `loadeddata` — there are pictures to show
 * - `resize` — the stream switched to a rendition of a different shape
 * - `progress` — more of the stream has arrived, so the seekable end may move
 * - `durationchange` — the length is known, or a live one has grown
 */
export type VideoEventName =
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'canplay'
  | 'loadeddata'
  | 'resize'
  | 'progress'
  | 'durationchange'
  | 'playing'
  | 'waiting'
  | 'seeking'
  | 'seeked'
  | 'ended'
  | 'ratechange'
  | 'error'
  | 'emptied'

export interface VideoListenerOptions {
  /** Remove the listener the first time it fires. */
  once?: boolean
}

export interface VideoHandle {
  /**
   * Seconds into the recording, readable **and** writable, and readable again
   * immediately after a write.
   *
   * `slowMotion` integrates against it frame by frame and `switchAngle` reads
   * it at the instant of the swap, so a value that lags behind what was just
   * written is not a small inaccuracy — it is a crawl that stalls and an angle
   * change that lands somewhere else.
   */
  currentTime: number
  /** The whole length, or `NaN`/`Infinity` for a live stream. */
  readonly duration: number
  readonly paused: boolean
  /** Native playback confirmation; a play request alone is not viewing. */
  readonly actuallyPlaying?: boolean
  muted: boolean
  playbackRate: number
  /**
   * Zero until the metadata has loaded, and at least 1 after.
   *
   * The single player only ever compares it as `>= 1`, which is
   * `HAVE_METADATA`: "may I seek yet". The multi-camera grid also asks whether
   * a picture is up (`HAVE_ENOUGH_DATA`, 4), which a phone's player reports
   * once it is ready for display.
   */
  readonly readyState: number
  /** The shape of the file, so the box can be cut to fit it. */
  readonly videoWidth: number
  readonly videoHeight: number
  play: () => Promise<void>
  pause: () => void
  addEventListener: (
    type: VideoEventName,
    listener: () => void,
    options?: VideoListenerOptions
  ) => void
  removeEventListener: (type: VideoEventName, listener: () => void) => void
  /**
   * Keep speech intelligible at a quarter speed rather than an octave down.
   *
   * Optional because only a browser has it, and spelled twice because Safari
   * still wants the prefix. AVPlayer does this by default and ExoPlayer has no
   * equivalent, so the native handle accepts both and ignores them.
   */
  preservesPitch?: boolean
  webkitPreservesPitch?: boolean
}

/** `HAVE_METADATA`: the length is known, so a seek will land where it is told. */
export const HAVE_METADATA = 1

/** `HAVE_CURRENT_DATA`: there is a picture, and nothing behind it yet. */
export const HAVE_CURRENT_DATA = 2

/** `HAVE_ENOUGH_DATA`: there is a picture, and more behind it. */
export const HAVE_ENOUGH_DATA = 4

/**
 * Where the footage a player could seek to ends, in seconds; null while it
 * cannot say. The browser's element has its `seekable` ranges; a phone's
 * handle keeps the end its player last reported (`seekableEnd`).
 */
export function seekableEndOf(
  handle:
    | VideoHandle
    | { readonly seekable: { length: number; end: (index: number) => number } }
): number | null {
  const shaped = handle as {
    seekable?: { length: number; end: (index: number) => number }
    seekableEnd?: number | null
  }
  const ranges = shaped.seekable
  if (ranges != null && ranges.length > 0) return ranges.end(ranges.length - 1)
  return shaped.seekableEnd ?? null
}
