import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { ChatDropTarget } from './ChatDropTarget'
import { ChatDropTarget as NativeDropTarget } from './ChatDropTarget.native'
import * as browserFiles from './chatFiles'
import type { ChatDropTargetProps, PickedFile } from './chatFileTypes'
import { ChatListScreen } from './ChatListScreen'
import { chat, member, message, view } from './chatViews.test.helpers'
import { ChatWorkspace } from './ChatWorkspace'
import {
  type ChatDraft,
  type ChatWorkspaceState,
  newChatWorkspaceState
} from './chatWorkspaceModel'
import { Composer, type ComposerProps } from './Composer'
import {
  type ConversationFiles,
  ConversationScreen
} from './ConversationScreen'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
const originalPointer = Object.getOwnPropertyDescriptor(
  globalThis,
  'matchMedia'
)
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  if (originalPointer != null)
    Object.defineProperty(globalThis, 'matchMedia', originalPointer)
  else Reflect.deleteProperty(globalThis, 'matchMedia')
})
const wait = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function render(element: React.ReactElement, fine = true): Promise<void> {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: fine })
  })
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
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label || node.textContent === label
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
function input(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!
}
function key(node = input(), over: KeyboardEventInit = {}): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...over
  })
  node.dispatchEvent(event)
  return event
}
async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(input(), value)
    input().dispatchEvent(new window.Event('input', { bubbles: true }))
    await wait()
  })
}
function prepared(fileName = 'notes.pdf'): PickedFile {
  return {
    bytes: new Uint8Array([1]),
    contentType: 'application/pdf',
    fileName
  }
}
function file(name = 'notes.pdf', read?: () => Promise<ArrayBuffer>): File {
  const chosen = new File([new Uint8Array([1])], name, {
    type: 'application/pdf'
  })
  if (read != null) chosen.arrayBuffer = read
  return chosen
}
interface Transfer {
  types: string[]
  items: Array<{ kind: string }>
  files: File[]
  dropEffect: string
}
const transfer = (
  files: File[] = [file()],
  types = ['Files'],
  items: Array<{ kind: string }> = []
): Transfer => ({ files, types, items, dropEffect: 'none' })
function pane(): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    '[data-testid="chat-drop-target"]'
  )!
  found.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 640,
    bottom: 480,
    width: 640,
    height: 480,
    toJSON: () => ({})
  })
  return found
}
async function drag(
  kind: string,
  data: Transfer | null,
  node = pane(),
  over: { relatedTarget?: Node | null; clientX?: number; clientY?: number } = {}
): Promise<Event> {
  const event = new window.Event(kind, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: data },
    relatedTarget: { value: over.relatedTarget ?? null },
    clientX: { value: over.clientX ?? 20 },
    clientY: { value: over.clientY ?? 20 }
  })
  await act(async () => {
    node.dispatchEvent(event)
    await wait()
  })
  return event
}
const overlay = (): HTMLElement | null =>
  document.querySelector('[data-testid="chat-drop-overlay"]')
const dropProps = (
  over: Partial<ChatDropTargetProps> = {}
): ChatDropTargetProps => ({
  children: (
    <>
      <div data-testid="first-child">Messages</div>
      <div data-testid="second-child">Composer</div>
    </>
  ),
  onPrepare: () => {},
  onReject: () => {},
  ...over
})

