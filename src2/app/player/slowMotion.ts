import type { VideoHandle } from './videoHandle'

/** A quarter of normal, which is slow enough to see a swing and still follow it. */
export const SLOW_RATE = 0.25

export interface SlowMotion {
  /** Start crawling forwards or backwards; safe to call twice. */
  start: (direction: 'forward' | 'back') => void
  /** Put the player back exactly as it was found. */
  stop: () => void
  /** `0.25`, `-0.25`, or 0 when it is running normally. */
  rate: () => number
}

interface Held {
  rate: number
  paused: boolean
  muted: boolean
}

/**
 * Quarter speed, in both directions, and silent both ways.
 *
 * Forwards is the easy half: every player has a playback rate. Backwards has no support anywhere — no browser engine takes a
 * negative rate, and neither does ExoPlayer — so it is stepped by hand, frame
 * by frame, with the player paused and muted. Sound played backwards helps
 * nobody.
 *
 * On a phone each of those frames is a `seek`, which is the one thing here
 * that has not been judged on a device. See `MOBILE.md`.
 *
 * It is only smooth inside what the streaming library has kept behind the
 * playhead; past that it re-buffers and stutters, which is the reason
 * `attachHls` asks for a generous back buffer.
 */
export function slowMotion(getVideo: () => VideoHandle | null): SlowMotion {
  let held: Held | null = null
  let frame = 0
  let last = 0
  let current = 0

  const stop = (): void => {
    const video = getVideo()
    if (frame !== 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    current = 0
    if (video == null || held == null) {
      held = null
      return
    }
    video.playbackRate = held.rate
    video.muted = held.muted
    if (held.paused) video.pause()
    else video.play().catch(() => undefined)
    held = null
  }

  const start = (direction: 'forward' | 'back'): void => {
    const video = getVideo()
    if (video == null || held != null) return
    held = {
      rate: video.playbackRate,
      paused: video.paused,
      muted: video.muted
    }

    if (direction === 'forward') {
      current = SLOW_RATE
      video.playbackRate = SLOW_RATE
      // Silent, as backwards is: a quarter-speed crowd is noise, and the
      // sound is given back exactly as it was found when the hold ends.
      video.muted = true
      video.play().catch(() => undefined)
      return
    }

    current = -SLOW_RATE
    video.pause()
    video.muted = true
    // The baseline comes from the first frame rather than from a clock read
    // here: `requestAnimationFrame` hands its callback a timestamp on every
    // platform, and taking it from there means this file needs no clock of its
    // own — `performance` is a browser global that a phone does not type.
    last = 0
    const step = (now: number): void => {
      const seconds = last === 0 ? 0 : (now - last) / 1000
      last = now
      const next = video.currentTime - seconds * SLOW_RATE
      video.currentTime = next < 0 ? 0 : next
      frame = next <= 0 ? 0 : requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  return { start, stop, rate: () => current }
}
