import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ChatPreferences } from '../../common/api'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatListScreen } from './ChatListScreen'
import { chat, member, message, view } from './chatViews.test.helpers'
import { ChatWorkspace } from './ChatWorkspace'
import { emptyChatDraft, newChatWorkspaceState } from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationListItem, ConversationView } from './engine/engine'
import type { ChatEngineEvent, ChatEngineListener } from './engine/store'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
const originalWidth = Object.getOwnPropertyDescriptor(
  document.documentElement,
  'clientWidth'
)
const originalHeight = Object.getOwnPropertyDescriptor(
  document.documentElement,
  'clientHeight'
)

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  if (originalWidth != null)
    Object.defineProperty(
      document.documentElement,
      'clientWidth',
      originalWidth
    )
  else Reflect.deleteProperty(document.documentElement, 'clientWidth')
  if (originalHeight != null)
    Object.defineProperty(
      document.documentElement,
      'clientHeight',
      originalHeight
    )
  else Reflect.deleteProperty(document.documentElement, 'clientHeight')
  window.dispatchEvent(new window.Event('resize'))
})

const wait = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await wait()
  })
}

function labelled(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[aria-label]')
  ].find(node => node.getAttribute('aria-label') === label)
  expect(found, label).not.equals(undefined)
  return found!
}

function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label ||
      (node.getAttribute('aria-label') == null &&
        node.textContent?.endsWith(label) === true)
  )
  expect(found, label).not.equals(undefined)
  return found!
}

async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await wait()
  })
}

async function type(value: string): Promise<void> {
  const input = labelled('Message') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await wait()
  })
}

function item(
  id: string,
  over: Partial<ConversationListItem> = {}
): ConversationListItem {
  return chat({
    id,
    title: `${id} Members`,
    scopeName: id,
    scope: { type: 'team', id: `tem_${id}` },
    ...over
  })
}

const preferences = (over: Partial<ChatPreferences> = {}): ChatPreferences => ({
  pinned: false,
  muted: false,
  manualUnread: false,
  manualUnreadRevision: 0,
  ...over
})

class FakeEngine implements ChatScreenEngine {
  list: ConversationListItem[] = []
  views = new Map<string, ConversationView>()
  listeners = new Set<ChatEngineListener>()
  opened: string[] = []
  closed: string[] = []
  reads: Array<[string, number | undefined]> = []
  typed: string[] = []
  previews: string[] = []
  failRefresh = false
  failSend = false
  async start(): Promise<'ready'> {
    return 'ready'
  }

  async refresh(): Promise<ConversationListItem[]> {
    if (this.failRefresh) throw new Error('Unavailable')
    return this.list
  }

  conversations(): ConversationListItem[] {
    return this.list
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ChatEngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async open(id: string): Promise<ConversationView> {
    this.opened.push(id)
    const found = this.views.get(id)
    if (found == null) throw new Error('Unavailable')
    return found
  }

  close(id: string): void {
    this.closed.push(id)
  }

  view(id: string): ConversationView | undefined {
    return this.views.get(id)
  }

  async loadEarlier(id: string): Promise<ConversationView> {
    return this.views.get(id)!
  }

  async loadPreview(id: string): Promise<void> {
    this.previews.push(id)
  }

  async sendText(): Promise<undefined> {
    if (this.failSend) throw new Error('Unavailable')
    return undefined
  }

  async attach(): Promise<undefined> {
    if (this.failSend) throw new Error('Unavailable')
    return undefined
  }

  async react(): Promise<void> {}
  async edit(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async moderatorDelete(): Promise<void> {}
  async report(): Promise<{ id: string; verified: boolean }> {
    return { id: 'crp_fixture', verified: true }
  }

  async markRead(id: string, revision?: number): Promise<void> {
    this.reads.push([id, revision])
  }

  typing(id: string): boolean {
    this.typed.push(id)
    return true
  }

  async openAttachment(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  approvals(): [] {
    return []
  }

  async approve(): Promise<void> {}
  async fillGrants(): Promise<number> {
    return 0
  }

  async safetyNumber(): Promise<undefined> {
    return undefined
  }

  async setPreferences(
    id: string,
    patch: Partial<Pick<ChatPreferences, 'pinned' | 'muted' | 'manualUnread'>>
  ): Promise<void> {
    const current = this.views.get(id)
    const previous = current?.conversation.preferences ?? preferences()
    const next = preferences({
      ...previous,
      ...patch,
      manualUnreadRevision:
        previous.manualUnreadRevision + (patch.manualUnread === true ? 1 : 0)
    })
    if (current != null)
      this.views.set(id, {
        ...current,
        conversation: { ...current.conversation, preferences: next }
      })
    this.list = this.list.map(chat =>
      chat.id === id ? { ...chat, preferences: next } : chat
    )
    this.emit({ type: 'conversation', conversationId: id })
    this.emit({ type: 'conversations' })
  }

  add(
    conversation: ConversationListItem,
    over: Partial<ConversationView> = {}
  ): void {
    this.list.push(conversation)
    this.views.set(
      conversation.id,
      view({
        conversation,
        members: [member(1, 'Trea Turner'), member(2, 'Mookie Betts')],
        ...over
      })
    )
  }
}

function list(
  engine: FakeEngine,
  extra: Partial<React.ComponentProps<typeof ChatListScreen>> = {}
): React.ReactElement {
  return (
    <ChatListScreen
      engine={engine}
      embedded
      narrow
      onOpen={() => {}}
      onNewMessage={() => {}}
      onFollowTeam={() => {}}
      {...extra}
    />
  )
}

async function layout(
  node: HTMLElement,
  width: number,
  height = 700
): Promise<void> {
  const onLayout = (
    node as HTMLElement & { __reactLayoutHandler?: (event: unknown) => void }
  ).__reactLayoutHandler
  expect(onLayout, 'React Native measured layout handler').not.equals(undefined)
  await act(async () => {
    onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width, height } } })
    await wait()
  })
}