describe('chat desktop file drop target', function () {
  it('shows one translucent white TeamStation overlay with exact copy for file-only drags', async function () {
    await render(<ChatDropTarget {...dropProps()} />)
    expect((await drag('dragenter', transfer())).defaultPrevented).equals(true)
    expect(overlay()?.textContent).equals('Attaching file to chat')
    expect(
      document.querySelectorAll('[data-testid="chat-drop-overlay"]')
    ).length(1)
    expect(document.querySelector('[aria-label="TeamStation"]')).not.equals(
      null
    )
    expect(getComputedStyle(overlay()!).backgroundColor).equals(
      'rgba(255, 255, 255, 0.82)'
    )
    const data = transfer()
    expect((await drag('dragover', data)).defaultPrevented).equals(true)
    expect(data.dropEffect).equals('copy')
    expect(
      document.querySelectorAll('[data-testid="chat-drop-overlay"]')
    ).length(1)
  })

  it('keeps its overlay while crossing nested children and clears only on leaving the pane', async function () {
    await render(<ChatDropTarget {...dropProps()} />)
    const data = transfer()
    const first = document.querySelector<HTMLElement>(
      '[data-testid="first-child"]'
    )!
    const second = document.querySelector<HTMLElement>(
      '[data-testid="second-child"]'
    )!
    await drag('dragenter', data)
    await drag('dragenter', data, first)
    await drag('dragleave', data, first, { relatedTarget: second })
    expect(overlay()).not.equals(null)
    await drag('dragenter', data, second)
    await drag('dragleave', data, second, { relatedTarget: first })
    expect(overlay()).not.equals(null)
    await drag('dragleave', data, pane(), { clientX: 700 })
    expect(overlay()).equals(null)
    await drag('dragenter', data)
    await drag('dragenter', data, first)
    await drag('dragleave', data, first)
    expect(overlay()).not.equals(null)
    await drag('dragleave', data)
    expect(overlay()).equals(null)
  })

  it('ignores text and link drags and recognizes file items or actual files when types are absent', async function () {
    let preparedCalls = 0
    await render(
      <ChatDropTarget
        {...dropProps({
          onPrepare: () => {
            preparedCalls += 1
          }
        })}
      />
    )
    for (const types of [['text/plain'], ['text/uri-list']]) {
      const data = transfer([], types)
      expect((await drag('dragenter', data)).defaultPrevented).equals(false)
      expect((await drag('dragover', data)).defaultPrevented).equals(false)
      expect((await drag('drop', data)).defaultPrevented).equals(false)
      expect(overlay()).equals(null)
    }
    expect((await drag('dragenter', null)).defaultPrevented).equals(false)
    await drag('dragenter', transfer([], [], [{ kind: 'file' }]))
    expect(overlay()).not.equals(null)
    await drag('drop', transfer([], ['text/plain']))
    expect(overlay()).equals(null)
    await drag('dragenter', transfer([file()], []))
    expect(overlay()).not.equals(null)
    expect(preparedCalls).equals(0)
  })

  it('cancels on Escape, window blur or drag end and detaches every listener on unmount', async function () {
    let preparedCalls = 0
    await render(
      <ChatDropTarget
        {...dropProps({
          onPrepare: () => {
            preparedCalls += 1
          }
        })}
      />
    )
    const target = pane()
    for (const kind of ['Escape', 'blur', 'dragend']) {
      await drag('dragenter', transfer())
      await act(async () => {
        window.dispatchEvent(
          kind === 'Escape'
            ? new window.KeyboardEvent('keydown', { key: kind })
            : new window.Event(kind)
        )
        await wait()
      })
      expect(overlay()).equals(null)
    }
    await drag('dragenter', transfer())
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x' }))
      await wait()
    })
    expect(overlay()).not.equals(null)
    await act(async () => {
      root!.unmount()
      root = undefined
    })
    expect((await drag('drop', transfer(), target)).defaultPrevented).equals(
      false
    )
    expect(preparedCalls).equals(0)
    expect(overlay()).equals(null)
  })

  it('prepares ordered files without sending and rejects blocked drops with current props while preventing navigation', async function () {
    const works: Array<(remaining: number) => Promise<PickedFile[]>> = []
    const rejected: string[] = []
    const props = dropProps({
      onPrepare: work => works.push(work),
      onReject: reason => rejected.push(reason)
    })
    await render(<ChatDropTarget {...props} />)
    expect(
      (await drag('drop', transfer([file('first.pdf'), file('second.pdf')])))
        .defaultPrevented
    ).equals(true)
    expect(works).length(1)
    expect((await works[0](2)).map(chosen => chosen.fileName)).deep.equals([
      'first.pdf',
      'second.pdf'
    ])
    expect(overlay()).equals(null)
    await render(
      <ChatDropTarget
        {...props}
        disabledReason="Attachments are unavailable in this conversation."
      />
    )
    expect((await drag('drop', transfer())).defaultPrevented).equals(true)
    expect(works).length(1)
    expect(rejected).deep.equals([
      'Attachments are unavailable in this conversation.'
    ])
  })

  it('leaves the native pane transparent with no drag or keyboard handlers', async function () {
    let calls = 0
    await render(
      <NativeDropTarget
        {...dropProps({
          children: <div data-testid="native-content">Native content</div>,
          onPrepare: () => {
            calls += 1
          },
          onReject: () => {
            calls += 1
          }
        })}
      />
    )
    const child = document.querySelector<HTMLElement>(
      '[data-testid="native-content"]'
    )!
    expect(
      (await drag('dragenter', transfer(), child)).defaultPrevented
    ).equals(false)
    expect((await drag('drop', transfer(), child)).defaultPrevented).equals(
      false
    )
    expect(overlay()).equals(null)
    expect(document.body.textContent).equals('Native content')
    expect(calls).equals(0)
  })
})

describe('chat composer current send state', function () {
  const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({
    text: 'Draft body',
    enabled: true,
    sending: false,
    context: undefined,
    attachments: [],
    sources: [],
    onText: () => {},
    onCancelContext: () => {},
    onRemoveAttachment: () => {},
    onAttach: () => {},
    onSend: () => {},
    ...over
  })
  it('blocks Enter and Send during preparation or sending, while reading current props after rerender', async function () {
    let sends = 0
    const current = props({
      text: '',
      onSend: () => {
        sends += 1
      }
    })
    await render(<Composer {...current} />)
    await act(async () => {
      key()
      button('Send').click()
      await wait()
    })
    expect(sends).equals(0)
    await render(<Composer {...current} text="Now ready" />)
    await act(async () => {
      key()
      await wait()
    })
    expect(sends).equals(1)
    for (const patch of [
      { preparing: true },
      { sending: true },
      { enabled: false }
    ]) {
      await render(<Composer {...current} text="Now ready" {...patch} />)
      expect(button('Send').getAttribute('aria-disabled')).equals('true')
      await act(async () => {
        key()
        button('Send').click()
        await wait()
      })
      expect(sends).equals(1)
    }
  })

  it('preserves Shift Enter, IME and mobile multiline events without sending', async function () {
    let sends = 0
    await render(
      <Composer
        {...props({
          onSend: () => {
            sends += 1
          }
        })}
      />
    )
    await act(async () => {
      expect(key(input(), { shiftKey: true }).defaultPrevented).equals(false)
      expect(key(input(), { isComposing: true }).defaultPrevented).equals(false)
      expect(key(input(), { keyCode: 229 }).defaultPrevented).equals(false)
      await wait()
    })
    expect(sends).equals(0)
    await render(
      <Composer
        {...props({
          onSend: () => {
            sends += 1
          }
        })}
      />,
      false
    )
    expect(key().defaultPrevented).equals(false)
    expect(sends).equals(0)
  })
})

