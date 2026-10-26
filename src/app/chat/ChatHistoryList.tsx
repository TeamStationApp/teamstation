import { LegendList, type LegendListRef } from '@legendapp/list/react-native'
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react'
import { ScrollView, type ScrollViewProps, StyleSheet } from 'react-native'

import type {
  ChatHistoryHandle,
  ChatHistoryKeyboard,
  ChatHistoryKeyboardOptions,
  ChatHistoryListProps
} from './chatHistoryListTypes'

export type { ChatHistoryHandle } from './chatHistoryListTypes'

type ScrollNode = HTMLElement & {
  getInnerViewNode?: () => unknown
  getContentNode?: () => unknown
  scrollTo: (options: { x?: number; y?: number; animated?: boolean }) => void
  scrollToEnd: (options?: { animated?: boolean }) => void
}

/**
 * The browser's history scrolls in React Native Web's own ScrollView, so the
 * page keeps its keyboard, wheel, focus and layout semantics, while Legend
 * List mounts only the rows near the visible band.
 */
function HistoryScrollView(
  props: React.ComponentProps<typeof ScrollView> & {
    ref?: React.Ref<unknown>
  }
): React.ReactElement {
  const { ref, ...rest } = props
  const attach = useCallback(
    (node: ScrollNode | null) => {
      // Legend List's scroll compensation looks for the content node.
      if (node != null) node.getContentNode = () => node.getInnerViewNode?.()
      if (typeof ref === 'function') ref(node as never)
      else if (ref != null)
        (ref as React.RefObject<ScrollNode | null>).current = node
    },
    [ref]
  )
  return <ScrollView {...rest} ref={attach as never} />
}

export function ChatHistoryList<T>(
  props: ChatHistoryListProps<T>
): React.ReactElement {
  const list = useRef<LegendListRef>(null)
  const gap = useRef(0)
  const flat = StyleSheet.flatten(props.contentContainerStyle)
  gap.current =
    typeof flat?.rowGap === 'number'
      ? flat.rowGap
      : typeof flat?.gap === 'number'
        ? flat.gap
        : 0
  const scroll = (): ScrollNode | undefined =>
    (list.current?.getNativeScrollRef() as ScrollNode | null) ?? undefined
  useImperativeHandle(
    props.listRef,
    (): ChatHistoryHandle => ({
      scrollTo: options => {
        scroll()?.scrollTo({ x: 0, y: options.y, animated: options.animated })
      },
      scrollToEnd: options => {
        scroll()?.scrollToEnd(options)
      },
      scrollToIndex: async params => {
        await list.current?.scrollToIndex(params)
      },
      reportRowHeight: (key, height) => {
        // React Native Web observes the row as the list does; whichever
        // reports first places the rows below it. A row's container also
        // carries the gap below it.
        if (height > 0)
          list.current?.setItemSize(key, {
            width: 0,
            height: height + gap.current
          })
      },
      getNativeScrollRef: () => scroll() as never,
      getInnerViewRef: () => scroll()?.getInnerViewNode?.() as never,
      getScrollableNode: () => scroll(),
      state: () => list.current?.getState()
    }),
    []
  )
  const positions = useRef(props.onPositions)
  positions.current = props.onPositions
  useEffect(
    () =>
      list.current?.getState().listen('lastPositionUpdate', () => {
        positions.current?.()
      }),
    []
  )
  const {
    listRef: _listRef,
    renderItem,
    keyOf,
    alwaysRender,
    // The browser lays out and scrolls the first window in one frame, and the
    // reader's own restoration owns every programmatic position there.
    initialScroll: _initialScroll,
    header,
    footer,
    onPositions: _onPositions,
    keyboard: _keyboard,
    onLayout,
    onContentSizeChange,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
    ...rest
  } = props
  // Legend List measures the browser viewport itself and passes no layout or
  // gesture callbacks to its scroll component; the reader still needs them.
  const callbacks = useRef({
    onScroll,
    onLayout,
    onContentSizeChange,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd
  })
  callbacks.current = {
    onScroll,
    onLayout,
    onContentSizeChange,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd
  }
  const renderScroll = useCallback(
    (scrollProps: object): React.ReactElement => (
      <HistoryScrollView
        {...(scrollProps as React.ComponentProps<typeof ScrollView>)}
        // Legend List asks its own scroll view for unthrottled events, which
        // React Native Web would instead deliver only at start and end.
        scrollEventThrottle={16}
        onScroll={event => {
          ;(scrollProps as ScrollViewProps).onScroll?.(event)
          // Every browser scroll reaches the reader, as it did before; the
          // list skips some (a scroll of empty content) for its own work.
          callbacks.current.onScroll(event)
        }}
        onLayout={event => {
          callbacks.current.onLayout(event)
        }}
        onContentSizeChange={(width, height) => {
          callbacks.current.onContentSizeChange(width, height)
        }}
        onScrollBeginDrag={event => {
          callbacks.current.onScrollBeginDrag(event)
        }}
        onScrollEndDrag={event => {
          callbacks.current.onScrollEndDrag(event)
        }}
        onMomentumScrollBegin={event => {
          callbacks.current.onMomentumScrollBegin(event)
        }}
        onMomentumScrollEnd={event => {
          callbacks.current.onMomentumScrollEnd(event)
        }}
      />
    ),
    []
  )
  const scrollComponent: object = { renderScrollComponent: renderScroll }
  return (
    <LegendList
      {...rest}
      ref={list}
      keyExtractor={(item: T) => keyOf(item)}
      renderItem={({ item, index }: { item: T; index: number }) =>
        renderItem(item, index)
      }
      alwaysRender={alwaysRender == null ? undefined : { keys: alwaysRender }}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      maintainVisibleContentPosition={{ size: true, data: false }}
      recycleItems={false}
      // Supported on the web, though its web typing omits it.
      {...scrollComponent}
    />
  )
}

/** The browser has no software keyboard to coordinate with the list. */
export function useChatHistoryKeyboard(
  _options: ChatHistoryKeyboardOptions
): ChatHistoryKeyboard {
  return {
    composerRef: useRef(null),
    onComposerLayout: () => {},
    listProps: undefined,
    managesEndInset: false,
    scrollToEnd: (list, animated) => {
      list?.scrollToEnd({ animated })
    }
  }
}

/** The browser's keyboard needs no provider. */
export function ChatKeyboardProvider(props: {
  children: React.ReactNode
}): React.ReactElement {
  return <>{props.children}</>
}
