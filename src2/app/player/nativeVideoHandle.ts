import type {
  OnLoadData,
  OnPlaybackStateChangedData,
  OnProgressData,
  OnSeekData,
  OnVideoAspectRatioData,
  OnVideoErrorData,
  OnVideoTracksData,
  VideoRef
} from 'react-native-video'

import { answersSeek, SEEK_TOLERANCE, shouldAdoptProgress } from './seekTracker'
import type {
  VideoEventName,
  VideoHandle,
  VideoListenerOptions
} from './videoHandle'

/**
 * `VideoHandle`, over a `react-native-video` player.
 *
 * The six modules that drive the picture read `currentTime` **synchronously**,
 * often in the same breath as writing it: `slowMotion` integrates
 * `currentTime - elapsed * 0.25` frame by frame, and `switchAngle` reads the
 * playhead at the instant of the swap to work out where the other camera was.
 * A `react-native-video` ref offers `seek()`, a `getCurrentPosition()` that
 * returns a promise, and an `onProgress` callback four times a second — and
 * nothing synchronous at all.
 *
 * So this is not a wrapper. It **owns** the playhead: a write goes into the
 * field and out to `seek()` in the same call, and the value the player reports
 * back is adopted only once every seek it has been given has landed. Reading
 * back a pre-seek position is not a small inaccuracy — it is a crawl that
 * stalls where it stands, and an angle change that arrives a quarter of a
 * second out.
 *
 * `rate`, `muted` and `paused` are props on the component rather than setters
 * on the player, so those go into `props` and the view is told to re-render.
 */

/** What the component has to pass to the player. */
export interface NativeVideoProps {
  paused: boolean
  muted: boolean
  rate: number
}

interface Listener {
  fn: () => void
  once: boolean
}

export class NativeVideoHandle implements VideoHandle {
  /** Set by the view once the player exists. */
  private player: VideoRef | null = null
  private readonly listeners = new Map<VideoEventName, Listener[]>()
  private readonly onPropsChange: () => void

  private time = 0
  private length = Number.POSITIVE_INFINITY
  private state = 0
  private width = 0
  private height = 0
  /**
   * Where the last seek was sent to, until the player has caught up with it.
   *
   * A **target**, not a count, and that distinction is the whole of it.
   * ExoPlayer keeps one `isSeeking` boolean and coalesces: hand it ten seeks
   * in ten frames — which is exactly what a quarter-speed crawl does — and it
   * answers once. A counter would go up ten times and down once, stay
   * permanently positive, and the player's own position would never be
   * believed again for the life of the source; the playhead would freeze at
   * wherever the crawl left it, and every `?t=` written into the address from
   * then on would be wrong. A target has nothing to desynchronise: a newer
   * seek simply replaces an older one.
   */
  private pendingSeekTo: number | null = null
  /**
   * When that seek was sent, so a seek nobody ever acknowledges cannot wedge
   * the playhead for ever.
   *
   * ExoPlayer does not report a seek at all when it happens while paused *and*
   * buffering, which is precisely a seek on a stalled live stream.
   */
  private pendingSeekAt = 0

  props: NativeVideoProps = { paused: true, muted: false, rate: 1 }

  /** Handed to `attachHls.native.ts`, which decides what to do about it. */
  onError: ((error: OnVideoErrorData) => void) | null = null

  /** What is playing, kept so a stalled stream can be asked for again. */
  source: string | null = null

  constructor(onPropsChange: () => void) {
    this.onPropsChange = onPropsChange
  }

  attach(player: VideoRef | null): void {
    this.player = player
    // A remount is a new player with none of the old one's state, and
    // inheriting a stale position or a stale `readyState` would let a seek be
    // issued against a player that has not loaded anything.
    if (player == null) this.reset()
  }

  // ---- the shape the shared modules use -------------------------------

  get currentTime(): number {
    return this.time
  }

  set currentTime(seconds: number) {
    const next = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
    this.time = next
    this.pendingSeekTo = next
    this.pendingSeekAt = Date.now()
    this.player?.seek(next, SEEK_TOLERANCE)
  }

  get duration(): number {
    return this.length
  }

  get paused(): boolean {
    return this.props.paused
  }

  get muted(): boolean {
    return this.props.muted
  }

  set muted(value: boolean) {
    if (this.props.muted === value) return
    this.props = { ...this.props, muted: value }
    this.onPropsChange()
  }

  get playbackRate(): number {
    return this.props.rate
  }

  set playbackRate(value: number) {
    if (this.props.rate === value) return
    this.props = { ...this.props, rate: value }
    this.onPropsChange()
  }

  get readyState(): number {
    return this.state
  }

  get videoWidth(): number {
    return this.width
  }

  get videoHeight(): number {
    return this.height
  }

  async play(): Promise<void> {
    if (!this.props.paused) return
    this.props = { ...this.props, paused: false }
    this.onPropsChange()
    // `play` is emitted here rather than waiting for the player to say so,
    // because `attachHls` records what the viewer asked for at the moment they
    // asked, and a recovery that arrives first would otherwise read the answer
    // as "they wanted it paused".
    this.emit('play')
  }

  pause(): void {
    if (this.props.paused) return
    this.props = { ...this.props, paused: true }
    this.onPropsChange()
    this.emit('pause')
  }

  addEventListener(
    type: VideoEventName,
    fn: () => void,
    options?: VideoListenerOptions
  ): void {
    const held = this.listeners.get(type) ?? []
    held.push({ fn, once: options?.once === true })
    this.listeners.set(type, held)
  }