class FakeEngine implements ChatScreenEngine {
  views = new Map<string, ConversationView>(
    ['cnv_aurora', 'cnv_solstice'].map(id => [
      id,
      view({
        conversation: chat({
          id,
          scopeName: id === 'cnv_aurora' ? 'Aurora' : 'Solstice'
        }),
        members: [member(1, 'Mookie Betts'), member(2, 'Shohei Ohtani')],
        messages: [
          message({ senderName: 'Shohei Ohtani', body: 'Original body' })
        ]
      })
    ])
  )

  listeners = new Set<ChatEngineListener>()
  calls: unknown[] = []
  failSend = false
  sendWork: Promise<void> = Promise.resolve()
  async start(): Promise<'ready'> {
    return 'ready'
  }

  async refresh(): Promise<Array<ReturnType<typeof chat>>> {
    return this.conversations()
  }

  conversations(): Array<ReturnType<typeof chat>> {
    return [...this.views.values()].map(current => current.conversation)
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async open(id: string): Promise<ConversationView> {
    return this.views.get(id)!
  }

  close(): void {}
  view(id: string): ConversationView | undefined {
    return this.views.get(id)
  }

  async loadEarlier(id: string): Promise<ConversationView> {
    return this.views.get(id)!
  }

  async sendText(
    id: string,
    body: string,
    options: unknown
  ): Promise<undefined> {
    this.calls.push(['send', id, body, options])
    await this.sendWork
    if (this.failSend) throw new Error('Unavailable')
    return undefined
  }

  async attach(
    id: string,
    picked: PickedFile[],
    body?: string,
    options?: unknown
  ): Promise<undefined> {
    this.calls.push(['attach', id, picked, body, options])
    await this.sendWork
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

  async markRead(): Promise<void> {}
  typing(): boolean {
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

  update(id: string, over: Partial<ConversationView>): void {
    this.views.set(id, { ...this.views.get(id)!, ...over })
    for (const listener of this.listeners)
      listener({ type: 'conversation', conversationId: id })
  }
}
const files: ConversationFiles = {
  ...browserFiles,
  bytesUri: async () => 'blob:fixture',
  releaseUri: async () => {},
  saveFile: async () => {}
}
async function screen(
  engine: FakeEngine,
  over: Partial<React.ComponentProps<typeof ConversationScreen>> = {}
): Promise<void> {
  const id = over.conversationId ?? 'cnv_aurora'
  await render(
    <ConversationScreen
      key={id}
      engine={engine}
      conversationId={id}
      userId={1}
      onMembers={() => {}}
      files={files}
      swipe={false}
      embedded
      {...over}
    />
  )
}
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let complete!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    complete = resolve
  })
  return { promise, resolve: complete }
}

async function measure(
  node: HTMLElement,
  width: number,
  height: number
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

async function showWorkspace(
  engine: FakeEngine,
  state: ChatWorkspaceState,
  conversationId?: string
): Promise<void> {
  await render(
    <ChatWorkspace
      engine={engine}
      state={state}
      userId={1}
      conversationId={conversationId}
      onOpen={() => {}}
      onMembers={() => {}}
      onNewMessage={() => {}}
      onTitle={() => {}}
    />
  )
  await measure(
    document.querySelector('[data-testid="chat-workspace"]')!,
    320,
    700
  )
}

function captureMessageScroll(): {
  node: HTMLElement
  moves: number[]
  resize: (height: number) => Promise<void>
} {
  const node = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="chat-message-pane"] div'
    )
  ].find(element => getComputedStyle(element).overflowY === 'auto')!
  expect(node, 'conversation scroll view').not.equals(undefined)
  const moves: number[] = []
  let contentHeight = 0
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 320 },
    offsetHeight: { configurable: true, value: 400 },
    offsetWidth: { configurable: true, value: 320 }
  })
  node.scroll = options => {
    const top = (options as ScrollToOptions).top ?? 0
    moves.push(top)
    node.scrollTop = Math.min(
      top,
      Math.max(0, contentHeight - node.clientHeight)
    )
  }
  return {
    node,
    moves,
    resize: async height => {
      contentHeight = height
      await measure(node.firstElementChild as HTMLElement, 320, height)
    }
  }
}

async function scrollEvent(
  node: HTMLElement,
  top: number,
  user = false
): Promise<void> {
  await act(async () => {
    if (user)
      node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
    node.scrollTop = top
    node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    await wait(150)
  })
}

function unreadSessionEngine(): {
  engine: FakeEngine
  reads: Array<[string, number | undefined]>
} {
  const engine = new FakeEngine()
  const screenEngine: ChatScreenEngine = engine
  const reads: Array<[string, number | undefined]> = []
  for (const [id, current] of engine.views)
    engine.views.set(id, {
      ...current,
      conversation: {
        ...current.conversation,
        title: `${current.conversation.scopeName} Members`,
        preferences: {
          pinned: false,
          muted: false,
          manualUnread: false,
          manualUnreadRevision: 0
        }
      }
    })
  screenEngine.markRead = async (id, revision) => {
    reads.push([id, revision])
    const current = engine.views.get(id)!
    const previous = current.conversation.preferences!
    const manualUnread =
      previous.manualUnread && revision !== previous.manualUnreadRevision
    if (
      current.conversation.unread === 0 &&
      manualUnread === previous.manualUnread
    )
      return
    engine.update(id, {
      conversation: {
        ...current.conversation,
        unread: 0,
        preferences: { ...previous, manualUnread }
      }
    })
  }
  screenEngine.setPreferences = async (id, patch) => {
    const current = engine.views.get(id)!
    const previous = current.conversation.preferences!
    engine.update(id, {
      conversation: {
        ...current.conversation,
        preferences: {
          ...previous,
          ...patch,
          manualUnreadRevision:
            previous.manualUnreadRevision +
            (patch.manualUnread === true ? 1 : 0)
        }
      }
    })
    for (const listener of engine.listeners) listener({ type: 'conversations' })
  }
  return { engine, reads }
}