describe('chat UI follow-up list views', function () {
  it('renders scope pills, direct titles, local previews and statuses without activating a chat', async function () {
    const engine = new FakeEngine()
    engine.list = [
      item('Aurora', {
        locked: true,
        preview: 'Do not reveal this note',
        unread: 2,
        closed: true,
        preferences: preferences({ muted: true, pinned: true })
      }),
      item('Solstice', {
        kind: 'dm',
        scope: null,
        title: 'Mookie Betts',
        preview: 'Bring water',
        avatarUrl: 'https://media.example.test/avatar.png',
        preferences: preferences({ manualUnread: true })
      }),
      item('Comet', {
        kind: 'seasonStaff',
        scope: { type: 'season', id: 'sea_comet' },
        lastSeq: 4
      }),
      item('Meteor', { kind: 'dm', scope: null, title: 'Trea Turner' })
    ]
    await render(list(engine))
    const text = document.body.textContent ?? ''
    expect(text).contains('Pinned').and.contains('Chats')
    expect(text).contains('Team Members').and.contains('Season Staff')
    expect(text)
      .contains('Bring water')
      .and.not.contains('Do not reveal this note')
    expect(text).contains(lstrings.chat_locked_message)
    expect(text).contains(lstrings.chat_latest_loading)
    expect(text).contains(lstrings.chat_no_messages)
    expect(text).contains('Muted').and.contains('Closed')
    expect(document.querySelector('[aria-label="2 unread"]')).not.equals(null)
    expect(
      document.querySelector(
        `[aria-label="${lstrings.chat_manual_unread_label}"]`
      )
    ).not.equals(null)
    expect(engine.opened).deep.equals([])
    expect(engine.reads).deep.equals([])
  })

  it('shows loading, a useful empty state, and a failed refresh without a false empty claim', async function () {
    const engine = new FakeEngine()
    let resolve: ((items: ConversationListItem[]) => void) | undefined
    engine.refresh = async () =>
      await new Promise(_resolve => {
        resolve = _resolve
      })
    await render(list(engine))
    expect(document.body.textContent).contains(lstrings.common_loading)
    await act(async () => {
      resolve?.([])
      await wait()
    })
    expect(document.body.textContent).contains(lstrings.chat_empty)
    expect(document.body.textContent).contains(lstrings.chat_empty_detail)
    const failed = new FakeEngine()
    failed.failRefresh = true
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await render(list(failed))
    expect(document.body.textContent).contains(lstrings.chat_cannot_load)
    expect(document.body.textContent).not.contains(lstrings.chat_empty)
  })

  it('opens rows and top actions, and dismisses a menu if its conversation disappears', async function () {
    const engine = new FakeEngine()
    engine.list = [item('Aurora')]
    const opened: string[] = []
    let newMessage = 0
    let follows = 0
    await render(
      list(engine, {
        selectedId: 'Aurora',
        onOpen: chat => {
          opened.push(chat.id)
        },
        onNewMessage: () => {
          newMessage += 1
        },
        onFollowTeam: () => {
          follows += 1
        }
      })
    )
    await press('Aurora Members')
    await press('New message')
    await press('Follow a team')
    expect(opened).deep.equals(['Aurora'])
    expect(newMessage).equals(1)
    expect(follows).equals(1)
    await press('Conversation actions: Aurora Members')
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).not.equals(null)
    await act(async () => {
      engine.list = []
      engine.emit({ type: 'conversations' })
      await wait()
    })
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
  })

  it('announces another known conversation while excluding the selected conversation and unknown IDs', async function () {
    const engine = new FakeEngine()
    engine.list = [item('Aurora'), item('Solstice')]
    await render(list(engine, { selectedId: 'Aurora' }))
    await act(async () => {
      engine.emit({ type: 'messageAlert', conversationId: 'Aurora' })
      engine.emit({ type: 'messageAlert', conversationId: 'missing' })
      await wait()
    })
    expect(document.body.textContent).not.contains('New message in')
    await act(async () => {
      engine.emit({ type: 'messageAlert', conversationId: 'Solstice' })
      await wait()
    })
    expect(document.body.textContent).contains('Solstice')
    expect(
      [...document.querySelectorAll('[aria-live="polite"]')].some(
        node => node.textContent?.includes('Solstice') === true
      )
    ).equals(true)
  })
})

