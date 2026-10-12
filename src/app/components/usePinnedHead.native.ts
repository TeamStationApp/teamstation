import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { LayoutChangeEvent } from 'react-native'
import type Animated from 'react-native-reanimated'
import {
  runOnJS,
  runOnUI,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'

import {
  anchored,
  AT_REST,
  cardOffset,
  type HeadState,
  pillsOffset,
  type PinnedHead,
  type PinnedHeadOptions,
  scrolled,
  spacerFor
} from './pinnedHead'

export type { PinnedHead, PinnedHeadOptions }

/**
 * Room laid after a tab while it lands: more than any team's season is tall,
 * and nothing a reader can reach, since the tab is anchored within a frame or
 * two and the room then shrinks to what it needs.
 */
const PROVISIONAL_ROOM = 20000

/** What the anchor needs to know, each from its own `onLayout`. */
interface Measured {
  viewport?: number
  pinAt?: number
  /** The tab's content: its top in the column, and its height. */
  content?: { y: number; height: number }
  /** Which tab `content` was measured for. */
  contentTab?: string
  /** The next game's top inside its section, and the section's in the content. */
  rowY?: number
  sectionY?: number
}

/**
 * A card that scrolls away under the header and pills that stay pinned under
 * it, with a selected tab scrolled to where it should start without moving
 * either: the phone's half (`usePinnedHead.ts` is the browser's).
 *
 * **Clamped translates, not `stickyHeaderIndices`.** The header is glass and
 * overlays the scroll view, so a sticky header would dock behind it, as
 * `GameWatchLayout.native.tsx` found. The two bands are translated instead, on
 * the animation thread, from the head the scroll handler keeps there.
 *
 * **Anchored after layout.** A selected tab is not where it can be measured
 * until it has been laid out, so the anchor waits for its content's
 * `onLayout` (and on the schedule the next game's), makes room after it, and
 * only then scrolls — in one worklet that sets the head and calls `scrollTo`,
 * so the jump and the head cannot be seen apart. Until then the head holds
 * still: Android clamps a scroll view whose content shrinks under it and
 * reports that as a scroll, and that scroll must not move the card.
 */
export function usePinnedHead(options: PinnedHeadOptions): PinnedHead {
  const latest = useRef(options)
  latest.current = options

  const y = useSharedValue(0)
  const collapse = useSharedValue(0)
  const pinAt = useSharedValue(0)
  /** True while a selected tab waits to be anchored. */
  const holding = useSharedValue(true)
  /**
   * Where an anchor sent the page, until it has stayed there. Fabric reports
   * a new tab's layout before the UI thread has mounted it, so a jump can be
   * clamped to the old content's height; a scroll that lands anywhere else
   * in this window is sent back. -1 when no jump is being kept.
   */
  const jumpTo = useSharedValue(-1)
  /** A finger is on the page. */
  const dragging = useSharedValue(false)
  /**
   * The page was taken in hand after a tab was selected and before it was
   * anchored. The anchor then gives way: the tab is not jumped back to its
   * start under somebody who is already scrolling it.
   */
  const takenOver = useSharedValue(false)
  const scrollRef = useAnimatedRef<Animated.ScrollView>()

  /** The head as a tab was selected, until that tab has been anchored. */
  const pending = useRef<HeadState | undefined>(AT_REST)
  const measured = useRef<Measured>({})
  /** The room the jump waits for, once the anchor has asked for it. */
  const growing = useRef<{ room: number; jump: () => void } | undefined>(
    undefined
  )
  const [space, setSpace] = useState(0)
  const spaceNow = useRef(0)
  spaceNow.current = space
  const [, setGeneration] = useState(0)
  /** The last anchor's sizes, for sizing the room again after a drag. */
  const lastAnchor = useRef<
    | { offset: number; reach: number; contentBottom: number; viewport: number }
    | undefined
  >(undefined)
  /** True once a taken-over page still has the landing room under it. */
  const roomAfterDrag = useSharedValue(false)
  /** Timers a jump leaves running; the next select, jump or unmount ends them. */
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const clearTimers = useCallback((): void => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  /**
   * The page was taken in hand before its tab was anchored, and has come to
   * rest: the room shrinks now, sized for wherever the finger left it.
   */
  const settleRoom = useCallback((at: number): void => {
    const sizes = lastAnchor.current
    if (sizes == null) return
    setSpace(
      spacerFor(Math.max(sizes.reach, at), sizes.contentBottom, sizes.viewport)
    )
  }, [])
  const settleSoon = useCallback((): void => {
    timers.current.push(
      setTimeout(() => {
        settleRoom(y.value)
      }, 400)
    )
  }, [settleRoom, y])

  const notify = useCallback(() => {
    latest.current.onScroll()
  }, [])

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: () => {
      // A finger on the page: from here the page goes where it is taken.
      dragging.value = true
      jumpTo.value = -1
      if (holding.value) takenOver.value = true
    },
    onEndDrag: () => {
      dragging.value = false
      // A drag with no fling after it ends here; a fling ends below.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- as below
      if (roomAfterDrag.value) runOnJS(settleSoon)()
    },
    onMomentumEnd: event => {
      if (!roomAfterDrag.value) return
      roomAfterDrag.value = false
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- as below
      runOnJS(settleRoom)(event.contentOffset.y)
    },
    onScroll: event => {
      const next = event.contentOffset.y
      if (jumpTo.value >= 0 && Math.abs(next - jumpTo.value) > 1) {
        scrollTo(scrollRef, 0, jumpTo.value, false)
        return
      }
      if (holding.value) {
        y.value = next
      } else {
        const head = scrolled({ y: y.value, collapse: collapse.value }, next)
        y.value = head.y
        collapse.value = head.collapse
      }
      // The hand-off measures the card on this same thread, but it has to be
      // told when.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- scheduleOnRN takes its arguments directly rather than returning a function, as in GameWatchLayout.native.tsx
      runOnJS(notify)()
    }
  })

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: cardOffset({ y: y.value, collapse: collapse.value }) }
    ]
  }))
  const pillStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: pillsOffset(
          { y: y.value, collapse: collapse.value },
          pinAt.value
        )
      }
    ]
  }))

  /**
   * A tab already anchored whose content, or card, has changed height since:
   * its room is sized again for the same anchor, as the browser's
   * ResizeObserver does, so the page still stops where the pills pin over it.
   */
  const resizeRoom = useCallback((): void => {
    const anchor = lastAnchor.current
    const { viewport, pinAt: pin, content } = measured.current
    if (pending.current != null || roomAfterDrag.value) return
    if (anchor == null || viewport == null || pin == null || content == null)
      return
    const { headerHeight, tail } = latest.current
    const contentBottom = headerHeight + content.y + content.height + tail
    lastAnchor.current = {
      offset: anchor.offset,
      reach: anchor.offset + pin,
      contentBottom,
      viewport
    }
    setSpace(spacerFor(anchor.offset + pin, contentBottom, viewport))
  }, [roomAfterDrag])

  /** The hand-off's ref, forwarded as it is now, whatever it was before. */
  const cardRef = useCallback((node: unknown): void => {
    const extra = latest.current.cardRef
    if (typeof extra === 'function') extra(node as never)
    else if (extra != null) {
      ;(extra as { current: unknown }).current = node
    }
  }, [])

  /** Runs the pending anchor once everything it needs has been laid out. */
  const tryAnchor = useCallback((): void => {
    const from = pending.current
    const { ready, anchorOnRow, headerHeight, tail } = latest.current
    const { viewport, pinAt: pin, content, rowY } = measured.current
    if (from == null || !ready || growing.current != null) return
    if (viewport == null || pin == null || content == null) return
    if (anchorOnRow && rowY == null) return
    const offset = anchorOnRow
      ? (measured.current.sectionY ?? 0) + (rowY ?? 0)
      : 0
    const target = anchored(from, offset, pin)
    const contentBottom = headerHeight + content.y + content.height + tail
    const jump = (): void => {
      growing.current = undefined
      pending.current = undefined
      clearTimers()
      lastAnchor.current = {
        offset,
        reach: offset + pin,
        contentBottom,
        viewport
      }
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- scheduleOnUI lives in react-native-worklets, which reanimated does not re-export
      runOnUI((to: number, held: number, room: number) => {
        'worklet'
        holding.value = false
        if (takenOver.value) {
          // Left where the finger put it, with the head as it was held. The
          // landing room stays until the page comes to rest, then shrinks
          // for where it is: shrinking now could clamp it under the finger.
          takenOver.value = false
          collapse.value = Math.min(held, Math.max(0, y.value))
          roomAfterDrag.value = true
          if (!dragging.value) {
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- as above
            runOnJS(settleSoon)()
          }
          return
        }
        y.value = to
        collapse.value = held
        // Kept only when nobody is dragging: a tab tapped and the page
        // grabbed at once still jumps, and then goes where it is taken.
        jumpTo.value = dragging.value ? -1 : to
        scrollTo(scrollRef, 0, to, false)
        // Only the room the tab needs, now the page is where it belongs: that
        // room holds the target, so shrinking to it cannot clamp the page.
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- as above
        runOnJS(setSpace)(room)
      })(target.y, target.collapse, room)
      // Sent again while the new tab mounts, in case the first was clamped
      // and no scroll followed to say so; then let the page go.
      for (const delay of [50, 150, 300, 600]) {
        timers.current.push(
          setTimeout(() => {
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- as above
            runOnUI(() => {
              'worklet'
              if (jumpTo.value >= 0) scrollTo(scrollRef, 0, jumpTo.value, false)
            })()
          }, delay)
        )
      }
      timers.current.push(
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- as above
          runOnUI(() => {
            'worklet'
            jumpTo.value = -1
          })()
        }, 900)
      )
      notify()
    }
    const room = spacerFor(offset + pin, contentBottom, viewport)
    // Room for the jump first, then the jump. Room within a pixel of what is
    // laid out already lays out to nothing new, so no layout would say so.
    const needed = Math.max(spaceNow.current, room)
    if (needed - spaceNow.current < 1) {
      jump()
    } else {
      growing.current = { room: needed, jump }
      setSpace(needed)
      // And if no layout says so at all, jump anyway.
      timers.current.push(
        setTimeout(() => {
          if (growing.current?.jump === jump) jump()
        }, 250)
      )
    }
  }, [
    clearTimers,
    collapse,
    dragging,
    holding,
    jumpTo,
    notify,
    roomAfterDrag,
    scrollRef,
    settleSoon,
    takenOver,
    y
  ])

  // A tab selected again, already laid out, needs no new layout to anchor;
  // the first load waits here for its data.
  useLayoutEffect(() => {
    tryAnchor()
  })

  const select = useCallback(
    (tab: string): void => {
      pending.current = { y: y.value, collapse: collapse.value }
      holding.value = true
      takenOver.value = false
      roomAfterDrag.value = false
      growing.current = undefined
      clearTimers()
      // A tab other than the one measured lays out anew before it anchors —
      // also when it is already showing, selected after the address moved it.
      if (tab !== measured.current.contentTab) {
        measured.current = {
          ...measured.current,
          content: undefined,
          rowY: undefined,
          sectionY: undefined
        }
      }
      // Room for wherever the page is now and for wherever the new tab will
      // anchor, whatever its height: the scroll view cannot clamp while the
      // new content lands, and the anchor can jump on the tab's first layout
      // rather than wait a second one for room. It shrinks to what the tab
      // needs once the page is there.
      setSpace(y.value + PROVISIONAL_ROOM)
      setGeneration(generation => generation + 1)
    },
    [clearTimers, collapse, holding, roomAfterDrag, takenOver, y]
  )

  return useMemo(
    () => ({
      screen: {
        onScroll,
        scrollRef,
        onLayout: (event: LayoutChangeEvent) => {
          measured.current.viewport = event.nativeEvent.layout.height
          tryAnchor()
        }
      },
      cardBand: { ref: cardRef, style: cardStyle },
      pillBand: {
        style: pillStyle,
        handleLayout: (event: LayoutChangeEvent) => {
          const at = event.nativeEvent.layout.y
          measured.current.pinAt = at
          pinAt.value = at
          tryAnchor()
          resizeRoom()
        }
      },
      content: {
        handleLayout: (event: LayoutChangeEvent) => {
          const { y: top, height } = event.nativeEvent.layout
          measured.current.content = { y: top, height }
          measured.current.contentTab = latest.current.tab
          tryAnchor()
          resizeRoom()
        }
      },
      nextRow: {
        handleLayout: (event: LayoutChangeEvent) => {
          measured.current.rowY = event.nativeEvent.layout.y
          tryAnchor()
        }
      },
      rowSection: {
        handleLayout: (event: LayoutChangeEvent) => {
          measured.current.sectionY = event.nativeEvent.layout.y
          tryAnchor()
        }
      },
      spacer: {
        style: { height: space },
        handleLayout: (event: LayoutChangeEvent) => {
          const grow = growing.current
          if (
            grow != null &&
            Math.abs(event.nativeEvent.layout.height - grow.room) < 1
          ) {
            grow.jump()
          }
        }
      },
      select
    }),
    [
      cardRef,
      cardStyle,
      onScroll,
      pillStyle,
      pinAt,
      resizeRoom,
      scrollRef,
      select,
      space,
      tryAnchor
    ]
  )
}