describe('chat read sessions preserve personal unread', function () {
  it('does not read a background document on opening or incoming messages and acknowledges the current revision on visible deliberate typing', async function () {
    const { engine, reads } = unreadSessionEngine()
    const current = engine.views.get('cnv_aurora')!
    engine.update('cnv_aurora', {
      conversation: {
        ...current.conversation,
        unread: 2,
        preferences: {
          ...current.conversation.preferences!,
          manualUnread: true,
          manualUnreadRevision: 7
        }
      }
    })
    const originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      'visibilityState'
    )
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
    let visibility: 'visible' | 'hidden' = 'hidden'
    Object.defineProperties(document, {
      visibilityState: { configurable: true, get: () => visibility },
      hidden: { configurable: true, get: () => visibility === 'hidden' }
    })
    try {
      await screen(engine)
      expect(reads, 'a mounted background document must not read').deep.equals(
        []
      )
      expect(engine.views.get('cnv_aurora')?.conversation.unread).equals(2)
      expect(
        engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread
      ).equals(true)
      await act(async () => {
        const opened = engine.views.get('cnv_aurora')!
        engine.update('cnv_aurora', {
          messages: [
            ...opened.messages,
            message({
              id: 'msg_background',
              seq: 2,
              senderName: 'Shohei Ohtani',
              body: 'Later update'
            })
          ],
          conversation: { ...opened.conversation, unread: 3 }
        })
        await wait()
      })
      expect(reads, 'background delivery must not advance reading').deep.equals(
        []
      )
      expect(engine.views.get('cnv_aurora')?.conversation.unread).equals(3)
      expect(
        engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread
      ).equals(true)
      await act(async () => {
        visibility = 'visible'
        document.dispatchEvent(new window.Event('visibilitychange'))
        await wait()
      })
      await type('Reviewed while visible')
      expect(
        reads.some(([id, revision]) => id === 'cnv_aurora' && revision === 7)
      ).equals(true)
      expect(engine.views.get('cnv_aurora')?.conversation.unread).equals(0)
      expect(
        engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread
      ).equals(false)
    } finally {
      if (originalVisibility == null)
        Reflect.deleteProperty(document, 'visibilityState')
      else
        Object.defineProperty(document, 'visibilityState', originalVisibility)
      if (originalHidden == null) Reflect.deleteProperty(document, 'hidden')
      else Object.defineProperty(document, 'hidden', originalHidden)
    }
  })

  it('keeps Mark unread through hiding the remembered narrow pane and width-only reveal, then clears it on explicit row selection', async function () {
    const { engine, reads } = unreadSessionEngine()
    const state = newChatWorkspaceState()
    await showWorkspace(engine, state, 'cnv_aurora')
    await act(async () => {
      await (engine as ChatScreenEngine).setPreferences?.('cnv_aurora', {
        manualUnread: true
      })
      await wait()
    })
    expect(
      engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread
    ).equals(true)
    const revision =
      engine.views.get('cnv_aurora')!.conversation.preferences!
        .manualUnreadRevision
    await showWorkspace(engine, state)
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.display
    ).equals('none')
    const beforeReveal = reads.length
    await measure(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200,
      700
    )
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.display
    ).equals('flex')
    expect(
      engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread,
      'width changes do not explicitly reselect a conversation'
    ).equals(true)
    expect(
      reads
        .slice(beforeReveal)
        .every(([, acknowledged]) => acknowledged !== revision)
    ).equals(true)
    const beforeSelect = reads.length
    await press('Aurora Members')
    expect(
      reads
        .slice(beforeSelect)
        .some(
          ([id, acknowledged]) =>
            id === 'cnv_aurora' && acknowledged === revision
        )
    ).equals(true)
    expect(
      engine.views.get('cnv_aurora')?.conversation.preferences?.manualUnread
    ).equals(false)
  })
})

