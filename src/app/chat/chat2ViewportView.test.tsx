import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Keyboard, Platform } from 'react-native'

import { userIdOfGumbo } from '../../common/userId'
import { AppHeader } from '../components/AppHeader'
import { AppNav } from '../components/AppNav'
import { HeaderSlotProvider } from '../components/headerSlot'
import { Screen } from '../components/Screen'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatConversationIdentity } from './ChatConversationIdentity'
import { ChatListScreen } from './ChatListScreen'
import { ChatViewport, useChatViewport } from './ChatViewport'
import { chat, message, view } from './chatViews.test.helpers'
import { Composer, type ComposerProps } from './Composer'
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
    expect(getComputedStyle(content).paddingBottom).equals('124px')
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
      ).equals('104')
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
