import type { RetryClock } from './attachHls'

/** Leave normal buffering to the engine before trying a bounded seek. */
export const LIVE_STALL_MS = 10_000
const MAX_GAP_SEC = 60
const MAX_NUDGES = 3

type StalledVideo = Pick<
  HTMLVideoElement,
  'currentTime' | 'paused' | 'ended' | 'seeking' | 'buffered'
>

/**
 * A live publisher can leave a timestamp hole with playable footage after it.
 * Some engines wait at that hole indefinitely without raising an error. Once
 * the picture has stopped for ten seconds, move into footage already held.
 * Never jump to the live edge, reload the source, or undo the viewer's pause.
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
