import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd
} from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import React, { useEffect, useImperativeHandle, useRef } from 'react'
import { Platform, type View } from 'react-native'
import {
  KeyboardProvider,
  useKeyboardController
} from 'react-native-keyboard-controller'
import {
  type SharedValue,
  useDerivedValue,
  useSharedValue
} from 'react-native-reanimated'

import type {
  ChatHistoryHandle,
  ChatHistoryKeyboard,
  ChatHistoryKeyboardOptions,
  ChatHistoryListProps
} from './chatHistoryListTypes'

export type { ChatHistoryHandle } from './chatHistoryListTypes'

interface NativeKeyboardProps {
  contentInsetEndAdjustment: SharedValue<number>
  freeze: SharedValue<boolean>
  keyboardOffset: number
}

interface NativeScroll {
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
      scrollToIndex: async params => {
        await list.current?.scrollToIndex(params)
      },
      // The native list measures each container in the same layout pass.
      reportRowHeight: () => {},
      getNativeScrollRef: () => scroll() as never,
      getInnerViewRef: () => scroll()?.getInnerViewRef?.() as never,
      getScrollableNode: () => list.current?.getScrollableNode(),
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
    initialScroll,
    header,
    footer,
    onPositions: _onPositions,
    keyboard,
    ...rest
  } = props
  const keys = keyboard as NativeKeyboardProps | undefined
  return (
    <KeyboardAwareLegendList
      {...rest}
      ref={list}
      keyExtractor={(item: T) => keyOf(item)}
      renderItem={({ item, index }: { item: T; index: number }) =>
        renderItem(item, index)
      }
      alwaysRender={alwaysRender == null ? undefined : { keys: alwaysRender }}
      {...(initialScroll === 'end'
        ? { initialScrollAtEnd: true }
        : initialScroll == null
          ? {}
          : { initialScrollIndex: initialScroll })}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      maintainVisibleContentPosition={{ size: true, data: false }}
      recycleItems={false}
      keyboardLiftBehavior="whenAtEnd"
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
}

/** Conversations that currently hold the Android keyboard coordination. */
const owners = new Set<object>()

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
  const clearance = useSharedValue(options.closedClearance)
  useEffect(() => {
    clearance.value = options.closedClearance
  }, [clearance, options.closedClearance])
  const endInset = useDerivedValue(
    () => contentInsetEndAdjustment.value + clearance.value
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
  const { setEnabled } = useKeyboardController()
  useEffect(() => {
    // iOS never resizes its window for the keyboard; the root keeps it on.
    if (Platform.OS !== 'android' || !options.active) return
    const owner = {}
    owners.add(owner)
    setEnabled(true)
    return () => {
      owners.delete(owner)
      if (owners.size === 0) setEnabled(false)
    }
  }, [options.active, setEnabled])
  return {
    composerRef,
    onComposerLayout,
    listProps: {
      // Read only by the scroll view's worklets.
      contentInsetEndAdjustment: endInset,
      freeze,
      keyboardOffset: options.keyboardOffset
    } satisfies NativeKeyboardProps,
    managesEndInset: true,
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
