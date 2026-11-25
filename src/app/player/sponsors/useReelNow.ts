import { useEffect, useRef, useState } from 'react'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import {
  animationFrames,
  type FrameLoop
} from '../scoreboardOverlay/usePlayheadStep'
import { reelAt } from './reelTimeline'

/**
 * The sponsor reel playing at the picture's wall time, read once a display
 * frame (`wallNow`, as the board is). The component re-renders only when the
 * reel changes, so a player lays the reel out, and hides what it covers, on
 * the frame it starts and the frame it ends. Null with no reels or none on.
 */
export function useReelNow(options: {
  reels: readonly GameSponsorReel[] | null | undefined
  wallNow: () => number | null
  frames?: FrameLoop
}): GameSponsorReel | null {
  const { frames = animationFrames } = options
  const [reel, setReel] = useState<GameSponsorReel | null>(null)
  const latest = useRef(options)
  latest.current = options
  const shown = useRef<GameSponsorReel | null>(null)
  const any = (options.reels?.length ?? 0) > 0

  useEffect(() => {
    if (!any) {
      if (shown.current != null) {
        shown.current = null
        setReel(null)
      }
      return
    }
    let handle = 0
    const tick = (): void => {
      const { reels, wallNow } = latest.current
      const next = reelAt(reels ?? [], wallNow())?.reel ?? null
      if (next?.id !== shown.current?.id) {
        shown.current = next
        setReel(next)
      }
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
    }
  }, [any, frames])

  return any ? reel : null
}
