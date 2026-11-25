import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd
} from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import React, {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  Dimensions,
  type NativeSyntheticEvent,
  Platform,
  requireNativeComponent,
  StyleSheet,
  type View,
  type ViewProps
} from 'react-native'
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardGestureArea,
  KeyboardProvider,
  useGenericKeyboardHandler
} from 'react-native-keyboard-controller'
import Animated, {
  type SharedValue,
  useDerivedValue,
  useEvent,
  useSharedValue
} from 'react-native-reanimated'

// A phone-only module, so it takes the phone's owner by name.
import { useKeyboardControllerOwner } from '../components/keyboardControllerOwner.native'
import type {
  ChatHistoryHandle,
  ChatHistoryKeyboard,
  ChatHistoryKeyboardOptions,
  ChatHistoryListProps
} from './chatHistoryListTypes'

export type { ChatHistoryHandle } from './chatHistoryListTypes'

interface GuideEvent {
  height: number
}
interface GuideProps extends ViewProps {
  onChatKeyboardInset: (event: GuideEvent) => void
  onChatKeyboardRest: (event: NativeSyntheticEvent<GuideEvent>) => void
}
let Guide: React.ComponentType<GuideProps> | undefined

function TabletKeyboardGuide({
  height,
  onRest
}: {
  height: SharedValue<number>
  onRest?: (height: number) => void
}): React.ReactElement {
  // Register the iOS-only native component only on its platform.
  Guide ??= Animated.createAnimatedComponent(
    requireNativeComponent<GuideProps>('TSChatKeyboardGuide')
  )
  const received = useEvent<GuideEvent>(
    event => {
      'worklet'
      height.value = event.height
    },
    ['onChatKeyboardInset']
  )
  return (
    <Guide
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onChatKeyboardRest={event => onRest?.(event.nativeEvent.height)}
      onChatKeyboardInset={received}
    />
  )
}

interface NativeKeyboardProps {
  guideHeight?: SharedValue<number>
  onTabletKeyboardRest?: (height: number) => void
  contentInsetEndAdjustment: SharedValue<number>
  freeze: SharedValue<boolean>
  keyboardOffset: number
}

interface NativeScroll {
  getNativeScrollRef?: () => React.ComponentRef<typeof View> | null
  scrollTo: (options: { x?: number; y?: number; animated?: boolean }) => void
  scrollToEnd: (options?: { animated?: boolean }) => void
  getInnerViewRef?: () => unknown
}

/**
 * The phone's history: Legend List in react-native-keyboard-controller's
 * chat scroll view, which pads the end for the floating composer and lifts
 * the latest rows with the keyboard only when the reader is at the end.
 */