describe('chat workspace saved scroll position', function () {
  it('holds an explicitly saved zero through layout growth, Back, reopening and switching conversations', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      text: 'Saved draft',
      picked: [],
      scrollOffset: 0,
      hasScrollPosition: true
    })
    await showWorkspace(engine, state, 'cnv_aurora')
    let scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1200)
    await scroll.resize(1500)
    await measure(scroll.node, 320, 400)
    await scroll.resize(1900)
    expect(scroll.moves.length).greaterThan(0)
    expect(scroll.moves.every(top => top === 0)).equals(true)
    expect(scroll.node.scrollTop).equals(0)
    await scrollEvent(scroll.node, 80)
    expect(state.drafts.get('cnv_aurora')?.scrollOffset).equals(0)
    await measure(scroll.node, 320, 400)
    await scroll.resize(2100)
    expect(scroll.moves.every(top => top === 0)).equals(true)
    expect(scroll.node.scrollTop).equals(0)

    await showWorkspace(engine, state)
    await showWorkspace(engine, state, 'cnv_aurora')
    scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1900)
    expect(scroll.moves.length).greaterThan(0)
    expect(scroll.moves.every(top => top === 0)).equals(true)

    await showWorkspace(engine, state, 'cnv_solstice')
    await showWorkspace(engine, state, 'cnv_aurora')
    scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1900)
    expect(scroll.moves.length).greaterThan(0)
    expect(scroll.moves.every(top => top === 0)).equals(true)
    expect(scroll.node.scrollTop).equals(0)
    expect(state.drafts.get('cnv_aurora')?.hasScrollPosition).equals(true)
    expect(state.drafts.get('cnv_aurora')?.scrollOffset).equals(0)
    expect(input().value).equals('Saved draft')
  })

  it('opens a conversation without a saved position at the latest message', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    expect(state.drafts.has('cnv_solstice')).equals(false)
    await showWorkspace(engine, state, 'cnv_solstice')
    const scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1200)
    expect(scroll.moves).deep.equals([1200])
    expect(scroll.node.scrollTop).equals(800)
  })

  it('ignores hidden-pane zero scroll and layout resets instead of overwriting the saved user position', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      text: '',
      picked: [],
      scrollOffset: 270,
      hasScrollPosition: true
    })
    await showWorkspace(engine, state, 'cnv_aurora')
    let scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1200)
    await scrollEvent(scroll.node, 270, true)
    expect(state.drafts.get('cnv_aurora')?.scrollOffset).equals(270)

    await showWorkspace(engine, state)
    scroll.moves.length = 0
    await scrollEvent(scroll.node, 0)
    await measure(scroll.node, 0, 0)
    await scroll.resize(0)
    await scroll.resize(0)
    expect(scroll.moves).deep.equals([])
    expect(state.drafts.get('cnv_aurora')?.scrollOffset).equals(270)
    expect(state.drafts.get('cnv_aurora')?.hasScrollPosition).equals(true)

    await showWorkspace(engine, state, 'cnv_aurora')
    scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1200)
    expect(scroll.moves.length).greaterThan(0)
    expect(scroll.moves.every(top => top === 270)).equals(true)
    expect(scroll.node.scrollTop).equals(270)
  })

  it('preserves a saved follow-latest view while the content grows and after reopening', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      text: '',
      picked: [],
      scrollOffset: 600,
      hasScrollPosition: true,
      followNewest: true
    })
    await showWorkspace(engine, state, 'cnv_aurora')
    let scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(1200)
    expect(scroll.moves).deep.equals([1200])
    await scrollEvent(scroll.node, 800)
    await scroll.resize(1700)
    expect(scroll.moves).deep.equals([1200, 1700])
    await scrollEvent(scroll.node, 1300)
    expect(state.drafts.get('cnv_aurora')?.followNewest).equals(true)

    await showWorkspace(engine, state)
    await showWorkspace(engine, state, 'cnv_aurora')
    scroll = captureMessageScroll()
    await measure(scroll.node, 320, 400)
    await scroll.resize(2200)
    expect(scroll.moves).deep.equals([2200])
    expect(scroll.node.scrollTop).equals(1800)
  })
})

describe('chat repeated offscreen announcements', function () {
  it('announces the remembered conversation while the narrow list is shown and stays quiet after returning to its message pane', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    const workspace = (conversationId?: string): React.ReactElement => (
      <ChatWorkspace
        engine={engine}
        userId={1}
        state={state}
        conversationId={conversationId}
        onOpen={() => {}}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onTitle={() => {}}
      />
    )
    await render(workspace('cnv_aurora'))
    const container = document.querySelector<HTMLElement>(
      '[data-testid="chat-workspace"]'
    )!
    const onLayout = (
      container as HTMLElement & {
        __reactLayoutHandler?: (event: unknown) => void
      }
    ).__reactLayoutHandler
    expect(onLayout, 'React Native measured layout handler').not.equals(
      undefined
    )
    await act(async () => {
      onLayout!({
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 700 } }
      })
      await wait()
    })
    await render(workspace())
    const listPane = document.querySelector<HTMLElement>(
      '[data-testid="chat-list-pane"]'
    )!
    const messagePane = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-pane"]'
    )!
    expect(state.selectedId).equals('cnv_aurora')
    expect(listPane.style.display).equals('flex')
    expect(messagePane.style.display).equals('none')
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]')!
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true
    })
    const alert = async (): Promise<void> => {
      await act(async () => {
        for (const listener of engine.listeners)
          listener({ type: 'messageAlert', conversationId: 'cnv_aurora' })
        await wait()
      })
    }
    try {
      const quietChild = region.firstChild
      await alert()
      expect(region.textContent).equals('New message in Aurora')
      expect(region.firstChild).not.equals(quietChild)
      expect(mutations.some(record => record.addedNodes.length > 0)).equals(
        true
      )

      await render(workspace('cnv_aurora'))
      expect(listPane.style.display).equals('none')
      expect(messagePane.style.display).equals('flex')
      const announcedChild = region.firstChild
      mutations.length = 0
      await alert()
      expect(mutations).length(0)
      expect(region.firstChild).equals(announcedChild)
      expect(region.textContent).equals('New message in Aurora')
    } finally {
      observer.disconnect()
    }
  })

  it('changes the live region once for each successive alert with identical text and keeps selected, unknown and ordinary updates quiet', async function () {
    const engine = new FakeEngine()
    await render(
      <ChatListScreen
        engine={engine}
        selectedId="cnv_aurora"
        embedded={false}
        narrow
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    const region = document.querySelector<HTMLElement>('[aria-live="polite"]')!
    expect(region).not.equals(null)
    expect(region.textContent).equals('')
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(region, {
      childList: true,
      characterData: true,
      subtree: true
    })
    const alert = async (id: string): Promise<void> => {
      await act(async () => {
        for (const listener of engine.listeners)
          listener({ type: 'messageAlert', conversationId: id })
        await wait()
      })
    }
    try {
      for (const id of ['cnv_aurora', 'cnv_unknown']) await alert(id)
      expect(mutations).length(0)
      expect(region.textContent).equals('')

      for (let post = 0; post < 2; post += 1) {
        const priorChild = region.firstChild
        mutations.length = 0
        await alert('cnv_solstice')
        expect(document.querySelector('[aria-live="polite"]')).equals(region)
        expect(region.textContent).equals('New message in Solstice')
        expect(region.firstChild).not.equals(priorChild)
        expect(
          mutations.reduce(
            (count, record) => count + record.addedNodes.length,
            0
          )
        ).equals(1)
        expect(
          mutations.reduce(
            (count, record) => count + record.removedNodes.length,
            0
          )
        ).equals(1)
      }

      const announcedChild = region.firstChild
      mutations.length = 0
      for (const id of ['cnv_aurora', 'cnv_unknown']) await alert(id)
      await act(async () => {
        for (const listener of engine.listeners)
          listener({ type: 'conversations' })
        await wait()
      })
      expect(mutations).length(0)
      expect(region.firstChild).equals(announcedChild)
      expect(region.textContent).equals('New message in Solstice')
    } finally {
      observer.disconnect()
    }
  })
})

