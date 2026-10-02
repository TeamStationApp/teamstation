import type { VideoHandle } from './videoHandle'

/** A quarter of normal, which is slow enough to see a swing and still follow it. */
export const SLOW_RATE = 0.25

export interface SlowMotion {
  /** Start crawling forwards; safe to call twice. */
  start: () => void
  /** Put the player back exactly as it was found. */
  stop: () => void
  /** `0.25` while crawling, or 0 when it is running normally. */
  rate: () => number
}

interface Held {
  rate: number
  paused: boolean
  muted: boolean
}

/**
 * Quarter speed, forwards, and silent.
 *
 * Every player has a playback rate, so this is the rate turned down for as
 * long as the hold lasts, and the player put back exactly as it was found
 * when it ends — playing or paused, loud or muted. There is no crawl
 * backwards.
 */
export function slowMotion(getVideo: () => VideoHandle | null): SlowMotion {
  let held: Held | null = null

  const stop = (): void => {
    const video = getVideo()
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

  const start = (): void => {
    const video = getVideo()
    if (video == null || held != null) return
    held = {
      rate: video.playbackRate,
      paused: video.paused,
      muted: video.muted
    }
    video.playbackRate = SLOW_RATE
    // Silent: a quarter-speed crowd is noise, and the sound is given back
    // exactly as it was found when the hold ends.
    video.muted = true
    video.play().catch(() => undefined)
  }

  return { start, stop, rate: () => (held == null ? 0 : SLOW_RATE) }
}