export function ChatHistoryList<T>(
  props: ChatHistoryListProps<T>
): React.ReactElement {
  const list = useRef<LegendListRef>(null)
  const pinned = useRef({ keys: '', version: 0 })
  const pinnedVersion = (keys: string[] | undefined): number => {
    const joined = (keys ?? []).join('\n')
    if (joined !== pinned.current.keys)
      pinned.current = { keys: joined, version: pinned.current.version + 1 }
    return pinned.current.version
  }
  const scroll = (): NativeScroll | undefined =>
    list.current?.getNativeScrollRef() ?? undefined
  useImperativeHandle(
    props.listRef,
    (): ChatHistoryHandle => ({
      scrollTo: options => {
        scroll()?.scrollTo({ x: 0, y: options.y, animated: options.animated })
      },
      scrollToEnd: options => {
        list.current?.scrollToEnd(options).catch(() => undefined)
      },
      // The native list measures each container in the same layout pass.
      reportRowHeight: () => {},
      getNativeScrollRef: () => {
        const view = scroll()
        return view?.getNativeScrollRef?.() ?? (view as never)
      },
      getInnerViewRef: () => scroll()?.getInnerViewRef?.() as never,
      getScrollableNode: () => list.current?.getScrollableNode(),
      state: () => list.current?.getState()
    }),
    []
  )
  // On Android the scroll view's raw content height includes the floating
  // composer's inset. Legend knows when the last row is already at the end.
  const [atInsetAdjustedEnd, setAtInsetAdjustedEnd] = useState(false)
  useLayoutEffect(() => {
    if (Platform.OS !== 'android') return
    const state = list.current?.getState()
    if (state == null) return
    setAtInsetAdjustedEnd(state.isAtEnd)
    return state.listen('isAtEnd', setAtInsetAdjustedEnd)
  }, [])
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
    initialScroll,
    header,
    footer,
    onPositions: _onPositions,
    keyboard,
    ...rest
  } = props
  const keys = keyboard as NativeKeyboardProps | undefined
  const history = (
    <KeyboardAwareLegendList
      {...rest}
      ref={list}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
      keyExtractor={(item: T) => keyOf(item)}
      renderItem={({ item, index }: { item: T; index: number }) =>
        renderItem(item, index)
      }
      alwaysRender={alwaysRender == null ? undefined : { keys: alwaysRender }}
      // Legend List lays out a newly pinned row with its next pass; a new
      // version makes that pass now, before the row is measured.
      dataVersion={pinnedVersion(alwaysRender)}
      {...(initialScroll === 'end' ? { initialScrollAtEnd: true } : {})}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      maintainVisibleContentPosition={{ size: true, data: false }}
      recycleItems={false}
      keyboardLiftBehavior={atInsetAdjustedEnd ? 'always' : 'whenAtEnd'}
      // The list itself reads every frame; the reader's bookkeeping keeps the
      // pace the history's ScrollView had before virtualization.
      scrollEventThrottle={100}
      {...(keys == null
        ? {}
        : {
            contentInsetEndAdjustment: keys.contentInsetEndAdjustment,
            freeze: keys.freeze,
            keyboardOffset: keys.keyboardOffset
          })}
    />
  )
  const handleTabletRest = keys?.onTabletKeyboardRest
  if (keys?.guideHeight != null)
    return (
      <>
        {history}
        <TabletKeyboardGuide
          height={keys.guideHeight}
          onRest={handleTabletRest}
        />
      </>
    )
  if (Platform.OS !== 'android') return history
  return (
    <KeyboardGestureArea style={props.style} interpolator="linear">
      {history}
    </KeyboardGestureArea>
  )
}

/** The scroll view's inset already holds the composer and the keyboard. */
const noEndPadding = (): number => 0

/**
 * The composer floats over the end of the history. Its measured height plus
 * the clearance below it is the list's end inset; the keyboard adds only what
 * it covers beyond that clearance (`keyboardOffset`).
 *
 * Android resizes the window for the keyboard unless keyboard-controller is
 * enabled, and every other screen relies on that resize, so the controller
 * is enabled only while a conversation shows without an overlay scene.
 */
