import { useEffect, useRef, useState } from 'react'
import { Dimensions, type ScaledSize } from 'react-native'

import { TABLET_MAX } from '../components/useBreakpoint'

/** How wide Tess's chat column is beside the app on a wide screen. */
export const TESS_COLUMN_WIDTH = 400

/**
 * Whether a window this wide shows Tess beside the app rather than over it:
 * wider than a portrait tablet, so the pane keeps at least a tablet's width.
 */
export function tessIsWide(windowWidth: number): boolean {
  return windowWidth > TABLET_MAX
}

/**
 * Whether the window is wide enough for Tess's column, as state that changes
 * only when the window crosses that width: the Shell reads this, and a window
 * dragged wider or narrower redraws nothing in between.
 */
export function useTessWide(): boolean {
  const [wide, setWide] = useState(() =>
    tessIsWide(Dimensions.get('window').width)
  )
  // Set only on a change: setting the same value can still redraw once.
  const shown = useRef(wide)
  useEffect(() => {
    const subscription = Dimensions.addEventListener(
      'change',
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- DisplayMetrics, which it suggests, is not in react-native's public types
      ({ window }: { window: ScaledSize }) => {
        const next = tessIsWide(window.width)
        if (next === shown.current) return
        shown.current = next
        setWide(next)
      }
    )
    return () => {
      subscription.remove()
    }
  }, [])
  return wide
}
