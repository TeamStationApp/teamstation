import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { HostInstance } from 'react-native'

/**
 * How long a scroller goes without an event before it counts as at rest, for
 * the lists that follow it only then.
 */
export const REST_MS = 150

/**
 * How long a finger that says nothing counts as gone. Android reports no end
 * for a touch taken away from a scroll view, and what waits for rest, an older
 * page among it, would otherwise wait for a drag that is already over.
 */
export const STILL_MS = 1000

/** What a list hears from the scroller that holds it. */
export interface PageScrollListener {
  /** The page moved: on every scroll while on show, and otherwise at rest. */
  onOffset?: (offset: number, viewport: number) => void
  /** The scroller's own height changed. */
  onViewport?: (viewport: number) => void
  /** What is in the scroller changed height, which may move the list in it. */
  onContentSize?: () => void
  onBeginDrag?: () => void
  onEndDrag?: () => void
  /**
   * A person moved the page, not the app. An anchor's own scroll never says
   * so, which is what lets a list tell its opening from its reader.
   */
  onReaderMoved?: () => void
  /** What the reader set moving has stopped. */
  onRest?: () => void
}

export interface PageScrollOptions {
  /** Whether the list is on show, and so follows every scroll. */
  active: boolean
}

/**
 * The scroller a list is a block in. The list is as tall as all its rows and
 * draws the ones this says are near the screen, so the screen keeps its own
 * scroller, and the pinned head that hangs off it.
 */
export interface PageScrollSource {
  subscribe: (
    listener: PageScrollListener,
    options: PageScrollOptions
  ) => () => void
  current: () => { offset: number; viewport: number }
  scrollTo: (y: number, animated?: boolean) => void
  scrollBy: (delta: number) => void
  /**
   * Whether the reader has the page, from a drag through the end of its
   * momentum. A scroll sent in that time would stop a fling dead on a phone,
   * so nothing moves the scroller until this is over. The app's own scrolls
   * are not motion: a correction goes on until the rows have settled.
   */
  moving: () => boolean
  /** Answers at once if the page is at rest, and otherwise when it is. */
  atRest: () => Promise<void>
  /** The content a phone's list measures its own top against. */
  contentRef: { readonly current: HostInstance | null }
  /** The browser's scrolling node, once it is mounted. */
  element: ScrollingNode | null
}

/**
 * The browser's scrolling node, as far as a list needs it. Named here because
 * this file is in the phone's program too, which has no DOM.
 */
export interface ScrollingNode {
  scrollTop: number
  clientHeight: number
  addEventListener: (
    name: string,
    listener: () => void,
    options?: { passive: boolean }
  ) => void
  removeEventListener: (name: string, listener: () => void) => void
}

/** What a phone's scroll view offers beyond a host view. */
interface PhoneScroller {
  scrollTo: (options: { x: number; y: number; animated: boolean }) => void
  getInnerViewRef?: () => unknown
}

/** A source and the scroller's side of it. */
export interface PageScrollPublisher extends PageScrollSource {
  attachElement: (element: ScrollingNode) => void
  attachScroller: (scroller: PhoneScroller) => void
  scrolled: (offset: number, viewport: number) => void
  resized: (viewport: number) => void
  contentResized: () => void
  beganDrag: () => void
  endedDrag: () => void
  /** A person's hand on the page, in a browser, where no drag is reported. */
  readerMoved: () => void
  /** A fling has ended, so the page is at rest with no wait. */
  momentumEnded: () => void
  dispose: () => void
}

/** The browser's events a person makes and an anchor's `scrollTop` does not. */
const READER_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown']

export const PageScrollContext = createContext<PageScrollSource | undefined>(
  undefined
)

/**
 * The nearest scroller. A list with none would draw every row with nothing
 * to tell it which are near the screen, so that is an error rather than a
 * list that quietly stops being virtual.
 */
export function usePageScroll(): PageScrollSource {
  const source = useContext(PageScrollContext)
  if (source == null)
    throw new Error('A PagedList needs a scroller given `pagedList` above it')
  return source
}

