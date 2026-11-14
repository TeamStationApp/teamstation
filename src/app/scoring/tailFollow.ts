import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ScrollView, ScrollViewProps } from 'react-native'

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
const AT_BOTTOM = 2

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
        if (y + layoutMeasurement.height >= contentSize.height - AT_BOTTOM) {
          following.current = true
          setPaused(false)
        }
        // Covers mouse-wheel scrolling on web as well as native drags.
        else if (y < lastOffset.current - 1) {
          following.current = false
          setPaused(true)
        }
        lastOffset.current = y
      }
    }),
    [follow]
  )
  return { ref, following: !paused, resume, reset, scrollProps }
}
