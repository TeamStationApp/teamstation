import { type RefObject, useEffect, useRef } from 'react'

import type { VideoHandle } from '../player/videoHandle'
import { randomUuid } from '../stream/deviceId'
import { useAnalytics } from './AnalyticsContext'
import { isForeground, observeLifecycle } from './lifecycle'
import { watchPlayer } from './watchPlayer'

/** Attach only to the full viewer. Feed previews have no analytics observer. */
export function useVideoAnalytics(
  handle: VideoHandle | RefObject<VideoHandle | null> | null,
  video: string,
  source: string | null,
  selected: boolean
): void {
  const analytics = useAnalytics()
  const observer = useRef<ReturnType<typeof watchPlayer> | undefined>(undefined)
  const chosen = useRef(selected)
  chosen.current = selected
  useEffect(() => {
    const player =
      handle != null && 'current' in handle ? handle.current : handle
    if (analytics == null || player == null || source == null) return
    // Freeze ownership when viewing actually starts; late callbacks after an
    // account switch must never become the new account's viewing history.
    let send: ReturnType<typeof analytics.capture> | undefined
    const current = watchPlayer(
      player,
      video,
      chosen.current,
      isForeground(),
      randomUuid,
      (event, properties) => {
        send ??= analytics.capture()
        send(event, properties)
      }
    )
    observer.current = current
    const stop = observeLifecycle(active => {
      current.foreground(active)
    })
    return () => {
      stop()
      current.close()
      if (observer.current === current) observer.current = undefined
      analytics.flush().catch(() => {})
    }
  }, [analytics, handle, video, source])
  useEffect(() => {
    observer.current?.select(selected)
  }, [selected])
}