describe('chat UI follow-up workspace', function () {
  it('restores list and message offsets and remembers later user scrolling', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora'))
    const state = newChatWorkspaceState()
    state.listOffset = 35
    state.drafts.set('Aurora', { ...emptyChatDraft(), scrollOffset: 80 })
    await render(
      <ChatWorkspace
        engine={engine}
        userId={1}
        state={state}
        conversationId="Aurora"
        onOpen={() => {}}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
        onTitle={() => {}}
      />
    )
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200
    )
    const listPane = document.querySelector('[data-testid="chat-list-pane"]')!
    const messagePane = document.querySelector(
      '[data-testid="chat-message-pane"]'
    )!
    const scrollable = (pane: Element): HTMLElement => {
      const found = [...pane.querySelectorAll<HTMLElement>('div')].find(
        node => getComputedStyle(node).overflowY === 'auto'
      )
      expect(found, 'scrollable pane').not.equals(undefined)
      return found!
    }
    const listScroll = scrollable(listPane)
    const messageScroll = scrollable(messagePane)
    const listMoves: number[] = []
    const messageMoves: number[] = []
    listScroll.scroll = options => {
      listMoves.push((options as ScrollToOptions).top ?? 0)
    }
    messageScroll.scroll = options => {
      messageMoves.push((options as ScrollToOptions).top ?? 0)
    }
    await layout(listScroll, 320, 400)
    await layout(messageScroll.firstElementChild as HTMLElement, 880, 900)
    expect(listMoves).contains(35)
    expect(messageMoves).contains(80)
    await act(async () => {
      listScroll.scrollTop = 120
      messageScroll.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
      messageScroll.scrollTop = 240
      listScroll.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      messageScroll.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(150)
    })
    expect(state.listOffset).equals(120)
    expect(state.drafts.get('Aurora')?.scrollOffset).equals(240)
  })

  it('keeps text, reply, prepared files and the same conversation instance across measured pane resizing and switching', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora'), {
      messages: [message({ senderName: 'Mookie Betts', body: 'Bring water' })]
    })
    engine.add(item('Solstice'))
    const state = newChatWorkspaceState()
    state.listOffset = 35
    state.drafts.set('Aurora', {
      ...emptyChatDraft(),
      text: 'Meet at the field',
      replyTo: message({ senderName: 'Mookie Betts', body: 'Bring water' }),
      picked: [
        {
          bytes: new Uint8Array([1, 2]),
          contentType: 'text/plain',
          fileName: 'notes.txt'
        }
      ],
      scrollOffset: 80
    })
    const opened: string[] = []
    const titles: string[] = []
    const workspace = (conversationId?: string): React.ReactElement => (
      <ChatWorkspace
        engine={engine}
        userId={1}
        state={state}
        conversationId={conversationId}
        onOpen={chat => {
          opened.push(chat.id)
        }}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
        onTitle={(_id, title) => {
          titles.push(title)
        }}
      />
    )
    await render(workspace('Aurora'))
    const field = labelled('Message') as HTMLTextAreaElement
    expect(field.value).equals('Meet at the field')
    expect(document.body.textContent)
      .contains('Replying to Mookie Betts')
      .and.contains('notes.txt')
    await type('Meet near the gate')
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200
    )
    const beforeOpens = engine.opened.length
    await layout(document.querySelector('[data-testid="chat-workspace"]')!, 320)
    expect(labelled('Message')).equals(field)
    expect(engine.opened.length).equals(beforeOpens)
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
        .style.display
    ).equals('none')
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200
    )
    expect(labelled('Message')).equals(field)
    expect(state.drafts.get('Aurora')?.text).equals('Meet near the gate')
    expect(state.drafts.get('Aurora')?.picked[0].fileName).equals('notes.txt')
    expect(state.drafts.get('Aurora')?.replyTo?.body).equals('Bring water')
    expect(state.drafts.get('Aurora')?.scrollOffset).equals(80)
    await press('Solstice Members')
    expect(opened).deep.equals(['Solstice'])
    await render(workspace('Solstice'))
    expect((labelled('Message') as HTMLTextAreaElement).value).equals('')
    expect(document.body.textContent).not.contains('Replying to Mookie Betts')
    await type('A separate draft')
    await render(workspace('Aurora'))
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Meet near the gate'
    )
    expect(document.body.textContent).contains('notes.txt')
    expect(state.drafts.get('Solstice')?.text).equals('A separate draft')
    expect(engine.closed).contains('Aurora').and.contains('Solstice')
    expect(titles).contains('Aurora Members')
  })

  it('shows the wide empty pane, remembers a selected chat, and deactivates its hidden narrow pane without losing draft text', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora'))
    const state = newChatWorkspaceState()
    let opened = 0
    const workspace = (conversationId?: string): React.ReactElement => (
      <ChatWorkspace
        engine={engine}
        userId={1}
        state={state}
        conversationId={conversationId}
        onOpen={() => {
          opened += 1
        }}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
        onTitle={() => {}}
      />
    )
    await render(workspace())
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200
    )
    expect(document.body.textContent).contains('Choose a conversation')
    await press('Aurora Members')
    expect(opened).equals(1)
    expect(state.selectedId).equals('Aurora')
    await type('Keep this draft')
    const field = labelled('Message')
    await layout(document.querySelector('[data-testid="chat-workspace"]')!, 320)
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.display
    ).equals('none')
    expect(engine.closed).contains('Aurora')
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200
    )
    expect(labelled('Message')).equals(field)
    expect((field as HTMLTextAreaElement).value).equals('Keep this draft')
    await render(workspace('Aurora'))
    await press('Aurora Members')
    expect(opened).equals(1)
  })
})

