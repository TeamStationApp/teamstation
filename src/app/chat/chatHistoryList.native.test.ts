import Module from 'node:module'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type * as NativeBand from './ChatComposerBand.native'
import type * as NativeHistory from './ChatHistoryList.native'
import type {
  ChatHistoryHandle,
  ChatHistoryKeyboard,
  ChatHistoryListProps
} from './chatHistoryListTypes'
import type { ChatComposerBandProps } from './ChatViewport'

/**
 * The phone's history list over stand-ins for Legend List's keyboard
 * integration, react-native-keyboard-controller, Reanimated and React Native:
 * what it asks of them is the contract a device build relies on.
 */
describe('native virtualized chat history', function () {
  let history: typeof NativeHistory
  let composerBand: typeof NativeBand
  interface KeyboardFrame {
    height: number
    progress: number
  }
  let frameHandlers: {
    onStart?: (event: KeyboardFrame) => void
    onMove: (event: KeyboardFrame) => void
    onInteractive: (event: KeyboardFrame) => void
    onEnd: (event: KeyboardFrame) => void
  }
  let initialKeyboardHeight = 0
  let sampleStyle: () => { transform: Array<{ translateY: number }> }
  let bandBottom: number
  const saved = new Map<string, NodeJS.Module | undefined>()
  const platform = { OS: 'android' }
  const shown = new Set<() => void>()
  const enabled: boolean[] = []
  const providers: Array<{ enabled: boolean }> = []
  let listProps: Record<string, unknown> = {}
  const calls: string[] = []
  const listeners: Array<() => void> = []
  const endListeners = new Set<(atEnd: boolean) => void>()
  let atEnd = false
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
      isAtEnd: atEnd,
      listen: (name: string, callback: (value?: boolean) => void) => {
        if (name === 'isAtEnd') {
          endListeners.add(callback)
          return () => {
            endListeners.delete(callback)
          }
        }
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
      View: ({ style }: { style: [unknown, { bottom: number }, unknown] }) => {
        bandBottom = style[1].bottom
        return null
      },
      useAnimatedStyle: (sample: typeof sampleStyle) => {
        sampleStyle = sample
        return sample()
      },
      useSharedValue: (initial: unknown) =>
        React.useRef({ value: initial }).current,
      useDerivedValue: (derive: () => unknown) => ({
        get value() {
          return derive()
        }
      })
    })
    stand('react-native-keyboard-controller', {
      useGenericKeyboardHandler: (handlers: typeof frameHandlers) => {
        frameHandlers = handlers
      },
      KeyboardGestureArea: (props: {
        children: React.ReactNode
      }): React.ReactElement =>
        React.createElement(React.Fragment, null, props.children),
      KeyboardProvider: (props: {
        enabled: boolean
        children: React.ReactNode
      }): React.ReactElement => {
        providers.push({ enabled: props.enabled })
        return React.createElement(React.Fragment, null, props.children)
      },
      useKeyboardController: () => ({
        setEnabled: (value: boolean) => enabled.push(value)
      }),
      // No keyboard up: a conversation that leaves lets go at once.
      KeyboardController: {
        isVisible: () => initialKeyboardHeight > 0,
        state: () => ({ height: initialKeyboardHeight })
      },
      KeyboardEvents: {
        addListener: (name: string, callback: () => void) => {
          if (name === 'keyboardDidShow') shown.add(callback)
          return { remove: () => shown.delete(callback) }
        }
      }
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
    composerBand = await import('./ChatComposerBand.native')
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
    initialKeyboardHeight = 0
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
    atEnd = false
  })

  interface Harness {
    handle: React.RefObject<ChatHistoryHandle | null>
    keyboard: { current: ChatHistoryKeyboard | undefined }
    positions: number[]
  }
  type Over = Partial<ChatHistoryListProps<string>> & {
    active?: boolean
    attachmentHandoff?: boolean
    onKeyboardReturnSettled?: () => void
  }
  function Screen(props: { over: Over; state: Harness }): React.ReactElement {
    const { over, state } = props
    const keyboard = history.useChatHistoryKeyboard({
      closedClearance: 100,
      keyboardOffset: 92,
      attachmentHandoff: over.attachmentHandoff,
      onKeyboardReturnSettled: over.onKeyboardReturnSettled,
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

  it('follows intermediate native keyboard frames through a reversal, handoff and pane switch', async function () {
    const frame = { value: { height: 0, progress: 0, revision: 0 } }
    const render = async (
      consumed: number,
      follow = true,
      active = true
    ): Promise<void> => {
      const viewport: ChatComposerBandProps['viewport'] = {
        composerBottom: 32,
        composerDock: { bottom: 88, gap: 8, consumed, follow }
      }
      await mount(
        React.createElement(composerBand.ChatComposerBand, {
          active,
          viewport,
          frame
        })
      )
    }
    function shift(height: number, progress: number): number {
      frame.value = { height, progress, revision: frame.value.revision + 1 }
      return sampleStyle().transform[0].translateY
    }
    await render(0)
    expect(bandBottom).equals(88)
    expect(shift(0, 0)).equals(0)
    expect(shift(150, 0.5)).equals(-110)
    expect(shift(300, 1)).equals(-220)
    expect(shift(225, 0.75)).equals(-165)
    expect(shift(270, 0.9)).equals(-198)
    await render(60)
    expect(shift(150, 0.5)).equals(-50)
    expect(shift(0, 0)).equals(0)
    await render(60, false)
    expect(bandBottom).equals(32)
    expect(shift(300, 1)).equals(0)
    await render(60, true, false)
    expect(shift(225, 0.75)).equals(0)
  })
  it('distinguishes a static keyboard from an interactive gesture that reverses to its starting height', async function () {
    initialKeyboardHeight = 300
    const { element, state } = harness()
    await mount(element)
    const frame = state.keyboard.current!.frame!
    frameHandlers.onStart?.({ height: 0, progress: 0 })
    expect(frame.value).to.deep.equal({ height: 300, progress: 1, revision: 0 })
    frameHandlers.onMove({ height: 300, progress: 1 })
    frameHandlers.onInteractive({ height: 230, progress: 0.77 })
    frameHandlers.onInteractive({ height: 300, progress: 1 })
    expect(frame.value).to.deep.equal({ height: 300, progress: 1, revision: 2 })
    frameHandlers.onMove({ height: 90, progress: 0.3 })
    frameHandlers.onEnd({ height: 0, progress: 0 })
    expect(frame.value).to.deep.equal({ height: 0, progress: 0, revision: 4 })
  })

  it('holds the existing keyboard inset while the source panel replaces the keyboard', async function () {
    const { element, state } = harness()
    await mount(element)
    const layout: Parameters<ChatHistoryKeyboard['onComposerLayout']>[0] =
      Object.create(null)
    state.keyboard.current!.holdKeyboardInset!()
    await mount(harness({ attachmentHandoff: true }).element)
    expect((listProps.freeze as { value: boolean }).value).equals(true)
    state.keyboard.current!.onComposerLayout(layout)
    expect(calls.includes('composer layout')).equals(false)
    expect(
      (listProps.contentInsetEndAdjustment as { value: number }).value
    ).equals(156)
    await mount(harness({ attachmentHandoff: false }).element)
    expect((listProps.freeze as { value: boolean }).value).equals(false)
    state.keyboard.current!.onComposerLayout(layout)
    expect(calls.includes('composer layout')).equals(true)
  })

  it('releases an Android source-panel handoff after the controller delivers its last animation frame', async function () {
    const end = (): void => {
      calls.push('keyboard returned')
    }
    await mount(
      harness({ attachmentHandoff: true, onKeyboardReturnSettled: end }).element
    )
    expect(shown.size).equals(1)
    await act(async () => {
      for (const notify of shown) notify()
      expect(calls).not.to.include('keyboard returned')
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(calls).to.include('keyboard returned')
    await mount(
      harness({ attachmentHandoff: false, onKeyboardReturnSettled: end })
        .element
    )
    expect(shown.size).equals(0)
  })

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

  it('keeps the Android end row above the keyboard and leaves an earlier reader in place', async function () {
    atEnd = true
    await mount(harness().element)
    expect(listProps.keyboardLiftBehavior).equals('always')
    await act(async () => {
      for (const update of endListeners) update(false)
    })
    expect(listProps.keyboardLiftBehavior).equals('whenAtEnd')
    await act(async () => {
      for (const update of endListeners) update(true)
    })
    expect(listProps.keyboardLiftBehavior).equals('always')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(endListeners.size).equals(0)
    platform.OS = 'ios'
    await mount(harness().element)
    expect(listProps.keyboardLiftBehavior).equals('whenAtEnd')
    expect(endListeners.size).equals(0)
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
