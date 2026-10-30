import React, { useCallback, useContext, useRef } from 'react'
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  Platform
} from 'react-native'
import Animated, {
  useAnimatedScrollHandler,
  useComposedEventHandler
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import {
  PageScrollContext,
  type PageScrollPublisher,
  type PageScrollSource,
  type ScrollingNode,
  usePageScrollSource
} from './pageScroll'

type ScrollProps = Omit<
  React.ComponentProps<typeof Animated.ScrollView>,
  'children' | 'onLayout' | 'onContentSizeChange'
>
type ScrollHandler = NonNullable<ScrollProps['onScroll']>

export interface PageScrollViewProps extends ScrollProps {
  children?: React.ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
  onContentSizeChange?: (width: number, height: number) => void
  /**
   * For a pane that scrolls only in some layouts: while set it is not the
   * scroller a list follows, and the one above it still is.
   */
  inert?: boolean
}

/** A plain handler, which runs in React rather than on the animation thread. */
type PlainScroll = (event: ScrollFields) => void

interface ScrollFields {
  nativeEvent: Pick<
    NativeScrollEvent,
    'contentOffset' | 'contentSize' | 'layoutMeasurement'
  >
}

/** A handler built by Reanimated, which can be composed with another. */
function isWorkletHandler(handler: unknown): handler is ScrollHandler {
  return (
    handler != null &&
    typeof handler === 'object' &&
    'workletEventHandler' in handler
  )
}

/** The ref a caller gave, and the source's own hold on the same scroller. */
function useScrollerRef(
  ref: ScrollProps['ref'],
  attach: (node: never) => void
): (node: never) => (() => void) | undefined {
  return useCallback(
    node => {
      if (node != null) attach(node)
      if (typeof ref === 'function') {
        const cleanup = (ref as (node: unknown) => unknown)(node)
        return typeof cleanup === 'function'
          ? (cleanup as () => void)
          : undefined
      }
      if (ref != null) (ref as { current: unknown }).current = node
      return undefined
    },
    [attach, ref]
  )
}

/** Gives what is inside it the scroller to follow, unless `inert`. */
export function Published(props: {
  source: PageScrollSource
  inert: boolean | undefined
  children: React.ReactNode
}): React.ReactElement {
  const { source, inert, children } = props
  const outer = useContext(PageScrollContext)
  return (
    <PageScrollContext.Provider value={inert === true ? outer : source}>
      {children}
    </PageScrollContext.Provider>
  )
}

function BrowserPageScrollView(props: PageScrollViewProps): React.ReactElement {
  const { ref, inert, children, ...rest } = props
  const source = usePageScrollSource()
  const { attachElement } = source
  const attach = useCallback(
    (node: ScrollingNode & { getScrollableNode?: () => ScrollingNode }) => {
      attachElement(node.getScrollableNode?.() ?? node)
    },
    [attachElement]
  )
  return (
    <Animated.ScrollView {...rest} ref={useScrollerRef(ref, attach)}>
      <Published source={source} inert={inert}>
        {children}
      </Published>
    </Animated.ScrollView>
  )
}

/**
 * The phone's scroller: its events cross from the animation thread here,
 * where a list can hear them, and a handler it was given keeps working.
 *
 * Reanimated composes handlers of its own and drops anything else, so a plain
 * function (`useHandoff.native.ts`'s `handleScroll`) is called from the
 * publishing handler, with the same fields a scroll event gives it.
 */
function PhonePageScrollView(props: PageScrollViewProps): React.ReactElement {
  const {
    ref,
    inert,
    onScroll,
    onLayout,
    onContentSizeChange,
    children,
    ...rest
  } = props
  const source: PageScrollPublisher = usePageScrollSource()
  const { attachScroller, scrolled, beganDrag, endedDrag, momentumEnded } =
    source
  const plain = useRef<PlainScroll | undefined>(undefined)
  plain.current =
    typeof onScroll === 'function' ? (onScroll as PlainScroll) : undefined
  const hasPlain = plain.current != null
  const callPlain = useCallback((event: ScrollFields) => {
    plain.current?.(event)
  }, [])
  const publishing = useAnimatedScrollHandler(
    {
      onScroll: event => {
        scheduleOnRN(
          scrolled,
          event.contentOffset.y,
          event.layoutMeasurement.height
        )
        if (!hasPlain) return
        const { contentOffset, contentSize, layoutMeasurement } = event
        scheduleOnRN(callPlain, {
          nativeEvent: { contentOffset, contentSize, layoutMeasurement }
        })
      },
      onBeginDrag: () => {
        scheduleOnRN(beganDrag)
      },
      onEndDrag: () => {
        scheduleOnRN(endedDrag)
      },
      onMomentumEnd: () => {
        scheduleOnRN(momentumEnded)
      }
    },
    [beganDrag, callPlain, endedDrag, hasPlain, momentumEnded, scrolled]
  )
  const joined = useComposedEventHandler([
    publishing,
    (isWorkletHandler(onScroll) ? onScroll : null) as typeof publishing | null
  ])
  return (
    <Animated.ScrollView
      {...rest}
      ref={useScrollerRef(ref, attachScroller)}
      onScroll={joined}
      onLayout={event => {
        source.resized(event.nativeEvent.layout.height)
        onLayout?.(event)
      }}
      onContentSizeChange={(width, height) => {
        source.contentResized()
        onContentSizeChange?.(width, height)
      }}
    >
      <Published source={source} inert={inert}>
        {children}
      </Published>
    </Animated.ScrollView>
  )
}

/**
 * An `Animated.ScrollView` a list can follow, in place of the plain one for a
 * screen that passes `pagedList`, so that no other screen pays for it.
 */
export function PageScrollView(props: PageScrollViewProps): React.ReactElement {
  return Platform.OS === 'web' ? (
    <BrowserPageScrollView {...props} />
  ) : (
    <PhonePageScrollView {...props} />
  )
}

/** The scroller for a screen that does or does not pass `pagedList`. */
export function pageScroller(
  pagedList: boolean | undefined
): typeof Animated.ScrollView {
  return pagedList === true
    ? (PageScrollView as unknown as typeof Animated.ScrollView)
    : Animated.ScrollView
}
