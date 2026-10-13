import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  anchored,
  AT_REST,
  type HeadState,
  inStep,
  type PinnedHead,
  type PinnedHeadOptions,
  scrolled,
  spacerFor
} from './pinnedHead'

export type { PinnedHead, PinnedHeadOptions }

/** A node the browser lays out; react-native-web hands one to every ref. */
type Node = HTMLElement | null

const NO_STYLE = {}

/**
 * A card that scrolls away under the header and pills that stay pinned under
 * it, with a selected tab scrolled to where it should start without moving
 * either: the browser's half (`usePinnedHead.native.ts` is the phone's).
 *
 * **Sticky, written to the node.** The pills are `position: sticky` at the
 * header's edge, which the browser pins on its compositor thread with no
 * JavaScript — a transform set from a scroll event would trail the content by
 * a frame. The card is left in the flow until a tab is anchored, and is then
 * held still the same way. The `top` values change on scroll events, so they
 * go straight onto the nodes: a React render per event would lag.
 *
 * **Measured with sticky lifted.** A stuck element reports where it is stuck,
 * not where the page put it, so the measure clears both bands' positions,
 * reads every rectangle, and puts them back in the same task. The browser
 * paints nothing in between. `onLayout` is not used: the web renderer reports
 * positions against whichever ancestor it makes the offset parent (see
 * `useHandoff.ts`).
 */
