import { useEffect, useState } from 'react'

import type { Insets } from '../platform/insets'

/** What the full-screen grid asks of the browser while it is up. */
export const COVER_VIEWPORT =
  'width=device-width, initial-scale=1, viewport-fit=cover'

const NONE: Insets = { top: 0, bottom: 0, left: 0, right: 0 }

/** Where the probe's padding reads the browser's insets from. */
const PROBE_STYLE = [
  'position: fixed',
  'top: 0',
  'left: 0',
  'width: 0',
  'height: 0',
  'visibility: hidden',
  'pointer-events: none',
  'padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
].join('; ')

const px = (value: string): number => {
  const number = parseFloat(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * What the hardware takes out of the screen, for the full-screen grid.
 *
 * The page itself does not ask for `viewport-fit=cover` (`index.html` says
 * why), so a browser keeps it inside the safe area and reports nothing. The
 * grid is the screen while it is up, and wants the pictures under the
 * rounded corners and the board flush with the camera's edge: so while it
 * is mounted the viewport asks for `cover`, and the page's own viewport comes
 * back when it goes. The insets are read off an invisible probe padded by
 * `env(safe-area-inset-*)`, again on every resize, turn and change of full
 * screen.
 */
export function useScreenInsets(): Insets {
  const [insets, setInsets] = useState<Insets>(NONE)
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]')
    const original = meta?.getAttribute('content') ?? null
    meta?.setAttribute('content', COVER_VIEWPORT)
    const probe = document.createElement('div')
    probe.setAttribute('style', PROBE_STYLE)
    probe.setAttribute('aria-hidden', 'true')
    document.body.appendChild(probe)
    const read = (): void => {
      const style = window.getComputedStyle(probe)
      const next = {
        top: px(style.paddingTop),
        right: px(style.paddingRight),
        bottom: px(style.paddingBottom),
        left: px(style.paddingLeft)
      }
      setInsets(prev =>
        prev.top === next.top &&
        prev.right === next.right &&
        prev.bottom === next.bottom &&
        prev.left === next.left
          ? prev
          : next
      )
    }
    read()
    // The new viewport is laid out after this effect: read once more then.
    const frame = requestAnimationFrame(read)
    const events = ['resize', 'orientationchange'] as const
    for (const name of events) window.addEventListener(name, read)
    document.addEventListener('fullscreenchange', read)
    document.addEventListener('webkitfullscreenchange', read)
    return () => {
      cancelAnimationFrame(frame)
      for (const name of events) window.removeEventListener(name, read)
      document.removeEventListener('fullscreenchange', read)
      document.removeEventListener('webkitfullscreenchange', read)
      probe.remove()
      if (original != null) meta?.setAttribute('content', original)
    }
  }, [])
  return insets
}
