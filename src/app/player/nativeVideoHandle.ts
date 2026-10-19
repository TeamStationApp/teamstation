import type {
  OnBufferData,
  OnLoadData,
  OnPlaybackStateChangedData,
  OnProgressData,
  OnSeekData,
  OnVideoAspectRatioData,
  OnVideoErrorData,
  OnVideoTracksData,
  ReactVideoSource,
  VideoRef
} from 'react-native-video'

import {
  answersSeek,
  SEEK_TOLERANCE,
  shouldAdoptProgress,
  shouldResumeAfterSeek
} from './seekTracker'
import {
  HAVE_CURRENT_DATA,
  HAVE_ENOUGH_DATA,
  type VideoEventName,
  type VideoHandle,
  type VideoListenerOptions
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
 *
 * Between the player's reports the playhead is carried forward at the rate it
 * plays: `t = lastReport + (now − lastReportAt) · rate`, from the last report,
 * seek or change of pace. Four reports a second moved the scoreboard drawn
 * over the picture a quarter of a second late, and the grid measured its
 * angles against each other a quarter of a second apart; a browser's element
 * is read to the frame, and this is read as nearly so.
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

/**
 * The furthest the playhead is carried past the player's last report: four
 * of its reports. A player that has stopped reporting without saying it
 * stopped has most likely stalled, and the picture is not moving either; a
 * second is also short of what the scoreboard reads as a seek, so the step
 * back when the next report comes is never taken for one.
 */
export const MAX_INTERPOLATION_MS = 1000

/**
 * How soon after the player says it stopped a buffering report makes that
 * stop a stall. Android sends the two in the same batch, the buffering one
 * last.
 */
export const STALL_REPORT_MS = 1000

// React Native has `performance.now()`, but its types leave it out.
const monotonic = (globalThis as { performance?: { now: () => number } })
  .performance
const steadyNow = (): number => monotonic?.now() ?? Date.now()

export class NativeVideoHandle implements VideoHandle {
  /** Set by the view once the player exists. */
  private player: VideoRef | null = null
  private readonly listeners = new Map<VideoEventName, Listener[]>()
  private readonly onPropsChange: () => void
  /** A clock that only goes forwards, which the playhead is carried on. */
  private readonly clock: () => number

  /** The playhead as last reported, sought or fixed by a change of pace. */
  private time = 0
  /** When, on `clock`, `time` was true. */
  private timeAt = 0
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
  /** It has played to its end, and stays ended until it is moved back. */
  private over = false
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

  /** The source as the view built it, buffer and live settings included. */
  sourceConfig: ReactVideoSource | null = null

  /**
   * Whether `reload` has to clear the player's source before handing it the
   * same one again. Set by the view on Android.
   *
   * Android's player compares a new source with the one it holds and, when
   * they match, does nothing at all: a player that has failed stays failed,
   * with Play on its control bar, and the recovery in `attachHls.native.ts`
   * waits for a picture that never comes. Clearing first makes the second
   * source a new one. iOS loads whatever it is handed.
   */
  clearBeforeReload = false

  /**
   * The player has run out of picture and is waiting for more, from the
   * player's `onBuffer` until it says it has enough again.
   */
  private buffering = false

  /**
   * When the player last said it had stopped playing, by itself, until
   * anything else happens: the buffering report that follows a stall.
   */
  private playerStoppedAt: number | null = null

  /**
   * The player has reported an error and shown no picture since.
   *
   * Media3 that fails a source — a server answering 502 for the seconds a
   * restart takes — reports the error and then "not playing". Read as a
   * pause, that told the game page the viewer had paused, and the recovery,
   * which resumes only what the viewer wants playing, left a reloaded picture
   * standing on Play for good. Measured on a Pixel with a minute buffered.
   */
  private failed = false

  /**
   * Where the footage the player could seek to ends: for a live game, its
   * newest moment. From the player's progress reports; null until one says.
   */
  private seekableEnd: number | null = null

  constructor(onPropsChange: () => void, clock: () => number = steadyNow) {
    this.onPropsChange = onPropsChange
    this.clock = clock
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
    return this.time + this.carried()
  }

  set currentTime(seconds: number) {
    const next = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
    this.time = next
    this.timeAt = this.clock()
    if (next < this.length - 0.5) this.over = false
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

  /** What a browser's element calls `ended`: it played to the end. */
  get ended(): boolean {
    return this.over
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
    this.rebase()
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
    this.playerStoppedAt = null
    if (!this.props.paused) return
    this.rebase()
    this.props = { ...this.props, paused: false }
    this.onPropsChange()
    // `play` is emitted here rather than waiting for the player to say so,
    // because `attachHls` records what the viewer asked for at the moment they
    // asked, and a recovery that arrives first would otherwise read the answer
    // as "they wanted it paused".
    this.emit('play')
  }

  pause(): void {
    this.playerStoppedAt = null
    if (this.props.paused) return
    this.rebase()
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
    this.timeAt = this.clock()
    this.emit('loadedmetadata')
  }

  /** The newest moment the player could seek to, or null while unknown. */
  get liveEdge(): number | null {
    return this.seekableEnd
  }

  handleProgress = (data: OnProgressData): void => {
    // AVPlayer reports the length of its seekable range, which for a game's
    // playlist starts at its first segment and so ends at the newest one.
    if (Number.isFinite(data.seekableDuration) && data.seekableDuration > 0) {
      this.seekableEnd = data.seekableDuration
    }
    const adopt = shouldAdoptProgress({
      target: this.pendingSeekTo,
      reported: data.currentTime,
      sentAt: this.pendingSeekAt,
      now: Date.now()
    })
    if (adopt) {
      this.pendingSeekTo = null
      this.time = data.currentTime
      this.timeAt = this.clock()
    }
    this.emit('timeupdate')
  }

  handleSeek = (data: OnSeekData): void => {
    if (answersSeek(this.pendingSeekTo, data.seekTime)) {
      // Held where it was sent while the player got there, and carried on
      // from there now that it has.
      this.pendingSeekTo = null
      this.timeAt = this.clock()
    }
    if (shouldResumeAfterSeek({ wantsPaused: this.props.paused })) {
      this.player?.resume()
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
    // A player that has run dry is waiting, not paused, as a browser's
    // element is. Android says "not playing" for both, and taking a stall for
    // a pause handed `paused` back to the player, which then stayed stopped
    // when the picture came again: a live viewer at the end of what had been
    // written, while the phone filming it was away, was left on Play for good.
    // Kept playing, the player carries on by itself once there is more.
    // Android reports "not playing" before it reports buffering, so a stop
    // is taken for a pause here and given back by `handleBuffer` when the
    // buffering report follows it; one that comes after is ignored here.
    if (paused && this.buffering) return
    // Nor is a player that has failed paused: the recovery reloads it, and
    // plays it again if the viewer still wants it playing.
    if (paused && this.failed) return
    this.rebase()
    this.props = { ...this.props, paused }
    this.onPropsChange()
    this.playerStoppedAt = paused ? this.clock() : null
    this.emit(paused ? 'pause' : 'play')
  }

  handleReadyForDisplay = (): void => {
    this.rebase()
    this.failed = false
    // A picture is up: what a browser calls `HAVE_ENOUGH_DATA`, which is what
    // the multi-camera grid asks before it believes a tile has started.
    this.state = Math.max(this.state, HAVE_ENOUGH_DATA)
    this.emit('canplay')
    this.emit('loadeddata')
  }

  /**
   * The player has run short, or has enough again.
   *
   * What a browser says with `readyState`, which on a phone otherwise reached
   * `HAVE_ENOUGH_DATA` with the first picture and stayed there: a tile that
   * had run dry looked as healthy as one with a minute in hand, so the grid
   * kept nudging it instead of waiting for it. Buffering takes it back to a
   * picture with nothing behind it; ready puts it back. A player still
   * opening its source has no picture yet, and stays where it is.
   *
   * Android's player says ready only once it holds what it was told to start
   * with (`bufferForPlaybackMs`); AVPlayer says it when it judges playback
   * likely to keep up.
   */
  handleBuffer = (data: OnBufferData): void => {
    this.rebase()
    this.buffering = data.isBuffering
    const stoppedAt = this.playerStoppedAt
    this.playerStoppedAt = null
    if (data.isBuffering) {
      this.state = Math.min(this.state, HAVE_CURRENT_DATA)
      // The player's "not playing" just before this was the stall, not a
      // pause: it is still meant to be playing, and plays on by itself.
      if (
        stoppedAt != null &&
        this.props.paused &&
        this.clock() - stoppedAt <= STALL_REPORT_MS
      ) {
        this.props = { ...this.props, paused: false }
        this.onPropsChange()
        this.emit('play')
      }
      return
    }
    if (this.state < HAVE_CURRENT_DATA || this.state === HAVE_ENOUGH_DATA) {
      return
    }
    this.state = HAVE_ENOUGH_DATA
    this.emit('canplay')
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

  handleEnd = (): void => {
    this.rebase()
    this.over = true
    // Ended is paused, as a browser's element is. Said here because a player
    // that ran dry before it ended, as a live one does when its playlist is
    // closed while it waits, said "not playing" already and will not again.
    this.buffering = false
    this.playerStoppedAt = null
    if (this.props.paused) return
    this.props = { ...this.props, paused: true }
    this.onPropsChange()
    this.emit('pause')
  }

  handleError = (error: OnVideoErrorData): void => {
    // Held where it failed: nothing moves in a player that has given up.
    this.rebase()
    this.failed = true
    // The "not playing" just before this was the failure, not a pause, as
    // the one before a buffering report is a stall. Given back before the
    // recovery hears of the error, so it knows the viewer still wants it.
    const stoppedAt = this.playerStoppedAt
    this.playerStoppedAt = null
    if (
      stoppedAt != null &&
      this.props.paused &&
      this.clock() - stoppedAt <= STALL_REPORT_MS
    ) {
      this.props = { ...this.props, paused: false }
      this.onPropsChange()
      this.emit('play')
    }
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
      this.rebase()
      this.props = { ...this.props, paused: true }
      this.onPropsChange()
    }
    if (this.clearBeforeReload) this.player?.setSource(undefined)
    // The whole source, not only its address: on Android the buffer and the
    // live offset travel with it, and a bare address put ExoPlayer back on
    // its defaults after every reload.
    this.player?.setSource(this.sourceConfig ?? { uri: this.source })
  }

  /** A new source: everything known about the last one is now wrong. */
  reset(): void {
    this.time = 0
    this.timeAt = this.clock()
    this.length = Number.POSITIVE_INFINITY
    this.state = 0
    this.width = 0
    this.height = 0
    this.pendingSeekTo = null
    this.over = false
    this.buffering = false
    this.playerStoppedAt = null
    this.failed = false
    this.seekableEnd = null
  }

  /**
   * How far the picture has moved since `time` was true: only while it is
   * playing a picture with enough behind it, not ended and not on its way to
   * a seek, at the rate it plays, never past `MAX_INTERPOLATION_MS` of it and
   * never past the end.
   */
  private carried(): number {
    if (
      this.props.paused ||
      this.failed ||
      this.over ||
      this.state !== HAVE_ENOUGH_DATA ||
      this.pendingSeekTo != null
    ) {
      return 0
    }
    const elapsed = Math.min(
      Math.max(0, this.clock() - this.timeAt),
      MAX_INTERPOLATION_MS
    )
    return Math.min(
      (elapsed / 1000) * this.props.rate,
      Math.max(0, this.length - this.time)
    )
  }

  /**
   * Fixes the carried playhead as the new starting point, just before the
   * pace changes: a pause, a new rate, a stall, or a stall's end.
   */
  private rebase(): void {
    this.time = this.currentTime
    this.timeAt = this.clock()
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
