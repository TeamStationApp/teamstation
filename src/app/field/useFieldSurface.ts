import { useLayoutEffect, useState } from 'react'
import type { ViewStyle } from 'react-native'

import type { Insets } from '../platform/insets'

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

const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 }
const SIDES = ['top', 'bottom', 'left', 'right'] as const

/**
 * The hardware insets in points, as numbers: the four
 * `env(safe-area-inset-*)` values, read from a hidden probe whose padding is
 * them. They are read at once, again on the next frame, since a browser may
 * apply the `viewport-fit=cover` `useFieldSurface` has just set only after
 * that first read and need not fire `resize` for it, and again whenever the
 * window or the visual viewport resizes or the window turns. A browser
 * without insets gives zeros.
 */
export function useFieldInsets(): Insets {
  const [insets, setInsets] = useState<Insets>(NO_INSETS)
  useLayoutEffect(() => {
    const probe = document.createElement('div')
    probe.setAttribute('data-field-insets', '')
    probe.setAttribute('aria-hidden', 'true')
    // The attribute, not `style.cssText`, so the `env()` text is the
    // browser's to read even where the parser would drop it.
    probe.setAttribute(
      'style',
      [
        'position: fixed',
        'top: 0',
        'left: 0',
        'width: 0',
        'height: 0',
        'visibility: hidden',
        'pointer-events: none',
        ...SIDES.map(
          side => `padding-${side}: env(safe-area-inset-${side}, 0px)`
        )
      ].join('; ')
    )
    document.body.append(probe)
    const read = (): void => {
      const style = window.getComputedStyle(probe)
      const of = (value: string): number => {
        const points = Number.parseFloat(value)
        return Number.isFinite(points) ? points : 0
      }
      const next: Insets = {
        top: of(style.paddingTop),
        bottom: of(style.paddingBottom),
        left: of(style.paddingLeft),
        right: of(style.paddingRight)
      }
      setInsets(previous =>
        SIDES.every(side => previous[side] === next[side]) ? previous : next
      )
    }
    read()
    const frame = window.requestAnimationFrame(read)
    const viewport = window.visualViewport
    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', read)
    viewport?.addEventListener('resize', read)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
      viewport?.removeEventListener('resize', read)
      probe.remove()
    }
  }, [])
  return insets
}
