import { useEffect, useRef } from 'react'

import type { KeyboardShortcuts } from './keyboardShortcuts'
import { HOLD_MS, seekBy, STEP_SECONDS } from './zones'

export type { KeyboardShortcuts }

/**
 * The arrow keys, space and `k`, while this screen is on top.
 *
 * The same four actions the nine squares do, because somebody watching on a
 * laptop reaches for the keyboard and not for the picture. Taken in the
 * **capture** phase: the browser's own control bar seeks on arrow keys the
 * moment its scrubber has focus, and a bubble-phase listener arrives after it
 * has already moved.
 *
 * A phone has no keyboard, and `useKeyboardShortcuts.native.ts` is the
 * one-line answer to that. Lifting this out of `PlayerSurface` is not tidying:
 * React Native defines `global.window` and gives it no `addEventListener`, so
 * left where it was this was a `TypeError` on every mount of the watch tab.
 *
 * **Right is a tap or a hold.** Let go within `HOLD_MS` it skips ten seconds,
 * on the way up; held that long it crawls at a quarter speed until it is let
 * go, and skips nothing. A key held while the window loses focus delivers no
 * `keyup`, so a hold not yet begun is forgotten then, and on unmount.
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcuts): void {
  const { enabled = true } = shortcuts
  // Through a ref, so a caller may pass fresh closures on every render —
  // which the multi-camera view does, because its actions close over which
  // tile is heard and where the take is — without tearing the listeners down
  // and putting them back each time.
  const latest = useRef(shortcuts)
  latest.current = shortcuts
  useEffect(() => {
    if (!enabled) return
    /** A Right down and not yet up, before it has become a hold. */
    let rightTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * Right, or Up, started the crawl running now, which its `keyup` ends. A
     * key held while another key or a finger already holds one starts
     * nothing, and letting it go must not end the other's.
     */
    let rightHeld = false
    let upHeld = false
    const forget = (): void => {
      if (rightTimer != null) clearTimeout(rightTimer)
      rightTimer = null
    }
    const isTyping = (target: EventTarget | null): boolean => {
      const node = target as HTMLElement | null
      // `?.` on the tag too: a key sent to the window itself has none.
      const tag = node?.tagName?.toLowerCase()
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        node?.isContentEditable === true
      )
    }
    const down = (event: KeyboardEvent): void => {
      const { act, beginSlow, holding, seek, video } = latest.current
      const player = video()
      if (player == null) return
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return
      }
      if (isTyping(event.target)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (seek != null) seek(-STEP_SECONDS)
        else seekBy(player, -STEP_SECONDS)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (event.repeat || rightTimer != null || rightHeld) return
        rightTimer = setTimeout(() => {
          rightTimer = null
          if (latest.current.holding()) return
          rightHeld = true
          latest.current.beginSlow('slowForward')
        }, HOLD_MS)
      } else if (event.key === 'ArrowUp') {
        // Held, it crawls forwards, as a hold on the +10 s square does.
        event.preventDefault()
        if (event.repeat || holding()) return
        upHeld = true
        beginSlow('slowForward')
      } else if (event.key === ' ' || event.key === 'k') {
        event.preventDefault()
        act('toggle')
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' && upHeld) {
        upHeld = false
        latest.current.endSlow()
      }
      if (event.key === 'ArrowRight') {
        if (rightTimer != null) {
          // Let go in time: a tap, which skips.
          forget()
          const { seek, video } = latest.current
          const player = video()
          if (seek != null) seek(STEP_SECONDS)
          else if (player != null) seekBy(player, STEP_SECONDS)
        } else if (rightHeld) {
          rightHeld = false
          latest.current.endSlow()
        }
      }
    }
    // A key held while the tab changes never delivers its `keyup`.
    const blur = (): void => {
      forget()
      if (rightHeld || upHeld) latest.current.endSlow()
      rightHeld = false
      upHeld = false
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      forget()
      latest.current.endSlow()
    }
    // Rebound only when it is switched on or off. Every caller hands in fresh
    // closures on each render, `video` included, and a rebind is not free: its
    // cleanup ends a crawl, so rebinding on the render that a crawl's own
    // state change causes stopped every hold a quarter of a second in.
  }, [enabled])
}
