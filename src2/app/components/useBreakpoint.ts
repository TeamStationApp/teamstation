import { useEffect, useState } from 'react'
import { Dimensions } from 'react-native'

/**
 * How wide the window is, in the three sizes the layout actually changes at.
 *
 * The designs are drawn at phone width only. Rather than scatter width checks
 * through the screens, every screen asks this and the few components that care
 * — the navigation, the content container, the grids — decide for themselves.
 *
 * The boundaries are the ones in the written spec: a handheld below 600, a
 * tablet or split dugout view to 1023, and a desktop above that.
 */
export type Breakpoint = 'phone' | 'tablet' | 'desktop'

export const PHONE_MAX = 600
export const TABLET_MAX = 1024

export function breakpointFor(width: number): Breakpoint {
  if (width < PHONE_MAX) return 'phone'
  if (width < TABLET_MAX) return 'tablet'
  return 'desktop'
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    breakpointFor(Dimensions.get('window').width)
  )

  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setBreakpoint(breakpointFor(window.width))
    })
    return () => {
      subscription.remove()
    }
  }, [])

  return breakpoint
}

/** How many columns a card grid gets. One on a phone is the design as drawn. */
export function columnsFor(breakpoint: Breakpoint): number {
  if (breakpoint === 'phone') return 1
  if (breakpoint === 'tablet') return 2
  return 3
}
