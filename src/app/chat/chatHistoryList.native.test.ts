import Module from 'node:module'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type * as NativeHistory from './ChatHistoryList.native'
import type {
  ChatHistoryHandle,
  ChatHistoryKeyboard,
  ChatHistoryListProps
} from './chatHistoryListTypes'

/**
 * The phone's history list over stand-ins for Legend List's keyboard
 * integration, react-native-keyboard-controller, Reanimated and React Native:
 * what it asks of them is the contract a device build relies on.
 */
describe('native virtualized chat history', function () {
  let history: typeof NativeHistory
  const saved = new Map<string, NodeJS.Module | undefined>()
  const platform = { OS: 'android' }
  const enabled: boolean[] = []
  const providers: Array<{ enabled: boolean }> = []
  let listProps: Record<string, unknown> = {}
  const calls: string[] = []
  const listeners: Array<() => void> = []
  const nativeScroll = {
    scrollTo: (options: { y: number; animated?: boolean }) => {
      calls.push(`scrollTo ${options.y} ${String(options.animated)}`)
    },
    getInnerViewRef: () => 'inner view'
  }
  const legend = {
    getNativeScrollRef: () => nativeScroll,
    getScrollableNode: () => 'scrollable',
    scrollToEnd: async (options?: { animated?: boolean }) => {
      calls.push(`scrollToEnd ${String(options?.animated)}`)
    },
    getState: () => ({
      positionByKey: () => 12,
      listen: (_name: string, callback: () => void) => {
        listeners.push(callback)
        return () => {
          listeners.splice(listeners.indexOf(callback), 1)
        }
      }
    })
  }
  const stand = (name: string, exports: object): void => {
    const path = require.resolve(name)
    saved.set(path, require.cache[path])
    const module = new Module(path)
    module.filename = path
    module.loaded = true
    module.exports = exports
    require.cache[path] = module
  }

  before(async function () {
    stand('react-native', { Platform: platform })
    stand('react-native-reanimated', {
      useSharedValue: (initial: unknown) =>
        React.useRef({ value: initial }).current,
      useDerivedValue: (derive: () => unknown) => ({
        get value() {
          return derive()
        }
      })
    })
    stand('react-native-keyboard-controller', {
      KeyboardProvider: (props: {
        enabled: boolean
        children: React.ReactNode
      }): React.ReactElement => {
        providers.push({ enabled: props.enabled })
        return React.createElement(React.Fragment, null, props.children)
      },
      useKeyboardController: () => ({
        setEnabled: (value: boolean) => enabled.push(value)
      })
    })
    stand('@legendapp/list/keyboard', {
      KeyboardAwareLegendList: React.forwardRef(
        (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          listProps = props
          React.useImperativeHandle(ref, () => legend)
          return null
        }
      ),
      useKeyboardChatComposerInset: () => ({
        contentInsetEndAdjustment: { value: 56 },
        onComposerLayout: () => {
          calls.push('composer layout')
        }
      }),
      useKeyboardScrollToEnd: (options: {
        listRef: {
          current: { scrollToEnd: (o: object) => Promise<void> } | null
        }
      }) => ({
        freeze: { value: false },
        scrollMessageToEnd: async ({ animated }: { animated: boolean }) => {
          calls.push('freeze')
          await options.listRef.current?.scrollToEnd({ animated })
        }
      })
    })
    history = await import('./ChatHistoryList.native')
  })

  after(function () {
    for (const [path, module] of saved) {
      if (module != null) require.cache[path] = module
      else Reflect.deleteProperty(require.cache, path)
    }
  })

  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(async function () {
    if (root != null)
      await act(async () => {
        root!.unmount()
      })
    root = undefined
    host?.remove()
    enabled.length = 0
    providers.length = 0
    calls.length = 0
    platform.OS = 'android'
  })

  interface Harness {
    handle: React.RefObject<ChatHistoryHandle | null>
    keyboard: { current: ChatHistoryKeyboard | undefined }
    positions: number[]
  }
  type Over = Partial<ChatHistoryListProps<string>> & { active?: boolean }
  function Screen(props: { over: Over; state: Harness }): React.ReactElement {
    const { over, state } = props
    const keyboard = history.useChatHistoryKeyboard({
      closedClearance: 100,
      keyboardOffset: 92,
      active: over.active ?? true
    })
    state.keyboard.current = keyboard
    return React.createElement(history.ChatHistoryList<string>, {
      listRef: state.handle,
      testID: 'chat-message-history',
      data: ['msg_1', 'msg_2'],
      keyOf: id => id,
      renderItem: id => React.createElement('div', { key: id }, id),
      extraData: undefined,
      header: null,
      footer: null,
      estimatedItemSize: 64,
      estimatedListSize: { width: 390, height: 844 },
      style: undefined,
      contentContainerStyle: undefined,
      keyboardShouldPersistTaps: 'handled',
      onScroll: () => {},
      onScrollBeginDrag: () => {},
      onScrollEndDrag: () => {},
      onMomentumScrollBegin: () => {},
      onMomentumScrollEnd: () => {},
      onLayout: () => {},
      onContentSizeChange: () => {},
      onPositions: () => {
        state.positions.push(1)
      },
      keyboard: keyboard.listProps,
      ...over
    })
  }
  const shared: Harness = {
    handle: React.createRef<ChatHistoryHandle>(),
    keyboard: { current: undefined },
    positions: []
  }
  function harness(over: Over = {}): {
    element: React.ReactElement
    state: Harness
  } {
    shared.positions.length = 0
    return {
      element: React.createElement(Screen, { over, state: shared }),
      state: shared
    }
  }
  async function mount(element: React.ReactElement): Promise<void> {
    if (root == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(element)
    })
  }

  it('pads the end for the floating composer and lifts with the keyboard only at the end', async function () {
    const { element, state } = harness({ initialScroll: 'end' })
    await mount(element)
    const inset = listProps.contentInsetEndAdjustment as { value: number }
    expect(inset.value, 'Composer height plus closed clearance').equals(156)
    expect(listProps.keyboardOffset).equals(92)
    expect(listProps.keyboardLiftBehavior).equals('whenAtEnd')
    expect(listProps.scrollEventThrottle).equals(100)
    expect(listProps.initialScrollAtEnd).equals(true)
    expect(listProps.maintainVisibleContentPosition).deep.equals({
      size: true,
      data: false
    })
    expect(state.keyboard.current!.managesEndInset).equals(true)
    expect(state.keyboard.current!.endPadding(169)).equals(0)
    const layout: Parameters<ChatHistoryKeyboard['onComposerLayout']>[0] =
      Object.create(null)
    state.keyboard.current!.onComposerLayout(layout)
    expect(calls).deep.equals(['composer layout'])
    const render = listProps.renderItem as (info: {
      item: string
      index: number
    }) => React.ReactElement
    expect(render({ item: 'msg_2', index: 1 }).key).equals('msg_2')
    expect(
      (listProps.keyExtractor as (item: string) => string)('msg_1')
    ).equals('msg_1')
  })

  it('leaves a saved reader to measured restoration and lays out newly pinned rows at once', async function () {
    // An index from the first view would name another row once the opened
    // view adds rows above it: the list gets no index to scroll to.
    const first = harness({ alwaysRender: ['msg_1'] })
    await mount(first.element)
    expect(listProps.initialScrollIndex).equals(undefined)
    expect(listProps.initialScrollAtEnd).equals(undefined)
    expect(listProps.alwaysRender).deep.equals({ keys: ['msg_1'] })
    const version = listProps.dataVersion as number
    await mount(harness({ alwaysRender: ['msg_1'] }).element)
    expect(listProps.dataVersion, 'Same pinned rows').equals(version)
    await mount(harness({ alwaysRender: ['msg_1', 'msg_2'] }).element)
    expect(listProps.dataVersion).equals(version + 1)
    expect(listProps.initialScrollIndex).equals(undefined)
    await mount(harness({ alwaysRender: undefined }).element)
    expect(listProps.alwaysRender).equals(undefined)
  })

  it('scrolls, measures and reports through the native scroll view', async function () {
    const { element, state } = harness()
    await mount(element)
    const handle = state.handle.current!
    handle.scrollTo({ y: 320, animated: false })
    handle.scrollToEnd({ animated: true })
    handle.reportRowHeight('msg_1', 80)
    expect(handle.getNativeScrollRef()).equals(nativeScroll)
    expect(handle.getInnerViewRef()).equals('inner view')
    expect(handle.getScrollableNode()).equals('scrollable')
    expect(handle.state()?.positionByKey('msg_1')).equals(12)
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).deep.equals(['scrollTo 320 false', 'scrollToEnd true'])
    for (const listener of [...listeners]) listener()
    expect(state.positions).length(1)
    calls.length = 0
    state.keyboard.current!.scrollToEnd(handle, true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls, 'Send and Latest freeze keyboard reactions').deep.equals([
      'freeze',
      'scrollToEnd true'
    ])
  })

  it('enables Android keyboard coordination only while a conversation owns it', async function () {
    const { element } = harness({ active: true })
    await mount(element)
    expect(enabled).deep.equals([true])
    await mount(harness({ active: false }).element)
    expect(enabled, 'An overlay scene gives the keyboard back').deep.equals([
      true,
      false
    ])
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    platform.OS = 'ios'
    await mount(harness({ active: true }).element)
    expect(enabled, 'iOS never resizes its window').deep.equals([true, false])
  })

  it('starts the provider disabled on Android and enabled on iOS', async function () {
    await mount(
      React.createElement(history.ChatKeyboardProvider, null, 'History')
    )
    platform.OS = 'ios'
    await mount(
      history.withChatKeyboard(React.createElement('span', null, 'History'))
    )
    expect(providers.map(provider => provider.enabled)).deep.equals([
      false,
      true
    ])
    expect(host!.textContent).equals('History')
  })
})
