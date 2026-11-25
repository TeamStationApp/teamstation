import assert from 'node:assert/strict'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppState, Platform } from 'react-native'

import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { lstrings } from '../locales/strings'
import { activeConversation } from '../push/activeConversation'
import { getTheme, ThemeProvider } from '../theme/ThemeContext'
import { whileChatBrowserOpen } from './chatBrowserVisibility'
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
import {
  TestComposer as Composer,
  type TestComposerProps as ComposerProps
} from './composer.test.helpers'
import {
  type ConversationFiles,
  ConversationScreen
} from './ConversationScreen'
import { UnconfirmedChatPost } from './engine/context'
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
      node.getAttribute('aria-label') === label ||
      // A chat row is named "title, preview, unread".
      node.getAttribute('aria-label')?.startsWith(label + ', ') === true ||
      node.textContent === label
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
  it('shows the selected image bytes in the draft and releases the preview when removed', async () => {
    const file = {
      fileName: 'practice.png',
      contentType: 'image/png',
      bytes: Uint8Array.of(12, 45)
    }
    const released: string[] = []
    const uri = 'blob:draft-photo-test'
    const files = {
      bytesUri: async (bytes: Uint8Array, mime: string, name: string) => {
        assert.equal(bytes, file.bytes)
        assert.equal(mime, file.contentType)
        assert.equal(name, file.fileName)
        return uri
      },
      releaseUri: async (value: string) => {
        released.push(value)
      }
    }
    await render(<Composer {...props({ files, attachments: [file] })} />)
    expect(
      document.querySelector('[data-testid="chat-draft-photo"]')
    ).not.equals(null)
    expect(document.body.textContent).contains(file.fileName)
    await render(<Composer {...props({ files, attachments: [] })} />)
    expect(document.querySelector('[data-testid="chat-draft-photo"]')).equals(
      null
    )
    assert.deepEqual(released, [uri])
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
      expect(document.querySelector('[aria-label="Send"]')).equals(null)
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

  it('draws visible circles behind Photos, Camera and File on a phone', async function () {
    const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    try {
      await render(
        <Composer {...props({ sources: ['photos', 'camera', 'files'] })} />
      )
      await press('Attach')
      const panel = document.querySelector(
        '[data-testid="chat-attachment-panel"]'
      )!
      const panelFill = getComputedStyle(panel).backgroundColor
      for (const label of ['Photos', 'Camera', 'File']) {
        const circle = getComputedStyle(button(label).firstElementChild!)
        expect(circle.width).equals(circle.height)
        expect(parseFloat(circle.width)).to.be.greaterThan(0)
        expect(parseFloat(circle.borderTopLeftRadius)).at.least(
          parseFloat(circle.width) / 2
        )
        expect(circle.backgroundColor).not.equals(panelFill)
        expect(circle.borderTopWidth).equals('1px')
      }
    } finally {
      Object.defineProperty(Platform, 'OS', saved)
    }
  })

  it('fits all attachment choices into a short phone drawer', async function () {
    const original = Platform.OS
    try {
      Platform.OS = 'android'
      let selected: string | undefined
      await render(
        <Composer
          {...props({
            attachmentPanelHeight: 68,
            sources: ['photos', 'camera', 'files'],
            onAttach: source => {
              selected = source
            }
          })}
        />
      )
      await press('Attach')
      for (const label of ['Photos', 'Camera', 'File']) {
        const action = button(label)
        expect(action.textContent).contains(label)
        expect(getComputedStyle(action).minHeight).equals('44px')
        expect(getComputedStyle(action.firstElementChild!).height).equals(
          '24px'
        )
        expect(getComputedStyle(action.parentElement!).paddingTop).equals('0px')
      }
      await press('File')
      expect(selected).equals('files')
    } finally {
      Platform.OS = original
    }
  })

  it('returns an emptied iOS field to one line when a send clears its draft', async function () {
    // Seen on an iPhone 13 Pro: the multiline field kept its three-line
    // height after a send cleared the draft from outside.
    const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    try {
      const height = (): string =>
        getComputedStyle(
          document.querySelector('[data-testid="chat-composer"]')!
        ).height
      await render(
        <Composer {...props({ text: 'First line\nSecond line\nThird line' })} />
      )
      expect(height()).not.equals('42px')
      await render(<Composer {...props({ text: '' })} />)
      const field = getComputedStyle(input().parentElement!)
      expect(
        parseFloat(height()) +
          parseFloat(field.borderTopWidth) +
          parseFloat(field.borderBottomWidth)
      ).equals(44)
    } finally {
      Object.defineProperty(Platform, 'OS', saved)
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
        members: [
          member(userIdOfGumbo(1), 'Mookie Betts'),
          member(userIdOfGumbo(2), 'Shohei Ohtani')
        ],
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
  async edit(...args: Parameters<ChatScreenEngine['edit']>): Promise<void> {
    this.calls.push(['edit', ...args])
  }

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
      userId={userIdOfGumbo(1)}
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
      userId={userIdOfGumbo(1)}
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

  it('keeps delivery unread and notifications enabled while Safari covers the conversation', async function () {
    const { engine, reads } = unreadSessionEngine()
    const id = 'cnv_aurora'
    await screen(engine)
    expect(activeConversation()).equals(id)
    let dismiss!: () => void
    const sheet = new Promise<void>(resolve => {
      dismiss = resolve
    })
    let opening!: Promise<void>
    try {
      await act(async () => {
        opening = whileChatBrowserOpen(async () => {
          await sheet
        })
        await wait()
      })
      expect(activeConversation()).equals(null)
      const visibleReads = reads.length
      await whileChatBrowserOpen(async () => {
        throw new Error('Repeated tap opened another sheet')
      })
      await act(async () => {
        const opened = engine.views.get(id)!
        engine.update(id, {
          messages: [
            ...opened.messages,
            message({ id: 'msg_under_browser', seq: 2, body: 'While browsing' })
          ],
          conversation: { ...opened.conversation, unread: 1 }
        })
        await wait()
      })
      expect(reads.length).equals(visibleReads)
      expect(engine.views.get(id)?.conversation.unread).equals(1)
    } finally {
      await act(async () => {
        dismiss()
        await opening
        await wait()
      })
    }
    expect(activeConversation()).equals(id)
    expect(engine.views.get(id)?.conversation.unread).equals(0)
    await act(async () => {
      await assert.rejects(
        whileChatBrowserOpen(async () => {
          throw new Error('Unavailable presenter')
        }),
        /Unavailable presenter/
      )
      await wait()
    })
    expect(activeConversation()).equals(id)
  })

  it('reads nothing while iOS covers the app (inactive), and reads once it is active again', async function () {
    const { engine, reads } = unreadSessionEngine()
    const current = engine.views.get('cnv_aurora')!
    engine.update('cnv_aurora', {
      conversation: { ...current.conversation, unread: 2 }
    })
    const originalState = Object.getOwnPropertyDescriptor(
      AppState,
      'currentState'
    )
    let state = 'inactive'
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      get: () => state
    })
    const change = async (next: string): Promise<void> => {
      state = next
      await act(async () => {
        // React Native Web reports a change on visibilitychange.
        document.dispatchEvent(new window.Event('visibilitychange'))
        await wait()
      })
    }
    try {
      await screen(engine)
      await act(async () => {
        const opened = engine.views.get('cnv_aurora')!
        engine.update('cnv_aurora', {
          messages: [
            ...opened.messages,
            message({
              id: 'msg_covered',
              seq: 2,
              senderName: 'Shohei Ohtani',
              body: 'Arrives under Notification Center'
            })
          ],
          conversation: { ...opened.conversation, unread: 3 }
        })
        await wait()
      })
      await type('Typed under the app switcher')
      expect(reads, 'an inactive app must not read').deep.equals([])
      expect(engine.views.get('cnv_aurora')?.conversation.unread).equals(3)
      await change('active')
      await type('Typed once active')
      expect(reads.some(([id]) => id === 'cnv_aurora')).equals(true)
      expect(engine.views.get('cnv_aurora')?.conversation.unread).equals(0)
    } finally {
      if (originalState == null)
        Reflect.deleteProperty(AppState, 'currentState')
      else Object.defineProperty(AppState, 'currentState', originalState)
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
        .style.visibility
    ).equals('hidden')
    const beforeReveal = reads.length
    await measure(
      document.querySelector('[data-testid="chat-workspace"]')!,
      1200,
      700
    )
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.visibility
    ).not.equals('hidden')
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

describe('a chat over its kept list on a narrow screen', function () {
  it('keeps the draft typed in a chat when the list beneath it remembers that chat', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    state.selectedId = 'cnv_aurora'
    const workspace = (conversationId?: string): React.ReactElement => (
      <div key={conversationId ?? 'list'}>
        <ChatWorkspace
          engine={engine}
          userId={userIdOfGumbo(1)}
          state={state}
          conversationId={conversationId}
          onOpen={() => {}}
          onMembers={() => {}}
          onNewMessage={() => {}}
          onTitle={() => {}}
        />
      </div>
    )
    await render(
      <>
        {workspace('cnv_aurora')}
        {workspace()}
      </>
    )
    for (const container of document.querySelectorAll<HTMLElement>(
      '[data-testid="chat-workspace"]'
    )) {
      await act(async () => {
        ;(
          container as HTMLElement & {
            __reactLayoutHandler?: (event: unknown) => void
          }
        ).__reactLayoutHandler?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 700 } }
        })
        await wait()
      })
    }
    await type('Keep me')
    // Back: the chat goes, and the list left behind draws again.
    await render(<>{workspace()}</>)
    await render(
      <>
        {workspace()}
        {workspace('cnv_aurora')}
      </>
    )
    expect(input().value).equals('Keep me')
  })

  it('keeps its usual look while it leaves, and takes nothing', async function () {
    const engine = new FakeEngine()
    await screen(engine)
    await screen(engine, { active: false })
    expect(input().placeholder).equals('Message')
    expect(input().readOnly).equals(true)
  })
})