describe('chat conversation shared file preparation and sending', function () {
  it('only prepares a drop, blocks both send entries until preparation finishes, and retains original file order', async function () {
    const engine = new FakeEngine()
    const read = pending<ArrayBuffer>()
    const first = file('first.pdf', async () => await read.promise)
    await screen(engine, {
      draft: { text: 'Caption', picked: [], scrollOffset: 0 }
    })
    await drag('drop', transfer([first, file('second.pdf')]))
    expect(button('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      key()
      button('Send').click()
      await wait()
    })
    expect(engine.calls).deep.equals([])
    await act(async () => {
      read.resolve(new Uint8Array([1]).buffer)
      await wait()
    })
    expect(
      [
        ...document.querySelectorAll('[data-testid="chat-attachment-chip"]')
      ].map(node =>
        ['first.pdf', 'second.pdf'].find(
          name => node.textContent?.includes(name) === true
        )
      )
    ).deep.equals(['first.pdf', 'second.pdf'])
    expect(engine.calls).deep.equals([])
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    await press('Send')
    expect((engine.calls[0] as unknown[]).slice(0, 2)).deep.equals([
      'attach',
      'cnv_aurora'
    ])
    expect(
      ((engine.calls[0] as unknown[])[2] as PickedFile[]).map(
        chosen => chosen.fileName
      )
    ).deep.equals(['first.pdf', 'second.pdf'])
  })

  it('uses one serial preparation queue for picker and drop, validates total capacity before bytes and reports failures', async function () {
    const engine = new FakeEngine()
    const picked = Array.from({ length: 9 }, (_, index) =>
      prepared(`ready-${index}.pdf`)
    )
    const picker = pending<PickedFile[]>()
    const remaining: number[] = []
    const pickerFiles: ConversationFiles = {
      ...files,
      pickFiles: async (_source, capacity) => {
        remaining.push(capacity ?? 10)
        return await picker.promise
      }
    }
    await screen(engine, {
      files: pickerFiles,
      draft: { text: 'Caption', picked, scrollOffset: 0 }
    })
    await press('Attach')
    let reads = 0
    await drag(
      'drop',
      transfer([
        file('eleventh.pdf', async () => {
          reads += 1
          return new Uint8Array([1]).buffer
        })
      ])
    )
    expect(remaining).deep.equals([1])
    expect(reads).equals(0)
    expect(button('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      picker.resolve([prepared('tenth.pdf')])
      await wait()
    })
    expect(reads).equals(0)
    expect(
      document.querySelectorAll('[data-testid="chat-attachment-chip"]')
    ).length(10)
    expect(document.body.textContent).contains(
      'A message can include up to 10 attachments.'
    )
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(engine.calls).deep.equals([])
  })

  it('reports the same read error for drop and picker without adding partial files or sending', async function () {
    const engine = new FakeEngine()
    await screen(engine)
    await drag(
      'drop',
      transfer([
        file('unreadable.pdf', async () => {
          throw new Error('Read unavailable')
        })
      ])
    )
    expect(document.body.textContent).contains(
      'That attachment could not be opened.'
    )
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
    await screen(engine, {
      files: {
        ...files,
        pickFiles: async () => {
          throw new Error('Read unavailable')
        }
      }
    })
    await press('Attach')
    expect(document.body.textContent).contains(
      'That attachment could not be opened.'
    )
    expect(engine.calls).deep.equals([])
  })

  it('cancels picker preparation cleanly and rejects drops in closed, read-only, locked or editing panes', async function () {
    const engine = new FakeEngine()
    await screen(engine)
    await press('Attach')
    const picker = document.querySelector('input[type="file"]')!
    await act(async () => {
      picker.dispatchEvent(new window.Event('cancel'))
      await wait()
    })
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
    expect(document.body.textContent).not.contains(
      'That attachment could not be opened.'
    )
    for (const composer of ['closed', 'readOnly', 'locked'] as const) {
      await act(async () => {
        engine.update('cnv_aurora', { composer })
        await wait()
      })
      let reads = 0
      expect(
        (
          await drag(
            'drop',
            transfer([
              file('blocked.pdf', async () => {
                reads += 1
                return new Uint8Array([1]).buffer
              })
            ])
          )
        ).defaultPrevented
      ).equals(true)
      expect(reads).equals(0)
      expect(document.body.textContent).contains(
        'Attachments are unavailable in this conversation.'
      )
    }
    await act(async () => {
      engine.update('cnv_aurora', { composer: 'enabled' })
      await wait()
    })
    await act(async () => {
      root!.unmount()
      root = undefined
    })
    await screen(engine, {
      draft: {
        text: 'Editing body',
        picked: [],
        scrollOffset: 0,
        editing: message({ mine: true, senderName: 'Mookie Betts' })
      }
    })
    expect((await drag('drop', transfer())).defaultPrevented).equals(true)
    expect(document.body.textContent).contains(
      'Attachments are unavailable in this conversation.'
    )
    expect(engine.calls).deep.equals([])
  })

  it('discards late preparation after conversation switch or unmount and never changes another draft', async function () {
    const engine = new FakeEngine()
    const picker = pending<PickedFile[]>()
    const drafts = new Map<string, ChatDraft>()
    const onDraftChange =
      (id: string) =>
      (draft: ChatDraft): void => {
        drafts.set(id, draft)
      }
    await screen(engine, {
      draft: { text: 'Aurora draft', picked: [], scrollOffset: 0 },
      files: { ...files, pickFiles: async () => await picker.promise },
      onDraftChange: onDraftChange('cnv_aurora')
    })
    await press('Attach')
    let queuedReads = 0
    await drag(
      'drop',
      transfer([
        file('queued.pdf', async () => {
          queuedReads += 1
          return new Uint8Array([1]).buffer
        })
      ])
    )
    await screen(engine, {
      conversationId: 'cnv_solstice',
      draft: { text: 'Solstice draft', picked: [], scrollOffset: 0 },
      onDraftChange: onDraftChange('cnv_solstice')
    })
    await act(async () => {
      picker.resolve([prepared('late.pdf')])
      await wait()
    })
    expect(input().value).equals('Solstice draft')
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
    expect(drafts.get('cnv_aurora')?.picked).deep.equals([])
    expect(drafts.get('cnv_solstice')?.picked).deep.equals([])
    expect(queuedReads).equals(0)
    const read = pending<ArrayBuffer>()
    await drag(
      'drop',
      transfer([file('after-unmount.pdf', async () => await read.promise)])
    )
    await act(async () => {
      root!.unmount()
      root = undefined
      read.resolve(new Uint8Array([1]).buffer)
      await wait()
    })
    expect(drafts.get('cnv_solstice')?.picked).deep.equals([])
    expect(engine.calls).deep.equals([])
  })

  it('blocks synchronous Enter and button duplicates and preserves typing added during sending', async function () {
    const engine = new FakeEngine()
    const send = pending<undefined>()
    engine.sendWork = send.promise
    await screen(engine, {
      draft: { text: 'First body', picked: [], scrollOffset: 0 }
    })
    await act(async () => {
      key()
      button('Send').click()
      key()
      await wait()
    })
    expect(engine.calls).deep.equals([['send', 'cnv_aurora', 'First body', {}]])
    await type('Next body')
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    expect(input().value).equals('Next body')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
  })

  it('keeps the unchanged reply and file beside typing added during an older successful send', async function () {
    const engine = new FakeEngine()
    const send = pending<undefined>()
    engine.sendWork = send.promise
    const target = message({
      senderName: 'Shohei Ohtani',
      body: 'Original body'
    })
    const attachment = prepared()
    await screen(engine, {
      draft: {
        text: 'Submitted caption',
        replyTo: target,
        picked: [attachment],
        scrollOffset: 0
      }
    })
    await press('Send')
    expect(engine.calls).deep.equals([
      [
        'attach',
        'cnv_aurora',
        [attachment],
        'Submitted caption',
        { quoteId: target.id }
      ]
    ])
    await type('New unsent caption')
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    expect(input().value).equals('New unsent caption')
    expect(document.querySelector('[aria-label="Cancel reply"]')).not.equals(
      null
    )
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')!
        .textContent
    ).contains('notes.pdf')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(engine.calls).length(1)
  })

  it('discards a prepared result after posting permission changes and recovers the preparation counter', async function () {
    const engine = new FakeEngine()
    const picker = pending<PickedFile[]>()
    await screen(engine, {
      draft: { text: 'Draft body', picked: [], scrollOffset: 0 },
      files: { ...files, pickFiles: async () => await picker.promise }
    })
    await press('Attach')
    await act(async () => {
      engine.update('cnv_aurora', { composer: 'readOnly' })
      await wait()
    })
    await act(async () => {
      picker.resolve([prepared('late.pdf')])
      await wait()
    })
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
    await act(async () => {
      engine.update('cnv_aurora', { composer: 'enabled' })
      await wait()
    })
    expect(input().value).equals('Draft body')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(engine.calls).deep.equals([])
  })

  it('clears a successfully submitted draft after switching while preserving the new conversation draft', async function () {
    const engine = new FakeEngine()
    const send = pending<undefined>()
    engine.sendWork = send.promise
    const drafts = new Map<string, ChatDraft>()
    const onDraftChange =
      (id: string) =>
      (draft: ChatDraft): void => {
        drafts.set(id, draft)
      }
    await screen(engine, {
      draft: {
        text: 'Submitted caption',
        picked: [prepared()],
        scrollOffset: 0,
        replyTo: message({ senderName: 'Shohei Ohtani', body: 'Original body' })
      },
      onDraftChange: onDraftChange('cnv_aurora')
    })
    await press('Send')
    await screen(engine, {
      conversationId: 'cnv_solstice',
      draft: {
        text: 'Other draft',
        picked: [prepared('other.pdf')],
        scrollOffset: 0
      },
      onDraftChange: onDraftChange('cnv_solstice')
    })
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    expect(drafts.get('cnv_aurora')?.text).equals('')
    expect(drafts.get('cnv_aurora')?.picked).deep.equals([])
    expect(drafts.get('cnv_aurora')?.replyTo).equals(undefined)
    expect(input().value).equals('Other draft')
    expect(document.body.textContent).contains('other.pdf')
    expect(drafts.get('cnv_solstice')?.text).equals('Other draft')
  })

  it('retains a reply draft and prepared files on failed Enter sending and clears only after success', async function () {
    const engine = new FakeEngine()
    engine.failSend = true
    await screen(engine, {
      draft: {
        text: 'Caption',
        picked: [prepared()],
        scrollOffset: 0,
        replyTo: message({ senderName: 'Shohei Ohtani', body: 'Original body' })
      }
    })
    await act(async () => {
      key()
      await wait()
    })
    expect(document.body.textContent)
      .contains('That did not send. Try again.')
      .and.contains('Replying to Shohei Ohtani')
      .and.contains('notes.pdf')
    expect(input().value).equals('Caption')
    expect((engine.calls[0] as unknown[])[4]).deep.equals({ quoteId: 'msg_1' })
    engine.failSend = false
    await act(async () => {
      key()
      await wait()
    })
    expect(input().value).equals('')
    expect(document.querySelector('[aria-label="Cancel reply"]')).equals(null)
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
  })
})

