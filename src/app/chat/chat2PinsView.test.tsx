import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ChatPin } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { HeaderSlotProvider } from '../components/headerSlot'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  measureChatTestViewport,
  message,
  view
} from './chatViews.test.helpers'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import { PinnedMessages } from './PinnedMessages'
import { PinnedMessageSummary } from './PinnedMessageSummary'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
let host: HTMLElement | undefined
let restoreViewport: (() => void) | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  restoreViewport?.()
  restoreViewport = undefined
})
const wait = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 30))
}
async function render(element: React.ReactElement): Promise<HTMLElement> {
  restoreViewport ??= measureChatTestViewport({ width: 390, height: 844 })
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await wait()
  })
  return host!
}
const pinnedAt = '2027-04-01T17:00:00.000Z'
const pin = (id: string): ChatPin => ({ messageId: id, pinnedAt })
function button(label: string): HTMLElement {
  const found = [
    ...host!.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label ||
      (node.getAttribute('aria-label') == null &&
        node.textContent?.endsWith(label) === true)
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await wait()
  })
}
async function layout(node: HTMLElement, height: number): Promise<void> {
  await act(async () => {
    ;(
      node as HTMLElement & { __reactLayoutHandler: (event: unknown) => void }
    ).__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height } }
    })
    await wait()
  })
}
function fixture(initial: ConversationView): {
  engine: ChatScreenEngine
  readonly shown: ConversationView
  setLoad: (work: () => Promise<ConversationView>) => void
  update: (next: ConversationView) => void
} {
  let shown = initial
  const listeners = new Set<ChatEngineListener>()
  let load: () => Promise<ConversationView> = async () => shown
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
    loadEarlier: async () => await load(),
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
  return {
    engine,
    get shown(): ConversationView {
      return shown
    },
    setLoad(work: () => Promise<ConversationView>): void {
      load = work
    },
    update(next: ConversationView): void {
      shown = next
      for (const listener of listeners)
        listener({
          type: 'conversation',
          conversationId: shown.conversation.id
        })
    }
  }
}
const files = {
  PICK_SOURCES: [] as const,
  pickFiles: async () => [],
  bytesUri: async () => 'blob:fixture',
  releaseUri: async () => {},
  saveFile: async () => {}
}