export function usePinnedHead(options: PinnedHeadOptions): PinnedHead {
  const latest = useRef(options)
  latest.current = options
  const { headerHeight } = options

  const state = useRef<HeadState>(AT_REST)
  /** The head as a tab was selected, until that tab has been anchored. */
  const pending = useRef<HeadState | undefined>(AT_REST)
  const pinAt = useRef(0)
  const card = useRef<Node>(null)
  const pills = useRef<Node>(null)
  const content = useRef<Node>(null)
  const row = useRef<Node>(null)
  const spacer = useRef<Node>(null)
  const [, setGeneration] = useState(0)

  /** The anchor's reach into the tab: what the room after it is sized for. */
  const lastOffset = useRef<number | undefined>(undefined)
  const page = useRef<Node>(null)

  /**
   * The element that scrolls: the nearest one above the pills that does.
   * Found once and kept, since it is asked on every scroll event.
   */
  const scroller = useCallback((): Node => {
    const kept = page.current
    if (kept?.isConnected === true && kept.contains(pills.current)) return kept
    page.current = null
    for (let node = pills.current; node != null; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') {
        page.current = node
        return node
      }
    }
    return null
  }, [])

  /** Puts each band where the head says it is. */
  const paint = useCallback((): void => {
    const head = state.current
    const header = latest.current.headerHeight
    if (pills.current != null) {
      pills.current.style.position = 'sticky'
      pills.current.style.top = `${
        inStep(head)
          ? header
          : header + pinAt.current - Math.min(head.collapse, pinAt.current)
      }px`
    }
    if (card.current != null) {
      const held = !inStep(head)
      card.current.style.position = held ? 'sticky' : ''
      card.current.style.top = held ? `${header - head.collapse}px` : ''
    }
  }, [])

  /** Every distance the anchor needs, read with sticky lifted. */
  const measure = useCallback(() => {
    const bands = [card.current, pills.current].filter(
      (node): node is HTMLElement => node != null
    )
    for (const node of bands) {
      node.style.position = ''
      node.style.top = ''
    }
    const page = scroller()
    const column = pills.current?.parentElement
    const top = (node: Node): number => node?.getBoundingClientRect().top ?? 0
    const columnTop = top(column ?? null)
    const pageTop = page?.getBoundingClientRect().top ?? 0
    const scrollTop = page?.scrollTop ?? 0
    const measured = {
      pinAt: top(pills.current) - columnTop,
      rowOffset:
        row.current == null ? 0 : top(row.current) - top(content.current),
      contentBottom:
        (content.current?.getBoundingClientRect().bottom ?? 0) -
        pageTop +
        scrollTop,
      viewport: page?.clientHeight ?? 0
    }
    paint()
    return measured
  }, [paint, scroller])

  /** Scrolls the selected tab to where it starts, holding the head still. */
  const anchor = useCallback((): void => {
    const from = pending.current
    const page = scroller()
    if (from == null || page == null) return
    const { pinAt: pin, rowOffset, contentBottom, viewport } = measure()
    pinAt.current = pin
    const offset = latest.current.anchorOnRow ? rowOffset : 0
    lastOffset.current = offset
    const target = anchored(from, offset, pin)
    const space = spacerFor(
      offset + pin,
      contentBottom + latest.current.tail,
      viewport
    )
    // Room for the jump first, then the jump, then only the room the tab
    // needs: shrinking before the jump could clamp the page and move the head.
    if (spacer.current != null) {
      const now = spacer.current.getBoundingClientRect().height
      spacer.current.style.height = `${Math.max(now, space)}px`
    }
    page.scrollTop = target.y
    if (spacer.current != null) spacer.current.style.height = `${space}px`
    const y = page.scrollTop
    state.current = { y, collapse: Math.min(target.collapse, y) }
    pending.current = undefined
    paint()
    latest.current.onScroll()
  }, [measure, paint, scroller])

  // After every commit: a tab selected (or the first load) is anchored as soon
  // as its content is on the page, before the browser paints it.
  useLayoutEffect(() => {
    if (pending.current != null && latest.current.ready) anchor()
  })

  // The pills stick from the start, and follow the header if it changes size.
  useLayoutEffect(() => {
    paint()
  }, [headerHeight, paint])

  // A card or tab that changes height after its tab was anchored — a window
  // resized until the team's name wraps, a font arriving late — moves where
  // the pills pin and how much room the tab needs. Both are read again then.
  //
  // A tab that shrinks where it is — a filter that leaves less to show —
  // under a page scrolled to its end has the page pulled back by the
  // browser, which would take the head down with it. The room is kept for
  // where the page is, too, and the page put back: the browser runs this
  // before the scroll its pull would send, which then finds nothing moved.
  const remeasure = useCallback((): void => {
    if (pending.current != null || lastOffset.current == null) return
    const { pinAt: pin, contentBottom, viewport } = measure()
    pinAt.current = pin
    const at = state.current.y
    const bottom = contentBottom + latest.current.tail
    if (spacer.current != null) {
      spacer.current.style.height = `${Math.max(
        spacerFor(lastOffset.current + pin, bottom, viewport),
        spacerFor(at, bottom, viewport)
      )}px`
    }
    const page = scroller()
    if (page != null && page.scrollTop < at - 1) page.scrollTop = at
    paint()
  }, [measure, paint, scroller])
  const remeasureRef = useRef(remeasure)
  remeasureRef.current = remeasure
  // Made on the first commit that can use it, so the card, the tab and the
  // page are watched from the start; a node that has left the page (each tab
  // is a new view) is let go of, so it is not kept alive by the watching.
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const watched = useRef<Set<Element>>(new Set())
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    observer.current ??= new ResizeObserver(() => {
      remeasureRef.current()
    })
    const watch = observer.current
    const now = new Set<Element>(
      [card.current, content.current, scroller()].filter(
        (node): node is HTMLElement => node != null
      )
    )
    for (const node of watched.current) {
      if (!now.has(node)) watch.unobserve(node)
    }
    for (const node of now) {
      if (!watched.current.has(node)) watch.observe(node)
    }
    watched.current = now
  })
  useEffect(
    () => () => {
      observer.current?.disconnect()
      observer.current = undefined
      watched.current = new Set()
    },
    []
  )

  /** Where the page could scroll to at the last scroll: its end. */
  const pageEnd = useRef<number | undefined>(undefined)
  const onScroll = useCallback((): void => {
    const page = scroller()
    const y = page?.scrollTop ?? 0
    const end = page == null ? undefined : page.scrollHeight - page.clientHeight
    const shrank =
      end != null && pageEnd.current != null && end < pageEnd.current - 1
    pageEnd.current = end
    // Pulled back to the new end of a tab that shrank where it is: not a
    // scroll anybody made. The room grows by what the tab lost and the page
    // goes back, the head where it was. (The end moved, which a bounce at
    // the end never does.)
    const at = state.current.y
    if (
      page != null &&
      end != null &&
      shrank &&
      pending.current == null &&
      y < at - 1 &&
      y >= end - 1
    ) {
      if (spacer.current != null) {
        const now = spacer.current.getBoundingClientRect().height
        spacer.current.style.height = `${now + (at - y)}px`
      }
      page.scrollTop = at
      pageEnd.current = page.scrollHeight - page.clientHeight
      return
    }
    // While a tab is being anchored the head holds still: the page can move
    // under it as the new content lands, and must not take the head along.
    state.current =
      pending.current == null
        ? scrolled(state.current, y)
        : { ...state.current, y }
    paint()
    latest.current.onScroll()
  }, [paint, scroller])

  const select = useCallback(
    (_tab: string): void => {
      pending.current = { ...state.current }
      // Room for wherever the page is now, whatever the new tab's height, so
      // the browser cannot clamp the page while the new content lands.
      const page = scroller()
      if (spacer.current != null && page != null) {
        spacer.current.style.height = `${state.current.y + page.clientHeight}px`
      }
      setGeneration(generation => generation + 1)
    },
    [scroller]
  )

  const cardRef = useCallback((node: unknown) => {
    card.current = node as Node
    const extra = latest.current.cardRef
    if (typeof extra === 'function') extra(node as never)
    else if (extra != null) {
      ;(extra as { current: unknown }).current = node
    }
  }, [])

  return useMemo(
    () => ({
      screen: { onScroll },
      cardBand: { ref: cardRef, style: NO_STYLE },
      pillBand: {
        ref: (node: unknown) => {
          pills.current = node as Node
        },
        style: NO_STYLE
      },
      content: {
        ref: (node: unknown) => {
          content.current = node as Node
        }
      },
      nextRow: {
        ref: (node: unknown) => {
          row.current = node as Node
        }
      },
      // The browser measures the row against the content itself.
      rowSection: {},
      spacer: {
        ref: (node: unknown) => {
          spacer.current = node as Node
        },
        style: NO_STYLE
      },
      select
    }),
    [cardRef, onScroll, select]
  )
}