export function useChatHistoryKeyboard(
  options: ChatHistoryKeyboardOptions
): ChatHistoryKeyboard {
  const composerRef = useRef<React.ComponentRef<typeof View>>(null)
  const listRef = useRef<{
    reportContentInset: (inset?: object | null) => void
  } | null>(null)
  const { contentInsetEndAdjustment, onComposerLayout } =
    useKeyboardChatComposerInset(listRef, composerRef, 0)
  const tablet = Platform.OS === 'ios' && Platform.isPad
  const guideHeight = useSharedValue(0)
  const dockClearance = options.dockClearance ?? options.keyboardOffset
  const tabletLift = useDerivedValue(() =>
    Math.max(0, guideHeight.value - dockClearance)
  )
  const [initialHeight] = useState(() =>
    KeyboardController.isVisible() ? KeyboardController.state().height : 0
  )
  const frame = useSharedValue({
    height: initialHeight,
    progress: initialHeight > 0 ? 1 : 0,
    revision: 0
  })
  const updateFrame = (event: { height: number; progress: number }): void => {
    'worklet'
    const previous = frame.value
    if (
      event.height !== previous.height ||
      event.progress !== previous.progress
    )
      frame.value = {
        height: event.height,
        progress: event.progress,
        revision: previous.revision + 1
      }
  }
  // iOS announces the destination height at the start of a transition. Its
  // move and interactive events carry the keyboard's actual position.
  useGenericKeyboardHandler(
    { onMove: updateFrame, onInteractive: updateFrame, onEnd: updateFrame },
    [frame]
  )
  const clearance = useSharedValue(options.closedClearance)
  useEffect(() => {
    clearance.value = options.closedClearance
  }, [clearance, options.closedClearance])
  const onKeyboardReturnSettled = options.onKeyboardReturnSettled
  useEffect(() => {
    if (
      Platform.OS !== 'android' ||
      options.attachmentHandoff !== true ||
      onKeyboardReturnSettled == null
    )
      return
    let frame: number | undefined
    const ended = KeyboardEvents.addListener('keyboardDidShow', () => {
      // The controller emits this notification immediately before dispatching
      // the final keyboard frame to the list. Keep its scroll frozen for both.
      if (frame != null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(onKeyboardReturnSettled)
    })
    return () => {
      ended.remove()
      if (frame != null) cancelAnimationFrame(frame)
    }
  }, [options.attachmentHandoff, onKeyboardReturnSettled])
  const heldInset = useSharedValue<number | null>(null)
  const holdingInset = useRef(false)
  useLayoutEffect(() => {
    if (options.attachmentHandoff !== true) {
      holdingInset.current = false
      heldInset.value = null
    }
  }, [options.attachmentHandoff, heldInset])
  const endInset = useDerivedValue(
    () =>
      heldInset.value ??
      contentInsetEndAdjustment.value +
        clearance.value +
        (tablet ? tabletLift.value : 0)
  )
  const scrollTarget = useRef<ChatHistoryHandle | null>(null)
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({
    listRef: {
      get current() {
        const target = scrollTarget.current
        return target == null
          ? null
          : {
              scrollToEnd: async (params?: { animated?: boolean }) => {
                target.scrollToEnd(params)
              }
            }
      }
    }
  })
  const freezeInset = useDerivedValue(
    () => heldInset.value != null || freeze.value
  )
  useKeyboardControllerOwner(options.active)
  return {
    frame,
    tabletLift: tablet ? tabletLift : undefined,
    composerRef,
    holdKeyboardInset: () => {
      holdingInset.current = true
      heldInset.value = endInset.value
    },
    onComposerLayout: event => {
      // The drawer replaces the keyboard inset already held by the scroll view.
      if (!holdingInset.current) onComposerLayout(event)
    },
    listProps: {
      // Read only by the scroll view's worklets.
      contentInsetEndAdjustment: endInset,
      freeze: freezeInset,
      guideHeight: tablet ? guideHeight : undefined,
      onTabletKeyboardRest: options.onTabletKeyboardRest,
      // The guide already accounts for the full overlap in the extra end inset.
      // Suppress the second inset from keyboard-controller's screen-coordinate frame.
      keyboardOffset: tablet
        ? Math.max(
            Dimensions.get('screen').height,
            Dimensions.get('screen').width
          )
        : options.keyboardOffset
    } satisfies NativeKeyboardProps,
    managesEndInset: true,
    endPadding: noEndPadding,
    scrollToEnd: (list, animated) => {
      scrollTarget.current = list
      scrollMessageToEnd({ animated, closeKeyboard: false }).catch(
        () => undefined
      )
    }
  }
}

/**
 * The chat history's keyboard coordination for the whole app. Android starts
 * disabled, and a conversation enables it (`useChatHistoryKeyboard`), because
 * an enabled controller stops the window resizing for other screens' fields.
 */
export function ChatKeyboardProvider(props: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <KeyboardProvider enabled={Platform.OS !== 'android'}>
      {props.children}
    </KeyboardProvider>
  )
}

/** The whole app, with the keyboard coordination its chat history uses. */
export function withChatKeyboard(app: React.ReactElement): React.ReactElement {
  return <ChatKeyboardProvider>{app}</ChatKeyboardProvider>
}