describe('chat UI follow-up mounted reading session', function () {
  function screen(engine: FakeEngine, readingSession = 1): React.ReactElement {
    return (
      <ConversationScreen
        engine={engine}
        conversationId="Aurora"
        userId={1}
        embedded
        readingSession={readingSession}
        onMembers={() => {}}
      />
    )
  }

  it('acknowledges an empty conversation explicitly opened with a manual unread revision', async function () {
    const engine = new FakeEngine()
    engine.add(
      item('Aurora', {
        preferences: preferences({
          manualUnread: true,
          manualUnreadRevision: 3
        })
      })
    )
    await render(screen(engine))
    expect(
      engine.reads.some(([, revision]) => revision === 3),
      JSON.stringify(engine.reads)
    ).equals(true)
  })

  it('keeps member counts and personal direct-message titles in the conversation header', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora', { memberCount: 7 }))
    await render(screen(engine))
    expect(document.body.textContent).contains('7 members')
    const direct = new FakeEngine()
    direct.add(
      item('Aurora', {
        kind: 'dm',
        scope: null,
        title: 'Mookie Betts',
        memberCount: 2
      })
    )
    await render(screen(direct))
    expect(document.body.textContent).contains('Mookie Betts')
    expect(document.body.textContent).contains('2 members')
  })

  it('keeps draft text, reply context and prepared files when a send fails', async function () {
    const engine = new FakeEngine()
    engine.failSend = true
    engine.add(item('Aurora'), {
      messages: [
        message({ senderName: 'Mookie Betts', body: 'Practice update' })
      ]
    })
    const state = newChatWorkspaceState()
    state.drafts.set('Aurora', {
      ...emptyChatDraft(),
      text: 'Bring a glove',
      replyTo: message({ senderName: 'Mookie Betts', body: 'Practice update' }),
      picked: [
        {
          bytes: new Uint8Array([1]),
          contentType: 'text/plain',
          fileName: 'notes.txt'
        }
      ]
    })
    await render(
      <ChatWorkspace
        engine={engine}
        userId={1}
        state={state}
        conversationId="Aurora"
        onOpen={() => {}}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
        onTitle={() => {}}
      />
    )
    await press('Send')
    expect(document.body.textContent).contains(lstrings.chat_send_failed)
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Bring a glove'
    )
    expect(document.body.textContent)
      .contains('Replying to Mookie Betts')
      .and.contains('notes.txt')
    expect(state.drafts.get('Aurora')?.text).equals('Bring a glove')
    expect(state.drafts.get('Aurora')?.picked.length).equals(1)
    expect(state.drafts.get('Aurora')?.replyTo?.body).equals('Practice update')
  })

  it('removes plaintext and the composer when the selected conversation is no longer accessible', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora'), {
      messages: [
        message({ senderName: 'Mookie Betts', body: 'Private fixture note' })
      ]
    })
    await render(screen(engine))
    expect(document.body.textContent).contains('Private fixture note')
    await act(async () => {
      engine.views.delete('Aurora')
      engine.list = []
      engine.emit({ type: 'conversations' })
      await wait()
    })
    expect(document.body.textContent).not.contains('Private fixture note')
    expect(document.querySelector('[aria-label="Message"]')).equals(null)
  })

  it('keeps a newly marked unread revision through pane updates and menu-close focus restoration until deliberate reading', async function () {
    const engine = new FakeEngine()
    engine.add(item('Aurora', { preferences: preferences() }), {
      messages: [message({ senderName: 'Mookie Betts', body: 'Bring water' })]
    })
    await render(screen(engine))
    await act(async () => {
      labelled('Message').focus()
      await wait()
    })
    await press('Conversation actions')
    const start = engine.reads.length
    await press('Mark unread')
    expect(
      engine.views.get('Aurora')?.conversation.preferences?.manualUnread
    ).equals(true)
    expect(
      engine.reads.slice(start).every(([, revision]) => revision !== 1),
      'automatic close/refocus must keep the new unread revision'
    ).equals(true)
    const current = engine.views.get('Aurora')!
    await act(async () => {
      engine.views.set('Aurora', {
        ...current,
        messages: [
          ...current.messages,
          message({
            id: 'msg_second',
            seq: 2,
            senderName: 'Trea Turner',
            body: 'See you there'
          })
        ]
      })
      engine.emit({ type: 'conversation', conversationId: 'Aurora' })
      await wait()
    })
    expect(
      engine.reads.slice(start).every(([, revision]) => revision !== 1)
    ).equals(true)
    await type('Thanks')
    expect(engine.reads.at(-1)).deep.equals(['Aurora', 1])
    expect(engine.typed).contains('Aurora')
  })

  it('acknowledges the current manual unread revision when explicitly reselected and never reads an inactive pane', async function () {
    const engine = new FakeEngine()
    engine.add(
      item('Aurora', {
        preferences: preferences({
          manualUnread: true,
          manualUnreadRevision: 4
        })
      }),
      { messages: [message({ senderName: 'Mookie Betts' })] }
    )
    await render(screen(engine))
    expect(
      engine.reads.some(([, revision]) => revision === 4),
      JSON.stringify(engine.reads)
    ).equals(true)
    const current = engine.views.get('Aurora')!
    await act(async () => {
      engine.views.set('Aurora', {
        ...current,
        conversation: {
          ...current.conversation,
          preferences: preferences({
            manualUnread: true,
            manualUnreadRevision: 5
          })
        }
      })
      engine.emit({ type: 'conversation', conversationId: 'Aurora' })
      await wait()
    })
    await render(screen(engine, 2))
    expect(engine.reads.at(-1)).deep.equals(['Aurora', 5])
    const readCount = engine.reads.length
    await render(
      <ConversationScreen
        engine={engine}
        conversationId="Aurora"
        userId={1}
        embedded
        active={false}
        readingSession={3}
        onMembers={() => {}}
      />
    )
    expect(engine.reads.length).equals(readCount)
  })
})
