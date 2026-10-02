import { useEffect, useMemo, useRef, useState } from 'react'

type FullscreenRoot = HTMLElement & {
  requestFullscreen?: () => Promise<void>
  webkitRequestFullscreen?: () => void
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}

/** Whether this browser can put a page, not just a `<video>`, full screen. */
function canGoFullscreen(): boolean {
  const root = document.documentElement as FullscreenRoot
  return (
    typeof root.requestFullscreen === 'function' ||
    typeof root.webkitRequestFullscreen === 'function'
  )
}

function isFullscreen(): boolean {
  const doc = document as FullscreenDocument
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement) != null
}

/**
 * Ask for full screen. Only works during a tap: a browser refuses a request
 * that no user gesture is behind, and turning the phone is not one.
 *
 * The answer comes later, and the view may be gone by then — closed in the
 * moment between asking and being granted. `disposed` says so, and a page
 * that arrives in full screen after the view has closed is taken straight
 * back out of it rather than left there.
 *
 * The screen is never locked to one orientation: the view works either way
 * up, and follows the phone.
 */
function goFullscreen(disposed: () => boolean): void {
  const root = document.documentElement as FullscreenRoot
  if (typeof root.requestFullscreen === 'function') {
    root.requestFullscreen().then(
      () => {
        if (disposed()) leaveFullscreen()
      },
      () => undefined
    )
  } else if (typeof root.webkitRequestFullscreen === 'function') {
    // No promise on this one: the change is announced as an event.
    document.addEventListener(
      'webkitfullscreenchange',
      () => {
        if (disposed()) leaveFullscreen()
      },
      { once: true }
    )
    root.webkitRequestFullscreen()
  }
}

function leaveFullscreen(): void {
  if (!isFullscreen()) return
  const doc = document as FullscreenDocument
  if (typeof doc.exitFullscreen === 'function') {
    doc.exitFullscreen().catch(() => undefined)
  } else {
    doc.webkitExitFullscreen?.()
  }
}

/**
 * How tall the window is with the browser's bars tucked away.
 *
 * `100lvh` is exactly that, in Safari since 15.4, either way up — the status
 * strip and the notch, which no swipe hides, already left out. Where it is
 * not understood the probe measures nothing, and the screen stands in: on an
 * iPhone `screen` keeps its upright size when turned, so it is the short
 * side sideways, less a sliver for the status strip.
 */
export function largeViewportHeight(landscape: boolean): number {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden'
  document.body.appendChild(probe)
  const measured = probe.offsetHeight
  probe.remove()
  if (measured > 0) return measured
  if (!landscape || typeof screen === 'undefined') return 0
  return Math.min(screen.width, screen.height) - 20
}

/** Room below the app for one swipe to scroll into. */
const SPACER_PX = 240

/**
 * The browser's own bars out of the way, as far as each browser allows.
 *
 * Where there is a fullscreen API — desktop, Android, iPad — the view asks
 * for it when it opens and again on the first touch after the phone is
 * turned, either way: the turn itself is not a gesture, so it cannot ask, and
 * the tap that follows can.
 *
 * Safari on an iPhone has no such API for anything but a bare `<video>`, and
 * the only thing that hides its bars is the viewer scrolling the page. So
 * while they are showing, either way up, the page is given room to scroll and
 * the view says to swipe up; `swipeToHide` is true for exactly that stretch,
 * and the view lets a vertical swipe through to the page while it is.
 */
export function useFullScreen(
  landscape: boolean,
  height: number
): {
  swipeToHide: boolean
} {
  /**
   * One more try is owed: at the start, and each time the phone is turned.
   * Once per turn, so somebody who leaves full screen on purpose is not
   * pulled back into it by every tap after — and never on a desktop, where
   * Escape means exactly that.
   */
  const owed = useRef(true)
  const wasLandscape = useRef(landscape)
  if (landscape !== wasLandscape.current) owed.current = true
  wasLandscape.current = landscape

  useEffect(() => {
    let closed = false
    const disposed = (): boolean => closed
    goFullscreen(disposed)
    const retry = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse' || !owed.current) return
      owed.current = false
      if (!isFullscreen()) goFullscreen(disposed)
    }
    // `pointerup` and not `pointerdown`: a touch only counts as a gesture
    // once the finger lifts. In the capture phase, so no tile or button can
    // keep it from being seen.
    document.addEventListener('pointerup', retry, true)
    return () => {
      closed = true
      document.removeEventListener('pointerup', retry, true)
      leaveFullscreen()
    }
  }, [])

  // Asked once: the view renders on every frame of a crawl, and neither the
  // browser nor the kind of pointer it has changes while it is up.
  const { noApi, touch } = useMemo(
    () => ({
      noApi: typeof document !== 'undefined' && !canGoFullscreen(),
      touch:
        typeof window !== 'undefined' &&
        window.matchMedia?.('(pointer: coarse)').matches
    }),
    []
  )
  // Measured again only when the window's shape changes, not on every frame
  // of a crawl.
  const fullHeight = useMemo(
    () => (noApi && touch ? largeViewportHeight(landscape) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noApi, touch, landscape, height]
  )
  const barsShowing = height < fullHeight - 10
  const swipeToHide = noApi && touch && barsShowing

  // The spacer stays once added: taking it away would scroll the page back
  // up, which is what brings the bars back. When the view closes the page is
  // put back where it was before the spacer was scrolled into — not at the
  // top, which on a long game page is somewhere the viewer never was.
  const [spacer, setSpacer] = useState(false)
  if (swipeToHide && !spacer) setSpacer(true)
  useEffect(() => {
    if (!spacer) return
    const x = window.scrollX
    const y = window.scrollY
    const node = document.createElement('div')
    node.style.height = `${SPACER_PX}px`
    node.setAttribute('aria-hidden', 'true')
    document.body.appendChild(node)
    return () => {
      node.remove()
      window.scrollTo(x, y)
    }
  }, [spacer])

  return { swipeToHide }
}
