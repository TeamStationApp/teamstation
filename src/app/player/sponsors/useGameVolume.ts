import { useEffect, useRef } from 'react'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import {
  animationFrames,
  type FrameLoop
} from '../scoreboardOverlay/usePlayheadStep'
import { gameVolumeAt, reelAt } from './reelTimeline'

/** How a player's game audio is turned down under a reel. */
export interface GameAudio {
  /** Sets the game's volume, 0 to 1. */
  setVolume: (volume: number) => void
  /**
   * Whether the volume can be set at all. iOS Safari's `<video>` ignores it
   * (`volumeSettable`); there the game is muted for the reel instead. Null
   * while there is no element to ask yet.
   */
  settable: () => boolean | null
  /**
   * Mutes the game for a reel (true), or gives it back the viewer's own
   * mute (false), where its volume cannot be set.
   */
  setDucked: (ducked: boolean) => void
}

/**
 * Whether an element's volume can be set: 0.5 is written and read back, and
 * the volume it had put back. iOS Safari reads back 1, whatever was written.
 */
export function volumeSettable(element: { volume: number }): boolean {
  const before = element.volume
  try {
    element.volume = 0.5
  } catch {
    return false
  }
  const took = Math.abs(element.volume - 0.5) < 0.01
  try {
    element.volume = before
  } catch {}
  return took
}

/** Volume steps finer than this are not written: a fade is a hundred of them. */
const STEP = 0.01

/**
 * The game's audio under its sponsor reels: each display frame, the volume
 * `gameVolumeAt` gives for the picture's wall time, down to 0.2 over the
 * second before a reel and back over the second after. Where the volume
 * cannot be set, the game is muted for the reel itself and given back the
 * viewer's mute after it. Which of the two is asked again each frame until
 * there is an element to answer, and kept from then. Nothing is written while
 * nothing changes, and with no reels or no audio the game is left as it is;
 * once they go, it is put back to full.
 */
export function useGameVolume(options: {
  reels: readonly GameSponsorReel[] | null | undefined
  wallNow: () => number | null
  audio: GameAudio | null
  frames?: FrameLoop
}): void {
  const { frames = animationFrames, audio } = options
  const latest = useRef(options)
  latest.current = options
  const any = (options.reels?.length ?? 0) > 0

  useEffect(() => {
    if (!any || audio == null) return
    let handle = 0
    let volume: number | null = null
    let ducked: boolean | null = null
    let settable: boolean | null = null
    const tick = (): void => {
      const { reels, wallNow } = latest.current
      const wall = wallNow()
      // Null while there is no element: asked again on the next frame.
      settable ??= audio.settable()
      if (settable === true) {
        const next = Math.round(gameVolumeAt(reels ?? [], wall) / STEP) * STEP
        if (volume == null || Math.abs(next - volume) >= STEP / 2) {
          volume = next
          audio.setVolume(next)
        }
      } else if (settable === false) {
        const next = reelAt(reels ?? [], wall) != null
        if (ducked !== next) {
          ducked = next
          audio.setDucked(next)
        }
      }
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
      if (volume != null && volume !== 1) audio.setVolume(1)
      if (ducked === true) audio.setDucked(false)
    }
  }, [any, audio, frames])
}
