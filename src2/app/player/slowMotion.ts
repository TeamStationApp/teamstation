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
 * Quarter speed, in both directions.
 *
 * Forwards is the easy half: the browser has a playback rate and keeps the
 * pitch. Backwards has no browser support anywhere — no engine takes a negative
 * rate — so it is stepped by hand, frame by frame, with the element paused and
 * muted. Sound played backwards helps nobody.
 *
 * It is only smooth inside what the streaming library has kept behind the
 * playhead; past that it re-buffers and stutters, which is the reason
 * `attachHls` asks for a generous back buffer.
 */
export function slowMotion(
  getVideo: () => HTMLVideoElement | null
): SlowMotion {
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
      // Keeps speech intelligible at a quarter speed rather than an octave down.
      const withPitch = video as HTMLVideoElement & {
        preservesPitch?: boolean
        webkitPreservesPitch?: boolean
      }
      withPitch.preservesPitch = true
      withPitch.webkitPreservesPitch = true
      video.play().catch(() => undefined)
      return
    }

    current = -SLOW_RATE
    video.pause()
    video.muted = true
    last = performance.now()
    const step = (now: number): void => {
      const seconds = (now - last) / 1000
      last = now
      const next = video.currentTime - seconds * SLOW_RATE
      video.currentTime = next < 0 ? 0 : next
      frame = next <= 0 ? 0 : requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  return { start, stop, rate: () => current }
}
