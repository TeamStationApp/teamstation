import { useEffect } from 'react'

import type { KeyboardShortcuts } from './keyboardShortcuts'
import { seekBy, STEP_SECONDS } from './zones'

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
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcuts): void {
  const { video, act, beginSlow, endSlow, holding } = shortcuts
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const node = target as HTMLElement | null
      const tag = node?.tagName.toLowerCase()
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        node?.isContentEditable === true
      )
    }
    const down = (event: KeyboardEvent): void => {
      const player = video()
      if (player == null) return
      if (
        event.ctrlKey === true ||
        event.metaKey === true ||
        event.altKey === true
      ) {
        return
      }
      if (isTyping(event.target)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekBy(player, -STEP_SECONDS)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekBy(player, STEP_SECONDS)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (event.repeat === true || holding()) return
        beginSlow(event.key === 'ArrowUp' ? 'slowForward' : 'slowBack')
      } else if (event.key === ' ' || event.key === 'k') {
        event.preventDefault()
        act('toggle')
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') endSlow()
    }
    // A key held while the tab changes never delivers its `keyup`.
    const blur = (): void => {
      endSlow()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      endSlow()
    }
    // Rebound only when the player itself changes; the callbacks are recreated
    // on every render and binding to them would rebind on every render too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video])
}