function renderedComposerProps(): ComposerProps {
  interface Fiber {
    return?: Fiber
    memoizedProps?: Partial<ComposerProps>
  }
  const node = input() as unknown as Record<string, unknown>
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = node[key] as Fiber | undefined
  while (fiber != null) {
    const props = fiber.memoizedProps
    if (props?.onAttach != null && props.sources != null)
      return props as ComposerProps
    fiber = fiber.return
  }
  throw new Error('Actual mounted Composer props unavailable')
}

describe('review3 picker activation and busy lifetime', function () {
  // Proposed additions inside the existing shared file-preparation family.
  it('does not queue a stale Attach behind a slow drop and recovers both controls', async function () {
    const engine = new FakeEngine()
    const slow = pending<ArrayBuffer>()
    let pickerCalls = 0
    let expiredActivation = false
    const picker = pending<PickedFile[]>()
    await screen(engine, {
      files: {
        ...files,
        pickFiles: async () => {
          pickerCalls += 1
          // Simulates an OS picker which produces no event after activation expiry.
          if (expiredActivation)
            return await new Promise<PickedFile[]>(() => {})
          return await picker.promise
        }
      },
      draft: { text: 'Preserved caption', picked: [], scrollOffset: 0 }
    })
    const staleAttach = renderedComposerProps().onAttach
    await drag(
      'drop',
      transfer([file('slow.txt', async () => await slow.promise)])
    )
    const attachWasDisabled =
      button('Attach').getAttribute('aria-disabled') === 'true'
    expect(button('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      staleAttach('files')
      expiredActivation = true
      slow.resolve(new Uint8Array([1, 2, 3]).buffer)
      await wait()
    })
    expect(
      pickerCalls,
      'old Attach must not invoke a picker after the earlier read'
    ).equals(0)
    expect(attachWasDisabled, 'busy Attach is disabled').equals(true)
    expect(button('Attach').getAttribute('aria-disabled')).not.equals('true')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(input().value).equals('Preserved caption')
    expect(
      document.querySelectorAll('[data-testid="chat-attachment-chip"]')
    ).length(1)
    expect(engine.calls).deep.equals([])
  })

  it('invokes a valid picker in its original Attach turn and releases preparation on cancel', async function () {
    const engine = new FakeEngine()
    const picker = pending<PickedFile[]>()
    let inPress = false
    const calls: boolean[] = []
    await screen(engine, {
      files: {
        ...files,
        pickFiles: async () => {
          calls.push(inPress)
          return await picker.promise
        }
      },
      draft: { text: 'Retained caption', picked: [], scrollOffset: 0 }
    })
    await act(async () => {
      inPress = true
      button('Attach').click()
      inPress = false
      await wait()
    })
    expect(
      calls,
      'picker is invoked before returning from its activation turn'
    ).deep.equals([true])
    expect(button('Attach').getAttribute('aria-disabled')).equals('true')
    expect(button('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      picker.resolve([])
      await wait()
    })
    expect(button('Attach').getAttribute('aria-disabled')).not.equals('true')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(input().value).equals('Retained caption')
    expect(
      document.querySelectorAll('[data-testid="chat-attachment-chip"]')
    ).length(0)
    expect(engine.calls).deep.equals([])
  })
})

