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
 * back out of it rather than left there, locked sideways.
 */
function goFullscreen(disposed: () => boolean): void {
  const root = document.documentElement as FullscreenRoot
  if (typeof root.requestFullscreen === 'function') {
    root.requestFullscreen().then(
      () => {
        if (disposed()) leaveFullscreen()
        else lockLandscape(disposed)
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

// `lock` is the Screen Orientation API's newest corner: Chrome on Android has
// it, Safari has never had it, and the two type-checkers this repo runs
// disagree about whether it exists — so the two methods are asked for by
// shape, which is true wherever they are and an assertion nowhere.
function orientationApi(): {
  lock?: (to: string) => Promise<void>
  unlock?: () => void
} | null {
  return typeof screen !== 'undefined' ? screen.orientation : null
}

/** Sideways, unless the view has closed by the time the lock is granted. */
function lockLandscape(disposed: () => boolean): void {
  orientationApi()
    ?.lock?.('landscape')
    .then(
      () => {
        if (disposed()) orientationApi()?.unlock?.()
      },
      () => undefined
    )
}

/** Room below the app for one swipe to scroll into. */
const SPACER_PX = 240

/**
 * The browser's own bars out of the way, as far as each browser allows.
 *
 * Where there is a fullscreen API — desktop, Android, iPad — the view asks
 * for it when it opens and again on the first touch after the phone is turned
 * sideways, which is what a phone turned sideways needs: the turn itself is not a
 * gesture, so it cannot ask, and the tap that follows can.
 *
 * Safari on an iPhone has no such API for anything but a bare `<video>`, and
 * the only thing that hides its bars is the viewer scrolling the page. So
 * while they are showing, sideways, the page is given room to scroll and the
 * view says to swipe up; `swipeToHide` is true for exactly that stretch, and
 * the view lets a vertical swipe through to the page while it is.
 */
export function useFullScreen(
  landscape: boolean,
  height: number
): {
  swipeToHide: boolean
} {
  const landscapeRef = useRef(landscape)
  landscapeRef.current = landscape
  /**
   * One more try is owed: at the start, and each time the phone is turned
   * sideways. Once per turn, so somebody who leaves full screen on purpose is
   * not pulled back into it by every tap after — and never on a desktop,
   * where Escape means exactly that.
   */
  const owed = useRef(true)
  const wasLandscape = useRef(landscape)
  if (landscape && !wasLandscape.current) owed.current = true
  wasLandscape.current = landscape

  useEffect(() => {
    let closed = false
    const disposed = (): boolean => closed
    goFullscreen(disposed)
    lockLandscape(disposed)
    const retry = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse' || !owed.current) return
      if (!landscapeRef.current) return
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
      orientationApi()?.unlock?.()
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
  // On an iPhone `screen` keeps its upright size when turned, so the short
  // side is the height the picture would have with no bars at all. What the
  // bars take is the difference; a sliver is left to allow for a status strip.
  const shortSide =
    typeof screen !== 'undefined' ? Math.min(screen.width, screen.height) : 0
  const barsShowing = height < shortSide - 30
  const swipeToHide = noApi && touch && landscape && barsShowing

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
