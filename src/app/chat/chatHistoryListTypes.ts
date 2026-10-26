import type React from 'react'
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  View,
  ViewStyle
} from 'react-native'

type HostView = React.ComponentRef<typeof View>

/** What Legend List says about the rows it has laid out. */
export interface ChatHistoryState {
  positionByKey: (key: string) => number | undefined
  indexByKey: (key: string) => number | undefined
  sizes: Map<string, number>
  scroll: number
  scrollLength: number
  start: number
  end: number
  isAtEnd: boolean
}

/** The history's scroll operations, the same on every platform. */
export interface ChatHistoryHandle {
  scrollTo: (options: { y: number; animated?: boolean }) => void
  scrollToEnd: (options?: { animated?: boolean }) => void
  /** A row's own measured height, before the list's observer may report it. */
  reportRowHeight: (key: string, height: number) => void
  /** The scroll viewport's host view (the scroll element on the web). */
  getNativeScrollRef: () => HostView | null | undefined
  /** The scroll content's host view, for content-relative measurement. */
  getInnerViewRef: () => HostView | null | undefined
  getScrollableNode: () => unknown
  state: () => ChatHistoryState | undefined
}

type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void

export interface ChatHistoryListProps<T> {
  listRef: React.Ref<ChatHistoryHandle>
  testID: string
  data: readonly T[]
  keyOf: (item: T) => string
  renderItem: (item: T, index: number) => React.ReactElement
  /** Anything the rows read besides their item; mounted rows re-render on change. */
  extraData: unknown
  header: React.ReactElement | null
  footer: React.ReactElement | null
  /** Rows kept mounted while off screen: jump targets and selected sources. */
  alwaysRender?: string[]
  /** The latest rows first; a saved reader is restored by measurement. */
  initialScroll?: 'end'
  estimatedItemSize: number
  estimatedListSize: { width: number; height: number }
  drawDistance?: number
  style: StyleProp<ViewStyle>
  contentContainerStyle: StyleProp<ViewStyle>
  keyboardShouldPersistTaps: 'handled'
  onScroll: ScrollHandler
  onScrollBeginDrag: ScrollHandler
  onScrollEndDrag: ScrollHandler
  onMomentumScrollBegin: ScrollHandler
  onMomentumScrollEnd: ScrollHandler
  onLayout: (event: LayoutChangeEvent) => void
  onContentSizeChange: (width: number, height: number) => void
  /** Item positions were recalculated (a row above grew, data changed). */
  onPositions?: () => void
  /** Native keyboard coordination from `useChatHistoryKeyboard`. */
  keyboard?: unknown
}

export interface ChatHistoryKeyboardOptions {
  /** Clearance below the last row with the keyboard closed, less the composer. */
  closedClearance: number
  /** How much of the keyboard's height the closed clearance already covers. */
  keyboardOffset: number
  /** Whether this conversation owns the keyboard (shown, no overlay scene). */
  active: boolean
}

export interface ChatHistoryKeyboard {
  composerRef: React.RefObject<React.ComponentRef<typeof View> | null>
  onComposerLayout: (event: LayoutChangeEvent) => void
  /** Spread into the list as its `keyboard` prop. */
  listProps: unknown
  /** The list itself pads its end for the composer and the keyboard. */
  managesEndInset: boolean
  /** The content's own end padding, given the clearance the overlays need. */
  endPadding: (contentBottom: number) => number
  scrollToEnd: (list: ChatHistoryHandle | null, animated: boolean) => void
}