describe('review3 started picker stale lifetime', function () {
  it('observes a held picker rejection after synchronous screen unmount without stale writes', async function () {
    const engine = new FakeEngine()
    let rejectPicker!: (error: Error) => void
    const held = new Promise<PickedFile[]>((_resolve, reject) => {
      rejectPicker = reject
    })
    let pickerCalls = 0
    const drafts: ChatDraft[] = []
    const unhandled: unknown[] = []
    const capture = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', capture)
    try {
      await screen(engine, {
        files: {
          ...files,
          pickFiles: async () => {
            pickerCalls++
            return await held
          }
        },
        draft: { text: 'Held picker caption', picked: [], scrollOffset: 0 },
        onDraftChange: draft => drafts.push(draft)
      })
      const attach = renderedComposerProps().onAttach
      await act(async () => {
        attach('files')
        expect(pickerCalls, 'picker really started').equals(1)
        root!.unmount()
        root = undefined
        await wait()
      })
      const before = drafts.length
      rejectPicker(new Error('Late picker rejection'))
      await wait(50)
      expect(
        unhandled,
        'every started promise has a rejection observer'
      ).deep.equals([])
      expect(drafts.length, 'no stale draft write after unmount').equals(before)
      expect(engine.calls).deep.equals([])
      await screen(engine, {
        draft: { text: 'Next screen caption', picked: [], scrollOffset: 0 }
      })
      expect(input().value).equals('Next screen caption')
      expect(button('Attach').getAttribute('aria-disabled')).not.equals('true')
      expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
      expect(document.body.textContent).not.contains(
        'That attachment could not be opened.'
      )
    } finally {
      process.removeListener('unhandledRejection', capture)
    }
  })
})
