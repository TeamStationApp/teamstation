import type { RetryClock } from './attachHls'

/** Leave normal buffering to the engine before trying a bounded seek. */
export const LIVE_STALL_MS = 10_000
const MAX_GAP_SEC = 60
const MAX_NUDGES = 3
/**
 * Footage held at the playhead that an engine should be playing rather than
 * waiting for more of: one segment.
 */
export const RESTART_AHEAD_SEC = 4

type StalledVideo = Pick<
  HTMLVideoElement,
  'currentTime' | 'paused' | 'ended' | 'seeking' | 'buffered'
> & {
  pause: () => void
  play: () => Promise<void>
}

/** Seconds of footage held without a break from `at` onwards. */
export function heldAhead(ranges: TimeRanges, at: number): number {
  for (let index = 0; index < ranges.length; index++) {
    const start = ranges.start(index)
    const end = ranges.end(index)
    if (start <= at && end > at) return end - at
  }
  return 0
}

/**
 * A live publisher can leave a timestamp hole with playable footage after it.
 * Some engines wait at that hole indefinitely without raising an error. Once
 * the picture has stopped for ten seconds, move into footage already held.
 * Never jump to the live edge, reload the source, or undo the viewer's pause.
 *
 * Safari can also stop with the footage right there. Its own player runs dry
 * at the edge of what it has, decides the line is too slow to keep up with
 * the one rendition there is, and waits for it to get faster — for ever,
 * while it goes on loading. Measured on an iPhone held to 3 Mbit/s under a
 * 5.4 Mbit/s game: stopped at `readyState` 3 with 44 seconds buffered ahead,
 * through three 50 ms nudges (each one cost it its decoded pictures and none
 * started it) and a bare `play()`. A pause and a play started it at once. So
 * where a whole segment is held at the playhead, that is what it gets.
 */
export function recoverLiveStalls(
  video: StalledVideo,
  wantsToPlay: () => boolean,
  clock: RetryClock = {
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: timer => {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  }
): () => void {
  let lastTime = video.currentTime
  let lastProgress = clock.now()
  let nudges = 0
  let timer: unknown

  const tick = (): void => {
    const at = video.currentTime
    const now = clock.now()
    if (video.paused || video.ended || !wantsToPlay()) {
      nudges = 0
      lastProgress = now
    } else if (video.seeking) {
      lastProgress = now
    } else if (Math.abs(at - lastTime) > 0.001) {
      nudges = 0
      lastProgress = now
    } else if (
      now - lastProgress >= LIVE_STALL_MS &&
      nudges < MAX_NUDGES &&
      heldAhead(video.buffered, at) >= RESTART_AHEAD_SEC
    ) {
      // The pause is not the viewer's: the play straight after it says so to
      // anything listening, and the element is playing again either way.
      video.pause()
      video.play().catch(() => undefined)
      nudges += 1
      lastProgress = now
    } else if (now - lastProgress >= LIVE_STALL_MS && nudges < MAX_NUDGES) {
      const ranges = video.buffered
      for (let index = 0; index < ranges.length; index++) {
        const start = ranges.start(index)
        const end = ranges.end(index)
        if (end < at + 1) continue
        // A later range can be left over from a seek. Only cross a large
        // hole when actually stopped at the end of the preceding range.
        if (
          start - at > 0.5 &&
          (index === 0 || Math.abs(ranges.end(index - 1) - at) > 0.5)
        )
          break
        // The first usable range either contains this moment or begins after
        // a missing stretch. A seek into it must leave a second to play.
        const next = Math.max(at, start) + 0.05
        if (next - at <= MAX_GAP_SEC && end - next >= 1) {
          video.currentTime = next
          nudges += 1
          lastProgress = now
        }
        break
      }
    }
    // Our own nudge is not evidence that pictures have resumed.
    lastTime = video.currentTime
    timer = clock.setTimeout(tick, 1000)
  }
  timer = clock.setTimeout(tick, 1000)
  return () => {
    clock.clearTimeout(timer)
  }
}
