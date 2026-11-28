import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ScrollView, ScrollViewProps } from 'react-native'

import type { PinnedHead } from '../components/pinnedHead'

/**
 * A scroll that follows its newest line, like the tail of a file: content
 * pegged to the bottom (the caller's `flexGrow: 1, justifyContent:
 * 'flex-end'`), scrolled smoothly to its end whenever it grows. A reader
 * who scrolls up stops the following; scrolling back to the bottom, or
 * `resume`, starts it again.
 */
export interface TailFollow {
  ref: React.RefObject<React.ComponentRef<typeof ScrollView> | null>
  /** False while the reader has scrolled up, away from the newest line. */
  following: boolean
  /** Scroll to the end, animated, and follow again. */
  resume: () => void
  /** Follow again from the top of new content, without scrolling: a new source. */
  reset: () => void
  scrollProps: Pick<
    ScrollViewProps,
    | 'onContentSizeChange'
    | 'onLayout'
    | 'onScroll'
    | 'onScrollBeginDrag'
    | 'scrollEventThrottle'
  >
}

/** How close to the end counts as at it: fractional offsets and overscroll. */
export const AT_BOTTOM = 2

/** Where a scroll left the page, and where it was before. */
export interface ScrollPosition {
  /** The offset now, and at the scroll before. */
  y: number
  lastY: number
  /** The height that shows, and the height there is to scroll through. */
  viewport: number
  content: number
}

/**
 * The rule a tail follows by: a scroll that reaches the end (within
 * `AT_BOTTOM`) follows, one that moves up stops following, and any other —
 * down, short of the end — leaves it as it was.
 */
export function followAfterScroll(
  following: boolean,
  at: ScrollPosition
): boolean {
  if (at.y + at.viewport >= at.content - AT_BOTTOM) return true
  if (at.y < at.lastY - 1) return false
  return following
}

export function useTailFollow(): TailFollow {
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const following = useRef(true)
  const lastOffset = useRef(0)
  const [paused, setPaused] = useState(false)
  const follow = useCallback((): void => {
    if (following.current) ref.current?.scrollToEnd({ animated: true })
  }, [])
  const resume = useCallback((): void => {
    following.current = true
    setPaused(false)
    ref.current?.scrollToEnd({ animated: true })
  }, [])
  const reset = useCallback((): void => {
    following.current = true
    lastOffset.current = 0
    setPaused(false)
  }, [])
  const scrollProps = useMemo<TailFollow['scrollProps']>(
    () => ({
      onContentSizeChange: follow,
      onLayout: follow,
      scrollEventThrottle: 16,
      onScrollBeginDrag: () => {
        following.current = false
        setPaused(true)
      },
      onScroll: event => {
        const { contentOffset, contentSize, layoutMeasurement } =
          event.nativeEvent
        const y = contentOffset.y
        // Covers mouse-wheel scrolling on web as well as native drags.
        const next = followAfterScroll(following.current, {
          y,
          lastY: lastOffset.current,
          viewport: layoutMeasurement.height,
          content: contentSize.height
        })
        if (next !== following.current) {
          following.current = next
          setPaused(!next)
        }
        lastOffset.current = y
      }
    }),
    [follow]
  )
  return { ref, following: !paused, resume, reset, scrollProps }
}

/** What `usePageTailFollow` hands back. */
export interface PageTailFollow {
  /** False while the reader has scrolled up, away from the newest line. */
  following: boolean
  /** Scroll to the end, animated, and follow again. */
  resume: () => void
  /** Stop following: the screen's `onScrollBeginDrag`, a finger on the page. */
  pause: () => void
  /** The followed content has laid out again: to its end, while following. */
  onGrow: () => void
  /** For the pinned head's options: where the page is, after each scroll. */
  onPosition: (at: { y: number; end: number }) => void
  /** For the pinned head's options: no room kept below a page at its end. */
  followEnd: boolean
}

/**
 * A tail for a page the screen's pinned head scrolls rather than a scroll
 * view of its own: the Plays tab on a game in progress. `pinned` is read
 * when it is needed, since the head is made after this hook, from the
 * `onPosition` and `followEnd` it hands back. While `enabled` and
 * following, `onGrow` scrolls the page to its end; a drag (`pause`) or a
 * scroll up stops it; reaching the end by hand, or `resume`, starts it again.
 */
export function usePageTailFollow(options: {
  pinned: React.RefObject<PinnedHead | null>
  enabled: boolean
}): PageTailFollow {
  const { pinned, enabled } = options
  const [following, setFollowing] = useState(true)
  const followingNow = useRef(true)
  const enabledNow = useRef(enabled)
  enabledNow.current = enabled
  const lastY = useRef<number | undefined>(undefined)

  const set = useCallback((next: boolean): void => {
    if (followingNow.current === next) return
    followingNow.current = next
    setFollowing(next)
  }, [])
  const resume = useCallback((): void => {
    set(true)
    pinned.current?.scrollToEnd(true)
  }, [pinned, set])
  const pause = useCallback((): void => {
    if (enabledNow.current) set(false)
  }, [set])
  const onGrow = useCallback((): void => {
    if (enabledNow.current && followingNow.current)
      pinned.current?.scrollToEnd(false)
  }, [pinned])
  const onPosition = useCallback(
    (at: { y: number; end: number }): void => {
      const before = lastY.current ?? at.y
      lastY.current = at.y
      if (!enabledNow.current) return
      set(
        followAfterScroll(followingNow.current, {
          y: at.y,
          lastY: before,
          viewport: 0,
          content: at.end
        })
      )
    },
    [set]
  )
  return {
    following,
    resume,
    pause,
    onGrow,
    onPosition,
    followEnd: enabled && following
  }
}