function createPublisher(
  showElement: (element: ScrollingNode) => void
): Omit<PageScrollPublisher, 'element'> {
  const listeners = new Map<PageScrollListener, PageScrollOptions>()
  let offset = 0
  let viewport = 0
  let scroller: PhoneScroller | undefined
  let node: ScrollingNode | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stillTimer: ReturnType<typeof setTimeout> | undefined
  let moving = false
  let dragging = false
  /** A drag was taken for over with no word of its end. */
  let fingerLost = false
  /** Where the last scroll sent is going, until the page is heard there. */
  let sent: number | undefined

  const each = (call: (listener: PageScrollListener) => void): void => {
    for (const listener of [...listeners.keys()]) call(listener)
  }
  const stopWaiting = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = undefined
  }
  const settled = (): void => {
    stopWaiting()
    for (const [listener, { active }] of [...listeners])
      if (!active) listener.onOffset?.(offset, viewport)
    if (!moving || dragging) return
    moving = false
    each(listener => listener.onRest?.())
  }
  const waitForRest = (): void => {
    stopWaiting()
    timer = setTimeout(settled, REST_MS)
  }
  const stopWatching = (): void => {
    if (stillTimer != null) clearTimeout(stillTimer)
    stillTimer = undefined
  }
  const endDrag = (): void => {
    stopWatching()
    dragging = false
    each(listener => listener.onEndDrag?.())
    waitForRest()
  }
  const watchFinger = (): void => {
    stopWatching()
    stillTimer = setTimeout(() => {
      fingerLost = true
      endDrag()
    }, STILL_MS)
  }
  const current = (): { offset: number; viewport: number } =>
    node == null
      ? { offset, viewport }
      : { offset: node.scrollTop, viewport: node.clientHeight }
  const resized = (height: number): void => {
    if (height === viewport) return
    viewport = height
    each(listener => listener.onViewport?.(height))
  }
  const scrollTo = (y: number, animated = false): void => {
    offset = y
    sent = y
    if (node != null) node.scrollTop = y
    else scroller?.scrollTo({ x: 0, y, animated })
  }
  const subscribe: PageScrollSource['subscribe'] = (listener, options) => {
    listeners.set(listener, options)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    subscribe,
    current,
    scrollTo,
    // From where the page will be: a second correction can come before the
    // scroll the first one sends, and a phone's report of an earlier place
    // can come between them.
    scrollBy: delta => {
      scrollTo((node == null ? (sent ?? offset) : node.scrollTop) + delta)
    },
    moving: () => moving,
    atRest: async () => {
      if (!moving) return
      await new Promise<void>(resolve => {
        const stop = subscribe(
          {
            onRest: () => {
              stop()
              resolve()
            }
          },
          { active: true }
        )
      })
    },
    contentRef: {
      get current() {
        return (scroller?.getInnerViewRef?.() ?? null) as HostInstance | null
      }
    },
    attachElement: element => {
      node = element
      showElement(element)
    },
    attachScroller: next => {
      scroller = next
    },
    scrolled: (y, height) => {
      const arrived = sent != null && Math.abs(y - sent) <= 1
      // A finger taken for gone, moving the page again.
      if (fingerLost && sent == null && y !== offset) {
        fingerLost = false
        moving = true
        dragging = true
      }
      if (arrived) sent = undefined
      offset = y
      // A side-by-side pane's height follows the page on the animation
      // thread, and only its scroll events say so.
      if (height > 0) resized(height)
      stopWaiting()
      let waiting = moving
      for (const [listener, { active }] of [...listeners])
        if (active) listener.onOffset?.(offset, viewport)
        else waiting = true
      if (waiting) timer = setTimeout(settled, REST_MS)
      if (dragging) watchFinger()
    },
    resized,
    contentResized: () => {
      each(listener => listener.onContentSize?.())
    },
    beganDrag: () => {
      moving = true
      dragging = true
      fingerLost = false
      sent = undefined
      watchFinger()
      each(listener => {
        listener.onBeginDrag?.()
        listener.onReaderMoved?.()
      })
    },
    endedDrag: () => {
      fingerLost = false
      endDrag()
    },
    readerMoved: () => {
      moving = true
      each(listener => listener.onReaderMoved?.())
      waitForRest()
    },
    momentumEnded: settled,
    dispose: () => {
      stopWaiting()
      stopWatching()
    }
  }
}

/**
 * What a scroller calls and provides. A browser's scroller is watched from
 * here, since its node can be listened to directly; a phone's hands its
 * events over from the animation thread (`PageScrollView`).
 */
export function usePageScrollSource(): PageScrollPublisher {
  const [element, setElement] = useState<ScrollingNode | null>(null)
  const publisher = useRef<ReturnType<typeof createPublisher>>(undefined)
  publisher.current ??= createPublisher(setElement)
  const source = publisher.current
  useEffect(() => source.dispose, [source])
  useEffect(() => {
    if (element == null) return
    const scrolled = (): void => {
      source.scrolled(element.scrollTop, element.clientHeight)
    }
    element.addEventListener('scroll', scrolled, { passive: true })
    for (const name of READER_EVENTS)
      element.addEventListener(name, source.readerMoved, { passive: true })
    return () => {
      element.removeEventListener('scroll', scrolled)
      for (const name of READER_EVENTS)
        element.removeEventListener(name, source.readerMoved)
    }
  }, [element, source])
  // A new value when the node arrives, so that a list hears of it.
  return useMemo(() => ({ ...source, element }), [element, source])
}
