import { createContext, useContext, useEffect, useState } from 'react'
import { Dimensions, type ScaledSize, useWindowDimensions } from 'react-native'

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

/**
 * Where the app's content pane sits in the window, when it is not the whole
 * window: with Tess open on a wide screen, her chat takes a column on the
 * left and the pane is the rest. Screens that size themselves to the window
 * size themselves to this instead, so they lay out for the width they have.
 */
export interface PaneFrame {
  x: number
  y: number
  width: number
  height: number
}

/** The pane's frame, or null where the pane is the whole window. */
export const PaneFrameContext = createContext<PaneFrame | null>(null)

/** The pane's rectangle in the window: the window itself without a frame. */
export function usePaneFrame(): PaneFrame {
  const frame = useContext(PaneFrameContext)
  const { width, height } = useWindowDimensions()
  return frame ?? { x: 0, y: 0, width, height }
}

/** How wide the pane is, which is the window's width without a frame. */
export function usePaneWidth(): number {
  return usePaneFrame().width
}

/** The pane's breakpoint: its frame's width, or the window's. */
export function useBreakpoint(): Breakpoint {
  const frame = useContext(PaneFrameContext)
  const windowBreakpoint = useWindowBreakpoint()
  return frame == null ? windowBreakpoint : breakpointFor(frame.width)
}

/**
 * The window's breakpoint, which changes state only when the window crosses
 * a boundary, so a window dragged wider redraws nothing in between.
 */
function useWindowBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    breakpointFor(Dimensions.get('window').width)
  )

  useEffect(() => {
    const subscription = Dimensions.addEventListener(
      'change',
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- DisplayMetrics, which it suggests, is not in react-native's public types
      ({ window }: { window: ScaledSize }) => {
        setBreakpoint(breakpointFor(window.width))
      }
    )
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