describe('floating personal pin summary', function () {
  it('renders zero, one and many personal pins and routes one directly while many open the ordered list', async function () {
    const jumps: string[] = []
    let opened = 0
    const props = {
      messages: [
        message({ senderName: 'Aaron Judge', body: 'Current excerpt' })
      ],
      onJump: (id: string) => jumps.push(id),
      onOpenList: () => {
        opened += 1
      }
    }
    let node = await render(<PinnedMessageSummary {...props} pins={[]} />)
    expect(node.querySelector('[data-testid="chat-pinned-summary"]')).equals(
      null
    )
    node = await render(
      <PinnedMessageSummary {...props} pins={[pin('msg_1')]} />
    )
    expect(node.textContent)
      .contains('Aaron Judge')
      .and.contains('Current excerpt')
    expect(node.querySelector('[data-testid="chat-pinned-count"]')).equals(null)
    await click(node.querySelector('[data-testid="chat-pinned-summary"]')!)
    expect(jumps).deep.equals(['msg_1'])
    node = await render(
      <PinnedMessageSummary {...props} pins={[pin('msg_b'), pin('msg_1')]} />
    )
    expect(
      node.querySelector('[data-testid="chat-pinned-count"]')!.textContent
    ).equals('2')
    await click(node.querySelector('[data-testid="chat-pinned-summary"]')!)
    expect(opened).equals(1)
    node = await render(
      <PinnedMessageSummary {...props} pins={[pin('msg_1')]} disabled />
    )
    await click(node.querySelector('[data-testid="chat-pinned-summary"]')!)
    expect(jumps).deep.equals(['msg_1'])
  })

  it('shows placeholders from the current view in both summary and list without leaking stale body or sender', async function () {
    const messages = [
      message({
        status: 'locked',
        body: 'Cached private words',
        senderName: 'Aaron Judge'
      })
    ]
    let node = await render(
      <PinnedMessageSummary
        pins={[pin('msg_1')]}
        messages={messages}
        onJump={() => {}}
        onOpenList={() => {}}
      />
    )
    expect(node.textContent)
      .not.contains('Cached private words')
      .and.not.contains('Aaron Judge')
    const jumps: string[] = []
    node = await render(
      <PinnedMessages
        pins={[pin('msg_b'), pin('msg_1')]}
        messages={messages}
        onJump={id => jumps.push(id)}
        onClose={() => {}}
      />
    )
    expect(node.textContent)
      .not.contains('Cached private words')
      .and.not.contains('Aaron Judge')
    const rows = [
      ...node.querySelectorAll<HTMLElement>('[role="button"]')
    ].filter(value => value.getAttribute('aria-label') !== 'Cancel')
    expect(rows[0].getAttribute('data-testid')).equals('chat-pin-msg_1')
    await click(
      node.querySelector<HTMLElement>('[data-testid="chat-pin-msg_1"]')!
    )
    expect(jumps).deep.equals(['msg_1'])
  })

  it('measures its floating band outside the full-height history and removes its clearance on last unpin', async function () {
    const state = fixture(
      view({
        messages: [message({ senderName: 'Aaron Judge' })],
        pins: [pin('msg_1')]
      })
    )
    let preferenceWrites = 0
    state.engine.setPreferences = async () => {
      preferenceWrites += 1
    }
    const node = await render(
      <HeaderSlotProvider
        headerHeight={48}
        navigationHeight={72}
        onHandoff={() => {}}
      >
        <ConversationScreen
          engine={state.engine}
          conversationId="cnv_1"
          userId={userIdOfGumbo(1)}
          onMembers={() => {}}
          files={{ ...files, PICK_SOURCES: [] }}
        />
      </HeaderSlotProvider>
    )
    const band = node.querySelector<HTMLElement>(
      '[data-testid="chat-pinned-band"]'
    )!
    const history = node.querySelector('[data-testid="chat-message-history"]')!
    expect(getComputedStyle(band).position).equals('absolute')
    expect(band.style.top).equals('48px')
    expect(history.contains(band)).equals(false)
    await layout(band, 64)
    expect((history.firstElementChild as HTMLElement).style.paddingTop).equals(
      '128px'
    )
    await act(async () => {
      state.update({ ...state.shown, pins: [pin('msg_1'), pin('msg_b')] })
      await wait()
    })
    expect(
      node.querySelector('[data-testid="chat-pinned-count"]')!.textContent
    ).equals('2')
    await act(async () => {
      state.update({ ...state.shown, pins: [] })
      await wait()
    })
    expect(node.querySelector('[data-testid="chat-pinned-band"]')).equals(null)
    expect((history.firstElementChild as HTMLElement).style.paddingTop).equals(
      '64px'
    )
    expect(preferenceWrites).equals(0)
  })

  it('keeps the reader in place on a failed resolution and ignores a pending target after Cancel', async function () {
    const state = fixture(
      view({
        messages: [message({ id: 'msg_current', seq: 200 })],
        pins: [pin('msg_older')],
        hasEarlier: true,
        historyBefore: 200
      })
    )
    let loads = 0
    let complete: ((next: ConversationView) => void) | undefined
    state.setLoad(async () => {
      loads += 1
      if (loads === 1) throw new Error('Unavailable')
      return await new Promise<ConversationView>(resolve => {
        complete = resolve
      })
    })
    const node = await render(
      <ConversationScreen
        engine={state.engine}
        conversationId="cnv_1"
        userId={userIdOfGumbo(1)}
        onMembers={() => {}}
        files={{ ...files, PICK_SOURCES: [] }}
      />
    )
    const history = node.querySelector('[data-testid="chat-message-history"]')!
    history.scrollTop = 137
    await click(node.querySelector('[data-testid="chat-pinned-summary"]')!)
    expect(loads).equals(1)
    expect(node.textContent).contains('unavailable')
    expect(
      node.querySelector('[data-testid="chat-history-jump-retry"]')
    ).not.equals(null)
    expect(history.scrollTop).equals(137)
    await click(button('Try again'))
    expect(loads).equals(2)
    expect(
      node.querySelector('[data-testid="chat-history-jump-cancel"]')
    ).not.equals(null)
    await click(button('Cancel'))
    const next = {
      ...state.shown,
      hasEarlier: false,
      messages: [message({ id: 'msg_older', seq: 20 }), ...state.shown.messages]
    }
    await act(async () => {
      state.update(next)
      complete?.(next)
      await wait()
    })
    expect(history.scrollTop).equals(137)
    expect(node.textContent).not.contains('Loading…')
  })

  it('does not jump to locked or deleted originals and removes private pin views on membership loss', async function () {
    const state = fixture(
      view({
        messages: [message({ status: 'locked', body: 'Cached private words' })],
        pins: [pin('msg_1')]
      })
    )
    const node = await render(
      <ConversationScreen
        engine={state.engine}
        conversationId="cnv_1"
        userId={userIdOfGumbo(1)}
        onMembers={() => {}}
        files={{ ...files, PICK_SOURCES: [] }}
      />
    )
    await click(node.querySelector('[data-testid="chat-pinned-summary"]')!)
    expect(node.textContent).contains('unavailable')
    expect(button('Try again')).not.equals(undefined)
    expect(node.textContent).not.contains('Cached private words')
    state.engine.view = () => undefined
    await act(async () => {
      state.update(state.shown)
      await wait()
    })
    expect(node.querySelector('[data-testid="chat-pinned-band"]')).equals(null)
    expect(node.querySelector('[data-testid="chat-pinned-summary"]')).equals(
      null
    )
  })
})
