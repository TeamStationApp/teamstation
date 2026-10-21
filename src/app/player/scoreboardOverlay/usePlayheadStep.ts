import { useEffect, useRef, useState } from 'react'

import type { BoardStep } from '../../../common/api'
import { boardAt } from './boardAt'

/** A source of display frames: the browser's animation frames by default. */
export interface FrameLoop {
  request: (run: () => void) => number
  cancel: (handle: number) => void
}

export const animationFrames: FrameLoop = {
  request: run =>
    requestAnimationFrame(() => {
      run()
    }),
  cancel: handle => {
    cancelAnimationFrame(handle)
  }
}

/**
 * How far the frame on screen may move past the clock in one frame before it
 * counts as a seek. Playing moves it by the frame's own length; a seek, or a
 * jump back, moves it by more than this.
 */
export const SEEK_JUMP_MS = 2000

/**
 * The step of the board for the frame on screen, read once a display frame:
 * or of any timeline of steps, such as the game's line score.
 *
 * `wallNow` is the wall-clock instant of the picture showing now: the
 * player's position, through the video's wall timeline. It is read every
 * frame rather than on the player's `timeupdate`, which comes four times a
 * second, so a change of board lands on the frame it belongs to. The
 * component re-renders only when the step changes.
 *
 * A jump of the picture against the clock is a seek, and is reported, so the
 * steps around the new position can be fetched again.
 */
export function usePlayheadStep<
  Step extends { at: number } = BoardStep
>(options: {
  steps: readonly Step[] | null
  wallNow: () => number | null
  onSeek?: (wallMs: number) => void
  frames?: FrameLoop
  now?: () => number
}): Step | null {
  const { frames = animationFrames, now = Date.now } = options
  const [step, setStep] = useState<Step | null>(null)
  const latest = useRef(options)
  latest.current = options
  const shown = useRef<Step | null>(null)

  useEffect(() => {
    let handle = 0
    let last: { wallMs: number; at: number } | null = null
    const tick = (): void => {
      const { steps, wallNow, onSeek } = latest.current
      const wallMs = wallNow()
      const at = now()
      if (wallMs != null) {
        if (last != null) {
          const moved = wallMs - last.wallMs
          if (moved - (at - last.at) > SEEK_JUMP_MS || moved < -SEEK_JUMP_MS)
            onSeek?.(wallMs)
        }
        last = { wallMs, at }
      }
      const next = boardAt(steps ?? [], wallMs)
      if (next !== shown.current) {
        shown.current = next
        setStep(next)
      }
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
    }
  }, [frames, now])

  return step
}
