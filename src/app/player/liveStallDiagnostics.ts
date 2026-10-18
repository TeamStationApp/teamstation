import { captureException } from '../sentrySdk'
import type { RetryClock } from './attachHls'

const STALL_MS = 15_000
const CHECK_RETRY_MS = 60_000

type LiveVideo = Pick<
  HTMLVideoElement,
  | 'currentTime'
  | 'paused'
  | 'ended'
  | 'seeking'
  | 'readyState'
  | 'networkState'
  | 'buffered'
  | 'seekable'
  | 'error'
>

export interface LiveStallSnapshot {
  positionSeconds: number | null
  stalledSeconds: number
  bufferedAheadSeconds: number
  nextBufferGapSeconds: number | null
  seekableStartSeconds: number | null
  seekableEndSeconds: number | null
  readyState: number
  networkState: number
  seeking: boolean
  error_code: number | null
}

/** Only numeric player state: never the source URL, error text or footage. */
export function liveStallSnapshot(
  video: LiveVideo,
  stalledMs: number
): LiveStallSnapshot {
  const at = video.currentTime
  let ahead = 0
  let gap: number | null = null
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i)
    const end = video.buffered.end(i)
    if (end <= at) continue
    if (start <= at) ahead = end - at
    else gap = start - at
    break
  }
  const seekable = video.seekable
  const finite = (value: number): number | null =>
    Number.isFinite(value) ? value : null
  return {
    positionSeconds: finite(at),
    stalledSeconds: stalledMs / 1000,
    bufferedAheadSeconds: ahead,
    nextBufferGapSeconds: gap,
    seekableStartSeconds:
      seekable.length > 0 ? finite(seekable.start(0)) : null,
    seekableEndSeconds:
      seekable.length > 0 ? finite(seekable.end(seekable.length - 1)) : null,
    readyState: video.readyState,
    networkState: video.networkState,
    seeking: video.seeking,
    error_code: video.error?.code ?? null
  }
}

export function reportLiveStall(
  snapshot: LiveStallSnapshot,
  engine: string,
  report: typeof captureException = captureException
): void {
  report(new Error('Live video playback stopped advancing'), {
    tags: { feature: 'live-playback', playbackEngine: engine },
    extra: { playback: snapshot }
  })
}

/**
 * Native HLS can keep retrying without raising an error. Report one sustained
 * foreground stall per attachment, after verifying the broadcast is still live.
 * This observes playback; it never seeks, reloads, pauses or resumes it.
 */
export function observeLiveStalls(
  video: LiveVideo,
  options: {
    engine: string
    wantsToPlay: () => boolean
    isLive: () => boolean | Promise<boolean>
  },
  dependencies: {
    clock?: RetryClock
    visible?: () => boolean
    report?: (snapshot: LiveStallSnapshot, engine: string) => void
  } = {}
): () => void {
  const clock: RetryClock = dependencies.clock ?? {
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: timer => {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  }
  const visible = dependencies.visible ?? (() => !globalThis.document?.hidden)
  const report = dependencies.report ?? reportLiveStall
  let lastAt = video.currentTime
  let lastProgress = clock.now()
  let lastTick = lastProgress
  let lastCheck = Number.NEGATIVE_INFINITY
  let generation = 0
  let pending = false
  let stopped = false
  let timer: unknown

  const reset = (): void => {
    lastAt = video.currentTime
    lastProgress = clock.now()
    lastTick = lastProgress
    generation += 1
  }
  const stop = (): void => {
    stopped = true
    clock.clearTimeout(timer)
    globalThis.document?.removeEventListener('visibilitychange', reset)
    globalThis.window?.removeEventListener('pageshow', reset)
    globalThis.window?.removeEventListener('pagehide', reset)
  }
  globalThis.document?.addEventListener('visibilitychange', reset)
  globalThis.window?.addEventListener('pageshow', reset)
  globalThis.window?.addEventListener('pagehide', reset)

  const tick = (): void => {
    const now = clock.now()
    const at = video.currentTime
    // Sleeping devices and suspended background timers are not playback stalls.
    // Also reset if the wall clock moves backwards during observation.
    const suspended = now - lastTick > 3000 || now < lastTick
    lastTick = now
    const idle =
      video.paused || video.ended || !options.wantsToPlay() || !visible()
    // A recovery nudge of 50 ms is not evidence of resumed playback.
    if (suspended || idle || Math.abs(at - lastAt) >= 0.1) {
      lastProgress = now
      generation += 1
    } else if (
      !pending &&
      now - lastProgress >= STALL_MS &&
      now - lastCheck >= CHECK_RETRY_MS
    ) {
      pending = true
      lastCheck = now
      const checkGeneration = generation
      Promise.resolve()
        .then(options.isLive)
        .then(live => {
          if (stopped || generation !== checkGeneration) return
          const resumedAt = clock.now()
          if (resumedAt - lastTick > 3000 || resumedAt < lastTick) {
            reset()
            return
          }
          if (
            video.paused ||
            video.ended ||
            !options.wantsToPlay() ||
            !visible()
          )
            return
          if (Math.abs(video.currentTime - at) >= 0.1) return
          stop()
          if (live)
            report(liveStallSnapshot(video, now - lastProgress), options.engine)
        })
        .catch(() => undefined)
        .finally(() => {
          pending = false
        })
    }
    lastAt = at
    if (!stopped) timer = clock.setTimeout(tick, 1000)
  }
  timer = clock.setTimeout(tick, 1000)
  return stop
}
