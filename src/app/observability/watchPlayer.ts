import type { EventName, Property } from '../../common/observability/contract'
import { WatchClock } from '../../common/observability/watch'
import type { VideoEventName, VideoHandle } from '../player/videoHandle'

/** Passive observer: never seeks, pauses, starts, or changes player properties. */
export function watchPlayer(
  player: VideoHandle,
  video: string,
  selected: boolean,
  foreground: boolean,
  id: () => string,
  emit: (event: EventName, properties: Record<string, Property>) => void,
  now?: () => number
): {
  select: (value: boolean) => void
  foreground: (value: boolean) => void
  close: () => void
} {
  let clock: WatchClock | undefined
  let playing =
    player.actuallyPlaying ?? (!player.paused && player.readyState >= 3)
  let buffering = false
  let seeking: number | undefined
  const state = (): void => {
    clock?.update({
      playing,
      buffering,
      selected,
      foreground,
      position: Math.max(
        0,
        Math.min(
          604800,
          Number.isFinite(player.currentTime) ? player.currentTime : 0
        )
      ),
      rate: Math.max(
        -16,
        Math.min(
          16,
          Number.isFinite(player.playbackRate) ? player.playbackRate : 1
        )
      )
    })
  }
  const start = (): void => {
    clock ??= new WatchClock(video, id(), emit, now)
    state()
  }
  const stop = (completed: boolean): void => {
    clock?.close(completed)
    clock = undefined
    playing = false
  }
  const handlers: Partial<Record<VideoEventName, () => void>> = {
    playing: () => {
      playing = true
      buffering = false
      seeking = undefined
      start()
    },
    pause: () => {
      playing = false
      state()
    },
    waiting: () => {
      buffering = true
      state()
    },
    seeking: () => {
      buffering = true
      state()
      // Native progress can acknowledge a seek before its seeked callback.
      // Capture the target at the transition so that callback ordering cannot lose it.
      const position = Math.max(
        0,
        Math.min(
          604800,
          Number.isFinite(player.currentTime) ? player.currentTime : 0
        )
      )
      if (seeking == null || Math.abs(position - seeking) > 0.5)
        clock?.seek(position)
      seeking = position
    },
    seeked: () => {
      buffering = false
      playing = player.actuallyPlaying ?? !player.paused
      state()
    },
    timeupdate: state,
    ratechange: state,
    error: () => {
      playing = false
      state()
    },
    ended: () => {
      stop(true)
    },
    emptied: () => {
      stop(false)
    }
  }
  start()
  for (const [event, handler] of Object.entries(handlers))
    player.addEventListener(event as VideoEventName, handler)
  return {
    select: value => {
      selected = value
      state()
    },
    foreground: value => {
      foreground = value
      state()
    },
    close: () => {
      for (const [event, handler] of Object.entries(handlers))
        player.removeEventListener(event as VideoEventName, handler)
      stop(false)
    }
  }
}