describe('chat repeated offscreen announcements', function () {
  it('announces the remembered conversation while the narrow list is shown and stays quiet after returning to its message pane', async function () {
    const engine = new FakeEngine()
    const state = newChatWorkspaceState()
    const workspace = (conversationId?: string): React.ReactElement => (
      <ChatWorkspace
        engine={engine}
        userId={userIdOfGumbo(1)}
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
    expect(messagePane.style.visibility).equals('hidden')
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
      expect(messagePane.style.visibility).not.equals('hidden')
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
  for (const platform of ['ios', 'android']) {
    it(
      'dismisses the attachment drawer on a history tap on ' + platform,
      async () => {
        const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
        Object.defineProperty(Platform, 'OS', {
          configurable: true,
          value: platform
        })
        try {
          await screen(new FakeEngine(), {
            draft: { text: 'Bring the bats', picked: [], scrollOffset: 0 }
          })
          await press('Attach')
          const panel = (): Element | null =>
            document.querySelector('[data-testid="chat-attachment-panel"]')
          assert.ok(panel() != null)
          const history = document.querySelector(
            '[data-testid="chat-message-history"]'
          )!
          await act(async () => {
            const touch = {
              target: history,
              identifier: 0,
              pageX: 8,
              pageY: 160
            }
            for (const type of ['touchstart', 'touchend']) {
              const touches = type === 'touchstart' ? [touch] : []
              history.dispatchEvent(
                Object.assign(new window.Event(type, { bubbles: true }), {
                  changedTouches: [touch],
                  targetTouches: touches,
                  touches
                })
              )
            }
            // jsdom doesn't synthesize the compatibility mouse events after a tap.
            for (const type of ['mousedown', 'mouseup'])
              history.dispatchEvent(
                new window.MouseEvent(type, { bubbles: true })
              )
            await wait()
          })
          assert.equal(panel() != null, false)
          assert.equal(input().value, 'Bring the bats')
          assert.notEqual(document.activeElement, input())
        } finally {
          Object.defineProperty(Platform, 'OS', saved)
        }
      }
    )
  }

  it('dismisses Attach on an outside click and preserves the draft and focus destination', async () => {
    await screen(new FakeEngine())
    await type('Bring the bats')
    const panel = (): Element | null =>
      document.querySelector('[data-testid="chat-attachment-panel"]')
    await press('Attach')
    assert.ok(panel() != null)
    const history = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    history.tabIndex = 0
    await act(async () => {
      history.focus()
      history.click()
      await wait()
    })
    expect(panel()).equals(null)
    expect(document.activeElement).equals(history)
    expect(input().value).equals('Bring the bats')
    await press('Attach')
    await press(lstrings.chat_close_attachments)
    expect(panel()).equals(null)
    expect(document.activeElement).equals(input())
  })

  it('edits an old original from the author menu and restores its separate unsent draft and file', async () => {
    const engine = new FakeEngine()
    const original = message({
      mine: true,
      body: 'Practice at four 🥎',
      sentAt: '2019-01-01T10:00:00Z'
    })
    engine.update('cnv_aurora', { messages: [original] })
    await screen(engine, {
      draft: {
        text: 'Bring the bats',
        picked: [prepared('lineup.pdf')],
        scrollOffset: 0
      }
    })
    await press('More message actions')
    await press('Edit')
    expect(input().value).equals(original.body)
    expect(document.activeElement).equals(input())
    expect(input().selectionStart).equals(original.body.length)
    expect(button('Attach').getAttribute('aria-disabled')).equals('true')
    expect(document.body.textContent).not.contains('lineup.pdf')
    await type('Practice at five')
    await press('Send')
    expect(engine.calls).deep.includes([
      'edit',
      'cnv_aurora',
      original.id,
      'Practice at five'
    ])
    expect(input().value).equals('Bring the bats')
    expect(button('Remove lineup.pdf').getAttribute('aria-label')).equals(
      'Remove lineup.pdf'
    )
    await press('More message actions')
    await press('Edit')
    await type('Discarded edit')
    await press('Cancel edit')
    expect(input().value).equals('Bring the bats')
    expect(button('Remove lineup.pdf').getAttribute('aria-label')).equals(
      'Remove lineup.pdf'
    )
  })

  for (const picker of ['Attach', 'Emoji'] as const) {
    it(`closes the ${picker} picker when editing and restores the draft on Escape`, async () => {
      const engine = new FakeEngine()
      const original = message({ mine: true, body: 'Tuesday practice' })
      engine.update('cnv_aurora', { messages: [original] })
      await screen(engine, {
        files: { ...files, PICK_SOURCES: ['photos', 'files'] },
        draft: { text: 'Bring the bats', picked: [], scrollOffset: 0 }
      })
      await press(picker)
      const control =
        picker === 'Attach'
          ? lstrings.chat_photo_library
          : lstrings.chat_more_emoji
      const panelControl = (): Element | null =>
        document.querySelector(`[aria-label="${control}"]`)
      expect(panelControl()).not.equals(null)
      await press('More message actions')
      await press('Edit')
      expect(input().value).equals(original.body)
      expect(document.activeElement).equals(input())
      expect(panelControl()).equals(null)
      await act(async () => {
        expect(key(input(), { key: 'Escape' }).defaultPrevented).equals(true)
        await wait()
      })
      expect(input().value).equals('Bring the bats')
      expect(document.body.textContent).not.contains('Editing your message')
      expect(panelControl()).equals(null)
    })
  }

  async function retainOlderEdit(mentions: string[] = []): Promise<{
    engine: FakeEngine
    room: string
    original: ReturnType<typeof message>
  }> {
    const engine = new FakeEngine()
    const room = 'cnv_aurora'
    const original = message({
      mine: true,
      seq: 8,
      body: 'Afternoon practice',
      mentions
    })
    engine.update(room, { messages: [original] })
    await screen(engine, {
      draft: { text: 'Bring the bats', picked: [], scrollOffset: 0 }
    })
    await press('More message actions')
    await press('Edit')
    await type('Evening practice')
    await act(async () => {
      engine.update(room, { messages: [], hasEarlier: true, historyBefore: 12 })
      await wait()
    })
    return { engine, room, original }
  }

  it('keeps editing across a partial history read and restores the parked draft when the original disappears', async () => {
    const { engine, room } = await retainOlderEdit()
    expect(input().value).equals('Evening practice')
    await act(async () => {
      engine.update(room, { messages: [], hasEarlier: true, historyBefore: 4 })
      await wait()
    })
    expect(input().value).equals('Bring the bats')
    expect(document.body.textContent).not.contains('Editing your message')
    expect(
      engine.calls.filter(call => Array.isArray(call) && call[0] === 'edit')
    ).deep.equals([])
  })

  it('loads an older edit target once when Save follows a partial history refresh', async () => {
    const { engine, room, original } = await retainOlderEdit()
    // A stalled cursor keeps the edited text available for a retry.
    engine.loadEarlier = async id => engine.view(id)!
    await press('Send')
    for (
      let frame = 0;
      frame < 30 &&
      document.body.textContent?.includes(lstrings.chat_send_failed) !== true;
      frame++
    )
      await act(async () => {
        await wait(80)
      })
    expect(document.body.textContent).contains(lstrings.chat_send_failed)
    expect(input().value).equals('Evening practice')

    let resume!: () => void
    const pending = new Promise<void>(resolve => {
      resume = resolve
    })
    let pages = 0
    engine.loadEarlier = async id => {
      pages++
      await pending
      engine.update(id, {
        messages: [original],
        hasEarlier: false,
        historyBefore: 8
      })
      return engine.view(id)!
    }
    await press('Send')
    await press('Send')
    expect(pages).equals(1)
    await act(async () => {
      resume()
      await wait()
    })
    for (
      let frame = 0;
      frame < 30 && input().value !== 'Bring the bats';
      frame++
    )
      await act(async () => {
        await wait(80)
      })
    expect(
      engine.calls.filter(call => Array.isArray(call) && call[0] === 'edit')
    ).deep.equals([['edit', room, original.id, 'Evening practice']])
    expect(input().value).equals('Bring the bats')
  })

  for (const [description, changed] of [
    [
      'retries the same signed edit after an intervening history read fails',
      false
    ],
    ['signs new wording after an intervening history read fails', true]
  ] as const) {
    it(description, async () => {
      const engine = new FakeEngine()
      const room = 'cnv_aurora'
      const original = message({ mine: true, seq: 8, body: 'Practice' })
      engine.update(room, { messages: [original] })
      const signed: string[] = []
      let retried = 0
      engine.edit = async (_room, _id, body) => {
        signed.push(body)
        if (signed.length > 1) return
        throw new UnconfirmedChatPost(
          new HttpError('offline', 'Lost acknowledgement'),
          async () => {
            retried++
          }
        )
      }
      await screen(engine, {
        draft: { text: 'Parked', picked: [], scrollOffset: 0 }
      })
      await press('More message actions')
      await press('Edit')
      await type('Evening practice')
      await press('Send')
      expect(signed).deep.equals(['Evening practice'])
      expect(document.body.textContent).contains(lstrings.chat_send_failed)

      await act(async () => {
        engine.update(room, {
          messages: [],
          hasEarlier: true,
          historyBefore: 12
        })
        await wait()
      })
      let reads = 0
      engine.loadEarlier = async id => {
        if (++reads === 1) throw new Error('History unavailable')
        engine.update(id, {
          messages: [original],
          hasEarlier: false,
          historyBefore: 8
        })
        return engine.view(id)!
      }
      await press('Send')
      expect(reads).equals(1)
      expect(input().value).equals('Evening practice')
      expect(retried).equals(0)
      if (changed) await type('Late practice')
      await press('Send')
      for (
        let i = 0;
        i < 30 && button('Send').getAttribute('aria-disabled') === 'true';
        i++
      )
        await act(async () => {
          await wait(80)
        })
      expect(reads).equals(2)
      expect(signed).deep.equals(
        changed ? ['Evening practice', 'Late practice'] : ['Evening practice']
      )
      expect(retried).equals(changed ? 0 : 1)
      expect(input().value).equals('Parked')
    })
  }

  it('checks current membership after loading a missing edit target', async () => {
    const departed = userIdOfGumbo(2)
    const remaining = userIdOfGumbo(3)
    const { engine, room, original } = await retainOlderEdit([
      departed,
      remaining
    ])
    const teammate = member(remaining, 'Sam')
    const previousMembers = [member(departed, 'Lee'), teammate]
    await act(async () => {
      engine.update(room, { members: previousMembers })
      await wait()
    })
    await type(original.body)
    const page = pending<undefined>()
    engine.loadEarlier = async id => {
      await page.promise
      engine.update(id, {
        messages: [original],
        members: [teammate],
        hasEarlier: false
      })
      return engine.view(id)!
    }
    await press('Send')
    await act(async () => {
      page.resolve(undefined)
      await wait()
    })
    for (
      let frame = 0;
      frame < 30 && input().value !== 'Bring the bats';
      frame++
    )
      await act(async () => {
        await wait(80)
      })
    expect(
      engine.calls.filter(call => Array.isArray(call) && call[0] === 'edit')
    ).deep.equals([['edit', room, original.id, original.body, [remaining]]])
  })

  it('ignores a late history page when Escape cancels an older edit during Save', async () => {
    const { engine, original } = await retainOlderEdit()
    let resume!: () => void
    const history = new Promise<void>(resolve => {
      resume = resolve
    })
    let requested = false
    engine.loadEarlier = async id => {
      requested = true
      await history
      engine.update(id, {
        messages: [original],
        hasEarlier: false,
        historyBefore: 8
      })
      return engine.view(id)!
    }
    await press('Send')
    expect(requested).equals(true)
    await act(async () => {
      input().focus()
      expect(key(input(), { key: 'Escape' }).defaultPrevented).equals(true)
      await wait()
    })
    expect(input().value).equals('Bring the bats')
    expect(button('Attach').getAttribute('aria-disabled')).not.equals('true')
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    const next = pending<undefined>()
    engine.sendWork = next.promise
    await press('Send')
    expect(engine.calls).deep.includes([
      'send',
      'cnv_aurora',
      'Bring the bats',
      {}
    ])
    await act(async () => {
      resume()
      await wait()
    })
    // A late page from the cancelled edit cannot release the new post.
    expect(button('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      next.resolve(undefined)
      await wait()
    })
    expect(input().value).equals('')
    expect(
      engine.calls.filter(call => Array.isArray(call) && call[0] === 'edit')
    ).deep.equals([])
    expect(document.body.textContent).not.contains(lstrings.chat_send_failed)
  })

  for (const result of ['accepted', 'failed'] as const) {
    it(`keeps a dispatched edit open until its ${result} response arrives`, async () => {
      const engine = new FakeEngine()
      const original = message({ mine: true, body: 'Practice' })
      engine.update('cnv_aurora', { messages: [original] })
      const response = pending<undefined>()
      const edits: string[] = []
      let retries = 0
      engine.edit = async (_room, _id, body) => {
        edits.push(body)
        await response.promise
        if (result === 'failed')
          throw new UnconfirmedChatPost(
            new HttpError('offline', 'No acknowledgement'),
            async () => {
              retries++
            }
          )
      }
      await screen(engine, {
        draft: { text: 'Parked', picked: [], scrollOffset: 0 }
      })
      await press('More message actions')
      await press('Edit')
      await type('Evening practice')
      await press('Send')
      expect(edits).deep.equals(['Evening practice'])
      expect(button('Cancel edit').getAttribute('aria-disabled')).equals('true')
      await press('Cancel edit')
      await act(async () => {
        input().focus()
        expect(key(input(), { key: 'Escape' }).defaultPrevented).equals(false)
        await wait()
      })
      expect(input().value).equals('Evening practice')
      await act(async () => {
        response.resolve(undefined)
        await wait()
      })
      if (result === 'failed') {
        expect(document.body.textContent).contains(lstrings.chat_send_failed)
        expect(input().value).equals('Evening practice')
        expect(button('Cancel edit').getAttribute('aria-disabled')).not.equals(
          'true'
        )
        await press('Send')
        expect(edits).deep.equals(['Evening practice'])
        expect(retries).equals(1)
      }
      expect(input().value).equals('Parked')
    })
  }

  it('offers Edit again when a pending attachment finishes with the author menu open', async () => {
    const engine = new FakeEngine()
    const original = message({ mine: true, body: 'Practice' })
    engine.update('cnv_aurora', { messages: [original] })
    const upload = pending<undefined>()
    engine.sendWork = upload.promise
    await screen(engine, {
      draft: {
        text: 'Lineup',
        picked: [prepared('lineup.pdf')],
        scrollOffset: 0
      }
    })
    await press('Send')
    await press('More message actions')
    expect(button(lstrings.chat_copy_text)).not.equals(undefined)
    const menuHasEdit = (): boolean =>
      [...document.querySelectorAll('[role="button"],button')].some(
        node =>
          node.getAttribute('aria-label') === 'Edit' ||
          node.textContent === 'Edit'
      )
    expect(menuHasEdit()).equals(false)
    await act(async () => {
      upload.resolve(undefined)
      await wait()
    })
    await press('Edit')
    expect(input().value).equals(original.body)
  })

  it('handles physical Up only in the empty field, reads earlier history and cancels on Escape', async () => {
    const engine = new FakeEngine()
    const room = 'cnv_aurora'
    const mine = message({
      id: 'msg_older',
      seq: 3,
      mine: true,
      body: 'Practice at noon'
    })
    const incoming = message({ id: 'msg_newer', seq: 8, mine: false })
    engine.update(room, {
      messages: [incoming],
      hasEarlier: true,
      historyBefore: 8
    })
    let pages = 0
    engine.loadEarlier = async id => {
      pages++
      engine.update(id, {
        messages: [mine, incoming],
        hasEarlier: false,
        historyBefore: 3
      })
      return engine.view(id)!
    }
    await screen(engine)
    await act(async () => {
      input().focus()
      key(input(), { key: 'ArrowUp', shiftKey: true })
      await wait()
    })
    expect(input().value).equals('')
    expect(input().id).equals('chatComposerEditLatest')
    await act(async () => {
      expect(key(input(), { key: 'ArrowUp' }).defaultPrevented).equals(true)
      await wait()
    })
    for (let frame = 0; frame < 30 && input().value === ''; frame++) {
      await act(async () => {
        await wait(80)
      })
    }
    expect(pages).equals(1)
    expect(input().value, document.body.textContent ?? '').equals(mine.body)
    expect(pages).equals(1)
    await act(async () => {
      key(input(), { key: 'Escape' })
      await wait()
    })
    expect(input().value).equals('')
    expect(document.body.textContent).not.contains('Editing your message')
    await type(' ')
    await act(async () => {
      key(input(), { key: 'ArrowUp' })
      await wait()
    })
    expect(input().value).equals(' ')
  })

  for (const platform of ['ios', 'android'] as const) {
    for (const interrupt of ['Escape', 'Unidentified']) {
      it(`keeps the composer empty when ${interrupt} interrupts a pending hardware Up on ${platform}`, async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(
          Platform,
          'OS'
        )!
        Object.defineProperty(Platform, 'OS', {
          configurable: true,
          value: platform
        })
        try {
          const engine = new FakeEngine()
          const room = 'cnv_aurora'
          const recent = message({ id: 'msg_recent', seq: 8, mine: false })
          const earlier = message({
            id: 'msg_earlier',
            seq: 3,
            mine: true,
            body: 'Early practice'
          })
          engine.update(room, {
            messages: [recent],
            hasEarlier: true,
            historyBefore: 8
          })
          const page = pending<undefined>()
          let requested = false
          engine.loadEarlier = async id => {
            requested = true
            await page.promise
            engine.update(id, {
              messages: [earlier, recent],
              hasEarlier: false,
              historyBefore: 3
            })
            return engine.view(id)!
          }
          await screen(engine)
          await act(async () => {
            input().focus()
            nativeFieldKey('ArrowUp')
            await wait()
          })
          expect(requested).equals(true)
          await act(async () => {
            nativeFieldKey(interrupt)
            page.resolve(undefined)
            await wait()
          })
          expect(input().value).equals('')
          expect(document.querySelector('[aria-label="Cancel edit"]')).equals(
            null
          )
          await act(async () => {
            nativeFieldKey('ArrowUp')
            await wait()
          })
          expect(input().value).equals('Early practice')
        } finally {
          Object.defineProperty(Platform, 'OS', originalPlatform)
        }
      })
    }
  }

  it('keeps an iOS text replacement named Escape in the edit', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    try {
      const engine = new FakeEngine()
      engine.update('cnv_aurora', {
        messages: [message({ mine: true, body: 'Practice' })]
      })
      await screen(engine)
      await press('More message actions')
      await press('Edit')
      await act(async () => {
        nativeFieldKey('Escape', false)
        await wait()
      })
      await type('Escape')
      expect(document.body.textContent).contains('Editing your message')
      expect(input().value).equals('Escape')
      await act(async () => {
        nativeFieldKey('Escape')
        await wait()
      })
      expect(document.body.textContent).not.contains('Editing your message')
      expect(input().value).equals('')
    } finally {
      Object.defineProperty(Platform, 'OS', descriptor)
    }
  })

  it('shows the received card, regenerates an edited caption’s chat link preview, and dismisses the next draft preview', async () => {
    const engine = new FakeEngine()
    const room = 'cnv_aurora'
    const url = 'https://example.org/game'
    const metadata = {
      url,
      siteName: 'example.org',
      title: 'Team schedule',
      description: ''
    }
    const original = message({
      mine: true,
      body: url + '#original',
      preview: metadata
    })
    engine.update(room, { messages: [original] })
    const pageLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    const prototype = Object.getPrototypeOf(
      document.createElement('iframe')
    ) as HTMLIFrameElement
    const sandbox = Object.getOwnPropertyDescriptor(prototype, 'sandbox')
    Object.defineProperty(prototype, 'sandbox', {
      configurable: true,
      get: () => new Set()
    })
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            !(node instanceof window.HTMLIFrameElement) ||
            node.contentWindow == null
          )
            continue
          node.contentWindow.postMessage = (
            request: { id: string },
            origin?: string | WindowPostMessageOptions,
            ports?: Transferable[]
          ) => {
            assert.equal(origin, '*')
            const port = ports?.[0] as MessagePort | undefined
            assert(port != null)
            port.postMessage({
              id: request.id,
              mime: 'text/html',
              bytes: new TextEncoder().encode('<title>Team schedule</title>')
                .buffer
            })
          }
          node.dispatchEvent(new window.Event('load'))
        }
      }
    })
    observer.observe(document.body, { childList: true })
    try {
      const body = 'Updated caption ' + url
      await screen(engine, {
        onOpenLink: async () => {},
        draft: { text: body, picked: [], scrollOffset: 0, editing: original }
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 650))
      })
      const received = document.querySelector(
        '[data-testid="chat-message-' +
          original.id +
          '"] [data-testid="chat-link-preview"]'
      )
      expect(received?.textContent).contains(metadata.title)
      expect(received?.querySelector('a')?.getAttribute('href')).equals(
        url + '#original'
      )
      const preview = document.querySelector<HTMLElement>(
        '[data-testid="chat-composer-band"] [data-testid="chat-link-preview"]'
      )
      assert(preview != null)
      const expectedSurface = document.createElement('div')
      expectedSurface.style.backgroundColor = getTheme().cardBackgroundColor
      expect(getComputedStyle(preview.parentElement!).backgroundColor).equals(
        expectedSurface.style.backgroundColor
      )
      expect(
        document.querySelector('[data-testid="chat-dismiss-link-preview"]')
      ).not.equals(null)
      await press('Send')
      expect(engine.calls).to.deep.include([
        'edit',
        room,
        original.id,
        body,
        [],
        metadata
      ])
      const next = 'Next game https://example.org/next'
      await type(next)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 650))
      })
      await press('Remove link preview')
      expect(
        document.querySelector('[data-testid="chat-dismiss-link-preview"]')
      ).equals(null)
      expect(received?.textContent).contains(metadata.title)
      await press('Send')
      expect(engine.calls).to.deep.include(['send', room, next, {}])
    } finally {
      observer.disconnect()
      if (sandbox == null) Reflect.deleteProperty(prototype, 'sandbox')
      else Object.defineProperty(prototype, 'sandbox', sandbox)
      if (pageLocation == null) Reflect.deleteProperty(globalThis, 'location')
      else Object.defineProperty(globalThis, 'location', pageLocation)
    }
  })

  it('only prepares a drop, blocks both send entries until preparation finishes, and retains original file order', async function () {
    const engine = new FakeEngine()
    const read = pending<ArrayBuffer>()
    const first = file('first.pdf', async () => await read.promise)
    await screen(engine, {
      draft: { text: 'Caption', picked: [], scrollOffset: 0 }
    })
    await press('Attach')
    const panel = (): Element | null =>
      document.querySelector('[data-testid="chat-attachment-panel"]')
    assert.ok(panel() != null)
    await drag('drop', transfer([first, file('second.pdf')]))
    expect(panel()).equals(null)
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
    expect(panel()).equals(null)
    await press('Attach')
    expect(panel()?.contains(document.activeElement)).equals(true)
    await press('Close attachments')
    expect(panel()).equals(null)
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
    await press('File')
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
    await press('File')
    expect(document.body.textContent).contains(
      'That attachment could not be opened.'
    )
    expect(engine.calls).deep.equals([])
  })

  it('cancels picker preparation cleanly and rejects drops in closed, read-only, locked or editing panes', async function () {
    const engine = new FakeEngine()
    await screen(engine)
    await press('Attach')
    await press('File')
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
    const mine = message({ mine: true, senderName: 'Mookie Betts' })
    engine.update('cnv_aurora', { messages: [mine] })
    await screen(engine, {
      draft: {
        text: 'Editing body',
        picked: [],
        scrollOffset: 0,
        editing: mine
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
    await press('File')
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
    await press('File')
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

  for (const [first, other] of [
    ['Cancel reply', 'Remove notes.pdf'],
    ['Remove notes.pdf', 'Cancel reply']
  ])
    it(`keeps the rest of a restored reply draft with a file after ${first}`, async function () {
      await screen(new FakeEngine(), {
        draft: {
          text: 'Caption',
          picked: [prepared()],
          scrollOffset: 0,
          replyTo: message({
            senderName: 'Shohei Ohtani',
            body: 'Original body'
          })
        }
      })
      await press(first)
      expect(document.querySelector(`[aria-label="${other}"]`)).not.equals(null)
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

function renderedFieldAncestor<T>(matches: (props: Partial<T>) => boolean): T {
  interface Fiber {
    return?: Fiber
    memoizedProps?: Partial<T>
  }
  const node = input() as unknown as Record<string, unknown>
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = node[key] as Fiber | undefined
  while (fiber != null) {
    const props = fiber.memoizedProps
    if (props != null && matches(props)) return props as T
    fiber = fiber.return
  }
  throw new Error('Expected a mounted chat composer field ancestor')
}

function renderedComposerProps(): ComposerProps {
  return renderedFieldAncestor<ComposerProps>(
    props => props.onAttach != null && props.sources != null
  )
}

function nativeFieldKey(key: string, chatHardwareKey = true): void {
  interface NativeField {
    nativeID: string
    onKeyPress: (event: {
      nativeEvent: { key: string; chatHardwareKey?: boolean }
    }) => void
  }
  const field = renderedFieldAncestor<NativeField>(
    props =>
      props.nativeID?.startsWith('chatComposer') === true &&
      props.onKeyPress != null
  )
  field.onKeyPress({ nativeEvent: { key, chatHardwareKey } })
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

  it('invokes a valid picker in its File activation turn and releases preparation on cancel', async function () {
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
    await press('Attach')
    expect(calls).deep.equals([])
    await act(async () => {
      inPress = true
      button('File').click()
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
