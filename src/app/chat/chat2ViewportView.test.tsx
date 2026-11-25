import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Dimensions, Keyboard, Platform } from 'react-native'

import { userIdOfGumbo } from '../../common/userId'
import { AppHeader } from '../components/AppHeader'
import { AppNav } from '../components/AppNav'
import { HeaderSlotProvider } from '../components/headerSlot'
import { NavCompactProvider } from '../components/navCompact'
import { NAV_BOTTOM_GAP } from '../components/navGeometry'
import { scrollFrom } from '../components/navScroll.test.helpers'
import { Screen } from '../components/Screen'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatConversationIdentity } from './ChatConversationIdentity'
import { ChatListScreen } from './ChatListScreen'
import { ChatViewport, useChatViewport } from './ChatViewport'
import { chat, message, view } from './chatViews.test.helpers'
import {
  TestComposer as Composer,
  type TestComposerProps as ComposerProps
} from './composer.test.helpers'
import { ConversationScreen } from './ConversationScreen'
import type { ChatEngineEvent, ChatEngineListener } from './engine/store'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

async function render(element: React.ReactElement): Promise<HTMLElement> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  return host!
}

describe('chat measured chrome and explicit focus', function () {
  it('compacts from the inbox list, leaving a hidden inbox unable to move navigation', async function () {
    const item = chat()
    const engine = {
      refresh: async () => [item],
      conversations: () => [item],
      subscribe: () => () => {}
    }
    const inbox = (selectedVisible: boolean): React.ReactElement => (
      <NavCompactProvider>
        <ChatListScreen
          embedded
          narrow
          selectedVisible={selectedVisible}
          engine={engine}
          onOpen={() => {}}
          onNewMessage={() => {}}
        />
        <AppNav selected="chat" mode="floating" onSelect={() => {}} />
      </NavCompactProvider>
    )
    const node = await render(inbox(false))
    const scroll = node.querySelector('[data-testid="chat-conversation-list"]')!
    const label = (): string =>
      node.querySelector('[data-testid="tab-chat"]')!.textContent!
    // Send DOM wheel and scroll events faster than the inbox's 100 ms RN callback.
    const wheelBurst = async (delta: number, count: number): Promise<void> => {
      await act(async () => {
        for (let i = 0; i < count; i++) {
          scroll.scrollTop += delta
          scroll.dispatchEvent(
            new window.WheelEvent('wheel', { bubbles: true, deltaY: delta })
          )
          scroll.dispatchEvent(new window.Event('scroll'))
        }
        await new Promise(resolve => setTimeout(resolve, 110))
      })
    }
    await scrollFrom(scroll, 160)
    expect(label(), 'the restored inbox position').includes('Chat')
    await wheelBurst(8, 3)
    expect(label(), '24 points downward').includes('Chat')
    await wheelBurst(8, 3)
    expect(
      label(),
      '48 points downward across two callback windows'
    ).not.includes('Chat')
    await wheelBurst(-6, 4)
    expect(label(), '24 points upward inside a callback window').includes(
      'Chat'
    )
    await scrollFrom(scroll, 0, 160)
    expect(label()).not.includes('Chat')
    await render(inbox(true))
    await scrollFrom(scroll, 30)
    expect(label()).not.includes('Chat')
    await render(inbox(false))
    await scrollFrom(scroll, 20)
    expect(label()).includes('Chat')
  })

  it('shares visual keyboard clearance with navigation through scroll, zoom and rotation', async function () {
    const saved = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const visual = Object.assign(new window.EventTarget(), {
      height: 844,
      width: 390,
      scale: 1,
      offsetTop: 0
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visual
    })
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 844
    })
    let measures = 0
    function Probe(): React.ReactElement {
      const viewport = useChatViewport({ composer: 52 })
      const { frame, measure } = viewport
      useEffect(() => {
        Object.defineProperty(frame.current!, 'measureInWindow', {
          configurable: true,
          value: (
            report: (
              x: number,
              y: number,
              width: number,
              height: number
            ) => void
          ) => {
            measures++
            report(0, 0, 390, 844)
          }
        })
        measure()
      }, [frame, measure])
      return (
        <>
          <textarea data-testid="keyboard-input" />
          <ChatViewport viewport={viewport}>
            <span data-testid="visual-bottom">{viewport.composerBottom}</span>
          </ChatViewport>
          <AppNav selected="chat" mode="floating" onSelect={() => {}} />
        </>
      )
    }
    try {
      const node = await render(<Probe />)
      expect(node.querySelector('[role="tablist"]')).not.equals(null)
      await act(async () => {
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: 700
        })
        visual.height = 700
        window.dispatchEvent(new window.Event('resize'))
      })
      expect(node.querySelector('[role="tablist"]')).not.equals(null)
      await act(async () => {
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: 844
        })
        visual.height = 844
        window.dispatchEvent(new window.Event('resize'))
        node.querySelector<HTMLTextAreaElement>('textarea')!.focus()
      })
      await act(async () => {
        visual.height = 500
        visual.dispatchEvent(new window.Event('resize'))
      })
      expect(
        node.querySelector('[data-testid="visual-bottom"]')?.textContent
      ).equals('352')
      expect(node.querySelector('[role="tablist"]')).equals(null)
      const beforeScroll = measures
      await act(async () => {
        visual.offsetTop = 100
        visual.dispatchEvent(new window.Event('scroll'))
      })
      expect(measures).greaterThan(beforeScroll)
      expect(
        node.querySelector('[data-testid="visual-bottom"]')?.textContent
      ).equals('252')
      await act(async () => {
        visual.offsetTop = 0
        visual.height = 422
        visual.scale = 2
        visual.dispatchEvent(new window.Event('resize'))
      })
      expect(node.querySelector('[role="tablist"]')).not.equals(null)
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', {
          configurable: true,
          value: 844
        })
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: 390
        })
        visual.height = 390
        visual.scale = 1
        window.dispatchEvent(new window.Event('resize'))
      })
      expect(node.querySelector('[role="tablist"]')).not.equals(null)
      await act(async () => {
        root?.unmount()
        root = undefined
      })
      const afterUnmount = measures
      visual.dispatchEvent(new window.Event('resize'))
      expect(measures).equals(afterUnmount)
    } finally {
      for (const [key, descriptor] of [
        ['visualViewport', saved],
        ['innerWidth', width],
        ['innerHeight', height]
      ] as const) {
        if (descriptor == null) Reflect.deleteProperty(window, key)
        else Object.defineProperty(window, key, descriptor)
      }
    }
  })

  it('uses settled tablet guide geometry for the readable area and clears it after dismissal', async function () {
    let current: ReturnType<typeof useChatViewport>
    function Probe(): React.ReactElement {
      current = useChatViewport({ composer: 52 })
      return (
        <ChatViewport viewport={current}>
          <span />
        </ChatViewport>
      )
    }
    await render(<Probe />)
    await act(async () => {
      current.onTabletKeyboardRest(427)
    })
    expect(current!.softwareKeyboardOpen).equals(true)
    expect(current!.composerBottom).equals(435)
    await act(async () => {
      current.onTabletKeyboardRest(427)
    })
    await act(async () => {
      current.onTabletKeyboardRest(0)
    })
    expect(current!.softwareKeyboardOpen).equals(false)
  })

  it('measures the complete phone tab-bar clearance inside the full list scroll frame', async function () {
    const item = chat()
    const node = await render(
      <HeaderSlotProvider
        headerHeight={64}
        navigationHeight={76}
        onHandoff={() => {}}
      >
        <ChatListScreen
          embedded
          engine={{
            refresh: async () => [item],
            conversations: () => [item],
            subscribe: () => () => {}
          }}
          onOpen={() => {}}
          onNewMessage={() => {}}
        />
      </HeaderSlotProvider>
    )
    const scroll = node.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-list"]'
    )!
    const content = scroll.firstElementChild!
    expect(getComputedStyle(content).paddingTop).equals('80px')
    expect(getComputedStyle(content).paddingBottom).equals(
      `${76 + NAV_BOTTOM_GAP + 32}px`
    )
    expect(getComputedStyle(scroll).overflowY).equals('auto')
    expect(
      scroll.querySelector('[data-testid="chat-conversation-' + item.id + '"]')
    ).not.equals(null)
  })

  it('opts a self-scrolling screen into the physical frame while preserving ordinary screen padding', async function () {
    const shell = (overlay: boolean): React.ReactElement => (
      <HeaderSlotProvider
        headerHeight={64}
        navigationHeight={76}
        onHandoff={() => {}}
      >
        <Screen scroll={false} overlayContent={overlay}>
          <div data-testid="body" />
        </Screen>
      </HeaderSlotProvider>
    )
    let node = await render(shell(true))
    expect(
      node.querySelector('[data-testid="body"]')!.parentElement!.style
        .paddingTop
    ).equals('')
    node = await render(shell(false))
    const frame = node.querySelector('[data-testid="body"]')!.parentElement!
      .parentElement!
    expect(frame.style.paddingTop).equals('64px')
  })

  it('reports actual navigation height and opts only requested header identities into larger text height', async function () {
    const heights: number[] = []
    let node = await render(
      <AppNav
        selected="chat"
        mode="floating"
        onSelect={() => {}}
        onHeight={height => heights.push(height)}
      />
    )
    const navigation = node.querySelector<
      HTMLElement & {
        __reactLayoutHandler: (event: unknown) => void
      }
    >('[role="tablist"]')!
    await act(async () => {
      navigation.__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 76 } }
      })
    })
    expect(heights).deep.equals([76])
    node = await render(<AppHeader title="Chats" contentHeight={72} />)
    expect((node.firstElementChild as HTMLElement).style.height).equals('72px')
    node = await render(<AppHeader title="Home" />)
    expect((node.firstElementChild as HTMLElement).style.height).equals('48px')
  })

  it('measures keyboard overlap against the current frame and releases event ownership on unmount', async function () {
    const originalListener = Object.getOwnPropertyDescriptor(
      Keyboard,
      'addListener'
    )
    const handlers = new Map<
      string,
      (event: { endCoordinates: { screenY: number } }) => void
    >()
    Object.defineProperty(Keyboard, 'addListener', {
      configurable: true,
      value: (
        name: string,
        callback: (event: { endCoordinates: { screenY: number } }) => void
      ) => {
        handlers.set(name, callback)
        return {
          remove: () => {
            handlers.delete(name)
          }
        }
      }
    })
    function Probe(): React.ReactElement {
      const viewport = useChatViewport({ composer: 52 })
      const { frame, measure } = viewport
      useEffect(() => {
        Object.defineProperty(frame.current!, 'measureInWindow', {
          configurable: true,
          value: (
            report: (
              x: number,
              y: number,
              width: number,
              height: number
            ) => void
          ) => {
            report(0, 0, 390, 844)
          }
        })
        measure()
      }, [frame, measure])
      return (
        <ChatViewport viewport={viewport}>
          <span data-testid="composer-bottom">{viewport.composerBottom}</span>
        </ChatViewport>
      )
    }
    try {
      const node = await render(
        <HeaderSlotProvider
          headerHeight={48}
          navigationHeight={72}
          onHandoff={() => {}}
        >
          <Probe />
        </HeaderSlotProvider>
      )
      const show = [...handlers].find(([name]) => name.endsWith('Show'))![1]
      const hide = [...handlers].find(([name]) => name.endsWith('Hide'))![1]
      await act(async () => {
        show({ endCoordinates: { screenY: 500 } })
      })
      expect(
        node.querySelector('[data-testid="composer-bottom"]')!.textContent
      ).equals('352')
      await act(async () => {
        hide({ endCoordinates: { screenY: 844 } })
      })
      expect(
        node.querySelector('[data-testid="composer-bottom"]')!.textContent
      ).equals(String(72 + NAV_BOTTOM_GAP + 16))
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      expect(handlers.size).equals(0)
    } finally {
      if (originalListener == null)
        Reflect.deleteProperty(Keyboard, 'addListener')
      else Object.defineProperty(Keyboard, 'addListener', originalListener)
    }
  })

  for (const os of ['ios', 'android'] as const)
    it(`fills only the vacated keyboard area with the ${os} attachment panel`, async function () {
      const originalOS = Platform.OS
      const originalListener = Keyboard.addListener.bind(Keyboard)
      const originalGet = Dimensions.get.bind(Dimensions)
      const handlers = new Map<
        string,
        (event: {
          endCoordinates: { screenY: number; width: number; height: number }
        }) => void
      >()
      const size = { width: 390, height: 844, scale: 1, fontScale: 1 }
      const normalBand = { composer: 0, measuredDrawer: 0, paneHeader: 0 }
      let measureBand: (band: typeof normalBand) => void
      let frameHeight = 844
      let refresh: () => void = () => {}
      let nativeKeyboardEnded: (() => void) | undefined
      function Probe(): React.ReactElement {
        const [handoffWidth, setHandoffWidth] = useState<number>()
        const [band, setBand] = useState(normalBand)
        measureBand = setBand
        const viewport = useChatViewport({
          ...band,
          attachmentPanel: true,
          handoffWidth
        })
        nativeKeyboardEnded = viewport.keyboardReturnSettled
        const handleReturnToKeyboard = viewport.returnToKeyboard
        useEffect(() => {
          Object.defineProperty(viewport.frame.current!, 'measureInWindow', {
            configurable: true,
            value: (
              read: (
                x: number,
                y: number,
                width: number,
                height: number
              ) => void
            ) => {
              read(0, 0, size.width, frameHeight)
            }
          })
          refresh = viewport.measure
          refresh()
        }, [viewport.measure, viewport.frame])
        return (
          <ChatViewport viewport={viewport}>
            <button onClick={handleReturnToKeyboard}>Return to keyboard</button>
            <button
              onClick={() => {
                setHandoffWidth(viewport.dockedKeyboardWidth)
              }}
            >
              Use keyboard dock
            </button>
            <span data-testid="dock-bottom">{viewport.composerBottom}</span>
            <span data-testid="returning">
              {String(viewport.returningToKeyboard)}
            </span>
            <span data-testid="drawer">{viewport.attachmentPanelHeight}</span>
          </ChatViewport>
        )
      }
      try {
        Platform.OS = os
        Dimensions.get = () => size
        Keyboard.addListener = (name, handler) => {
          handlers.set(
            name,
            handler as (event: {
              endCoordinates: { screenY: number; width: number; height: number }
            }) => void
          )
          return {
            remove: () => {
              handlers.delete(name)
            }
          }
        }
        const node = await render(<Probe />)
        const height = (): number =>
          Number(node.querySelector('[data-testid="drawer"]')!.textContent)
        expect(height()).equals(260)
        // The app can start in a short split-screen frame on a full-size display.
        await act(async () => {
          frameHeight = 400
          refresh()
        })
        expect(height()).equals(260)
        await act(async () => {
          frameHeight = 844
          refresh()
        })
        const event = (
          y: number,
          w: number,
          h: number
        ): {
          endCoordinates: { screenY: number; width: number; height: number }
        } => ({
          endCoordinates: { screenY: y, width: w, height: h }
        })
        const show = [...handlers].find(([key]) => key.endsWith('Show'))![1]
        const hide = [...handlers].find(([key]) => key.endsWith('Hide'))![1]
        await act(async () => {
          show(event(530, 390, 314))
        })
        expect(height()).equals(0)
        await act(async () => {
          frameHeight = 660
          refresh()
          hide(event(844, 390, 0))
        })
        expect(height()).equals(130)
        // Resizing the app after dismissal keeps the keyboard's height, but
        // moves the dock to the new bottom even when the width is unchanged.
        // In the shorter frame the header and conversation keep 112 points.
        for (const [appHeight, panelHeight] of [
          [400, 288],
          [650, 314]
        ]) {
          await act(async () => {
            size.height = appHeight
            frameHeight = appHeight
            refresh()
          })
          expect(height()).equals(panelHeight)
        }
        await act(async () => {
          size.height = frameHeight = 320
          measureBand({ composer: 136, measuredDrawer: 0, paneHeader: 56 })
          refresh()
        })
        // The shell and pane headers consume 104 points. The tall draft,
        // composer inset and panel gap must fit above the attachment choices.
        expect(height()).equals(68)
        await act(async () => {
          measureBand({ composer: 208, measuredDrawer: 72, paneHeader: 56 })
        })
        expect(height()).equals(68)
        await act(async () => {
          measureBand(normalBand)
          size.height = 844
          frameHeight = 844
          refresh()
        })
        expect(height()).equals(314)
        await act(async () => {
          show(event(280, 190, 120))
        })
        expect(height()).equals(314)
        await act(async () => {
          node.querySelector('button')!.click()
        })
        const returning = (): string | null =>
          node.querySelector('[data-testid="returning"]')!.textContent
        expect(returning()).equals('true')
        // A hardware keyboard can keep focus without a software show event.
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 550))
        })
        expect(returning()).equals('false')
        // Starting from a docked system keyboard holds the field at its previous
        // height even when hide and show notifications arrive on different frames.
        await act(async () => {
          show(event(530, 390, 314))
        })
        const dockBottom = (): number =>
          Number(node.querySelector('[data-testid="dock-bottom"]')!.textContent)
        const initial = dockBottom()
        await act(async () => {
          node.querySelectorAll('button')[1].click()
        })
        const panel = height()
        expect(panel).to.be.greaterThan(300)
        expect(dockBottom() + panel + 4).equals(initial)
        await act(async () => {
          hide(event(844, 390, 0))
        })
        expect(height()).equals(panel)
        expect(dockBottom() + height() + 4).equals(initial)
        await act(async () => {
          node.querySelector('button')!.click()
        })
        await act(async () => {
          show(event(530, 390, 314))
        })
        expect(
          returning(),
          'the dock stays occupied until the keyboard animation ends'
        ).equals('true')
        await act(async () => {
          if (os === 'ios')
            handlers.get('keyboardDidShow')!(event(530, 390, 314))
          else nativeKeyboardEnded!()
        })
        expect(returning()).equals('false')
        if (os === 'android') {
          // Some phones deliver the controller end before RN measures the IME.
          await act(async () => {
            hide(event(844, 390, 0))
          })
          await act(async () => {
            node.querySelector('button')!.click()
          })
          await act(async () => {
            nativeKeyboardEnded!()
            await new Promise(resolve => setTimeout(resolve, 550))
          })
          expect(returning(), 'wait for the new keyboard bounds').equals('true')
          await act(async () => {
            show(event(530, 390, 314))
          })
          expect(returning()).equals('false')
        }
      } finally {
        Platform.OS = originalOS
        Dimensions.get = originalGet
        Keyboard.addListener = originalListener
      }
    })
  it('shows one accessible two-line identity for groups and DMs and opens information through the full hit area', async function () {
    let opened = 0
    const group = chat({ scopeName: 'Harbor', memberCount: 99 })
    let node = await render(
      <ChatConversationIdentity
        conversation={group}
        onPress={() => {
          opened += 1
        }}
      />
    )
    const identity = node.querySelector<HTMLElement>(
      '[aria-label="Harbor, Team Members"]'
    )!
    expect(identity).not.equals(null)
    expect(identity.textContent)
      .contains('Harbor')
      .and.contains('Team Members')
      .and.not.contains('99')
    expect(
      identity.getAttribute('aria-description') ??
        identity.getAttribute('aria-describedby') ??
        identity.getAttribute('aria-label')
    ).a('string')
    await act(async () => {
      identity.click()
    })
    expect(opened).equals(1)
    node = await render(
      <ChatConversationIdentity
        conversation={chat({ kind: 'dm', scope: null, title: 'Aaron Judge' })}
        onPress={() => {}}
      />
    )
    expect(
      node.querySelector('[aria-label="Aaron Judge, Direct message"]')
    ).not.equals(null)
  })

  it('gives the open Android attachment panel the scene back action and restores the input', async function () {
    const original = Platform.OS
    try {
      Platform.OS = 'android'
      let back: (() => void) | null = null
      let resumed = 0
      const node = await render(
        <HeaderSlotProvider
          headerHeight={48}
          onHandoff={() => {}}
          onBackOverride={handler => {
            back = handler
          }}
        >
          <Composer
            text="Practice"
            onText={() => {}}
            enabled
            sending={false}
            context={undefined}
            onCancelContext={() => {}}
            attachments={[]}
            onRemoveAttachment={() => {}}
            sources={['photos', 'camera', 'files']}
            onAttach={() => {}}
            onSend={() => {}}
            returnToKeyboard={() => {
              resumed++
            }}
          />
        </HeaderSlotProvider>
      )
      const input = node.querySelector<HTMLTextAreaElement>('textarea')!
      await act(async () => {
        node.querySelector<HTMLElement>('[aria-label="Attach"]')!.click()
      })
      expect(
        node.querySelector('[data-testid="chat-attachment-panel"]')
      ).not.equals(null)
      expect(back).to.be.a('function')
      await act(async () => {
        back?.()
      })
      expect(back).equals(null)
      expect(resumed).equals(1)
      expect(document.activeElement).equals(input)
      expect(input.value).equals('Practice')
      expect(
        node.querySelector('[data-testid="chat-attachment-panel"]')
      ).equals(null)
    } finally {
      Platform.OS = original
    }
  })
  it('registers a synchronous reusable focus action and never focuses a disabled or merely updated draft', async function () {
    let focus: (() => void) | undefined
    const register = (next: () => void) => {
      focus = next
      return () => {
        focus = undefined
      }
    }
    const props: ComposerProps = {
      text: 'Saved text',
      onText: () => {},
      enabled: true,
      sending: false,
      context: undefined,
      onCancelContext: () => {},
      attachments: [],
      onRemoveAttachment: () => {},
      sources: [],
      onAttach: () => {},
      onSend: () => {},
      registerFocus: register
    }
    await render(<Composer {...props} />)
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    expect(document.activeElement).not.equals(input)
    let calls = 0
    const actual = input.focus.bind(input)
    input.focus = () => {
      calls += 1
      actual()
    }
    focus!()
    focus!()
    expect(calls).equals(2)
    expect(document.activeElement).equals(input)
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    await render(<Composer {...props} text="Restored draft" />)
    expect(document.activeElement).equals(elsewhere)
    await render(<Composer {...props} enabled={false} />)
    focus!()
    expect(calls).equals(2)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(focus).equals(undefined)
  })

  for (const platform of ['android', 'ios', 'web'] as const)
    it(`brings the ${platform} keyboard back for a focus request on a field already focused`, async function () {
      const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: platform
      })
      try {
        let focus: (() => void) | undefined
        await render(
          <Composer
            text=""
            onText={() => {}}
            enabled
            sending={false}
            context={undefined}
            onCancelContext={() => {}}
            attachments={[]}
            onRemoveAttachment={() => {}}
            sources={[]}
            onAttach={() => {}}
            onSend={() => {}}
            registerFocus={next => {
              focus = next
              return () => {
                focus = undefined
              }
            }}
          />
        )
        const input = host!.querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-composer"]'
        )!
        // The keyboard was hidden with Back; the field kept its focus.
        input.focus()
        const calls: string[] = []
        const blur = input.blur.bind(input)
        const refocus = input.focus.bind(input)
        input.blur = () => {
          calls.push('blur')
          blur()
        }
        input.focus = () => {
          calls.push('focus')
          refocus()
        }
        focus!()
        expect(calls).deep.equals(
          platform === 'android' ? ['blur', 'focus'] : ['focus']
        )
        expect(document.activeElement).equals(input)
      } finally {
        Object.defineProperty(Platform, 'OS', saved)
      }
    })

  it('hands a selected narrow conversation to shell glass, focuses every explicit Reply, and clears stale identity on pane hiding', async function () {
    let shown = view({
      messages: [
        message({ senderName: 'Aaron Judge', body: 'Synthetic message' })
      ]
    })
    const listeners = new Set<ChatEngineListener>()
    const emit = (event: ChatEngineEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const engine: ChatScreenEngine = {
      start: async () => 'ready',
      refresh: async () => [shown.conversation],
      conversations: () => [shown.conversation],
      subscribe: listener => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      open: async () => shown,
      close: () => {},
      view: () => shown,
      loadEarlier: async () => shown,
      sendText: async () => undefined,
      attach: async () => undefined,
      react: async () => {},
      edit: async () => {},
      deleteMessage: async () => {},
      moderatorDelete: async () => {},
      report: async () => ({ id: 'crp_fixture', verified: true }),
      markRead: async () => {},
      typing: () => true,
      openAttachment: async () => new Uint8Array(),
      approvals: () => [],
      approve: async () => {},
      fillGrants: async () => 0,
      safetyNumber: async () => undefined
    }
    let members = 0
    function Shell(props: {
      active: boolean
      pane?: boolean
    }): React.ReactElement {
      const [handoff, setHandoff] = useState<React.ReactNode>(null)
      const [height, setHeight] = useState(0)
      return (
        <HeaderSlotProvider
          headerHeight={48}
          navigationHeight={72}
          onHandoff={setHandoff}
          onHandoffHeight={setHeight}
        >
          <AppHeader title="Chats" handoff={handoff} contentHeight={height} />
          <ConversationScreen
            engine={engine}
            userId={userIdOfGumbo(1)}
            conversationId={shown.conversation.id}
            active={props.active}
            paneHeader={props.pane}
            onMembers={() => {
              members += 1
            }}
            embedded
            swipe={false}
          />
        </HeaderSlotProvider>
      )
    }
    const node = await render(<Shell active />)
    const identity = node.querySelector<HTMLElement>(
      '[aria-label="Hawks, Team Members"]'
    )!
    expect(identity).not.equals(null)
    expect(node.querySelector('[aria-label="Members"]')).equals(null)
    expect(node.querySelector('[aria-label="Conversation actions"]')).equals(
      null
    )
    await act(async () => {
      identity.click()
    })
    expect(members).equals(1)
    const input = node.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    const reply = node.querySelector<HTMLElement>('[aria-label="Reply"]')!
    expect(reply).not.equals(null)
    await act(async () => {
      reply.click()
    })
    expect(document.activeElement).equals(input)
    expect(node.textContent).contains('Replying to Aaron Judge')
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    await act(async () => {
      reply.click()
    })
    expect(document.activeElement).equals(input)
    elsewhere.focus()
    await act(async () => {
      shown = {
        ...shown,
        typing: [{ userId: userIdOfGumbo(2), name: 'Aaron Judge' }]
      }
      emit({ type: 'conversation', conversationId: shown.conversation.id })
    })
    expect(document.activeElement).equals(elsewhere)
    await render(<Shell active={false} />)
    expect(node.querySelector('[data-testid="headerHandoff"]')).equals(null)
    expect(
      node.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"]')
        ?.readOnly
    ).equals(true)
    await render(<Shell active pane />)
    expect(node.querySelector('[data-testid="headerHandoff"]')).equals(null)
    expect(node.querySelector('[aria-label="Hawks, Team Members"]')).not.equals(
      null
    )
  })
})