  removeEventListener(type: VideoEventName, fn: () => void): void {
    const held = this.listeners.get(type)
    if (held == null) return
    const index = held.findIndex(entry => entry.fn === fn)
    if (index >= 0) held.splice(index, 1)
  }

  /**
   * Accepted, and ignored.
   *
   * AVPlayer's default time-pitch algorithm already keeps speech at its own
   * pitch when it slows down, and ExoPlayer has no equivalent to offer.
   */
  preservesPitch = true
  webkitPreservesPitch = true

  // ---- what the view feeds in -----------------------------------------

  handleLoad = (data: OnLoadData): void => {
    // A live stream has no length, and ExoPlayer says so with a **zero** — not
    // a `NaN`, which is what a browser gives and what every caller checks for
    // with `Number.isFinite`. Left as nought, `zones.seekBy` clamps every seek
    // to the range `[0, 0]`, so tapping ten-seconds-forward during a live game
    // sends the picture to the top of the stream.
    this.length = data.duration > 0 ? data.duration : Number.POSITIVE_INFINITY
    this.width = data.naturalSize.width
    this.height = data.naturalSize.height
    this.state = 1
    // A fresh source starts where it says it does, and a seek aimed at the
    // *previous* one will never be answered now.
    this.pendingSeekTo = null
    this.time = data.currentTime
    this.emit('loadedmetadata')
  }

  handleProgress = (data: OnProgressData): void => {
    const adopt = shouldAdoptProgress({
      target: this.pendingSeekTo,
      reported: data.currentTime,
      sentAt: this.pendingSeekAt,
      now: Date.now()
    })
    if (adopt) {
      this.pendingSeekTo = null
      this.time = data.currentTime
    }
    this.emit('timeupdate')
  }

  handleSeek = (data: OnSeekData): void => {
    if (answersSeek(this.pendingSeekTo, data.seekTime)) {
      this.pendingSeekTo = null
    }
  }

  handlePlaybackState = (data: OnPlaybackStateChangedData): void => {
    // A seek is never information about intent. ExoPlayer reports
    // `isPlaying: false, isSeeking: true` while it works, and reading that as
    // "not playing" would flip a **paused** player to playing the moment
    // somebody tapped a seek square — and `attachHls` would record that as the
    // viewer asking for playback, and put it back after the next stumble.
    if (data.isSeeking) return
    // Otherwise only when the player disagrees with what it was told — a
    // stall, an end, an interruption. When it agrees, the event was already
    // emitted by `play` or `pause`, and emitting it twice makes `attachHls`
    // believe a viewer paused something they did not.
    const paused = !data.isPlaying
    if (paused === this.props.paused) return
    this.props = { ...this.props, paused }
    this.onPropsChange()
    this.emit(paused ? 'pause' : 'play')
  }

  handleReadyForDisplay = (): void => {
    this.emit('canplay')
    this.emit('loadeddata')
  }

  handleVideoTracks = (data: OnVideoTracksData): void => {
    // The shape of the track that was chosen, at the moment it is chosen. It
    // does **not** stand in for the DOM's `resize`: adaptive switches inside
    // one track group do not re-announce the tracks, so this fires when a
    // source is opened and rarely after. That is enough — renditions of one
    // recording share an aspect ratio, and the box only has to be cut once —
    // and `handleAspectRatio` below catches the rest.
    const chosen = data.videoTracks.find(track => track.selected === true)
    if (chosen?.width == null || chosen.height == null) return
    this.resized(chosen.width, chosen.height)
  }

  /** The player's own word on the shape, which is closer to `resize`. */
  handleAspectRatio = (data: OnVideoAspectRatioData): void => {
    this.resized(data.width, data.height)
  }

  private resized(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.emit('resize')
  }

  handleError = (error: OnVideoErrorData): void => {
    this.onError?.(error)
  }

  /**
   * Ask for the same stream again.
   *
   * The retry a browser gets from hls.js, which owns the segment loads there
   * and can simply start loading again. Here the player owns them, and the
   * only way back in is to hand it the source a second time — which it treats
   * as a fresh start and which is exactly what is wanted after a field has
   * lost its signal for a minute.
   */
  reload(): void {
    if (this.source == null) return
    // Paused first, and that is not tidiness. A player handed its source again
    // starts stopped, exactly as a browser's does after `load()`, and the
    // recovery in `attachHls.native.ts` decides whether to resume by asking
    // whether it is paused. Leaving this saying "playing" makes that question
    // answer itself wrongly and the resume never runs — in precisely the case
    // the whole ladder exists for.
    if (!this.props.paused) {
      this.props = { ...this.props, paused: true }
      this.onPropsChange()
    }
    this.player?.setSource({ uri: this.source })
  }

  /** A new source: everything known about the last one is now wrong. */
  reset(): void {
    this.time = 0
    this.length = Number.POSITIVE_INFINITY
    this.state = 0
    this.width = 0
    this.height = 0
    this.pendingSeekTo = null
  }

  private emit(type: VideoEventName): void {
    const held = this.listeners.get(type)
    if (held == null || held.length === 0) return
    // A copy, because a listener may remove itself or add another.
    for (const entry of [...held]) {
      // By identity of the registration, not of the function: the same
      // function can be registered twice, once with `once` and once without,
      // and dropping it by name would take the wrong one away.
      if (entry.once) {
        const index = held.indexOf(entry)
        if (index >= 0) held.splice(index, 1)
      }
      entry.fn()
    }
  }
}
