import { useLayoutEffect } from 'react'
import type { ViewStyle } from 'react-native'

export const glassStyle: ViewStyle & {
  backdropFilter: string
  WebkitBackdropFilter: string
} = {
  backdropFilter: 'blur(18px) saturate(150%)',
  WebkitBackdropFilter: 'blur(18px) saturate(150%)'
}

/** Cover only this route; restore the rest of the app's viewport policy on exit. */
export function useFieldSurface(): { root: ViewStyle; safe: ViewStyle } {
  useLayoutEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]')
    const previous = meta?.getAttribute('content') ?? ''
    const overflow = document.body.style.overflow
    const overscroll = document.documentElement.style.overscrollBehavior
    meta?.setAttribute(
      'content',
      'width=device-width, initial-scale=1, viewport-fit=cover'
    )
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overscrollBehavior = 'none'
    return () => {
      meta?.setAttribute('content', previous)
      document.body.style.overflow = overflow
      document.documentElement.style.overscrollBehavior = overscroll
    }
  }, [])
  return {
    root: {
      position: 'fixed',
      inset: 0,
      width: '100%',
      height: '100dvh',
      overflow: 'hidden',
      touchAction: 'none'
    } as unknown as ViewStyle,
    safe: {
      paddingTop: 'max(8px, env(safe-area-inset-top))',
      // The gap sits beyond the home indicator's inset, as on a phone
      // (`fieldSafeArea.ts`); it is the same 8px wherever there is none.
      paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
      paddingLeft: 'max(8px, env(safe-area-inset-left))',
      paddingRight: 'max(8px, env(safe-area-inset-right))'
    }
  }
}
