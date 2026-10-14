import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as ReactNative from 'react-native'

import { HeaderSlotProvider } from '../components/headerSlot'
import { ThemeProvider } from '../theme/ThemeContext'
import type { PickedFile } from './chatFileTypes'
import { ChatListScreen } from './ChatListScreen'
import { ChatOverlayHost } from './ChatOverlayHost'
import {
  chat,
  measureChatTestViewport,
  member,
  message,
  settleChatMessageActions,
  view
} from './chatViews.test.helpers'
import * as WebScroll from './chatWebInteractions'
import * as NativeScroll from './chatWebInteractions.native'
import { ChatWorkspace } from './ChatWorkspace'
import {
  type ChatDraft,
  ChatListNavigationCapture,
  type ChatListPositionCapture,
  type ChatWorkspaceState,
  emptyChatDraft,
  newChatWorkspaceState
} from './chatWorkspaceModel'
import { ConversationMenu } from './ConversationMenu'
import type { MessageView } from './engine/apply'
import type { ConversationListItem, ConversationView } from './engine/engine'
import type { ChatEngineEvent, ChatEngineListener } from './engine/store'
import { MessageBubble } from './MessageBubble'
import { MessageMenu } from './MessageMenu'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
let restoreViewport: (() => void) | undefined
const originalPointer = Object.getOwnPropertyDescriptor(
  globalThis,
  'matchMedia'
)
const originalVibration = Object.getOwnPropertyDescriptor(navigator, 'vibrate')

afterEach(async function () {
  await unmount()
  restoreViewport?.()
  restoreViewport = undefined
  if (originalPointer != null)
    Object.defineProperty(globalThis, 'matchMedia', originalPointer)
  else Reflect.deleteProperty(globalThis, 'matchMedia')
  if (originalVibration != null)
    Object.defineProperty(navigator, 'vibrate', originalVibration)
  else Reflect.deleteProperty(navigator, 'vibrate')
})

const wait = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement, fine = true): Promise<void> {
  restoreViewport ??= measureChatTestViewport()
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
  await settleChatMessageActions()
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = undefined
}

function button(label: string, within: ParentNode = document): HTMLElement {
  const found = [
    ...within.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label || node.textContent === label
  )
  expect(found, label).not.equals(undefined)
  return found!
}

async function press(
  label: string,
  within: ParentNode = document
): Promise<void> {
  await act(async () => {
    button(label, within).click()
    await wait()
  })
  await settleChatMessageActions()
}

function input(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let complete!: (value: T) => void
  let fail!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  return { promise, resolve: complete, reject: fail }
}

const original = (id = 'msg_original', mine = false): MessageView =>
  message({
    id,
    senderUserId: mine ? 1 : 2,
    senderName: mine ? 'Mookie Betts' : 'Shohei Ohtani',
    mine,
    body: id === 'msg_original' ? 'Practice notes' : 'Bring water'
  })

const prepared = (fileName = 'notes.pdf'): PickedFile => ({
  bytes: new Uint8Array([1]),
  contentType: 'application/pdf',
  fileName
})

class ReviewEngine implements ChatScreenEngine {
  views = new Map<string, ConversationView>(
    ['cnv_aurora', 'cnv_solstice'].map(id => [
      id,
      view({
        conversation: chat({
          id,
          title: id === 'cnv_aurora' ? 'Aurora Members' : 'Solstice Members',
          scopeName: id === 'cnv_aurora' ? 'Aurora' : 'Solstice'
        }),
        members: [member(1, 'Mookie Betts'), member(2, 'Shohei Ohtani')],
        messages: [original(), original('msg_second')]
      })
    ])
  )

  listeners = new Set<ChatEngineListener>()
  sent: Array<{
    id: string
    body?: string
    files: PickedFile[]
    options: unknown
  }> = []

  sendWork: Promise<void> = Promise.resolve()
  refreshWork: Promise<ConversationListItem[]> | undefined
  pinWork: Promise<void> = Promise.resolve()
  async start(): Promise<'ready'> {
    return 'ready'
  }

  async refresh(): Promise<ConversationListItem[]> {
    return await (this.refreshWork ?? Promise.resolve(this.conversations()))
  }

  conversations(): ConversationListItem[] {
    return [...this.views.values()].map(current => current.conversation)
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

  update(id: string, over: Partial<ConversationView>): void {
    this.views.set(id, { ...this.views.get(id)!, ...over })
    this.emit({ type: 'conversation', conversationId: id })
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

  async loadPreview(_id: string, _retry = false): Promise<void> {}
  async sendText(
    id: string,
    body: string,
    options: unknown
  ): Promise<undefined> {
    this.sent.push({ id, body, files: [], options })
    await this.sendWork
    return undefined
  }

  async attach(
    id: string,
    files: PickedFile[],
    body?: string,
    options?: unknown
  ): Promise<undefined> {
    this.sent.push({ id, body, files, options })
    await this.sendWork
    return undefined
  }

  async pinMessage(): Promise<void> {
    await this.pinWork
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
}

async function workspace(
  engine: ReviewEngine,
  state: ChatWorkspaceState,
  conversationId: string | null = 'cnv_aurora',
  userId = 1,
  listNavigation?: ChatListNavigationCapture
): Promise<void> {
  await render(
    <ChatOverlayHost>
      <ChatWorkspace
        engine={engine}
        userId={userId}
        state={state}
        listNavigation={listNavigation}
        conversationId={conversationId ?? undefined}
        onOpen={() => {}}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onTitle={() => {}}
      />
    </ChatOverlayHost>
  )
}

async function reply(id: string): Promise<void> {
  await press(
    'Reply',
    document.querySelector(`[data-testid="chat-message-${id}"]`)!
  )
}

function assertDraft(
  state: ChatWorkspaceState,
  text: string,
  replyId: string | undefined,
  names: string[]
): void {
  expect(input().value).equals(text)
  const saved = state.drafts.get('cnv_aurora')!
  expect(saved.text).equals(text)
  expect(saved.replyTo?.id).equals(replyId)
  expect(saved.picked.map(file => file.fileName)).deep.equals(names)
  expect(document.querySelector('[aria-label="Cancel reply"]') != null).equals(
    replyId != null
  )
  expect(
    [...document.querySelectorAll('[data-testid="chat-attachment-chip"]')].map(
      node => node.textContent
    )
  ).length(names.length)
}

describe('chat review persistent submission ownership', function () {
  for (const success of [true, false])
    it(`${success ? 'clears' : 'retains'} only the submitted draft when completion arrives while the workspace is unmounted`, async function () {
      const engine = new ReviewEngine()
      const send = deferred<undefined>()
      engine.sendWork = send.promise
      const state = newChatWorkspaceState()
      state.drafts.set('cnv_aurora', {
        ...emptyChatDraft(),
        text: 'Submitted caption',
        replyTo: original(),
        picked: [prepared()],
        scrollOffset: 240,
        hasScrollPosition: true,
        scrollAnchor: { id: 'msg_original', relativeY: -40 }
      })
      state.drafts.set('cnv_solstice', {
        ...emptyChatDraft(),
        text: 'Other unsent body',
        picked: [prepared('other.pdf')]
      })
      await workspace(engine, state)
      await press('Send')
      expect(engine.sent[0].options).deep.equals({ quoteId: 'msg_original' })
      await unmount()
      await act(async () => {
        if (success) send.resolve(undefined)
        else send.reject(new Error('Unavailable'))
        await wait()
      })
      await workspace(engine, state)
      assertDraft(
        state,
        success ? '' : 'Submitted caption',
        success ? undefined : 'msg_original',
        success ? [] : ['notes.pdf']
      )
      expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(240)
      expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: -40
      })
      await workspace(engine, state, 'cnv_solstice')
      expect(input().value).equals('Other unsent body')
      expect(
        document.querySelector('[data-testid="chat-attachment-chip"]')!
          .textContent
      ).contains('other.pdf')
      expect(engine.sent).length(1)
    })

  it('blocks the same pending send after A to B to A and a full workspace remount', async function () {
    const engine = new ReviewEngine()
    const send = deferred<undefined>()
    engine.sendWork = send.promise
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      ...emptyChatDraft(),
      text: 'Submitted body'
    })
    await workspace(engine, state)
    await press('Send')
    await workspace(engine, state, 'cnv_solstice')
    await workspace(engine, state)
    const disabledOnReturn = button('Send').getAttribute('aria-disabled')
    await unmount()
    await workspace(engine, state)
    await act(async () => {
      button('Send').click()
      input().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
      await wait()
    })
    expect(engine.sent).length(1)
    expect(disabledOnReturn).equals('true')
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    expect(input().value).equals('')
  })

  it('retains the entire newer text draft with its unchanged reply and file across routes and offscreen success', async function () {
    const engine = new ReviewEngine()
    const send = deferred<undefined>()
    engine.sendWork = send.promise
    const state = newChatWorkspaceState()
    const target = original()
    const attachment = prepared()
    state.drafts.set('cnv_aurora', {
      ...emptyChatDraft(),
      text: 'Submitted caption',
      replyTo: target,
      picked: [attachment]
    })
    await workspace(engine, state)
    await press('Send')
    await type('New unsent caption')
    assertDraft(state, 'New unsent caption', target.id, ['notes.pdf'])
    await workspace(engine, state, 'cnv_solstice')
    await unmount()
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    await workspace(engine, state)
    assertDraft(state, 'New unsent caption', target.id, ['notes.pdf'])
    expect(state.drafts.get('cnv_aurora')!.picked[0]).equals(attachment)
    expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(engine.sent).length(1)
    expect(engine.sent[0].options).deep.equals({ quoteId: target.id })
    expect(engine.sent[0].files[0]).equals(attachment)
  })

  it('clears the whole unchanged submitted context after width-only layout changes', async function () {
    const engine = new ReviewEngine()
    const send = deferred<undefined>()
    engine.sendWork = send.promise
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      ...emptyChatDraft(),
      text: 'Submitted caption',
      replyTo: original(),
      picked: [prepared()]
    })
    await workspace(engine, state)
    await press('Send')
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-workspace"]'
    )!
    await layout(node, 1200, 700)
    await layout(node, 320, 700)
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    assertDraft(state, '', undefined, [])
    expect(engine.sent).length(1)
  })

  for (const success of [true, false])
    it(`preserves current text, reply and replacement files after an old ${success ? 'successful' : 'failed'} send completes across remounts`, async function () {
      const engine = new ReviewEngine()
      const send = deferred<undefined>()
      engine.sendWork = send.promise
      const state = newChatWorkspaceState()
      state.drafts.set('cnv_aurora', {
        ...emptyChatDraft(),
        text: 'Submitted caption',
        replyTo: original(),
        picked: [prepared()]
      })
      await workspace(engine, state)
      await press('Send')
      await workspace(engine, state, 'cnv_solstice')
      // Prepared files are model input while A is unmounted. The active
      // composer's preparation UI is deliberately disabled during sending.
      const replacement = prepared()
      state.drafts.set('cnv_aurora', {
        ...state.drafts.get('cnv_aurora')!,
        picked: [replacement]
      })
      await workspace(engine, state)
      await type('New unsent caption')
      await press('Cancel reply')
      await reply('msg_second')
      expect(engine.sent).length(1)
      expect(replacement).not.equals(engine.sent[0].files[0])
      expect(state.drafts.get('cnv_aurora')!.picked).deep.equals([replacement])
      await unmount()
      await act(async () => {
        if (success) send.resolve(undefined)
        else send.reject(new Error('Unavailable'))
        await wait()
      })
      await workspace(engine, state)
      assertDraft(state, 'New unsent caption', 'msg_second', ['notes.pdf'])
      expect(state.drafts.get('cnv_aurora')!.picked[0]).equals(replacement)
      expect(button('Send').getAttribute('aria-disabled')).not.equals('true')
      if (!success)
        expect(document.body.textContent).contains(
          'That did not send. Try again.'
        )
    })

  it('preserves identical text and reply deliberately reentered after submission', async function () {
    const engine = new ReviewEngine()
    const send = deferred<undefined>()
    engine.sendWork = send.promise
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      ...emptyChatDraft(),
      text: 'Practice caption',
      replyTo: original(),
      picked: [prepared()]
    })
    await workspace(engine, state)
    await press('Send')
    await workspace(engine, state, 'cnv_solstice')
    const replacement = prepared()
    state.drafts.set('cnv_aurora', {
      ...state.drafts.get('cnv_aurora')!,
      picked: [replacement]
    })
    await workspace(engine, state)
    await type('')
    await type('Practice caption')
    await press('Cancel reply')
    await reply('msg_original')
    await act(async () => {
      send.resolve(undefined)
      await wait()
    })
    await workspace(engine, state, 'cnv_solstice')
    await workspace(engine, state)
    assertDraft(state, 'Practice caption', 'msg_original', ['notes.pdf'])
  })

  for (const boundary of ['engine', 'user'] as const)
    it(`isolates an old completion from a changed ${boundary} session using the same conversation ID`, async function () {
      const first = new ReviewEngine()
      const send = deferred<undefined>()
      first.sendWork = send.promise
      const state = newChatWorkspaceState()
      state.drafts.set('cnv_aurora', {
        ...emptyChatDraft(),
        text: 'Old session draft'
      })
      await workspace(first, state)
      await press('Send')
      const next = boundary === 'engine' ? new ReviewEngine() : first
      const userId = boundary === 'user' ? 2 : 1
      state.listAnchor = { id: 'cnv_aurora', relativeY: 12 }
      await workspace(next, state, 'cnv_aurora', userId)
      expect(
        state.listAnchor,
        'Old session list geometry is not reused'
      ).equals(undefined)
      expect(input().value).equals('')
      await type('Current session draft')
      await act(async () => {
        send.resolve(undefined)
        await wait()
      })
      await unmount()
      await workspace(next, state, 'cnv_aurora', userId)
      assertDraft(state, 'Current session draft', undefined, [])
    })
})

describe('chat review popup lifetime and accessible failures', function () {
  for (const focus of ['Pin', 'Delete'])
    it(`retains ${focus} keyboard focus while typing and conversation/read updates rerender the screen`, async function () {
      const engine = new ReviewEngine()
      engine.update('cnv_aurora', {
        messages: [original('msg_original', true)]
      })
      const state = newChatWorkspaceState()
      await workspace(engine, state)
      await press('More message actions')
      await act(async () => {
        button(focus).focus()
        await wait()
      })
      await type('Unsent body')
      expect(document.activeElement).equals(button(focus))
      await act(async () => {
        engine.update('cnv_aurora', {
          messages: [
            { ...original('msg_original', true), readBy: [2] },
            { ...original('msg_arrived'), seq: 3 }
          ],
          typing: [{ userId: 2, name: 'Shohei Ohtani' }]
        })
        engine.emit({ type: 'conversations' })
        await wait()
      })
      expect(document.activeElement).equals(button(focus))
    })

  for (const desktop of [true, false])
    it(`keeps ${desktop ? 'anchored' : 'overlay'} focus and invokes the latest Escape close callback`, async function () {
      const closes: number[] = []
      const anchor = document.createElement('button')
      document.body.append(anchor)
      const menu = (revision: number): React.ReactElement => (
        <ChatOverlayHost>
          <MessageMenu
            message={original('msg_original', true)}
            actions={['copy', 'pin', 'delete']}
            desktop={desktop}
            anchor={anchor}
            onReply={() => {}}
            onReact={() => {}}
            onMoreEmoji={() => {}}
            onDelete={() => {}}
            onClose={() => closes.push(revision)}
          />
        </ChatOverlayHost>
      )
      await render(menu(1))
      await act(async () => {
        button('Delete').focus()
        await wait()
      })
      await render(menu(2))
      expect(document.activeElement).equals(button('Delete'))
      await act(async () => {
        document.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true
          })
        )
        await wait()
      })
      expect(closes).deep.equals([2])
    })

  it('dismisses a failed Pin action and exposes a reachable error before retry', async function () {
    const engine = new ReviewEngine()
    const pin = deferred<undefined>()
    engine.pinWork = pin.promise
    const state = newChatWorkspaceState()
    await workspace(engine, state)
    await press('More message actions')
    await press('Pin')
    await act(async () => {
      pin.reject(new Error('Unavailable'))
      await wait()
    })
    const error = [...document.querySelectorAll<HTMLElement>('*')].find(
      node =>
        node.childElementCount === 0 &&
        [
          'Could not update this message pin. Try again.',
          'That did not send. Try again.'
        ].includes(node.textContent ?? '')
    )
    expect(error, 'Visible Pin failure').not.equals(undefined)
    expect(error!.closest('[aria-hidden="true"]')).equals(null)
    expect(error!.textContent).equals(
      'Could not update this message pin. Try again.'
    )
    expect(document.querySelector('[aria-label="Copy text"]')).equals(null)
    await press('More message actions')
    expect(button('Pin').closest('[aria-hidden="true"]')).equals(null)
  })
})

async function layout(
  node: HTMLElement,
  width: number,
  height: number,
  y = 0
): Promise<void> {
  const handler = (
    node as HTMLElement & { __reactLayoutHandler?: (event: unknown) => void }
  ).__reactLayoutHandler
  expect(handler, 'Rendered native layout handler').not.equals(undefined)
  await act(async () => {
    handler!({ nativeEvent: { layout: { x: 0, y, width, height } } })
    await wait()
  })
}

describe('chat review list return restoration', function () {
  it('keeps the saved list offset through an empty viewport and deferred refresh until populated geometry can restore it', async function () {
    const engine = new ReviewEngine()
    const refreshed = deferred<ConversationListItem[]>()
    engine.refreshWork = refreshed.promise
    const offsets: number[] = []
    await render(
      <ChatListScreen
        engine={engine}
        embedded
        initialOffset={240}
        onOffset={offset => offsets.push(offset)}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    const scroll = [...document.querySelectorAll<HTMLElement>('div')].find(
      node => getComputedStyle(node).overflowY === 'auto'
    )!
    expect(scroll, 'Rendered list scroll view').not.equals(undefined)
    let contentHeight = 0
    const moves: number[] = []
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => contentHeight },
      clientHeight: { configurable: true, value: 400 }
    })
    scroll.scroll = options => {
      const top = (options as ScrollToOptions).top ?? 0
      moves.push(top)
      scroll.scrollTop = Math.min(top, Math.max(0, contentHeight - 400))
    }
    await layout(scroll, 320, 400)
    await layout(scroll.firstElementChild as HTMLElement, 320, 100)
    await act(async () => {
      scroll.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(150)
    })
    expect(moves, 'Empty geometry must not consume restoration').deep.equals([])
    expect(
      offsets,
      'Empty scroll must not overwrite saved position'
    ).deep.equals([])
    await act(async () => {
      refreshed.resolve(
        Array.from({ length: 16 }, (_, index) =>
          chat({
            id: `cnv_list_${index}`,
            title: `Aurora ${index} Members`,
            scopeName: `Aurora ${index}`
          })
        )
      )
      await wait()
    })
    expect(document.body.textContent).contains('Aurora 15')
    contentHeight = 500
    await layout(scroll.firstElementChild as HTMLElement, 320, contentHeight)
    expect(
      moves,
      'Intermediate reveal must not consume the saved offset'
    ).deep.equals([100])
    expect(
      offsets,
      'Intermediate offset is not the saved reading position'
    ).deep.equals([])
    contentHeight = 1800
    await layout(scroll.firstElementChild as HTMLElement, 320, contentHeight)
    expect(moves).deep.equals([100, 240])
    expect(scroll.scrollTop).equals(240)
    await layout(scroll.firstElementChild as HTMLElement, 320, 1900)
    expect(moves, 'Later content must not repeat restoration').deep.equals([
      100, 240
    ])
  })

  it('clamps a genuinely shorter fetched list only after its populated geometry and saves the resulting position', async function () {
    const pending = await returningList()
    await pending.populate(2)
    expect(
      pending.moves,
      'Fetched data alone must not reuse the empty layout'
    ).deep.equals([])
    expect(pending.offsets).deep.equals([])
    setListRowMeasurement('cnv_return_1', 420, listTailHeight(80))
    const lastRow = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_1"]'
    )!.parentElement!
    // Native layout is delivered only if this rendered row observes it.
    // An unobserved row still participates in the final content geometry.
    if (
      typeof (lastRow as HTMLElement & { __reactLayoutHandler?: unknown })
        .__reactLayoutHandler === 'function'
    )
      await layout(lastRow, 320, listTailHeight(80))
    expect(
      pending.moves,
      'Measured rows must not reuse empty content geometry'
    ).deep.equals([])
    await pending.content(500)
    expect(pending.moves).deep.equals([100])
    expect(pending.node.scrollTop).equals(100)
    await pending.scroll(100)
    expect(pending.offsets.at(-1)).equals(100)
    await pending.content(510)
    expect(
      pending.moves,
      'The completed clamp must not be reapplied'
    ).deep.equals([100])
  })

  for (const intent of ['wheel', 'PageDown'])
    it(`honors actual ${intent} intent before restored geometry and never jumps back after later data layout`, async function () {
      const pending = await returningList()
      await pending.populate(8)
      expect(pending.moves).deep.equals([])
      // The DOM can scroll before its content-size notification reaches RNW.
      // This is current user input, not a programmatic restoration event.
      pending.setDomContent(500)
      await act(async () => {
        pending.node.dispatchEvent(
          intent === 'wheel'
            ? new window.WheelEvent('wheel', { bubbles: true, deltaY: 80 })
            : new window.KeyboardEvent('keydown', {
                bubbles: true,
                key: intent
              })
        )
        await wait()
      })
      await pending.scroll(80)
      expect(
        pending.offsets.at(-1),
        'User position recorded during pending restore'
      ).equals(80)
      await pending.content(1800)
      expect(
        pending.moves,
        'Later fetched geometry must not restore over the reader'
      ).deep.equals([])
      expect(pending.node.scrollTop).equals(80)
      expect(pending.offsets.at(-1)).equals(80)
    })

  it('restores measured populated rows through a same-ID metadata refresh without another content-size event', async function () {
    const pending = await returningList(false)
    await pending.populate(8)
    await pending.content(1800)
    expect(pending.moves, 'Viewport geometry is not available yet').deep.equals(
      []
    )
    await pending.refreshMetadata()
    expect(
      document.querySelector('[data-testid="chat-conversation-cnv_return_0"]')!
        .textContent
    ).contains('Updated practice preview')
    await layout(pending.node, 320, 400)
    expect(pending.moves).deep.equals([240])
    expect(pending.node.scrollTop).equals(240)
  })
})

async function returningList(
  measureViewport = true,
  initialOffset = 240,
  initialAnchor?: { id: string; relativeY: number },
  navigationHeight = 0
): Promise<{
  node: HTMLElement
  moves: number[]
  offsets: number[]
  anchors: Array<{ id: string; relativeY: number } | undefined>
  capture: () => Promise<void>
  captureAvailable: () => boolean
  populate: (count: number) => Promise<void>
  refreshMetadata: () => Promise<void>
  reorder: (id?: string) => Promise<void>
  setDomContent: (height: number) => void
  content: (height: number) => Promise<void>
  scroll: (top: number) => Promise<void>
  hide: () => Promise<void>
  show: () => Promise<void>
  replace: (count: number) => Promise<void>
}> {
  const engine = new ReviewEngine()
  const refreshed = deferred<ConversationListItem[]>()
  if (navigationHeight > 0)
    restoreViewport ??= measureChatTestViewport({ width: 390, height: 844 })
  engine.refreshWork = refreshed.promise
  const offsets: number[] = []
  const anchors: Array<{ id: string; relativeY: number } | undefined> = []
  let rows: ConversationListItem[] = []
  let capture: ChatListPositionCapture | undefined
  const registerCapture = (read: ChatListPositionCapture): (() => void) => {
    capture = read
    return () => {
      if (capture === read) capture = undefined
    }
  }
  // This fixture measures a list pane without the shell's floating tab bar.
  // The phone tab-bar clearance is exercised by the measured-chrome suite.
  const scene = (child: React.ReactNode): React.ReactElement => (
    <HeaderSlotProvider
      headerHeight={48}
      navigationHeight={navigationHeight}
      onHandoff={() => {}}
    >
      {child}
    </HeaderSlotProvider>
  )
  await render(
    scene(
      <ChatListScreen
        engine={engine}
        embedded
        registerPositionCapture={registerCapture}
        initialOffset={initialOffset}
        initialAnchor={initialAnchor}
        onOffset={offset => offsets.push(offset)}
        onAnchor={anchor => anchors.push(anchor)}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
  )
  const node = [...document.querySelectorAll<HTMLElement>('div')].find(
    element => getComputedStyle(element).overflowY === 'auto'
  )!
  expect(node, 'Returning list scroll view').not.equals(undefined)
  let contentHeight = 100
  const moves: number[] = []
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, value: 400 }
  })
  node.scroll = options => {
    const top = (options as ScrollToOptions).top ?? 0
    moves.push(top)
    node.scrollTop = Math.min(top, Math.max(0, contentHeight - 400))
  }
  if (measureViewport) await layout(node, 320, 400)
  await layout(node.firstElementChild as HTMLElement, 320, contentHeight)
  return {
    node,
    moves,
    offsets,
    anchors,
    capture: async () => {
      await capture?.()
    },
    captureAvailable: () => capture != null,
    populate: async count => {
      await act(async () => {
        rows = Array.from({ length: count }, (_, index) =>
          chat({
            id: `cnv_return_${index}`,
            title: `Solstice ${index} Members`,
            scopeName: `Solstice ${index}`
          })
        )
        refreshed.resolve(rows)
        await wait()
      })
    },
    reorder: async (id = 'cnv_return_3') => {
      await act(async () => {
        rows = rows.map(row => ({
          ...row,
          lastPostAt: row.id === id ? '2026-01-02T00:00:00Z' : null
        }))
        engine.conversations = () => rows
        engine.emit({ type: 'conversations' })
        await wait()
      })
    },
    refreshMetadata: async () => {
      await act(async () => {
        rows = rows.map(row => ({
          ...row,
          preview: 'Updated practice preview',
          unread: 1
        }))
        engine.conversations = () => rows
        engine.emit({ type: 'conversations' })
        await wait()
      })
    },
    setDomContent: height => {
      contentHeight = height
    },
    content: async height => {
      contentHeight = height
      await layout(node.firstElementChild as HTMLElement, 320, height)
    },
    scroll: async top => {
      await act(async () => {
        node.scrollTop = top
        node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await wait(150)
      })
    },
    hide: async () => {
      await render(
        scene(
          <ChatListScreen
            engine={engine}
            embedded
            narrow
            selectedVisible
            registerPositionCapture={registerCapture}
            initialOffset={initialOffset}
            initialAnchor={initialAnchor}
            onOffset={offset => offsets.push(offset)}
            onAnchor={anchor => anchors.push(anchor)}
            onOpen={() => {}}
            onNewMessage={() => {}}
          />
        )
      )
    },
    show: async () => {
      await render(
        scene(
          <ChatListScreen
            engine={engine}
            embedded
            narrow
            selectedVisible={false}
            registerPositionCapture={registerCapture}
            initialOffset={initialOffset}
            initialAnchor={initialAnchor}
            onOffset={offset => offsets.push(offset)}
            onAnchor={anchor => anchors.push(anchor)}
            onOpen={() => {}}
            onNewMessage={() => {}}
          />
        )
      )
    },
    replace: async count => {
      await act(async () => {
        rows = Array.from({ length: count }, (_, index) =>
          chat({
            id: `cnv_replacement_${index}`,
            title: `Aurora ${index} Members`,
            scopeName: `Aurora ${index}`
          })
        )
        engine.conversations = () => rows
        engine.refreshWork = Promise.resolve(rows)
        engine.emit({ type: 'conversations' })
        await wait()
      })
    }
  }
}

interface ReadingScrollEvent {
  nativeEvent: {
    contentOffset: { x: number; y: number }
    contentSize: { width: number; height: number }
    layoutMeasurement: { width: number; height: number }
  }
}

type ScrollPhase = 'onScroll' | 'onScrollEndDrag' | 'onMomentumScrollEnd'
type ScrollCallbacks = Partial<
  Record<ScrollPhase, (event: ReadingScrollEvent) => void>
>

function renderedReadingCallbacks(node: HTMLElement): ScrollCallbacks {
  interface RenderedFiber {
    memoizedProps?: ScrollCallbacks & { onContentSizeChange?: unknown }
    return?: RenderedFiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, RenderedFiber | undefined>)[
    key
  ]
  while (fiber != null) {
    if (typeof fiber.memoizedProps?.onContentSizeChange === 'function')
      return fiber.memoizedProps
    fiber = fiber.return
  }
  throw new Error('Rendered message ScrollView not found')
}

function terminalReadingPane(): {
  node: HTMLElement
  moves: number[]
  measure: () => Promise<void>
  deliver: (
    callbacks: ScrollCallbacks,
    phase: ScrollPhase,
    offset: number
  ) => Promise<void>
} {
  const pane = document.querySelector('[data-testid="chat-message-pane"]')!
  const node = [...pane.querySelectorAll<HTMLElement>('div')].find(
    element => getComputedStyle(element).overflowY === 'auto'
  )!
  expect(node, 'Actual message scroll view').not.equals(undefined)
  const body = node.firstElementChild as HTMLElement
  const row = document.querySelector<HTMLElement>(
    '[data-testid="chat-message-msg_original"]'
  )!.parentElement!
  const moves: number[] = []
  node.getBoundingClientRect = () => new window.DOMRect(0, 0, 640, 400)
  body.getBoundingClientRect = () =>
    new window.DOMRect(0, -node.scrollTop, 640, 2200)
  row.getBoundingClientRect = () =>
    new window.DOMRect(0, -node.scrollTop, 640, 1000)
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 2200 },
    clientHeight: { configurable: true, value: 400 },
    offsetHeight: { configurable: true, value: 400 },
    offsetWidth: { configurable: true, value: 640 }
  })
  Object.defineProperties(body, {
    offsetParent: { configurable: true, value: node },
    offsetHeight: { configurable: true, value: 2200 },
    offsetWidth: { configurable: true, value: 640 }
  })
  Object.defineProperties(row, {
    offsetParent: { configurable: true, value: body },
    offsetTop: { configurable: true, value: 0 },
    offsetHeight: { configurable: true, value: 1000 },
    offsetWidth: { configurable: true, value: 640 }
  })
  node.scroll = options => {
    const top = (options as ScrollToOptions).top ?? 0
    moves.push(top)
    node.scrollTop = Math.min(top, 1800)
  }
  return {
    node,
    moves,
    measure: async () => {
      await layout(node, 640, 400)
      await layout(body, 640, 2200)
      await layout(row, 640, 1000)
      await act(async () => {
        await wait(80)
      })
    },
    deliver: async (callbacks, phase, offset) => {
      await act(async () => {
        node.scrollTop = offset
        callbacks[phase]?.({
          nativeEvent: {
            contentOffset: { x: 0, y: offset },
            contentSize: { width: 640, height: 2200 },
            layoutMeasurement: { width: 640, height: 400 }
          }
        })
        await wait()
      })
    }
  }
}

function terminalDraft(): ChatDraft {
  return {
    ...emptyChatDraft(),
    text: 'Current unsent body',
    replyTo: original(),
    picked: [prepared()],
    scrollOffset: 22,
    hasScrollPosition: true,
    followNewest: false
  }
}

describe('chat measured chrome reader anchors', function () {
  for (const initialY of [56, -700])
    it(`defers newly covering first-pin clearance until spotlight exit and preserves a clipped reader (${initialY})`, async function () {
      const engine = new ReviewEngine()
      engine.update('cnv_aurora', { messages: [original()], pins: [] })
      const state = newChatWorkspaceState()
      state.drafts.set('cnv_aurora', { ...terminalDraft(), scrollOffset: 1000 })
      await render(
        <HeaderSlotProvider
          headerHeight={48}
          navigationHeight={0}
          onHandoff={() => {}}
        >
          <ChatOverlayHost>
            <ChatWorkspace
              engine={engine}
              userId={1}
              state={state}
              conversationId="cnv_aurora"
              onOpen={() => {}}
              onMembers={() => {}}
              onNewMessage={() => {}}
              onTitle={() => {}}
            />
          </ChatOverlayHost>
        </HeaderSlotProvider>,
        false
      )
      await layout(
        document.querySelector('[data-testid="chat-workspace"]')!,
        390,
        844
      )
      const reading = terminalReadingPane()
      await reading.measure()
      const row = document.querySelector<HTMLElement>(
        '[data-testid="chat-message-msg_original"]'
      )!.parentElement!
      const contentY = 1000 + initialY
      Object.defineProperty(row, 'offsetTop', {
        configurable: true,
        value: contentY
      })
      row.getBoundingClientRect = () =>
        new window.DOMRect(0, contentY - reading.node.scrollTop, 640, 1000)
      document.querySelector<HTMLElement>(
        '[data-testid="chat-bubble-msg_original"]'
      )!.getBoundingClientRect = () =>
        new window.DOMRect(42, initialY, 210, 1000)
      await layout(row, 640, 1000, contentY)
      await act(async () => {
        reading.node.scrollTop = 1000
        reading.node.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
        )
        await wait()
      })
      await reading.deliver(
        renderedReadingCallbacks(reading.node),
        'onScroll',
        1000
      )
      await press('More message actions')
      await act(async () => {
        button('Pin').click()
        await wait(20)
        engine.update('cnv_aurora', {
          pins: [
            { messageId: 'msg_original', pinnedAt: '2027-04-01T17:00:00Z' }
          ]
        })
        await wait(20)
      })
      await layout(
        document.querySelector('[data-testid="chat-pinned-band"]')!,
        640,
        64
      )
      expect(
        row.getBoundingClientRect().top,
        'Background remains fixed during exit'
      ).equals(initialY)
      await settleChatMessageActions('closed')
      await act(async () => {
        await wait(80)
      })
      const expected = initialY === 56 ? 120 : initialY
      expect(
        row.getBoundingClientRect().top,
        'Only the newly covered leading edge is revealed after exit'
      ).equals(expected)
      await act(async () => {
        engine.update('cnv_aurora', { pins: [] })
        await wait(80)
      })
      expect(
        row.getBoundingClientRect().top,
        'Last unpin keeps the current reader'
      ).equals(expected)
      expect(state.drafts.get('cnv_aurora')!.text).equals('Current unsent body')
    })

  it('holds the actual reader through spotlight opening arrivals composer growth and closing, then leaves new posts below', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      ...terminalDraft(),
      scrollOffset: 1800,
      followNewest: true
    })
    await render(
      <ChatOverlayHost>
        <ChatWorkspace
          engine={engine}
          userId={1}
          state={state}
          conversationId="cnv_aurora"
          onOpen={() => {}}
          onMembers={() => {}}
          onNewMessage={() => {}}
          onTitle={() => {}}
        />
      </ChatOverlayHost>,
      false
    )
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      390,
      844
    )
    const reading = terminalReadingPane()
    await reading.measure()
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_original"]'
    )!.parentElement!
    Object.defineProperty(row, 'offsetTop', { configurable: true, value: 1800 })
    row.getBoundingClientRect = () =>
      new window.DOMRect(0, 1800 - reading.node.scrollTop, 640, 180)
    await layout(row, 640, 180, 1800)
    await reading.deliver(
      renderedReadingCallbacks(reading.node),
      'onScroll',
      1800
    )
    document.querySelector<HTMLElement>(
      '[data-testid="chat-bubble-msg_original"]'
    )!.getBoundingClientRect = () => new window.DOMRect(42, 100, 210, 180)
    reading.node.scroll = options => {
      const top = (options as ScrollToOptions).top ?? 0
      reading.moves.push(top)
      reading.node.scrollTop = Math.min(
        top,
        reading.node.scrollHeight - reading.node.clientHeight
      )
    }
    const content = (): void => {
      Object.defineProperty(reading.node, 'scrollHeight', {
        configurable: true,
        value: 3000
      })
      const callbacks = renderedReadingCallbacks(
        reading.node
      ) as ScrollCallbacks & {
        onContentSizeChange: (width: number, height: number) => void
      }
      callbacks.onContentSizeChange(640, 3000)
    }
    reading.moves.length = 0
    await act(async () => {
      button('More message actions').click()
      await wait(20)
      engine.update('cnv_aurora', {
        messages: [original(), { ...original('msg_arrival'), seq: 2 }]
      })
      content()
      await wait(30)
    })
    await settleChatMessageActions('open')
    expect(
      reading.node.scrollTop,
      'Opening arrival keeps the physical reader'
    ).equals(1800)
    await layout(
      document.querySelector('[data-testid="chat-composer-band"]')!,
      640,
      120
    )
    await act(async () => {
      content()
      await wait(40)
    })
    expect(
      reading.node.scrollTop,
      'Composer clearance cannot follow the arriving post'
    ).equals(1800)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-message-spotlight"]')!
        .dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      await wait(20)
      content()
      await wait(30)
    })
    await settleChatMessageActions('closed')
    expect(
      reading.node.scrollTop,
      'Closing keeps the same row coordinate'
    ).equals(1800)
    expect(
      reading.moves.every(move => move === 1800),
      'No stage asks to follow the new end'
    ).equals(true)
    expect(state.drafts.get('cnv_aurora')!.text).equals('Current unsent body')
    expect(state.drafts.get('cnv_aurora')!.followNewest).equals(false)
    reading.moves.length = 0
    await act(async () => {
      content()
      await wait(40)
    })
    expect(
      reading.moves,
      'Dismissal retains the reader with unseen posts below'
    ).deep.equals([])
    await reading.deliver(
      renderedReadingCallbacks(reading.node),
      'onScroll',
      2600
    )
    await act(async () => {
      Object.defineProperty(reading.node, 'scrollHeight', {
        configurable: true,
        value: 3400
      })
      ;(
        renderedReadingCallbacks(reading.node) as ScrollCallbacks & {
          onContentSizeChange: (width: number, height: number) => void
        }
      ).onContentSizeChange(640, 3400)
      await wait(40)
    })
    expect(
      reading.node.scrollTop,
      'Returning to the end resumes ordinary following'
    ).equals(3000)
  })

  it('keeps the same partially visible tall row when the composer grows and floating pins appear or disappear', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', {
      ...terminalDraft(),
      scrollOffset: 700,
      scrollAnchor: { id: 'msg_original', relativeY: -700 }
    })
    await workspace(engine, state)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      390,
      844
    )
    const reading = terminalReadingPane()
    await reading.measure()
    expect(reading.node.scrollTop).equals(700)
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_original"]'
    )!.parentElement!
    const relative = (): number =>
      row.getBoundingClientRect().top - reading.node.getBoundingClientRect().top
    expect(relative()).equals(-700)
    reading.moves.length = 0
    await layout(
      document.querySelector('[data-testid="chat-composer-band"]')!,
      640,
      96
    )
    await act(async () => {
      await wait(80)
    })
    expect(reading.node.scrollTop).equals(700)
    expect(
      relative(),
      'Composer growth preserves the actual reading row'
    ).equals(-700)
    expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
      id: 'msg_original',
      relativeY: -700
    })
    await act(async () => {
      engine.update('cnv_aurora', {
        pins: [{ messageId: 'msg_original', pinnedAt: '2027-04-01T17:00:00Z' }]
      })
      await wait()
    })
    await layout(
      document.querySelector('[data-testid="chat-pinned-band"]')!,
      640,
      64
    )
    expect(
      relative(),
      'A measured floating pin preserves the partially visible row'
    ).equals(-700)
    await act(async () => {
      engine.update('cnv_aurora', { pins: [] })
      await wait(60)
    })
    expect(document.querySelector('[data-testid="chat-pinned-band"]')).equals(
      null
    )
    expect(relative(), 'Last unpin preserves the same reader').equals(-700)
    expect(reading.node.scrollTop).equals(700)
  })
})

describe('chat review final native scroll positions', function () {
  it('saves the final drag and momentum zero offsets instead of the last throttled position and reopens at the first row', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    const tokens = [{ userId: 2, start: 0, end: 14, label: '@Shohei Ohtani' }]
    state.drafts.set('cnv_aurora', {
      ...terminalDraft(),
      text: '@Shohei Ohtani ',
      mentionTokens: tokens
    })
    await workspace(engine, state)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      320,
      700
    )
    const reading = terminalReadingPane()
    await reading.measure()
    await act(async () => {
      reading.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: -1 })
      )
      await wait()
    })
    const callbacks = renderedReadingCallbacks(reading.node)
    const deliverNative = async (
      phase: ScrollPhase,
      offset: number
    ): Promise<void> => {
      const descriptor = Object.getOwnPropertyDescriptor(
        ReactNative.Platform,
        'OS'
      )!
      Object.defineProperty(ReactNative.Platform, 'OS', {
        configurable: true,
        value: 'ios'
      })
      try {
        await reading.deliver(callbacks, phase, offset)
      } finally {
        Object.defineProperty(ReactNative.Platform, 'OS', descriptor)
      }
    }
    for (const phase of ['onScrollEndDrag', 'onMomentumScrollEnd'] as const) {
      await deliverNative('onScroll', 22.095)
      expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(22.095)
      expect(
        state.drafts.get('cnv_aurora')!.mentionTokens,
        'Ordinary native scroll preserves selected encrypted IDs'
      ).deep.equals(tokens)
      await deliverNative(phase, 0)
      const saved = state.drafts.get('cnv_aurora')!
      expect(saved.scrollOffset, `${phase} carries the real final edge`).equals(
        0
      )
      expect(saved.hasScrollPosition).equals(true)
      expect(saved.followNewest).equals(false)
      expect(
        saved.mentionTokens,
        'Final drag and momentum preserve mention ownership'
      ).deep.equals(tokens)
      expect(saved.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: 0
      })
    }
    await workspace(engine, state, null)
    await workspace(engine, state, 'cnv_solstice')
    await workspace(engine, state, null)
    await workspace(engine, state)
    const reopened = terminalReadingPane()
    await reopened.measure()
    expect(reopened.moves).contains(0)
    expect(
      reopened.moves.some(offset => offset > 0),
      'No stale offset or newest-follow restoration'
    ).equals(false)
    expect(reopened.node.scrollTop).equals(0)
    expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(0)
    expect(state.drafts.get('cnv_aurora')!.mentionTokens).deep.equals(tokens)
    expect(state.drafts.get('cnv_aurora')!.text).equals('@Shohei Ohtani ')
    expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
      id: 'msg_original',
      relativeY: 0
    })
  })

  it('ignores queued retained drag and momentum endings after the pane hides or unmounts without writing drafts or commanding scroll', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', terminalDraft())
    await workspace(engine, state)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      320,
      700
    )
    const reading = terminalReadingPane()
    await reading.measure()
    await act(async () => {
      reading.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
      await wait()
    })
    const retained = renderedReadingCallbacks(reading.node)
    await reading.deliver(retained, 'onScroll', 22)
    await workspace(engine, state, null)
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.display
    ).equals('none')
    const hidden = state.drafts.get('cnv_aurora')!
    reading.moves.length = 0
    await reading.deliver(retained, 'onScrollEndDrag', 0)
    await reading.deliver(retained, 'onMomentumScrollEnd', 999)
    expect(
      state.drafts.get('cnv_aurora'),
      'Hidden callbacks must not write'
    ).equals(hidden)
    expect(hidden.scrollOffset).equals(22)
    expect(hidden.text).equals('Current unsent body')
    expect(hidden.replyTo?.id).equals('msg_original')
    expect(hidden.picked.map(file => file.fileName)).deep.equals(['notes.pdf'])
    expect(reading.moves).deep.equals([])
    await unmount()
    const removed = state.drafts.get('cnv_aurora')
    await reading.deliver(retained, 'onScrollEndDrag', 888)
    await reading.deliver(retained, 'onMomentumScrollEnd', 0)
    expect(
      state.drafts.get('cnv_aurora'),
      'Unmounted callbacks must not write'
    ).equals(removed)
    expect(reading.moves).deep.equals([])
  })
})

interface NativeContact {
  timestamp: number
  identifier: number
  pageX: number
  pageY: number
}

interface NativePressEvent {
  nativeEvent: Partial<NativeContact> & {
    touches?: NativeContact[]
    changedTouches?: NativeContact[]
  }
}

type PressPhase =
  'onPressIn' | 'onPress' | 'onLongPress' | 'onTouchMove' | 'onTouchCancel'
type NativePressCallbacks = Partial<
  Record<PressPhase, (event: NativePressEvent) => void>
>
type NativeTarget = 'body' | 'file' | 'video' | 'quote' | 'reaction'

function contact(
  timestamp: number,
  identifier = 7,
  x = 20,
  stamp: 'direct' | 'array' = 'direct'
): NativePressEvent {
  const point = { timestamp, identifier, pageX: x, pageY: 20 }
  const event: NativePressEvent = {
    nativeEvent: { ...point, touches: [point], changedTouches: [point] }
  }
  if (stamp === 'array') {
    delete event.nativeEvent.timestamp
    delete event.nativeEvent.identifier
  }
  return event
}

function renderedPressCallbacks(node: HTMLElement): NativePressCallbacks {
  interface RenderedFiber {
    memoizedProps?: NativePressCallbacks
    return?: RenderedFiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, RenderedFiber | undefined>)[
    key
  ]
  while (fiber != null) {
    if (typeof fiber.memoizedProps?.onPressIn === 'function')
      return fiber.memoizedProps
    fiber = fiber.return
  }
  throw new Error('Rendered native Pressable callbacks not found')
}

async function nativePress(
  callbacks: NativePressCallbacks,
  phase: PressPhase,
  event: NativePressEvent
): Promise<void> {
  // Deliver native-time packets immediately, without PressOut or advancing
  // the JavaScript hold timer. Pressability may defer its JS PressOut signal.
  await act(async () => {
    callbacks[phase]?.(event)
    await Promise.resolve()
  })
}

async function compressedRelease(
  callbacks: NativePressCallbacks,
  start: NativePressEvent,
  release: NativePressEvent
): Promise<void> {
  // Both packets run in the same JS turn, including releases delivered before
  // Pressability's minimum JS press duration. The child must gate its action.
  await act(async () => {
    callbacks.onPressIn?.(start)
    callbacks.onPress?.(release)
    await Promise.resolve()
  })
}

let nativeFixture = 0
async function nativeGesture(kind: NativeTarget): Promise<{
  target: NativePressCallbacks
  body: NativePressCallbacks
  opens: string[]
  short: string[]
  pulses: number[]
  generation: { current: number }
}> {
  const opens: string[] = []
  const short: string[] = []
  const pulses: number[] = []
  const generation = { current: 0 }
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (duration: number) => {
      pulses.push(duration)
      return true
    }
  })
  const value = original(`msg_native_${kind}`)
  value.body = 'Practice notes'
  if (kind === 'file' || kind === 'video')
    value.attachments = [
      {
        id: `cat_native_${kind}`,
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        size: 1,
        contentType: kind === 'file' ? 'application/pdf' : 'video/mp4',
        fileName: kind === 'file' ? 'notes.pdf' : 'practice-clip.mp4',
        ...(kind === 'video' ? { width: 640, height: 360 } : {})
      }
    ]
  if (kind === 'quote')
    value.quote = {
      id: 'msg_original',
      authorId: 2,
      authorName: 'Shohei Ohtani',
      snippet: 'Practice notes',
      status: 'ok'
    }
  if (kind === 'reaction')
    value.reactions = [{ emoji: '👍', userIds: [2], mine: false }]
  await render(
    <MessageBubble
      key={++nativeFixture}
      message={value}
      conversation={chat()}
      members={[member(2, 'Shohei Ohtani')]}
      engine={{
        openAttachment: async attachment => {
          short.push(`fetch:${attachment.id}`)
          return new Uint8Array([1])
        }
      }}
      files={{
        bytesUri: async () => {
          short.push('uri')
          return 'blob:fixture-video'
        },
        releaseUri: async () => {},
        saveFile: async () => {
          short.push('save')
        }
      }}
      maxWidth={320}
      swipe={false}
      gestureGeneration={generation}
      onLongPress={selected => opens.push(selected.id)}
      onReply={() => {}}
      onJump={id => short.push(`jump:${id}`)}
      onToggleReaction={(_message, emoji) => short.push(`react:${emoji}`)}
    />,
    false
  )
  const body = document.querySelector<HTMLElement>(
    `[data-testid="chat-bubble-${value.id}"]`
  )!
  Object.defineProperty(body, 'measureInWindow', {
    configurable: true,
    value: (
      accept: (x: number, y: number, width: number, height: number) => void
    ) => {
      accept(24, 160, 260, 100)
    }
  })
  const target =
    kind === 'body'
      ? body
      : button(
          {
            file: 'Save notes.pdf',
            video: 'Open practice-clip.mp4',
            quote: 'Jump to message from Shohei Ohtani: Practice notes',
            reaction: '👍, 1'
          }[kind]
        )
  return {
    body: renderedPressCallbacks(body),
    target: renderedPressCallbacks(target),
    opens,
    short,
    pulses,
    generation
  }
}

function expectedShort(kind: NativeTarget): string[] {
  switch (kind) {
    case 'file':
      return ['fetch:cat_native_file', 'save']
    case 'video':
      return ['fetch:cat_native_video', 'uri']
    case 'quote':
      return ['jump:msg_original']
    case 'reaction':
      return ['react:👍']
    default:
      return []
  }
}

describe('chat review native-time message holds', function () {
  for (const duration of [80, 499, 500, 568])
    it(`uses native body duration ${duration} without waiting for the JavaScript timer or delayed PressOut`, async function () {
      for (const stamp of ['direct', 'array'] as const) {
        const value = await nativeGesture('body')
        const release = contact(1000 + duration, 7, 20, stamp)
        release.nativeEvent.touches = []
        await compressedRelease(
          value.target,
          contact(1000, 7, 20, stamp),
          release
        )
        expect(value.opens, stamp).deep.equals(
          duration >= 500 ? ['msg_native_body'] : []
        )
        expect(value.pulses).deep.equals(duration >= 500 ? [8] : [])
        expect(value.short).deep.equals([])
      }
    })

  for (const kind of ['file', 'video', 'quote', 'reaction'] as const)
    it(`preserves ${kind} short activation and suppresses it for compressed native 500/568 holds`, async function () {
      for (const stamp of ['direct', 'array'] as const)
        for (const duration of [80, 499, 500, 568]) {
          const value = await nativeGesture(kind)
          const release = contact(1000 + duration, 7, 20, stamp)
          release.nativeEvent.touches = []
          await compressedRelease(
            value.target,
            contact(1000, 7, 20, stamp),
            release
          )
          await act(async () => {
            await wait()
          })
          const long = duration >= 500
          expect(
            value.opens,
            `${kind} ${stamp} native ${duration}`
          ).deep.equals(long ? [`msg_native_${kind}`] : [])
          expect(value.pulses).deep.equals(long ? [8] : [])
          expect(value.short).deep.equals(long ? [] : expectedShort(kind))
          if (kind === 'video')
            expect(document.querySelector('video') != null).equals(!long)
        }
    })

  it('keeps duplicate child/parent starts, repeated release and later long callbacks to one action and pulse per contact', async function () {
    for (const kind of [
      'body',
      'file',
      'video',
      'quote',
      'reaction'
    ] as const) {
      const value = await nativeGesture(kind)
      const start = contact(1000)
      await nativePress(value.target, 'onPressIn', start)
      await nativePress(value.body, 'onPressIn', start)
      for (let index = 0; index < 13; index += 1)
        await nativePress(value.target, 'onTouchMove', contact(1000 + index))
      await nativePress(value.target, 'onPress', contact(1568))
      await nativePress(value.body, 'onPress', contact(1568))
      await nativePress(value.target, 'onLongPress', contact(1568))
      await nativePress(value.body, 'onPressIn', start)
      await nativePress(value.target, 'onPress', contact(1568))
      expect(value.opens).deep.equals([`msg_native_${kind}`])
      expect(value.pulses).deep.equals([8])
      expect(value.short).deep.equals([])
      await nativePress(value.target, 'onPressIn', contact(2000, 8))
      await nativePress(value.target, 'onPress', contact(2568, 8))
      expect(value.opens).deep.equals([
        `msg_native_${kind}`,
        `msg_native_${kind}`
      ])
      expect(value.pulses).deep.equals([8, 8])
      expect(value.short).deep.equals([])
    }
  })

  it('retains scheduled long recognition without native metadata and never duplicates it on release', async function () {
    const value = await nativeGesture('file')
    const ordinary: NativePressEvent = {
      nativeEvent: { pageX: 20, pageY: 20 }
    }
    await nativePress(value.target, 'onPressIn', ordinary)
    await nativePress(value.target, 'onLongPress', ordinary)
    await nativePress(value.target, 'onPress', contact(1568))
    expect(value.opens).deep.equals(['msg_native_file'])
    expect(value.pulses).deep.equals([8])
    expect(value.short).deep.equals([])
  })

  it('keeps movement, cancellation and parent scrolling from recognizing or short-activating a native long release', async function () {
    for (const kind of ['body', 'file', 'video', 'quote', 'reaction'] as const)
      for (const cancellation of [
        'movement',
        'release-movement',
        'cancel',
        'scroll'
      ] as const) {
        const value = await nativeGesture(kind)
        await nativePress(value.target, 'onPressIn', contact(1000))
        if (cancellation === 'movement')
          await nativePress(value.target, 'onTouchMove', contact(1100, 7, 31))
        else if (cancellation === 'cancel')
          await nativePress(value.target, 'onTouchCancel', contact(1100))
        else if (cancellation === 'scroll') value.generation.current += 1
        await nativePress(
          value.target,
          'onPress',
          contact(1568, 7, cancellation === 'release-movement' ? 31 : 20)
        )
        expect(value.opens, `${kind} ${cancellation}`).deep.equals([])
        expect(value.pulses).deep.equals([])
        expect(value.short).deep.equals([])
      }
  })

  it('requires the same contact and a finite forward native release timestamp', async function () {
    for (const release of [
      contact(1568, 8),
      contact(999),
      contact(Number.NaN)
    ]) {
      const value = await nativeGesture('body')
      await nativePress(value.target, 'onPressIn', contact(1000))
      await nativePress(value.target, 'onPress', release)
      expect(value.opens).deep.equals([])
      expect(value.pulses).deep.equals([])
    }
  })

  it('uses the authoritative native release stamp even when a retained touch array still has an older move stamp', async function () {
    const value = await nativeGesture('file')
    const release = contact(1568)
    release.nativeEvent.touches = []
    release.nativeEvent.changedTouches =
      contact(1100).nativeEvent.changedTouches
    await compressedRelease(value.target, contact(1000), release)
    expect(value.opens).deep.equals(['msg_native_file'])
    expect(value.pulses).deep.equals([8])
    expect(value.short).deep.equals([])
  })

  it('cancels uncertain child activation for a mismatched contact or backward stamp but preserves metadata-free keyboard and ordinary short activation', async function () {
    for (const kind of ['file', 'video', 'quote', 'reaction'] as const) {
      for (const release of [contact(1568, 8), contact(999)]) {
        const value = await nativeGesture(kind)
        await compressedRelease(value.target, contact(1000), release)
        expect(value.opens).deep.equals([])
        expect(value.short, kind).deep.equals([])
        expect(value.pulses).deep.equals([])
      }
      for (const ordinary of [
        { nativeEvent: {} },
        { nativeEvent: { pageX: 20, pageY: 20 } }
      ]) {
        const value = await nativeGesture(kind)
        await compressedRelease(value.target, ordinary, ordinary)
        await act(async () => {
          await wait()
        })
        expect(value.opens).deep.equals([])
        expect(value.short, kind).deep.equals(expectedShort(kind))
        expect(value.pulses).deep.equals([])
      }
    }
  })
})

describe('chat review native-time narrow conversation row', function () {
  it('short-opens at native499 and opens actions once at native500/568 without opening the conversation', async function () {
    for (const stamp of ['direct', 'array'] as const)
      for (const duration of [499, 500, 568]) {
        const engine = new ReviewEngine()
        const opened: string[] = []
        const pulses: number[] = []
        Object.defineProperty(navigator, 'vibrate', {
          configurable: true,
          value: (value: number) => {
            pulses.push(value)
            return true
          }
        })
        await render(
          <ChatOverlayHost key={++nativeFixture}>
            <ChatListScreen
              engine={engine}
              embedded
              narrow
              onOpen={conversation => opened.push(conversation.id)}
              onNewMessage={() => {}}
            />
          </ChatOverlayHost>,
          false
        )
        const row = document.querySelector<HTMLElement>(
          '[data-testid="chat-conversation-cnv_aurora"]'
        )!
        const callbacks = renderedPressCallbacks(row)
        const release = contact(1000 + duration, 7, 20, stamp)
        release.nativeEvent.touches = []
        await compressedRelease(callbacks, contact(1000, 7, 20, stamp), release)
        await act(async () => {
          await wait()
        })
        const long = duration >= 500
        expect(opened, `${stamp} native ${duration}`).deep.equals(
          long ? [] : ['cnv_aurora']
        )
        expect(
          document.querySelectorAll('[aria-label="Conversation actions"]')
        ).length(long ? 1 : 0)
        expect(pulses).deep.equals(long ? [8] : [])
        if (long) {
          await nativePress(callbacks, 'onPress', release)
          await nativePress(callbacks, 'onLongPress', release)
          expect(opened).deep.equals([])
          expect(
            document.querySelectorAll('[aria-label="Conversation actions"]')
          ).length(1)
          expect(pulses).deep.equals([8])
        }
      }
  })
})

describe('chat review2 arrival host, confirmation focus and list terminals', function () {
  it('keeps the one offscreen-arrival live region exposed while the narrow list is hidden and repeats its text safely', async function () {
    const engine = new ReviewEngine()
    const state = newChatWorkspaceState()
    await workspace(engine, state)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      390,
      844
    )
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
        .style.display
    ).equals('none')
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-message-pane"]')!
        .style.display
    ).equals('flex')
    const send = async (id: string): Promise<void> => {
      await act(async () => {
        engine.emit({ type: 'messageAlert', conversationId: id })
        await wait()
      })
    }
    await send('cnv_solstice')
    const region = [
      ...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')
    ].find(n => n.textContent === 'New message in Solstice')!
    expect(region, 'eligible alert host').not.equals(undefined)
    const hidden: string[] = []
    for (let n: HTMLElement | null = region; n != null; n = n.parentElement)
      if (
        getComputedStyle(n).display === 'none' ||
        n.getAttribute('aria-hidden') === 'true'
      )
        hidden.push(n.getAttribute('data-testid') ?? n.tagName)
    expect(hidden, 'no hidden list ancestor').deep.equals([])
    expect(
      [
        ...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')
      ].filter(node => node.textContent === 'New message in Solstice')
    ).length(1)
    const records: MutationRecord[] = []
    const changes = new MutationObserver(next => records.push(...next))
    changes.observe(region, {
      childList: true,
      subtree: true,
      characterData: true
    })
    const first = region.firstChild
    await send('cnv_solstice')
    expect(region.firstChild).not.equals(first)
    expect(
      records.reduce((total, record) => total + record.addedNodes.length, 0),
      'one live host update for one eligible post'
    ).equals(1)
    records.length = 0
    const latest = region.firstChild
    await send('cnv_aurora')
    expect(region.firstChild).equals(latest)
    expect(records).length(0)
    await workspace(engine, state, null)
    await send('cnv_aurora')
    expect(region.textContent).equals('New message in Aurora')
    changes.disconnect()
  })
  for (const desktop of [true, false])
    it(`moves only confirmation focus to Cancel in ${desktop ? 'anchored' : 'overlay'} mode and retains the original trigger on close`, async function () {
      const anchor = document.createElement('button')
      document.body.append(anchor)
      anchor.focus()
      let closed = 0
      let deleted = 0
      const element = (revision: number): React.ReactElement => (
        <ChatOverlayHost>
          <MessageMenu
            message={original('msg_original', true)}
            actions={['copy', 'pin', 'delete']}
            desktop={desktop}
            anchor={anchor}
            onReply={() => {}}
            onReact={() => {}}
            onMoreEmoji={() => {}}
            onDelete={() => {
              deleted++
            }}
            onClose={() => {
              closed = revision
            }}
          />
        </ChatOverlayHost>
      )
      await render(element(1))
      await act(async () => {
        button('Delete').focus()
        button('Delete').click()
        await wait()
      })
      expect(
        document.activeElement?.textContent,
        'confirmation Cancel is focused'
      ).equals('Cancel')
      expect(document.activeElement?.getAttribute('role')).equals('button')
      expect(deleted).equals(0)
      await render(element(2))
      expect(document.activeElement?.textContent).equals('Cancel')
      await act(async () => {
        document.activeElement!.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true
          })
        )
        document.activeElement!.dispatchEvent(
          new window.KeyboardEvent('keyup', {
            key: 'Enter',
            bubbles: true,
            cancelable: true
          })
        )
        /* JSDOM does not synthesize native button activation from Enter. */ if (
          document.activeElement!.tagName === 'BUTTON'
        )
          (document.activeElement as HTMLElement).click()
        await wait()
      })
      expect(closed, 'Enter invokes latest Cancel handler').equals(2)
      expect(deleted).equals(0)
      await unmount()
      expect(document.activeElement).equals(anchor)
      anchor.remove()
    })
  it('saves real terminal list zero offsets and ignores retained callbacks after the narrow list hides or unmounts', async function () {
    const engine = new ReviewEngine()
    const state = newChatWorkspaceState()
    state.listOffset = 22.095
    await workspace(engine, state, null)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      390,
      800
    )
    const listPane = document.querySelector('[data-testid="chat-list-pane"]')!
    const node = [...listPane.querySelectorAll<HTMLElement>('div')].find(
      n => getComputedStyle(n).overflowY === 'auto'
    )!
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, value: 1800 },
      clientHeight: { configurable: true, value: 400 }
    })
    node.scroll = options => {
      node.scrollTop = (options as ScrollToOptions).top ?? 0
    }
    await layout(node, 320, 400)
    await layout(node.firstElementChild as HTMLElement, 320, 1800)
    const callbacks = renderedReadingCallbacks(node)
    const deliver = async (phase: ScrollPhase, y: number): Promise<void> => {
      await act(async () => {
        callbacks[phase]?.({
          nativeEvent: {
            contentOffset: { x: 0, y },
            contentSize: { width: 320, height: 1800 },
            layoutMeasurement: { width: 320, height: 400 }
          }
        })
        await wait()
      })
    }
    for (const phase of ['onScrollEndDrag', 'onMomentumScrollEnd'] as const) {
      await deliver('onScroll', 22.095)
      expect(state.listOffset).equals(22.095)
      await deliver(phase, 0)
      expect(state.listOffset, `${phase} persists edge`).equals(0)
    }
    await workspace(engine, state, 'cnv_aurora')
    await deliver('onScrollEndDrag', 999)
    expect(state.listOffset, 'hidden terminal ignored').equals(0)
    await unmount()
    await deliver('onMomentumScrollEnd', 888)
    expect(state.listOffset, 'unmounted terminal ignored').equals(0)
    await workspace(engine, state, null)
    const next = [
      ...document
        .querySelector('[data-testid="chat-list-pane"]')!
        .querySelectorAll<HTMLElement>('div')
    ].find(n => getComputedStyle(n).overflowY === 'auto')!
    const moves: number[] = []
    next.scroll = options => {
      moves.push((options as ScrollToOptions).top ?? 0)
    }
    await layout(next, 320, 400)
    await layout(next.firstElementChild as HTMLElement, 320, 1800)
    expect(moves).deep.equals([0])
  })
})

function renderedModalEscape(): (() => void) | undefined {
  interface Fiber {
    return?: Fiber
    memoizedProps?: {
      accessibilityViewIsModal?: boolean
      onAccessibilityEscape?: () => void
    }
  }
  for (const node of document.querySelectorAll('*')) {
    const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))
    if (key == null) continue
    let fiber = (node as unknown as Record<string, unknown>)[key] as
      Fiber | undefined
    while (fiber != null) {
      if (fiber.memoizedProps?.accessibilityViewIsModal === true)
        return fiber.memoizedProps.onAccessibilityEscape
      fiber = fiber.return
    }
  }
  throw new Error('Mounted native modal props unavailable')
}

describe('review3 native modal escape current-close path', function () {
  for (const kind of ['conversation', 'message'] as const)
    it(
      'closes the mounted ' +
        kind +
        ' through its latest native escape callback',
      async function () {
        const closed: number[] = []
        let mutations = 0
        const element = (revision: number): React.ReactElement => (
          <ChatOverlayHost>
            {kind === 'conversation' ? (
              <ConversationMenu
                conversation={chat()}
                engine={{
                  setPreferences: async () => {
                    mutations++
                  }
                }}
                onClose={() => closed.push(revision)}
              />
            ) : (
              <MessageMenu
                message={original('msg_original', true)}
                actions={['copy', 'pin', 'delete']}
                onReply={() => {
                  mutations++
                }}
                onReact={() => {
                  mutations++
                }}
                onMoreEmoji={() => {
                  mutations++
                }}
                onDelete={() => {
                  mutations++
                }}
                onClose={() => closed.push(revision)}
              />
            )}
          </ChatOverlayHost>
        )
        await render(element(1), false)
        const retainedEscape = renderedModalEscape()
        await render(element(2), false)
        await act(async () => {
          // Dispatches the actual native-only View prop, not an OS VoiceOver gesture.
          retainedEscape?.()
          await wait()
        })
        expect(closed, 'only the current close callback').deep.equals([2])
        expect(mutations, 'dismissal does not run an action').equals(0)
        await unmount()
      }
    )
})

describe('review4 selected clone controls', function () {
  it('keeps the real selected quote and counts readable without dead controls while its toolbar acts', async function () {
    const engine = new ReviewEngine()
    const changed: Array<{ id: string; emoji: string }> = []
    engine.react = async (...args: unknown[]) => {
      changed.push({ id: String(args[1]), emoji: String(args[2]) })
    }
    const reply = message({
      id: 'msg_quoted',
      seq: 2,
      senderName: 'Shohei Ohtani',
      body: 'Current reply body',
      quote: {
        id: 'msg_original',
        authorId: 1,
        authorName: 'Mookie Betts',
        snippet: 'Original quoted body',
        status: 'ok'
      },
      reactions: [{ emoji: '👍', userIds: [2], mine: false }]
    })
    engine.update('cnv_aurora', {
      messages: [
        { ...original('msg_original', true), body: 'Original quoted body' },
        reply
      ]
    })
    await render(
      <ChatOverlayHost>
        <ChatWorkspace
          engine={engine}
          userId={1}
          state={newChatWorkspaceState()}
          conversationId="cnv_aurora"
          onOpen={() => {}}
          onMembers={() => {}}
          onNewMessage={() => {}}
          onTitle={() => {}}
        />
      </ChatOverlayHost>,
      false
    )
    const normal = document.querySelector(
      '[data-testid="chat-message-msg_quoted"]'
    )!
    expect(
      normal.querySelector(
        '[role="button"][aria-label="Jump to message from You: Original quoted body"]'
      )
    ).not.equals(null)
    expect(button('👍, 1', normal)).not.equals(undefined)
    await press('More message actions', normal)
    const panel = document.querySelector(
      '[aria-label="Message from Shohei Ohtani"]'
    )!
    expect(panel.textContent).contains('Original quoted body')
    expect(panel.textContent).contains('Current reply body')
    expect(
      panel
        .querySelector('[data-testid="chat-bubble-msg_quoted"]')!
        .getAttribute('tabindex'),
      'Static selected body is not an unnamed dead focus target'
    ).not.equals('0')
    expect(
      panel.querySelector('[role="button"][aria-label^="Jump to message"]')
    ).equals(null)
    const count = [...panel.querySelectorAll('[aria-label]')].find(
      node => node.getAttribute('aria-label') === '👍, 1'
    )!
    expect(count, 'count remains readable').not.equals(null)
    expect(
      count.getAttribute('role'),
      'static count is not a dead button'
    ).not.equals('button')
    expect(count.getAttribute('tabindex')).not.equals('0')
    expect(changed).deep.equals([])
    await press('React with 👍', panel)
    expect(changed).deep.equals([{ id: 'msg_quoted', emoji: '👍' }])
    expect(
      document.querySelector('[aria-label="Message from Shohei Ohtani"]')
    ).equals(null)
  })

  it('exposes no jump button when a regular bubble has no jump callback', async function () {
    const reply = message({
      quote: {
        id: 'msg_original',
        authorId: 1,
        authorName: 'Mookie Betts',
        snippet: 'Original quoted body',
        status: 'ok'
      }
    })
    await render(
      <MessageBubble
        message={reply}
        conversation={chat()}
        members={[]}
        engine={{ openAttachment: async () => new Uint8Array() }}
        files={{
          bytesUri: async () => '',
          releaseUri: async () => {},
          saveFile: async () => {}
        }}
        maxWidth={300}
        swipe={false}
        actions={[]}
        userId={1}
        onLongPress={() => {}}
        onReply={() => {}}
        onToggleReaction={() => {}}
      />
    )
    expect(document.body.textContent).contains('Original quoted body')
    expect(
      document.querySelector('[role="button"][aria-label^="Jump to message"]')
    ).equals(null)
  })
})

describe('review4 virtualized restoration and scrollbar intent', function () {
  it('advances an unmounted long-list tail incrementally without consuming or saving the target early', async function () {
    const pending = await returningList(true, 6000)
    await pending.populate(300)
    expect(
      document.querySelector(
        '[data-testid="chat-conversation-cnv_return_299"]'
      ),
      'Tail remains outside the actual mounted virtualized window'
    ).equals(null)
    await pending.content(1200)
    expect(pending.moves).deep.equals([800])
    await pending.scroll(800)
    expect(
      pending.offsets,
      'Programmatic reveal is not final restoration'
    ).deep.equals([])
    await pending.content(1200)
    expect(pending.moves, 'Unchanged geometry does not spin').deep.equals([800])
    await pending.content(2800)
    expect(pending.moves).deep.equals([800, 2400])
    await pending.content(9000)
    expect(pending.moves).deep.equals([800, 2400, 6000])
    await pending.scroll(6000)
    expect(pending.offsets.at(-1)).equals(6000)
    await pending.content(10000)
    expect(pending.moves).deep.equals([800, 2400, 6000])
  })

  it('abandons incremental restoration on a real scrollbar offset change and saves the user position', async function () {
    const pending = await returningList(true, 6000)
    await pending.populate(300)
    await pending.content(1200)
    pending.node.getBoundingClientRect = () =>
      new window.DOMRect(0, 0, 320, 400)
    Object.defineProperties(pending.node, {
      clientWidth: { configurable: true, value: 304 },
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
      offsetWidth: { configurable: true, value: 320 },
      offsetHeight: { configurable: true, value: 400 }
    })
    pending.node.dispatchEvent(
      new window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 319,
        clientY: 100
      })
    )
    await pending.scroll(500)
    document.dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
    )
    expect(pending.offsets.at(-1)).equals(500)
    await pending.content(9000)
    expect(pending.moves, 'No later jump over the reader').deep.equals([800])
  })

  it('preserves a changed message reading position after scrollbar drag but ignores child/programmatic focus scrolls', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', { ...terminalDraft(), scrollOffset: 700 })
    await workspace(engine, state)
    const reading = terminalReadingPane()
    await reading.measure()
    const callbacks = renderedReadingCallbacks(reading.node)
    reading.moves.length = 0
    Object.defineProperties(reading.node, {
      clientWidth: { configurable: true, value: 624 },
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 }
    })
    reading.node.firstElementChild!.dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
    )
    await reading.deliver(callbacks, 'onScroll', 500)
    document.dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
    )
    expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(700)
    reading.node.dispatchEvent(
      new window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 300,
        clientY: 100
      })
    )
    await reading.deliver(callbacks, 'onScroll', 450)
    document.dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
    )
    expect(
      state.drafts.get('cnv_aurora')!.scrollOffset,
      'Bare content press plus programmatic nudge is not reading'
    ).equals(700)
    reading.node.dispatchEvent(
      new window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 639,
        clientY: 100
      })
    )
    await act(async () => {
      reading.node.scrollTop = 400
      reading.node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(150)
    })
    document.dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
    )
    expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(400)
    reading.moves.length = 0
    await layout(reading.node.firstElementChild as HTMLElement, 640, 2300)
    expect(
      reading.moves,
      'Later content cannot reapply the old reading target'
    ).deep.equals([])
    await workspace(engine, state, 'cnv_solstice')
    await workspace(engine, state)
    const reopened = terminalReadingPane()
    await reopened.measure()
    expect(reopened.moves).contains(400)
    expect(reopened.moves).not.contains(700)
  })
})

interface ListLayoutCallbacks {
  onContentSizeChange: (width: number, height: number) => void
  onLayout: (event: { nativeEvent: { layout: { height: number } } }) => void
}
function renderedListCallbacks(node: HTMLElement): ListLayoutCallbacks {
  interface Fiber {
    memoizedProps?: ListLayoutCallbacks & { testID?: string; data?: unknown }
    stateNode?: {
      props: ListLayoutCallbacks & { testID?: string; data?: unknown }
    }
    return?: Fiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, Fiber>)[key]
  let appProps: ListLayoutCallbacks | undefined
  while (fiber != null) {
    const props = fiber.stateNode?.props ?? fiber.memoizedProps
    if (
      props?.testID === 'chat-conversation-list' &&
      Array.isArray(props.data) &&
      typeof props.onContentSizeChange === 'function'
    )
      appProps = props
    fiber = fiber.return!
  }
  if (appProps != null) return appProps
  throw Error('Rendered app list callbacks unavailable')
}

describe('review4 incremental restoration lifecycle', function () {
  it('rejects delayed content/layout work after hide/unmount, including tail layout, and restores only fresh visible geometry', async function () {
    for (const count of [300, 2]) {
      const pending = await returningList(true, 6000)
      await pending.populate(count)
      const content = count === 300 ? 1200 : 500
      const available = content - 400
      await pending.content(content)
      const retained = renderedListCallbacks(pending.node)
      const tail = count === 2 ? renderedRowLayout('cnv_return_1') : undefined
      await pending.hide()
      await act(async () => {
        retained.onContentSizeChange(320, 9000)
        retained.onLayout({ nativeEvent: { layout: { height: 500 } } })
        tail?.({ nativeEvent: { layout: { height: 80 } } })
        await wait()
      })
      expect(
        pending.moves,
        'Hidden content/tail cannot consume the target'
      ).deep.equals([available])
      await pending.show()
      expect(
        pending.moves,
        'A hidden tail cannot clamp on visibility return'
      ).deep.equals([available])
      if (count === 300) await pending.content(9000)
      else
        await act(async () => {
          // A fresh visible tail now permits a legitimate short-list clamp.
          setListRowMeasurement('cnv_return_1', 420, listTailHeight(80))
          renderedRowLayout('cnv_return_1')({
            nativeEvent: { layout: { height: listTailHeight(80) } }
          })
          await wait()
        })
      const expected = [available, count === 300 ? 6000 : available]
      expect(pending.moves).deep.equals(expected)
      await unmount()
      await act(async () => {
        retained.onContentSizeChange(320, 10000)
        retained.onLayout({ nativeEvent: { layout: { height: 400 } } })
        tail?.({ nativeEvent: { layout: { height: 80 } } })
        await wait()
      })
      expect(
        pending.moves,
        'Unmounted content cannot command scroll'
      ).deep.equals(expected)
    }
  })

  it('ignores older-data callbacks while advancing only the replacement list geometry', async function () {
    const pending = await returningList(true, 6000)
    await pending.populate(300)
    await pending.content(1200)
    const retained = renderedListCallbacks(pending.node)
    await pending.replace(300)
    await act(async () => {
      retained.onContentSizeChange(320, 9000)
      retained.onLayout({ nativeEvent: { layout: { height: 500 } } })
      await wait()
    })
    expect(pending.moves, 'Old data cannot complete a new list').deep.equals([
      800
    ])
    await pending.content(4000)
    expect(pending.moves).deep.equals([800, 3600])
    await pending.content(9000)
    expect(pending.moves).deep.equals([800, 3600, 6000])
  })
})

function renderedRowLayout(id: string): ListLayoutCallbacks['onLayout'] {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="chat-conversation-${id}"]`
  )!.parentElement! as HTMLElement & {
    __reactLayoutHandler?: ListLayoutCallbacks['onLayout']
  }
  // The installed RNW adapter updates this host handler on every ref commit.
  // A DOM node's React fiber may still point to the preceding alternate tree.
  const callback = row.__reactLayoutHandler
  if (typeof callback !== 'function')
    throw Error('Rendered current row layout callback unavailable')
  return callback
}

const listMeasurementMethods = new WeakMap<object, unknown>()

/** Total mocked content includes the scene's actual trailing chrome inset. */
function listTailHeight(remaining: number): number {
  const content = document.querySelector<HTMLElement>(
    '[data-testid="chat-conversation-list"]'
  )!.firstElementChild!
  const parsed = Number.parseFloat(getComputedStyle(content).paddingBottom)
  const inset = Number.isFinite(parsed) ? parsed : 0
  expect(inset, 'Rendered trailing content inset').greaterThan(0)
  expect(remaining, 'Mocked last row remains visible').greaterThan(inset)
  return remaining - inset
}

function setListRowMeasurement(id: string, y: number, height = 67): void {
  const node = document.querySelector<HTMLElement>(
    `[data-testid="chat-conversation-${id}"]`
  )!.parentElement!
  const original = listMeasurementMethods.get(node)
  if (original != null) {
    Object.defineProperty(node, 'measureLayout', {
      configurable: true,
      writable: true,
      value: original
    })
    listMeasurementMethods.delete(node)
  }
  const content = node.closest(
    '[data-testid="chat-conversation-list"]'
  )!.firstElementChild
  // Calibrate DOM geometry read by the installed RNW method. Ref commits can
  // reattach that method; the row geometry still belongs to this same node.
  Object.defineProperties(node, {
    offsetTop: { configurable: true, value: y },
    offsetHeight: { configurable: true, value: height },
    offsetWidth: { configurable: true, value: 320 },
    offsetParent: { configurable: true, value: content }
  })
}

function holdListRowMeasurement<T>(
  node: { measureLayout: T },
  measure: T
): void {
  // Only explicit delayed/failing transport schedules use a double. Preserve
  // that selected callback when RNW reattaches its normal ref method.
  if (!listMeasurementMethods.has(node))
    listMeasurementMethods.set(node, node.measureLayout)
  Object.defineProperty(node, 'measureLayout', {
    configurable: true,
    get: () => measure,
    set: () => {}
  })
}

describe('deep list opaque reading anchors', function () {
  it('restores the same row after a changed prefix and keeps it through late growth without publishing intermediate offsets', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 206)
    await pending.content(500)
    expect(pending.moves).deep.equals([100])
    await pending.scroll(100)
    expect(pending.offsets).deep.equals([])
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    expect(pending.moves).deep.equals([100, 176])
    await pending.scroll(176)
    setListRowMeasurement('cnv_return_3', 256)
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(30)
    })
    expect(pending.moves).deep.equals([100, 176, 226])
    await pending.scroll(226)
    await pending.content(1900)
    await act(async () => {
      await wait(30)
    })
    expect(pending.moves, 'Growth below this row does not move it').deep.equals(
      [100, 176, 226]
    )
    expect(256 - pending.node.scrollTop).equals(30)
  })

  it('does not accept an asynchronous clamped native offset as the saved target and retries only after newer geometry', async function () {
    const pending = await returningList(true, 6000)
    await pending.populate(300)
    await pending.content(9000)
    expect(pending.moves).deep.equals([6000])
    await pending.scroll(4800)
    expect(
      pending.offsets,
      'A native clamp is not successful restoration'
    ).deep.equals([])
    expect(pending.moves, 'Same geometry cannot spin requests').deep.equals([
      6000
    ])
    await pending.content(10000)
    expect(pending.moves).deep.equals([6000, 6000])
    await pending.scroll(6000)
    expect(pending.offsets.at(-1)).equals(6000)
  })

  it('measures complete tail coordinates rather than consuming a pending target from tail layout before content size', async function () {
    const pending = await returningList(true, 240)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_7', 1720, listTailHeight(80))
    await pending.content(500)
    await act(async () => {
      renderedRowLayout('cnv_return_7')({
        nativeEvent: { layout: { height: 80 } }
      })
      await wait(30)
    })
    expect(pending.moves).deep.equals([100])
    await pending.scroll(100)
    expect(pending.offsets).deep.equals([])
    await pending.content(1800)
    expect(pending.moves).deep.equals([100, 240])
  })

  it('captures an opaque viewport anchor from measured rows during actual user scrolling and drops restoration on newer user intent', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    await pending.scroll(240)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 80 })
      )
      await wait()
    })
    await pending.scroll(280)
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(30)
    })
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: -10
    })
    setListRowMeasurement('cnv_return_3', 330)
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(30)
    })
    await pending.content(1900)
    expect(
      pending.moves,
      'New user reading cancels the owned saved anchor'
    ).deep.equals([240])
    expect(pending.node.scrollTop).equals(280)
  })
})

describe('deep list measurement lifetime', function () {
  for (const boundary of ['hide', 'unmount', 'reorder'])
    it(`discards queued row/scroll geometry after ${boundary} without writing or consuming the saved anchor`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-conversation-cnv_return_3"]'
      )!.parentElement! as HTMLElement & {
        measureLayout: (
          relative: unknown,
          success: (x: number, y: number, width: number, height: number) => void
        ) => void
      }
      const completions: Array<
        (x: number, y: number, width: number, height: number) => void
      > = []
      holdListRowMeasurement(node, (_relative, success) =>
        completions.push(success)
      )
      await pending.content(1800)
      const retained = renderedListCallbacks(pending.node)
      const oldRow = renderedRowLayout('cnv_return_3')
      expect(
        completions.length,
        'A real mounted-row measurement is pending'
      ).greaterThan(0)
      if (boundary === 'hide') await pending.hide()
      else if (boundary === 'unmount') await unmount()
      else await pending.reorder()
      await act(async () => {
        for (const complete of completions) complete(0, 206, 320, 67)
        oldRow({ nativeEvent: { layout: { height: 67 } } })
        retained.onContentSizeChange(320, 1900)
        retained.onLayout({ nativeEvent: { layout: { height: 400 } } })
        await wait(30)
      })
      expect(
        pending.moves,
        'Obsolete callbacks never issue scroll commands'
      ).deep.equals([])
      expect(
        pending.offsets,
        'Obsolete callbacks never write position'
      ).deep.equals([])
    })

  it('falls back to a measured shorter list when its saved row has been removed', async function () {
    const pending = await returningList(true, 6000, {
      id: 'cnv_removed',
      relativeY: 20
    })
    await pending.populate(2)
    setListRowMeasurement('cnv_return_1', 420, listTailHeight(80))
    await pending.content(500)
    await act(async () => {
      await wait(30)
    })
    await pending.scroll(100)
    expect(pending.node.scrollTop).equals(100)
    expect(pending.offsets.at(-1)).equals(100)
  })
})

describe('deep list delayed geometry freshness', function () {
  it('does not publish a cached same-order anchor after prefix layout changes while a fresh measurement is pending', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    await pending.scroll(240)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
    const before = [...pending.anchors]
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_3"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    const completions: Array<
      (x: number, y: number, width: number, height: number) => void
    > = []
    holdListRowMeasurement(node, (_relative, success) =>
      completions.push(success)
    )
    await pending.content(1864)
    await pending.scroll(240)
    expect(
      pending.anchors,
      'Cached coordinates cannot be written while newer geometry is pending'
    ).deep.equals(before)
    await pending.hide()
    await act(async () => {
      for (const complete of completions) complete(0, 334, 320, 67)
      await wait(30)
    })
    expect(
      pending.anchors,
      'Quick navigation cannot accept late hidden coordinates'
    ).deep.equals(before)
  })

  for (const first of ['timeout', 'failure'])
    it(`recovers an anchor measurement after an initial ${first} callback`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-conversation-cnv_return_3"]'
      )!.parentElement! as HTMLElement & {
        measureLayout: (
          relative: unknown,
          success: (
            x: number,
            y: number,
            width: number,
            height: number
          ) => void,
          failure: () => void
        ) => void
      }
      let calls = 0
      holdListRowMeasurement(node, (_relative, success, failure) => {
        calls += 1
        if (calls === 1) {
          if (first === 'failure') failure()
        } else success(0, 206, 320, 67)
      })
      await pending.content(1800)
      await act(async () => {
        await wait(200)
      })
      expect(calls).greaterThan(1)
      expect(pending.moves).deep.equals([176])
      await pending.scroll(176)
      expect(pending.anchors.at(-1)).deep.equals({
        id: 'cnv_return_3',
        relativeY: 30
      })
    })
})

describe('deep list anchor fallback and overlapping measurements', function () {
  it('falls back to the saved raw offset after unavailable measurements and recovers when the mounted row becomes measurable', async function () {
    this.timeout(5000)
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_3"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void,
        failure: () => void
      ) => void
    }
    holdListRowMeasurement(node, (_relative, _success, failure) => {
      failure()
    })
    await pending.content(1800)
    await act(async () => {
      await wait(2100)
    })
    expect(pending.moves).deep.equals([240])
    await pending.scroll(240)
    setListRowMeasurement('cnv_return_3', 206)
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(160)
    })
    expect(pending.moves.at(-1)).equals(176)
    expect(pending.moves).not.contains(0)
  })

  it('remeasures after overlapping prefix layout without applying an obsolete completed measurement', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_3"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    const completions: Array<
      (x: number, y: number, width: number, height: number) => void
    > = []
    holdListRowMeasurement(node, (_relative, success) =>
      completions.push(success)
    )
    await pending.content(1800)
    expect(
      completions.length,
      'Actual anchor measurement is pending'
    ).greaterThan(0)
    const old = completions.shift()!
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      old(0, 206, 320, 67)
      await wait(30)
    })
    expect(
      pending.moves,
      'A stale measured y206 cannot issue offset176'
    ).deep.equals([])
    setListRowMeasurement('cnv_return_3', 270)
    await act(async () => {
      for (const complete of completions) complete(0, 270, 320, 67)
      await wait(60)
    })
    expect(pending.moves).deep.equals([240])
    await pending.scroll(240)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
  })
})

describe('deep list coherent tail revisions', function () {
  it('rejects a preceding short-tail geometry and its old clamped acknowledgement after same-order row layout, then restores from fresh content', async function () {
    const pending = await returningList(true, 6000)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_7', 420, listTailHeight(80))
    await pending.content(500)
    await act(async () => {
      await wait(30)
    })
    expect(pending.moves).deep.equals([100])
    const tail = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_7"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    const completions: Array<
      (x: number, y: number, width: number, height: number) => void
    > = []
    holdListRowMeasurement(tail, (_relative, success) =>
      completions.push(success)
    )
    await act(async () => {
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait()
    })
    await pending.scroll(100)
    expect(
      pending.offsets,
      'An old clamp cannot acknowledge a newer geometry revision'
    ).deep.equals([])
    expect(
      completions.length,
      'Current row layout remeasures the tail even without another content callback'
    ).greaterThan(0)
    await act(async () => {
      for (const complete of completions)
        complete(0, 1720, 320, listTailHeight(80))
      await wait(30)
    })
    expect(pending.offsets).deep.equals([])
    setListRowMeasurement('cnv_return_7', 1720, listTailHeight(80))
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    expect(pending.moves.at(-1)).equals(1400)
    await pending.scroll(1400)
    expect(pending.offsets.at(-1)).equals(1400)
  })
})

describe('b66 offscreen layout current-anchor schedule', function () {
  it('recaptures currently visible row coordinates after a same-order prefix and final offscreen layout before navigation', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    let rowY = 270
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_3"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    holdListRowMeasurement(row, (_relative, success) => {
      success(0, rowY, 320, 67)
    })
    setListRowMeasurement('cnv_return_7', 1720, listTailHeight(80))
    await pending.content(1800)
    await pending.scroll(0)
    const callbacks = renderedListCallbacks(
      pending.node
    ) as ListLayoutCallbacks & {
      data: Array<{ type: string; key: string; chat?: ConversationListItem }>
      onViewableItemsChanged: (event: {
        viewableItems: Array<{
          item: { type: string; key: string; chat?: ConversationListItem }
        }>
      }) => void
    }
    await act(async () => {
      callbacks.onViewableItemsChanged({
        viewableItems: [
          { item: callbacks.data.find(item => item.key === 'cnv_return_3')! }
        ]
      })
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 240 })
      )
      await wait(30)
    })
    await pending.scroll(240)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
    rowY = 334
    setListRowMeasurement('cnv_return_7', 1784, listTailHeight(80))
    await act(async () => {
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 131 } }
      })
      renderedRowLayout('cnv_return_7')({
        nativeEvent: { layout: { height: 80 } }
      })
      await wait(30)
    })
    expect(
      pending.anchors.at(-1),
      'The visible row must be recaptured after the final offscreen invalidation'
    ).deep.equals({ id: 'cnv_return_3', relativeY: 94 })
    const saved = pending.anchors.at(-1)
    await pending.hide()
    expect(
      pending.anchors.at(-1),
      'Navigation keeps the actual current viewport anchor'
    ).deep.equals(saved)
  })
})

describe('post-deep saved anchor ownership', function () {
  for (const intent of ['wheel', 'ArrowUp', 'gutter'])
    it(`retains the valid boundary anchor after ${intent} intent without movement and restores it after a changed prefix`, async function () {
      const pending = await returningList(true, 0, {
        id: 'cnv_return_0',
        relativeY: 105
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_0', 105)
      await pending.content(1800)
      await act(async () => {
        await wait(30)
      })
      await pending.scroll(0)
      const saved = pending.anchors.at(-1)
      expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: 105 })
      pending.node.getBoundingClientRect = () =>
        new window.DOMRect(0, 0, 320, 400)
      Object.defineProperties(pending.node, {
        clientWidth: { configurable: true, value: 304 },
        offsetWidth: { configurable: true, value: 320 },
        offsetHeight: { configurable: true, value: 400 },
        clientLeft: { configurable: true, value: 0 },
        clientTop: { configurable: true, value: 0 }
      })
      await act(async () => {
        pending.node.dispatchEvent(
          intent === 'wheel'
            ? new window.WheelEvent('wheel', { bubbles: true, deltaY: -80 })
            : intent === 'ArrowUp'
              ? new window.KeyboardEvent('keydown', {
                  bubbles: true,
                  key: intent
                })
              : new window.MouseEvent('mousedown', {
                  bubbles: true,
                  button: 0,
                  clientX: 319,
                  clientY: 100
                })
        )
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
        )
        await wait()
      })
      expect(pending.node.scrollTop).equals(0)
      expect(
        pending.anchors.at(-1),
        'No new measured reading position replaced this anchor'
      ).deep.equals(saved)
      await unmount()
      const returning = await returningList(true, 0, saved)
      await returning.populate(8)
      setListRowMeasurement('cnv_return_0', 169)
      await returning.content(1800)
      await act(async () => {
        await wait(30)
      })
      expect(returning.moves.at(-1)).equals(64)
      expect(169 - returning.node.scrollTop).equals(105)
    })

  it('continues seeking an unmounted saved row beyond its previous numeric offset', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_299',
      relativeY: 30
    })
    await pending.populate(300)
    expect(
      document.querySelector('[data-testid="chat-conversation-cnv_return_299"]')
    ).equals(null)
    Object.defineProperties(pending.node, {
      offsetHeight: { configurable: true, value: 400 },
      offsetWidth: { configurable: true, value: 320 }
    })
    const callbacks = renderedListCallbacks(
      pending.node
    ) as ListLayoutCallbacks & {
      data: Array<{ key: string }>
      onScrollEndDrag: (event: {
        nativeEvent: { contentOffset: { y: number } }
      }) => void
    }
    await act(async () => {
      for (const node of [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid^="chat-conversation-cnv_return_"]'
        )
      ].slice(0, 8)) {
        const id = node
          .getAttribute('data-testid')!
          .slice('chat-conversation-'.length)
        const index = callbacks.data.findIndex(row => row.key === id)
        const cell = node.parentElement!.parentElement! as HTMLElement & {
          __reactLayoutHandler?: (event: unknown) => void
        }
        expect(
          cell.__reactLayoutHandler,
          'Rendered RNW virtual-list cell measurement callback'
        ).not.equals(undefined)
        cell.__reactLayoutHandler!({
          nativeEvent: {
            layout: { x: 0, y: index * 67 + 105, width: 320, height: 67 }
          }
        })
      }
      await wait(30)
    })
    await pending.content(1200)
    expect(
      pending.moves,
      'Current-index seek advances beyond the old240 window'
    ).deep.equals([800])
    await pending.scroll(800)
    expect(pending.offsets).deep.equals([])
    await pending.content(2800)
    expect(pending.moves).deep.equals([800, 2400])
    await pending.scroll(2400)
    expect(pending.offsets).deep.equals([])
    const index = callbacks.data.findIndex(row => row.key === 'cnv_return_299')
    await pending.content(21000)
    await pending.scroll(pending.moves.at(-1)!)
    await act(async () => {
      const deadline = Date.now() + 3000
      while (
        document.querySelector(
          '[data-testid="chat-conversation-cnv_return_299"]'
        ) == null &&
        Date.now() < deadline
      )
        await wait(25)
    })
    expect(
      document.querySelector(
        '[data-testid="chat-conversation-cnv_return_299"]'
      ),
      'The seek really mounts the saved row'
    ).not.equals(null)
    const y = index * 67 + 105
    const mountedRow = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_299"]'
    )!.parentElement!
    // RNW measures these DOM dimensions through its normal mounted methods;
    // they remain valid while the virtualizer finishes later render batches.
    Object.defineProperties(mountedRow, {
      offsetTop: { configurable: true, value: y },
      offsetHeight: { configurable: true, value: 67 },
      offsetWidth: { configurable: true, value: 320 },
      offsetParent: {
        configurable: true,
        value: pending.node.firstElementChild
      }
    })
    await act(async () => {
      renderedRowLayout('cnv_return_299')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(160)
    })
    expect(pending.moves.at(-1)).equals(y - 30)
    await act(async () => {
      pending.node.scrollTop = y - 30
      ;(
        renderedListCallbacks(pending.node) as typeof callbacks
      ).onScrollEndDrag({ nativeEvent: { contentOffset: { y: y - 30 } } })
      await wait(30)
    })
    expect(pending.offsets.at(-1)).equals(y - 30)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_299',
      relativeY: 30
    })
  })

  it('remeasures unchanged-height content after a same-ID reorder without requiring another content-size notification', async function () {
    const pending = await returningList(true, 300, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 330)
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    await pending.scroll(300)
    const content = pending.node.firstElementChild as HTMLElement & {
      measure: (
        callback: (
          x: number,
          y: number,
          width: number,
          height: number,
          pageX: number,
          pageY: number
        ) => void
      ) => void
    }
    const completions: Array<
      (
        x: number,
        y: number,
        width: number,
        height: number,
        pageX: number,
        pageY: number
      ) => void
    > = []
    content.measure = callback => completions.push(callback)
    await pending.reorder('cnv_return_7')
    expect(
      document
        .querySelector('[data-testid^="chat-conversation-cnv_return_"]')!
        .getAttribute('data-testid')
    ).equals('chat-conversation-cnv_return_7')
    setListRowMeasurement('cnv_return_3', 397)
    content.measure = measured => {
      measured(0, 0, 320, 1800, 0, 0)
    }
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      for (const complete of completions) complete(0, 0, 320, 1800, 0, 0)
      await wait(100)
    })
    expect(
      pending.moves.at(-1),
      'Reordered geometry restores367 without a content-size event'
    ).equals(367)
    await pending.scroll(367)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
  })
})

describe('post-deep content validation lifetime', function () {
  it('starts the latest same-height order validation after an older pending measurement without another layout or size event', async function () {
    const pending = await returningList(true, 300, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 330)
    await pending.content(1800)
    await act(async () => {
      await wait(30)
    })
    await pending.scroll(300)
    const content = pending.node.firstElementChild as HTMLElement & {
      measure: (
        callback: (
          x: number,
          y: number,
          width: number,
          height: number,
          pageX: number,
          pageY: number
        ) => void
      ) => void
    }
    const completions: Array<
      (
        x: number,
        y: number,
        width: number,
        height: number,
        pageX: number,
        pageY: number
      ) => void
    > = []
    content.measure = callback => completions.push(callback)
    await pending.reorder('cnv_return_7')
    await pending.reorder('cnv_return_6')
    setListRowMeasurement('cnv_return_3', 397)
    content.measure = measured => {
      measured(0, 0, 320, 1800, 0, 0)
    }
    await act(async () => {
      for (const complete of completions) complete(0, 0, 320, 1800, 0, 0)
      await wait(150)
    })
    expect(
      pending.moves.at(-1),
      'Latest order is validated without an unrelated future notification'
    ).equals(367)
    await pending.scroll(367)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
  })
})

describe('post-deep review2 current geometry persistence', function () {
  it('publishes the genuine intermediate clamp when a later current tail promotes it without another scroll event', async function () {
    const pending = await returningList(true, 240)
    await pending.populate(2)
    const completions: Array<
      (x: number, y: number, width: number, height: number) => void
    > = []
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_1"]'
    )!.parentElement! as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    holdListRowMeasurement(row, (_relative, success) =>
      completions.push(success)
    )
    await pending.content(500)
    expect(pending.moves).deep.equals([100])
    await act(async () => {
      pending.node.scrollTop = 100
      ;(
        renderedListCallbacks(pending.node) as ListLayoutCallbacks & {
          onScroll: (event: {
            nativeEvent: { contentOffset: { y: number } }
          }) => void
        }
      ).onScroll({ nativeEvent: { contentOffset: { y: 100 } } })
      expect(
        pending.offsets,
        'Observed scroll precedes tail completion'
      ).deep.equals([])
      expect(
        completions.length,
        'A real mounted tail measurement is pending'
      ).greaterThan(0)
      for (const complete of completions.splice(0))
        complete(0, 420, 320, listTailHeight(80))
      holdListRowMeasurement(row, (_relative, success) => {
        success(0, 420, 320, listTailHeight(80))
      })
      await wait(80)
    })
    expect(
      pending.moves,
      'Promotion does not need a second scroll request'
    ).deep.equals([100])
    expect(
      pending.offsets.at(-1),
      'The observed destination becomes the saved clamp'
    ).equals(100)
    await pending.content(1800)
    expect(
      pending.moves,
      'Later content cannot restore obsolete240'
    ).deep.equals([100])
    expect(pending.offsets.at(-1)).equals(100)
  })

  for (const change of ['edit', 'delete'] as const)
    it(`recaptures live ${change} reflow with current draft fields and returns to that exact non-following position`, async function () {
      const engine = new ReviewEngine()
      const above = { ...original('msg_above'), seq: 1 }
      const visible = { ...original(), seq: 2 }
      engine.update('cnv_aurora', { messages: [above, visible] })
      let reads = 0
      let activations = 0
      engine.markRead = async () => {
        reads += 1
      }
      const open = engine.open.bind(engine)
      engine.open = async id => {
        activations += 1
        return await open(id)
      }
      const state = newChatWorkspaceState()
      state.drafts.set('cnv_aurora', terminalDraft())
      await workspace(engine, state)
      await layout(
        document.querySelector('[data-testid="chat-workspace"]')!,
        320,
        700
      )
      const reading = terminalReadingPane()
      await reading.measure()
      const row = document.querySelector<HTMLElement>(
        '[data-testid="chat-message-msg_original"]'
      )!.parentElement!
      let rowY = 1030
      Object.defineProperty(row, 'offsetTop', {
        configurable: true,
        get: () => rowY
      })
      row.getBoundingClientRect = () =>
        new window.DOMRect(0, rowY - reading.node.scrollTop, 640, 1000)
      await layout(row, 640, 1000, 1030)
      await act(async () => {
        reading.node.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
        )
        await wait()
      })
      await reading.deliver(
        renderedReadingCallbacks(reading.node),
        'onScroll',
        1000
      )
      expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: 30
      })
      await type('New current unsent caption')
      const beforeReads = reads
      const beforeActivations = activations
      reading.moves.length = 0
      await act(async () => {
        engine.update('cnv_aurora', {
          messages: [
            change === 'edit'
              ? { ...above, body: 'Shorter wording', edited: true }
              : { ...above, body: '', status: 'removed', removedBy: 'author' },
            visible
          ]
        })
        await wait()
      })
      rowY = 966
      await layout(row, 640, 1000, 966)
      const content = renderedReadingCallbacks(
        reading.node
      ) as ScrollCallbacks & {
        onContentSizeChange: (width: number, height: number) => void
      }
      await act(async () => {
        content.onContentSizeChange(640, 2136)
        await wait()
      })
      const saved = state.drafts.get('cnv_aurora')!
      expect(saved.scrollOffset).equals(1000)
      expect(saved.followNewest).equals(false)
      expect(saved.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: -34
      })
      expect(saved.text).equals('New current unsent caption')
      expect(saved.replyTo?.id).equals('msg_original')
      expect(saved.picked.map(file => file.fileName)).deep.equals(['notes.pdf'])
      expect(reading.moves, 'Saving a live reflow must not scroll').deep.equals(
        []
      )
      expect(reads, 'Geometry does not advance read cursor').equals(beforeReads)
      expect(activations, 'Geometry does not activate a conversation').equals(
        beforeActivations
      )
      await unmount()
      await workspace(engine, state)
      await layout(
        document.querySelector('[data-testid="chat-workspace"]')!,
        320,
        700
      )
      const returning = terminalReadingPane()
      const mountedRow = document.querySelector<HTMLElement>(
        '[data-testid="chat-message-msg_original"]'
      )!.parentElement!
      Object.defineProperty(mountedRow, 'offsetTop', {
        configurable: true,
        value: 966
      })
      mountedRow.getBoundingClientRect = () =>
        new window.DOMRect(0, 966 - returning.node.scrollTop, 640, 1000)
      await returning.measure()
      expect(returning.moves).contains(1000)
      expect(
        returning.moves.some(offset => offset === 936),
        'No obsolete relative30 restore'
      ).equals(false)
      expect(returning.node.scrollTop).equals(1000)
      expect(966 - returning.node.scrollTop).equals(-34)
    })

  it('ignores retained reflow layout callbacks after a narrow hide or full unmount without stale draft writes or scroll', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', { messages: [original()] })
    const state = newChatWorkspaceState()
    state.drafts.set('cnv_aurora', terminalDraft())
    await workspace(engine, state)
    await layout(
      document.querySelector('[data-testid="chat-workspace"]')!,
      320,
      700
    )
    const reading = terminalReadingPane()
    await reading.measure()
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_original"]'
    )!.parentElement! as HTMLElement & {
      __reactLayoutHandler: (event: {
        nativeEvent: {
          layout: { x: number; y: number; width: number; height: number }
        }
      }) => void
    }
    const retained = row.__reactLayoutHandler
    await act(async () => {
      reading.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
      await wait()
    })
    await reading.deliver(
      renderedReadingCallbacks(reading.node),
      'onScroll',
      1000
    )
    await workspace(engine, state, null)
    const saved = state.drafts.get('cnv_aurora')
    reading.moves.length = 0
    await act(async () => {
      retained({
        nativeEvent: { layout: { x: 0, y: 966, width: 640, height: 1000 } }
      })
      await wait()
    })
    expect(state.drafts.get('cnv_aurora')).equals(saved)
    expect(reading.moves).deep.equals([])
    await unmount()
    await act(async () => {
      retained({
        nativeEvent: { layout: { x: 0, y: 900, width: 640, height: 1000 } }
      })
      await wait()
    })
    expect(state.drafts.get('cnv_aurora')).equals(saved)
    expect(reading.moves).deep.equals([])
  })
})

describe('review3 browser virtual fill scheduling', function () {
  it('fills its saved reader after the current interaction finishes without another batching delay', async function () {
    // The installed adapter exposes this public API; the app's compatibility
    // declaration intentionally lists only its ordinary component surface.
    const { InteractionManager } = ReactNative as unknown as {
      InteractionManager: {
        createInteractionHandle: () => number
        clearInteractionHandle: (id: number) => void
        runAfterInteractions: (task: () => void) => unknown
      }
    }
    const pending = await returningList(true, 6000, {
      id: 'cnv_return_99',
      relativeY: 30
    })
    await pending.populate(300)
    Object.defineProperties(pending.node, {
      offsetHeight: { configurable: true, value: 400 },
      offsetWidth: { configurable: true, value: 320 }
    })
    expect(
      document.querySelector('[data-testid="chat-conversation-cnv_return_99"]')
    ).equals(null)
    // Drain earlier real-clock work before taking ownership of this clock.
    await act(async () => {
      await new Promise<void>(resolve => {
        InteractionManager.runAfterInteractions(resolve)
      })
    })
    mock.timers.enable({ apis: ['setTimeout'] })
    const handle = InteractionManager.createInteractionHandle()
    try {
      await act(async () => {
        pending.setDomContent(9000)
        ;(
          pending.node.firstElementChild as HTMLElement & {
            __reactLayoutHandler: (event: unknown) => void
          }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 9000 } }
        })
        pending.node.dispatchEvent(
          new window.Event('scroll', { bubbles: true })
        )
        mock.timers.tick(1)
      })
      expect(
        document.querySelector(
          '[data-testid="chat-conversation-cnv_return_99"]'
        )
      ).equals(null)
      await act(async () => {
        InteractionManager.clearInteractionHandle(handle)
        mock.timers.tick(1)
      })
      const mounted = document.querySelector<HTMLElement>(
        '[data-testid="chat-conversation-cnv_return_99"]'
      )
      expect(
        mounted,
        'The saved reader is mounted when its interaction releases'
      ).not.equals(null)
      const row = mounted!.parentElement!
      Object.defineProperties(row, {
        offsetTop: { configurable: true, value: 20138 },
        offsetHeight: { configurable: true, value: 67 },
        offsetWidth: { configurable: true, value: 320 },
        offsetParent: {
          configurable: true,
          value: pending.node.firstElementChild
        }
      })
      await act(async () => {
        renderedRowLayout('cnv_return_99')({
          nativeEvent: { layout: { height: 67 } }
        })
        pending.setDomContent(22000)
        ;(
          pending.node.firstElementChild as HTMLElement & {
            __reactLayoutHandler: (event: unknown) => void
          }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 22000 } }
        })
        mock.timers.tick(1)
      })
      // Resolve the actual mounted measurement callbacks, not a new scroll.
      for (let turn = 0; turn < 10 && pending.moves.at(-1) !== 20108; turn++)
        await act(async () => {
          mock.timers.tick(1)
        })
      expect(pending.moves.at(-1)).equals(20108)
      await act(async () => {
        ;(
          renderedListCallbacks(pending.node) as ListLayoutCallbacks & {
            onScrollEndDrag: (event: {
              nativeEvent: { contentOffset: { y: number } }
            }) => void
          }
        ).onScrollEndDrag({ nativeEvent: { contentOffset: { y: 20108 } } })
        mock.timers.tick(1)
      })
      expect(pending.offsets.at(-1)).equals(20108)
      expect(pending.anchors.at(-1)).deep.equals({
        id: 'cnv_return_99',
        relativeY: 30
      })
    } finally {
      InteractionManager.clearInteractionHandle(handle)
      await act(async () => {
        if (root != null) {
          root.unmount()
          root = undefined
        }
        mock.timers.tick(100)
        let drained = false
        InteractionManager.runAfterInteractions(() => {
          drained = true
        })
        mock.timers.tick(1)
        expect(drained, 'Owned virtual-list clock drains before reset').equals(
          true
        )
      })
      mock.timers.reset()
      document.body.innerHTML = ''
    }
  })
})

describe('review4 no-event clamps and reachable jumps', function () {
  it('saves the verified zero of a complete shorter list without a synthetic scroll event or later obsolete restore', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_removed',
      relativeY: 30
    })
    await pending.populate(2)
    setListRowMeasurement('cnv_return_1', 120, listTailHeight(80))
    await pending.content(200)
    await act(async () => {
      await wait(30)
    })
    expect(pending.moves).deep.equals([0])
    expect(pending.node.scrollTop).equals(0)
    expect(pending.offsets.at(-1)).equals(0)
    // No scroll/drag/momentum callback is delivered for this zero-distance move.
    await pending.content(900)
    expect(pending.moves).deep.equals([0])
    expect(pending.offsets.at(-1)).equals(0)
  })

  for (const route of ['quote', 'pin'] as const)
    it(`persists the actual reachable near-end ${route} jump and keeps it after more content while unmounted`, async function () {
      const engine = new ReviewEngine()
      const quoted = message({
        id: 'msg_quote',
        seq: 2,
        body: 'Received reply',
        quote: {
          id: 'msg_original',
          authorId: 2,
          authorName: 'Shohei Ohtani',
          snippet: 'Practice notes',
          status: 'ok'
        }
      })
      engine.update('cnv_aurora', {
        messages: [original(), quoted],
        pins: [{ messageId: 'msg_original', pinnedAt: '2026-01-01T00:00:00Z' }]
      })
      const state = newChatWorkspaceState()
      await workspace(engine, state, 'cnv_aurora')
      await type('New current caption')
      const reading = terminalReadingPane()
      const body = reading.node.firstElementChild as HTMLElement
      const row = document.querySelector<HTMLElement>(
        '[data-testid="chat-message-msg_original"]'
      )!.parentElement!
      let content = 1200
      Object.defineProperties(reading.node, {
        scrollHeight: { configurable: true, get: () => content }
      })
      Object.defineProperties(row, {
        offsetTop: { configurable: true, value: 1000 },
        offsetHeight: { configurable: true, value: 100 },
        offsetParent: { configurable: true, value: body }
      })
      Object.defineProperties(body, {
        offsetHeight: { configurable: true, get: () => content }
      })
      reading.node.scroll = options => {
        const target = (options as ScrollToOptions).top ?? 0
        reading.moves.push(target)
        reading.node.scrollTop = Math.min(target, Math.max(0, content - 400))
      }
      await layout(reading.node, 640, 400)
      await layout(body, 640, content)
      await layout(row, 640, 100, 1000)
      reading.moves.length = 0
      if (route === 'quote')
        await press('Jump to message from Shohei Ohtani: Practice notes')
      else await press('Pinned messages: 1')
      const jumpDeadline = Date.now() + 2000
      while (reading.moves.length === 0 && Date.now() < jumpDeadline)
        await act(async () => {
          await wait(10)
        })
      expect(reading.moves.at(-1)).equals(800)
      await act(async () => {
        reading.node.scrollTop = 800
        renderedReadingCallbacks(reading.node).onMomentumScrollEnd?.({
          nativeEvent: {
            contentOffset: { x: 0, y: 800 },
            contentSize: { width: 640, height: content },
            layoutMeasurement: { width: 640, height: 400 }
          }
        })
        await wait()
      })
      expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(800)
      expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: 200
      })
      expect(state.drafts.get('cnv_aurora')!.followNewest).equals(false)
      expect(state.drafts.get('cnv_aurora')!.text).equals('New current caption')
      await unmount()
      engine.update('cnv_aurora', {
        messages: [original(), quoted, original('msg_later')]
      })
      await workspace(engine, state, 'cnv_aurora')
      const returned = terminalReadingPane()
      const returnedBody = returned.node.firstElementChild as HTMLElement
      const returnedRow = document.querySelector<HTMLElement>(
        '[data-testid="chat-message-msg_original"]'
      )!.parentElement!
      content = 2000
      Object.defineProperties(returned.node, {
        scrollHeight: { configurable: true, get: () => content }
      })
      Object.defineProperties(returnedBody, {
        offsetHeight: { configurable: true, get: () => content }
      })
      Object.defineProperties(returnedRow, {
        offsetTop: { configurable: true, value: 1000 },
        offsetHeight: { configurable: true, value: 100 },
        offsetParent: { configurable: true, value: returnedBody }
      })
      await layout(returned.node, 640, 400)
      await layout(returnedBody, 640, content)
      await layout(returnedRow, 640, 100, 1000)
      await act(async () => {
        await wait(80)
      })
      expect(returned.moves.at(-1)).equals(800)
      expect(returned.moves).not.contains(992)
      expect(state.drafts.get('cnv_aurora')!.scrollAnchor).deep.equals({
        id: 'msg_original',
        relativeY: 200
      })
      expect(state.drafts.get('cnv_aurora')!.text).equals('New current caption')
      expect(engine.sent).deep.equals([])
    })
})

describe('review4 quiet preview recovery', function () {
  it('shows a recoverable unavailable preview and retries only that row without opening it', async function () {
    const engine = new ReviewEngine()
    engine.update('cnv_aurora', {
      conversation: chat({
        id: 'cnv_aurora',
        title: 'Aurora Members',
        scopeName: 'Aurora',
        lastSeq: 1,
        previewFailed: true
      })
    })
    const calls: Array<{ id: string; retry: boolean }> = []
    const completed = deferred<undefined>()
    engine.loadPreview = async (id, retry = false) => {
      calls.push({ id, retry })
      if (!retry) return
      engine.update(id, {
        conversation: {
          ...engine.view(id)!.conversation,
          previewRetrying: true
        }
      })
      engine.emit({ type: 'conversations' })
      await completed.promise
      engine.update(id, {
        conversation: {
          ...engine.view(id)!.conversation,
          previewFailed: false,
          previewRetrying: false,
          preview: 'Recovered latest post'
        }
      })
      engine.emit({ type: 'conversations' })
    }
    const opened: string[] = []
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={chat => opened.push(chat.id)}
        onNewMessage={() => {}}
      />
    )
    const row = document.querySelector(
      '[data-testid="chat-conversation-cnv_aurora"]'
    )!
    expect(row.textContent).contains('Could not load latest message.')
    expect(row.textContent).not.contains('Loading latest message')
    await press('Try loading latest message again')
    const retryButton = document.querySelector<HTMLElement>(
      '[data-testid="chat-preview-retry-cnv_aurora"]'
    )!
    expect(retryButton.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      retryButton.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      )
      await wait()
    })
    expect(calls.filter(call => call.retry)).deep.equals([
      { id: 'cnv_aurora', retry: true }
    ])
    await act(async () => {
      completed.resolve(undefined)
      await wait()
    })
    expect(
      document.querySelector('[data-testid="chat-conversation-cnv_aurora"]')!
        .textContent
    ).contains('Recovered latest post')
    expect(
      document.querySelector('[data-testid="chat-preview-retry-cnv_aurora"]')
    ).equals(null)
    expect(opened).deep.equals([])
    expect(engine.sent).deep.equals([])
  })
})

describe('qa4 accepted list boundaries', function () {
  it('accepts a phone clamp only after its tail plus measured navigation inset completes and preserves the same reader after growth', async function () {
    const pending = await returningList(
      true,
      780,
      { id: 'cnv_return_1', relativeY: 20 },
      76
    )
    await pending.populate(2)
    const incompleteHeight = listTailHeight(194)
    const completeHeight = listTailHeight(200)
    expect(completeHeight).equals(76)
    setListRowMeasurement('cnv_return_1', 800, incompleteHeight)
    await pending.content(1000)
    await act(async () => {
      await wait(40)
    })
    expect(pending.moves).deep.equals([600])
    await pending.scroll(600)
    expect(
      pending.offsets,
      'An incomplete tail cannot acknowledge the clamp'
    ).deep.equals([])
    setListRowMeasurement('cnv_return_1', 800, completeHeight)
    await act(async () => {
      renderedRowLayout('cnv_return_1')({
        nativeEvent: { layout: { height: completeHeight } }
      })
      await wait(40)
    })
    expect(
      pending.moves,
      'Completion does not issue another scroll'
    ).deep.equals([600])
    expect(pending.offsets.at(-1)).equals(600)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_1',
      relativeY: 200
    })
    setListRowMeasurement('cnv_return_1', 800, listTailHeight(500))
    await pending.content(1300)
    await act(async () => {
      await wait(40)
    })
    expect(pending.moves).deep.equals([600])
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_1',
      relativeY: 200
    })
  })

  it('finishes a complete surviving-anchor clamp at the acknowledged relative position without restoring the obsolete target after growth', async function () {
    const pending = await returningList(true, 610, {
      id: 'cnv_return_1',
      relativeY: 20
    })
    await pending.populate(2)
    setListRowMeasurement('cnv_return_1', 630, listTailHeight(90))
    await pending.content(720)
    await act(async () => {
      renderedRowLayout('cnv_return_1')({
        nativeEvent: { layout: { height: listTailHeight(90) } }
      })
      await wait(40)
    })
    expect(pending.moves.at(-1)).equals(320)
    expect(pending.offsets).deep.equals([])
    await pending.scroll(320)
    expect(pending.offsets.at(-1)).equals(320)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_1',
      relativeY: 310
    })
    setListRowMeasurement('cnv_return_1', 630, listTailHeight(490))
    await pending.content(1120)
    await act(async () => {
      await wait(40)
    })
    expect(pending.moves).not.contains(610)
    expect(pending.moves.at(-1)).equals(320)
    // A genuine later prefix change still preserves this accepted reader.
    setListRowMeasurement('cnv_return_1', 670, listTailHeight(490))
    await pending.content(1160)
    await act(async () => {
      await wait(40)
    })
    expect(pending.moves.at(-1)).equals(360)
  })

  it('does not finalize a surviving-anchor clamp before the current tail is complete', async function () {
    const pending = await returningList(true, 610, {
      id: 'cnv_return_1',
      relativeY: 20
    })
    await pending.populate(2)
    setListRowMeasurement('cnv_return_1', 630, listTailHeight(80))
    await pending.content(720)
    await act(async () => {
      await wait(40)
    })
    await pending.scroll(320)
    expect(pending.offsets).deep.equals([])
    setListRowMeasurement('cnv_return_1', 630, listTailHeight(90))
    await act(async () => {
      renderedRowLayout('cnv_return_1')({
        nativeEvent: { layout: { height: listTailHeight(90) } }
      })
      await wait(40)
    })
    expect(
      pending.moves,
      'Promote the genuine previous ACK without a second scroll'
    ).deep.equals([320])
    expect(pending.offsets.at(-1)).equals(320)
  })

  it('persists an actual user terminal zero through delayed row measurements and a changed action header on remount', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', {
          bubbles: true,
          deltaY: 100
        })
      )
    })
    await pending.scroll(100)
    await act(async () => {
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    expect(pending.anchors.at(-1)).not.equals(undefined)
    const end = renderedListCallbacks(pending.node) as ListLayoutCallbacks & {
      onScrollEndDrag: (event: {
        nativeEvent: { contentOffset: { y: number } }
      }) => void
    }
    await act(async () => {
      // The preceding web gesture has completed; this is a new native drag.
      nativeListStart(pending.node)
      pending.node.scrollTop = 0
      end.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(
      pending.anchors.at(-1),
      'The user chose the action header at the absolute top'
    ).equals(undefined)
    await act(async () => {
      setListRowMeasurement('cnv_return_0', 160)
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait()
    })
    expect(
      pending.anchors.at(-1),
      'A delayed row callback cannot replace the explicit top'
    ).equals(undefined)
    await unmount()
    const returning = await returningList(
      true,
      pending.offsets.at(-1),
      pending.anchors.at(-1)
    )
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 160)
    await returning.content(1800)
    await returning.scroll(0)
    expect(returning.moves).deep.equals([0])
    expect(returning.node.scrollTop).equals(0)
    // Complete a measured first return, then navigate again without movement.
    await act(async () => {
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    const measuredAnchor = returning.anchors.at(-1)
    await unmount()
    const second = await returningList(
      true,
      returning.offsets.at(-1),
      measuredAnchor
    )
    await second.populate(8)
    setListRowMeasurement('cnv_return_0', 216)
    await second.content(1800)
    await second.scroll(second.moves.at(-1)!)
    expect(
      second.moves,
      'A measured remount must not recreate a row-relative top'
    ).deep.equals([0])
    expect(second.node.scrollTop).equals(0)
    expect(measuredAnchor).equals(undefined)
  })

  it('does not accept a stale hidden terminal zero as a new user reading position', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(240)
    const saved = pending.anchors.at(-1)
    const end = renderedListCallbacks(pending.node) as ListLayoutCallbacks & {
      onMomentumScrollEnd: (event: {
        nativeEvent: { contentOffset: { y: number } }
      }) => void
    }
    await pending.hide()
    await act(async () => {
      end.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(240)
    expect(pending.anchors.at(-1)).deep.equals(saved)
  })
})

interface NativeListEvent {
  nativeEvent: { contentOffset: { y: number }; velocity?: { y: number } }
}
function nativeListStart(node: HTMLElement, momentum = false): void {
  const props = renderedListCallbacks(node) as ListLayoutCallbacks & {
    onScrollBeginDrag: () => void
    onMomentumScrollBegin?: () => void
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    ReactNative.Platform,
    'OS'
  )!
  try {
    Object.defineProperty(ReactNative.Platform, 'OS', {
      ...descriptor,
      value: 'ios'
    })
    if (momentum) props.onMomentumScrollBegin?.()
    else props.onScrollBeginDrag()
  } finally {
    Object.defineProperty(ReactNative.Platform, 'OS', descriptor)
  }
}
function nativeListEnd(
  node: HTMLElement,
  momentum = false
): (event: NativeListEvent) => void {
  const props = renderedListCallbacks(node) as ListLayoutCallbacks & {
    onScrollEndDrag: (event: NativeListEvent) => void
    onMomentumScrollEnd: (event: NativeListEvent) => void
  }
  return momentum ? props.onMomentumScrollEnd : props.onScrollEndDrag
}

describe('qa4 review1 native-shaped list lifecycle', function () {
  for (const rawZero of [0, -40])
    it(`keeps the supplied zero boundary after begin/end without normalized movement (${rawZero})`, async function () {
      const pending = await returningList(true, 0, {
        id: 'cnv_return_0',
        relativeY: 105
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_0', 105)
      await pending.content(1800)
      await pending.scroll(0)
      const saved = pending.anchors.at(-1)
      await act(async () => {
        nativeListStart(pending.node)
        nativeListEnd(pending.node)({
          nativeEvent: { contentOffset: { y: rawZero } }
        })
        await wait()
      })
      expect(pending.offsets.at(-1)).equals(0)
      expect(pending.anchors.at(-1)).deep.equals(saved)
      await unmount()
      const returning = await returningList(true, 0, saved)
      await returning.populate(8)
      setListRowMeasurement('cnv_return_0', 169)
      await returning.content(1800)
      await act(async () => {
        await wait(40)
      })
      expect(returning.moves.at(-1)).equals(64)
    })

  it('accepts a positive-to-zero native terminal with no intermediate scroll event or velocity', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(240)
    await act(async () => {
      nativeListStart(pending.node)
      pending.node.scrollTop = 0
      nativeListEnd(pending.node)({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })

  it('carries only a preceding native release into its actual momentum terminal', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(240)
    await act(async () => {
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({
        nativeEvent: { contentOffset: { y: 160 }, velocity: { y: -2 } }
      })
      nativeListStart(pending.node, true)
      pending.node.scrollTop = 0
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })

  for (const velocity of [undefined, 0])
    it(`always ingests momentum coordinates but does not inherit closed intent without release velocity (${velocity})`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_3', 270)
      await pending.content(1800)
      await pending.scroll(240)
      await act(async () => {
        nativeListStart(pending.node)
        nativeListEnd(pending.node)({
          nativeEvent: {
            contentOffset: { y: 160 },
            ...(velocity == null ? {} : { velocity: { y: velocity } })
          }
        })
        nativeListStart(pending.node, true)
        nativeListEnd(
          pending.node,
          true
        )({ nativeEvent: { contentOffset: { y: 0 } } })
        await wait()
      })
      expect(pending.offsets.at(-1)).equals(0)
      expect(pending.anchors.at(-1)).deep.equals({
        id: 'cnv_return_3',
        relativeY: 270
      })
    })

  it('rejects unsolicited programmatic momentum classification and a hidden retained terminal', async function () {
    const pending = await returningList(true, 0, {
      id: 'cnv_return_0',
      relativeY: 105
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 105)
    await pending.content(1800)
    await pending.scroll(0)
    const saved = pending.anchors.at(-1)
    await act(async () => {
      nativeListStart(pending.node, true)
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 100 } } })
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.anchors.at(-1)).deep.equals(saved)
    await act(async () => {
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({
        nativeEvent: { contentOffset: { y: 100 }, velocity: { y: 2 } }
      })
      await wait()
    })
    const end = nativeListEnd(pending.node, true)
    const offset = pending.offsets.at(-1)
    const anchor = pending.anchors.at(-1)
    await pending.hide()
    await act(async () => {
      end({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(offset)
    expect(pending.anchors.at(-1)).deep.equals(anchor)
  })
})

describe('qa4 review2 actual RNW scroll lifetime', function () {
  for (const intent of ['wheel', 'key'])
    it(`ends completed ${intent} input through RNW onScroll before an automatic clamp and preserves the later relative return`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_3', 270)
      await pending.content(1800)
      await pending.scroll(240)
      await act(async () => {
        pending.node.dispatchEvent(
          intent === 'wheel'
            ? new window.WheelEvent('wheel', { bubbles: true, deltaY: 60 })
            : new window.KeyboardEvent('keydown', {
                bubbles: true,
                key: 'ArrowDown'
              })
        )
      })
      // The installed RNW adapter delivers the DOM tick and its delayed ending
      // only through onScroll. Do not manufacture a native terminal callback.
      await pending.scroll(300)
      await act(async () => {
        renderedRowLayout('cnv_return_3')({
          nativeEvent: { layout: { height: 67 } }
        })
        await wait()
      })
      expect(pending.anchors.at(-1)).deep.equals({
        id: 'cnv_return_3',
        relativeY: -30
      })
      // Calibrate the actual longer viewport and resulting automatic zero.
      Object.defineProperty(pending.node, 'clientHeight', {
        configurable: true,
        value: 2000
      })
      await layout(pending.node, 320, 2000)
      await act(async () => {
        renderedRowLayout('cnv_return_3')({
          nativeEvent: { layout: { height: 67 } }
        })
        await wait()
      })
      await pending.scroll(0)
      const saved = pending.anchors.at(-1)
      expect(pending.offsets.at(-1)).equals(0)
      await unmount()
      const returning = await returningList(true, 0, saved)
      await returning.populate(8)
      setListRowMeasurement('cnv_return_3', 334)
      await returning.content(1800)
      await act(async () => {
        await wait(40)
      })
      expect(
        returning.moves.at(-1),
        'Automatic clamp must retain the current row-relative reading boundary'
      ).equals(64)
      expect(saved).deep.equals({ id: 'cnv_return_3', relativeY: 270 })
    })

  for (const intent of ['wheel', 'key', 'gutter'])
    it(`preserves genuine continuous ${intent} movement to top using real DOM scroll dispatch`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_3', 270)
      await pending.content(1800)
      await pending.scroll(240)
      pending.node.getBoundingClientRect = () =>
        new window.DOMRect(0, 0, 320, 400)
      Object.defineProperties(pending.node, {
        clientWidth: { configurable: true, value: 304 },
        offsetWidth: { configurable: true, value: 320 },
        offsetHeight: { configurable: true, value: 400 },
        clientLeft: { configurable: true, value: 0 },
        clientTop: { configurable: true, value: 0 }
      })
      await act(async () => {
        pending.node.dispatchEvent(
          intent === 'wheel'
            ? new window.WheelEvent('wheel', { bubbles: true, deltaY: -240 })
            : intent === 'key'
              ? new window.KeyboardEvent('keydown', {
                  bubbles: true,
                  key: 'Home'
                })
              : new window.MouseEvent('mousedown', {
                  bubbles: true,
                  button: 0,
                  clientX: 319,
                  clientY: 100
                })
        )
        // A single gesture has multiple raw events; its final coordinate can
        // arrive only in RNW's coalesced ending callback after the DOM dispatch.
        for (const top of [160, 80, 0]) {
          pending.node.scrollTop = top
          pending.node.dispatchEvent(
            new window.Event('scroll', { bubbles: true })
          )
        }
        if (intent === 'gutter')
          document.dispatchEvent(
            new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
          )
        await wait(150)
      })
      expect(pending.offsets.at(-1)).equals(0)
      expect(pending.anchors.at(-1)).equals(undefined)
      await unmount()
      const returning = await returningList(true, 0, pending.anchors.at(-1))
      await returning.populate(8)
      setListRowMeasurement('cnv_return_3', 334)
      await returning.content(1800)
      expect(returning.moves).deep.equals([0])
    })
})

describe('qa4 review3 DOM-owned reading position', function () {
  it('retains one held gutter drag across RNW inactivity and resumes to the absolute top', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(240)
    pending.node.getBoundingClientRect = () =>
      new window.DOMRect(0, 0, 320, 400)
    Object.defineProperties(pending.node, {
      clientWidth: { configurable: true, value: 304 },
      offsetWidth: { configurable: true, value: 320 },
      offsetHeight: { configurable: true, value: 400 },
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 }
    })
    await act(async () => {
      pending.node.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 319,
          clientY: 200
        })
      )
    })
    await pending.scroll(160)
    // pending.scroll includes the installed RNW inactivity callback while held.
    await pending.scroll(0)
    await act(async () => {
      document.dispatchEvent(
        new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
      )
      await wait(40)
    })
    expect(pending.anchors.at(-1)).equals(undefined)
    await unmount()
    const returning = await returningList(true, 0, pending.anchors.at(-1))
    await returning.populate(8)
    setListRowMeasurement('cnv_return_3', 334)
    await returning.content(1800)
    expect(returning.moves).deep.equals([0])
  })

  it('retires a wheel input with no bottom movement before a later automatic clamp and preserves its relative return', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(700)
    await pending.scroll(240)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 60 })
      )
    })
    await pending.scroll(300)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 60 })
      )
      await wait(40)
    })
    Object.defineProperty(pending.node, 'clientHeight', {
      configurable: true,
      value: 800
    })
    await layout(pending.node, 320, 800)
    await act(async () => {
      renderedRowLayout('cnv_return_3')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait()
    })
    await pending.scroll(0)
    const saved = pending.anchors.at(-1)
    expect(saved).deep.equals({ id: 'cnv_return_3', relativeY: 270 })
    await unmount()
    const returning = await returningList(true, 0, saved)
    await returning.populate(8)
    setListRowMeasurement('cnv_return_3', 334)
    await returning.content(1800)
    expect(returning.moves.at(-1)).equals(64)
  })

  it('rejects hidden and replaced-data input ownership before a delayed zero event', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(240)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: -240 })
      )
    })
    await pending.hide()
    const before = [...pending.offsets]
    await pending.scroll(0)
    expect(pending.offsets).deep.equals(before)
    await pending.show()
    await pending.scroll(240)
    await act(async () => {
      pending.node.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: -240 })
      )
    })
    await pending.reorder()
    await pending.scroll(0)
    expect(
      pending.anchors.at(-1),
      'An obsolete input must not choose explicit top'
    ).not.equals(undefined)
  })
})

describe('qa4 review3 scoped web input completion', function () {
  it('tracks delayed moving frames through scrollend, ignores child scrolls, cancels programmatic movement and disposes only its binding', async function () {
    const candidate: unknown = Reflect.get(WebScroll, 'cancelUserScroll')
    const nativeCandidate: unknown = Reflect.get(
      NativeScroll,
      'cancelUserScroll'
    )
    if (
      typeof candidate !== 'function' ||
      typeof nativeCandidate !== 'function'
    ) {
      this.skip()
      return
    }
    const cancel = candidate as (view: unknown) => void
    const nativeCancel = nativeCandidate as (view: unknown) => void
    const element = document.createElement('div')
    const child = document.createElement('div')
    element.append(child)
    document.body.append(element)
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1800 }
    })
    const view = { getScrollableNode: () => element }
    const positions: number[] = []
    let reads = 0
    const stop = WebScroll.bindUserScroll(
      view,
      () => {
        reads += 1
      },
      top => {
        positions.push(top)
      }
    )
    try {
      element.scrollTop = 240
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' })
      )
      for (const top of [160, 80, 0]) {
        element.scrollTop = top
        element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise<void>(resolve =>
          window.requestAnimationFrame(() => {
            resolve()
          })
        )
      }
      expect(positions).deep.equals([160, 80, 0])
      element.dispatchEvent(new window.Event('scrollend'))
      element.scrollTop = 100
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([160, 80, 0])
      element.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 100 })
      )
      child.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([160, 80, 0])
      cancel(view)
      element.scrollTop = 0
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([160, 80, 0])
      const another = WebScroll.bindUserScroll(
        view,
        () => {
          reads += 1
        },
        top => {
          positions.push(top)
        }
      )
      element.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 100 })
      )
      stop()
      nativeCancel(view)
      element.scrollTop = 100
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions.at(-1)).equals(100)
      another()
      element.scrollTop = 200
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions.at(-1)).equals(100)
      const readOnly = WebScroll.bindUserScroll(view, () => {
        reads += 1
      })
      const beforeStationary = reads
      element.dispatchEvent(new window.Event('touchmove'))
      element.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 0 }))
      expect(reads).equals(beforeStationary + 2)
      readOnly()
      element.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 0 }))
      expect(reads).equals(beforeStationary + 2)
    } finally {
      stop()
      element.remove()
    }
  })
})

describe('qa4 review4 native ownership across hidden return', function () {
  for (const hiddenEnd of [true, false])
    it(`preserves a row-relative clamp after native terminal ${hiddenEnd ? 'while hidden' : 'before hide'}`, async function () {
      const pending = await returningList(true, 240, {
        id: 'cnv_return_3',
        relativeY: 30
      })
      await pending.populate(8)
      setListRowMeasurement('cnv_return_3', 270)
      await pending.content(1800)
      await pending.scroll(240)
      await act(async () => {
        nativeListStart(pending.node)
      })
      const end = nativeListEnd(pending.node)
      if (!hiddenEnd)
        await act(async () => {
          end({ nativeEvent: { contentOffset: { y: 240 } } })
          await wait()
        })
      await pending.hide()
      if (hiddenEnd)
        await act(async () => {
          end({ nativeEvent: { contentOffset: { y: 0 } } })
          await wait()
        })
      await pending.show()
      Object.defineProperty(pending.node, 'clientHeight', {
        configurable: true,
        value: 2000
      })
      await layout(pending.node, 320, 2000)
      await act(async () => {
        renderedRowLayout('cnv_return_3')({
          nativeEvent: { layout: { height: 67 } }
        })
        await wait()
      })
      await pending.scroll(0)
      const saved = pending.anchors.at(-1)
      expect(saved).deep.equals({ id: 'cnv_return_3', relativeY: 270 })
      await unmount()
      const returning = await returningList(true, 0, saved)
      await returning.populate(8)
      setListRowMeasurement('cnv_return_3', 334)
      await returning.content(1800)
      expect(returning.moves.at(-1)).equals(64)
    })
})

describe('qa4 review4 held geometry rebase', function () {
  it('rejects a geometry-induced coordinate, keeps the physical hold, and accepts subsequent movement to zero', function () {
    const element = document.createElement('div')
    document.body.append(element)
    let content = 1800
    element.scrollTop = 240
    element.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 400)
    Object.defineProperties(element, {
      clientHeight: { value: 400, configurable: true },
      clientWidth: { value: 304, configurable: true },
      offsetWidth: { value: 320, configurable: true },
      offsetHeight: { value: 400, configurable: true },
      scrollHeight: { get: () => content, configurable: true },
      clientTop: { value: 0, configurable: true },
      clientLeft: { value: 0, configurable: true }
    })
    const positions: number[] = []
    const stop = WebScroll.bindUserScroll(
      element,
      () => {},
      top => {
        positions.push(top)
      }
    )
    try {
      element.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 319,
          clientY: 200
        })
      )
      element.scrollTop = 160
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      content = 1900
      element.scrollTop = 100
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([160])
      element.scrollTop = 0
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([160, 0])
      document.dispatchEvent(
        new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
      )
    } finally {
      stop()
      element.remove()
    }
  })
})

function scrollEndSupport(present: boolean): () => void {
  const prototype = window.HTMLElement.prototype
  const original = Object.getOwnPropertyDescriptor(prototype, 'onscrollend')
  if (present)
    Object.defineProperty(prototype, 'onscrollend', {
      configurable: true,
      value: null
    })
  else Reflect.deleteProperty(prototype, 'onscrollend')
  return () => {
    if (original != null)
      Object.defineProperty(prototype, 'onscrollend', original)
    else Reflect.deleteProperty(prototype, 'onscrollend')
  }
}

describe('qa4 review4 delayed and finite web input', function () {
  for (const modern of [true, false])
    it(`accepts delayed Home after an unchanged initial RAF (${modern ? 'scrollend present' : 'legacy target'}) and retires completed motion`, async function () {
      const element = document.createElement('div')
      document.body.append(element)
      const restoreEnd = scrollEndSupport(modern)
      expect('onscrollend' in element).equals(modern)
      Object.defineProperties(element, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1800 }
      })
      element.scrollTop = 240
      const positions: number[] = []
      const stop = WebScroll.bindUserScroll(
        element,
        () => {},
        top => {
          positions.push(top)
        }
      )
      try {
        element.dispatchEvent(
          new window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' })
        )
        await new Promise<void>(resolve =>
          window.requestAnimationFrame(() => {
            resolve()
          })
        )
        expect(positions).deep.equals([])
        for (const top of [160, 0]) {
          element.scrollTop = top
          element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        }
        expect(positions).deep.equals([160, 0])
        element.dispatchEvent(new window.Event('scrollend'))
        element.scrollTop = 100
        element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        expect(positions).deep.equals([160, 0])
      } finally {
        stop()
        restoreEnd()
        element.remove()
      }
    })

  it('uses a finite legacy arrow/page and normalized wheel destination without taking canceled, modified, editable or nested input', function () {
    const element = document.createElement('div')
    const editable = document.createElement('input')
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    element.append(editable, nested)
    document.body.append(element)
    const restoreEnd = scrollEndSupport(false)
    expect('onscrollend' in element).equals(false)
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1800 }
    })
    Object.defineProperties(nested, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: { configurable: true, value: 200 }
    })
    const commands: number[] = []
    let top = 240
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
        commands.push(value)
      }
    })
    const positions: number[] = []
    const stop = WebScroll.bindUserScroll(
      element,
      () => {},
      top => {
        positions.push(top)
      }
    )
    try {
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'ArrowUp'
        })
      )
      expect(commands.at(-1)).equals(200)
      expect(positions).deep.equals([200])
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'PageUp'
        })
      )
      expect(positions.at(-1)).equals(0)
      const count = commands.length
      const prevent = (event: Event): void => {
        event.preventDefault()
      }
      document.addEventListener('keydown', prevent)
      try {
        element.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'ArrowDown'
          })
        )
        expect(commands.length).equals(count)
      } finally {
        document.removeEventListener('keydown', prevent)
      }
      const canceled = new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowDown'
      })
      canceled.preventDefault()
      element.dispatchEvent(canceled)
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'ArrowDown'
        })
      )
      editable.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'ArrowDown'
        })
      )
      nested.dispatchEvent(
        new window.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 100
        })
      )
      expect(commands.length).equals(count)
      element.dispatchEvent(
        new window.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 100
        })
      )
      expect(positions.at(-1)).equals(100)
      expect(commands.at(-1)).equals(100)
      stop()
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'ArrowDown'
        })
      )
      expect(commands.length).equals(count + 1)
    } finally {
      stop()
      restoreEnd()
      element.remove()
    }
  })

  it('retires modern canceled input and accepts only exact scrollend without treating a held pause as completion', function () {
    const element = document.createElement('div')
    const child = document.createElement('div')
    element.append(child)
    document.body.append(element)
    Object.defineProperties(element, {
      onscrollend: { configurable: true, value: null },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1800 }
    })
    element.scrollTop = 240
    const positions: number[] = []
    const stop = WebScroll.bindUserScroll(
      element,
      () => {},
      top => {
        positions.push(top)
      }
    )
    const prevent = (event: Event): void => {
      event.preventDefault()
    }
    document.addEventListener('keydown', prevent)
    try {
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Home'
        })
      )
      element.scrollTop = 160
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([])
      document.removeEventListener('keydown', prevent)
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })
      )
      child.dispatchEvent(new window.Event('scrollend', { bubbles: true }))
      element.scrollTop = 80
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([80])
      element.dispatchEvent(new window.Event('scrollend'))
      element.scrollTop = 0
      element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(positions).deep.equals([80])
    } finally {
      document.removeEventListener('keydown', prevent)
      stop()
      element.remove()
    }
  })
})

describe('qa4 review5 independent touch stream', function () {
  function touchScroller(modern: boolean): {
    element: HTMLElement
    positions: number[]
    touch: (type: string, y?: number) => void
    scroll: (top: number) => void
    stop: () => void
    dispose: () => void
  } {
    const element = document.createElement('div')
    document.body.append(element)
    const restoreEnd = scrollEndSupport(modern)
    element.scrollTop = 240
    element.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 400)
    Object.defineProperties(element, {
      clientHeight: { value: 400, configurable: true },
      clientWidth: { value: 304, configurable: true },
      offsetWidth: { value: 320, configurable: true },
      offsetHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1800, configurable: true },
      clientTop: { value: 0, configurable: true },
      clientLeft: { value: 0, configurable: true }
    })
    const positions: number[] = []
    const stop = WebScroll.bindUserScroll(
      element,
      () => {},
      top => {
        positions.push(top)
      }
    )
    return {
      element,
      positions,
      touch: (type, y) => {
        const event = new window.Event(type, { bubbles: true })
        Object.defineProperty(event, 'touches', {
          value: y == null ? [] : [{ clientY: y }]
        })
        element.dispatchEvent(event)
      },
      scroll: top => {
        element.scrollTop = top
        element.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      },
      stop,
      dispose: () => {
        stop()
        restoreEnd()
        element.remove()
      }
    }
  }

  for (const modern of [true, false])
    it(`keeps the same physical touch pan after pointercancel (${modern ? 'scrollend present' : 'legacy'})`, function () {
      const pane = touchScroller(modern)
      try {
        pane.touch('touchstart', 200)
        pane.touch('touchmove', 240)
        document.dispatchEvent(new window.Event('pointercancel'))
        pane.scroll(160)
        pane.touch('touchmove', 400)
        pane.scroll(0)
        expect(pane.positions).deep.equals([160, 0])
      } finally {
        pane.dispose()
      }
    })

  for (const boundary of ['touchcancel', 'touchend', 'blur', 'dispose'])
    it(`retires the actual touch stream at ${boundary} and ignores subsequent offsets without a new touchstart`, function () {
      const pane = touchScroller(false)
      try {
        pane.touch('touchstart', 200)
        pane.touch('touchmove', 240)
        if (boundary === 'dispose') pane.stop()
        else if (boundary === 'blur')
          window.dispatchEvent(new window.Event('blur'))
        else pane.touch(boundary)
        pane.scroll(160)
        pane.touch('touchmove', 400)
        pane.scroll(0)
        expect(pane.positions).deep.equals([])
      } finally {
        pane.dispose()
      }
    })

  it('cancels pointer-only scrollbar ownership when there is no active touch stream', function () {
    const pane = touchScroller(true)
    try {
      pane.element.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 319,
          clientY: 200
        })
      )
      document.dispatchEvent(new window.Event('pointercancel'))
      pane.scroll(0)
      expect(pane.positions).deep.equals([])
    } finally {
      pane.dispose()
    }
  })
})

describe('native deliberate-top late coordinate persistence', function () {
  it('keeps the chosen top through stationary zero then an unowned positive coordinate and remount', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await act(async () => {
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({
        nativeEvent: { contentOffset: { y: 120 } }
      })
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({ nativeEvent: { contentOffset: { y: 0 } } })
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    expect(pending.offsets.at(-1), 'The genuine terminal chose zero').equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
    // An unowned offset event follows the completed native input.
    await act(async () => {
      const callbacks = renderedListCallbacks(
        pending.node
      ) as ListLayoutCallbacks & { onScroll: (event: NativeListEvent) => void }
      callbacks.onScroll({ nativeEvent: { contentOffset: { y: 52 } } })
      await wait()
    })
    await act(async () => {
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    expect(
      pending.offsets.at(-1),
      'Unowned positive coordinate cannot replace the deliberate top'
    ).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
    await unmount()
    const returning = await returningList(
      true,
      pending.offsets.at(-1),
      pending.anchors.at(-1)
    )
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 160)
    await returning.content(1800)
    await returning.scroll(returning.moves.at(-1)!)
    expect(returning.moves).deep.equals([0])
    expect(returning.node.scrollTop).equals(0)
  })
})

describe('native deliberate-top ownership', function () {
  it('ingests the unowned coordinate without treating its unchanged native terminal as new movement', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await act(async () => {
      const callbacks = renderedListCallbacks(
        pending.node
      ) as ListLayoutCallbacks & { onScroll: (event: NativeListEvent) => void }
      callbacks.onScroll({ nativeEvent: { contentOffset: { y: 52 } } })
      await wait()
    })
    await act(async () => {
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({ nativeEvent: { contentOffset: { y: 52 } } })
      await wait()
    })
    // If raw 52 had been discarded internally, this same-coordinate terminal
    // would appear to move from zero and incorrectly retire the top choice.
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })

  it('lets a genuine new positive native gesture replace the deliberate top', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await act(async () => {
      const callbacks = renderedListCallbacks(
        pending.node
      ) as ListLayoutCallbacks & { onScroll: (event: NativeListEvent) => void }
      callbacks.onScroll({ nativeEvent: { contentOffset: { y: 52 } } })
      await wait()
    })
    await act(async () => {
      nativeListStart(pending.node)
      pending.node.scrollTop = 120
      nativeListEnd(pending.node)({
        nativeEvent: { contentOffset: { y: 120 } }
      })
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    expect(pending.offsets.at(-1)).equals(120)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_0',
      relativeY: -16
    })
  })

  it('accepts positive momentum with the genuine preceding native release scope', async function () {
    const pending = await returningList(true, 120)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(120)
    await act(async () => {
      nativeListStart(pending.node)
      nativeListEnd(pending.node)({
        nativeEvent: { contentOffset: { y: 0 }, velocity: { y: 2 } }
      })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
    await act(async () => {
      nativeListStart(pending.node, true)
      pending.node.scrollTop = 80
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 80 } } })
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    expect(pending.offsets.at(-1)).equals(80)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_0',
      relativeY: 24
    })
  })
})

function nativeMomentumBeginAt(
  node: HTMLElement,
  event?: NativeListEvent,
  platform: 'android' | 'ios' = 'android'
): void {
  const props = renderedListCallbacks(node) as ListLayoutCallbacks & {
    onMomentumScrollBegin?: (event?: NativeListEvent) => void
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    ReactNative.Platform,
    'OS'
  )!
  try {
    Object.defineProperty(ReactNative.Platform, 'OS', {
      ...descriptor,
      value: platform
    })
    props.onMomentumScrollBegin?.(event)
  } finally {
    Object.defineProperty(ReactNative.Platform, 'OS', descriptor)
  }
}

describe('android non-drag momentum lifecycle', function () {
  it('persists an already-delivered hardware-wheel position through a zero-velocity momentum begin and changed-prefix return', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    // Installed Android ACTION_SCROLL dispatches the ordinary scroll before
    // momentum begin, with zero velocity and without a begin-drag callback.
    await pending.scroll(120)
    await act(async () => {
      nativeMomentumBeginAt(pending.node, {
        nativeEvent: { contentOffset: { y: 120 }, velocity: { y: 0 } }
      })
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 120 } } })
      renderedRowLayout('cnv_return_0')({
        nativeEvent: { layout: { height: 67 } }
      })
      await wait(40)
    })
    expect(
      pending.offsets.at(-1),
      'Native wheel movement replaces the deliberately saved top'
    ).equals(120)
    const saved = pending.anchors.at(-1)
    expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: -16 })
    await unmount()
    const returning = await returningList(true, pending.offsets.at(-1), saved)
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 160)
    await returning.content(1800)
    await returning.scroll(returning.moves.at(-1)!)
    expect(returning.moves).deep.equals([176])
    expect(returning.anchors.at(-1)).deep.equals(saved)
  })
})

describe('android non-drag momentum ownership guards', function () {
  it('does not invent Android input for a missing or nonfinite momentum event', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await pending.scroll(52)
    await act(async () => {
      nativeMomentumBeginAt(pending.node)
      nativeMomentumBeginAt(pending.node, {
        nativeEvent: { contentOffset: { y: NaN } }
      })
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 52 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })

  it('does not classify a programmatic restoration event as new Android input', async function () {
    const pending = await returningList(true, 240, {
      id: 'cnv_return_3',
      relativeY: 30
    })
    await pending.populate(8)
    await act(async () => {
      nativeMomentumBeginAt(pending.node, {
        nativeEvent: { contentOffset: { y: 120 }, velocity: { y: 0 } }
      })
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 120 } } })
      await wait()
    })
    expect(pending.offsets).deep.equals([])
    setListRowMeasurement('cnv_return_3', 270)
    await pending.content(1800)
    await pending.scroll(pending.moves.at(-1)!)
    expect(pending.moves).deep.equals([240])
    expect(pending.offsets.at(-1)).equals(240)
    expect(pending.anchors.at(-1)).deep.equals({
      id: 'cnv_return_3',
      relativeY: 30
    })
  })

  for (const staleScope of ['visibility', 'data'])
    it(`rejects an Android momentum begin retained from older ${staleScope} ownership`, async function () {
      const pending = await returningList(true, 0)
      await pending.populate(8)
      setListRowMeasurement('cnv_return_0', 104)
      await pending.content(1800)
      await pending.scroll(0)
      const begin = (
        renderedListCallbacks(pending.node) as ListLayoutCallbacks & {
          onMomentumScrollBegin: (event: NativeListEvent) => void
        }
      ).onMomentumScrollBegin
      if (staleScope === 'visibility') {
        await pending.hide()
        await pending.show()
      } else await pending.reorder()
      await pending.scroll(0)
      await act(async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          ReactNative.Platform,
          'OS'
        )!
        try {
          Object.defineProperty(ReactNative.Platform, 'OS', {
            ...descriptor,
            value: 'android'
          })
          begin({
            nativeEvent: { contentOffset: { y: 120 }, velocity: { y: 0 } }
          })
        } finally {
          Object.defineProperty(ReactNative.Platform, 'OS', descriptor)
        }
        nativeListEnd(
          pending.node,
          true
        )({ nativeEvent: { contentOffset: { y: 120 } } })
        await wait()
      })
      expect(pending.offsets.at(-1)).equals(0)
      expect(pending.anchors.at(-1)).equals(undefined)
    })

  it('keeps iOS momentum dependent on the preceding native release', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    await pending.scroll(120)
    await act(async () => {
      nativeMomentumBeginAt(
        pending.node,
        { nativeEvent: { contentOffset: { y: 120 }, velocity: { y: 0 } } },
        'ios'
      )
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 120 } } })
      await wait()
    })
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })

  it('retains the supplied zero relative boundary after stationary Android momentum and changed header geometry', async function () {
    const pending = await returningList(true, 0, {
      id: 'cnv_return_0',
      relativeY: 105
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 105)
    await pending.content(1800)
    await pending.scroll(0)
    await act(async () => {
      nativeMomentumBeginAt(pending.node, {
        nativeEvent: { contentOffset: { y: 0 }, velocity: { y: 0 } }
      })
      nativeListEnd(
        pending.node,
        true
      )({ nativeEvent: { contentOffset: { y: 0 } } })
      await wait()
    })
    const saved = pending.anchors.at(-1)
    expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: 105 })
    await unmount()
    const returning = await returningList(true, 0, saved)
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 169)
    await returning.content(1800)
    await returning.scroll(returning.moves.at(-1)!)
    expect(returning.moves).deep.equals([64])
  })
})

function measureListWindowFromDom(node: HTMLElement): void {
  const content = node.firstElementChild as HTMLElement
  const rect = (y: number, height: number): DOMRect =>
    new window.DOMRect(0, y, 320, height)
  node.getBoundingClientRect = () => rect(100, node.clientHeight)
  content.getBoundingClientRect = () =>
    rect(100 - node.scrollTop, node.scrollHeight)
  for (const row of document.querySelectorAll<HTMLElement>(
    '[data-testid^="chat-conversation-cnv_return_"]'
  )) {
    const wrapper = row.parentElement!
    wrapper.getBoundingClientRect = () =>
      rect(100 + wrapper.offsetTop - node.scrollTop, wrapper.offsetHeight)
  }
}

describe('measured native position before navigation', function () {
  it('keeps the physically displayed top when a stale raw coordinate says52', async function () {
    const pending = await returningList(true, 0)
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await pending.content(1800)
    await pending.scroll(0)
    measureListWindowFromDom(pending.node)
    await act(async () => {
      const callbacks = renderedListCallbacks(
        pending.node
      ) as ListLayoutCallbacks & { onScroll: (event: NativeListEvent) => void }
      callbacks.onScroll({ nativeEvent: { contentOffset: { y: 52 } } })
      await pending.capture()
    })
    expect(pending.node.scrollTop).equals(0)
    expect(pending.offsets.at(-1)).equals(0)
    expect(pending.anchors.at(-1)).equals(undefined)
  })
  for (const [input, offset] of [
    ['keyboard paging', 120],
    ['accessibility scrolling', 180]
  ] as const)
    it(`captures actual ${input} from ordinary scroll only before a changed-prefix return`, async function () {
      const pending = await returningList(true, 0)
      await pending.populate(8)
      setListRowMeasurement('cnv_return_0', 104, 120)
      await pending.content(1800)
      await pending.scroll(0)
      measureListWindowFromDom(pending.node)
      await pending.scroll(offset)
      await act(async () => {
        await pending.capture()
      })
      expect(
        pending.offsets.at(-1),
        'Measured displayed position overrides the remembered top'
      ).equals(offset)
      const saved = pending.anchors.at(-1)
      expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: 104 - offset })
      await unmount()
      const returning = await returningList(true, pending.offsets.at(-1), saved)
      await returning.populate(8)
      setListRowMeasurement('cnv_return_0', 160, 120)
      await returning.content(1800)
      await returning.scroll(returning.moves.at(-1)!)
      expect(returning.moves).deep.equals([offset + 56])
    })
})

describe('managed list navigation measurement ordering', function () {
  it('measures before push/pop/tab/route changes and preserves rapid order and complete draft context', async function () {
    const nav = new ChatListNavigationCapture()
    const measured = deferred<undefined>()
    const state = newChatWorkspaceState()
    state.selectedId = 'cnv_return_0'
    const picked: PickedFile = {
      fileName: 'practice.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3])
    }
    const draft = {
      ...emptyChatDraft(),
      text: 'Unsent caption',
      replyTo: message(),
      picked: [picked]
    }
    state.drafts.set(state.selectedId, draft)
    const ordered: string[] = []
    let reads = 0
    nav.attach(async () => {
      reads++
      await measured.promise
      state.listOffset = 120
    })
    const pending = ['push', 'pop', 'tab', 'route'].map(async kind => {
      await nav.navigate(() => {
        expect(state.listOffset).equals(120)
        ordered.push(kind)
      })
    })
    expect(ordered).deep.equals([])
    measured.resolve(undefined)
    await Promise.all(pending)
    expect(ordered).deep.equals(['push', 'pop', 'tab', 'route'])
    expect(reads).equals(1)
    expect(state.selectedId).equals('cnv_return_0')
    expect(state.drafts.get(state.selectedId)).equals(draft)
    expect(draft.picked[0]).equals(picked)
    expect(draft.replyTo).equals(state.drafts.get(state.selectedId)?.replyTo)
    expect(draft.text).equals('Unsent caption')
  })

  it('continues disposed-owner navigation in order without publishing its stale measurement', async function () {
    const nav = new ChatListNavigationCapture()
    const old = deferred<undefined>()
    const stop = nav.attach(async () => {
      await old.promise
    })
    let stale = false
    const previous = nav.navigate(() => {
      stale = true
    })
    stop()
    let current = false
    nav.attach(async () => {})
    const next = nav.navigate(() => {
      current = true
    })
    old.resolve(undefined)
    await Promise.all([previous, next])
    expect(stale).equals(true)
    expect(current).equals(true)
    const failure = new Error('Navigation action failed')
    let actual: unknown
    try {
      await nav.navigate(() => {
        throw failure
      })
    } catch (error) {
      actual = error
    }
    expect(actual).equals(failure)
  })

  it('continues navigation with the previous position when the public measurement callback times out', async function () {
    const list = await returningList(true, 0)
    await list.populate(8)
    setListRowMeasurement('cnv_return_0', 104)
    await list.content(1800)
    await list.scroll(0)
    measureListWindowFromDom(list.node)
    await list.scroll(120)
    const node = list.node as HTMLElement & {
      measureInWindow: (callback: () => void) => void
    }
    const original = node.measureInWindow
    node.measureInWindow = () => {}
    const nav = new ChatListNavigationCapture()
    nav.attach(list.capture)
    let left = false
    try {
      await act(async () => {
        await nav.navigate(() => {
          left = true
        })
      })
    } finally {
      node.measureInWindow = original
    }
    expect(left).equals(true)
    expect(list.offsets.at(-1)).equals(0)
    expect(list.anchors.at(-1)).equals(undefined)
  })
})

function holdViewportMeasurement(node: HTMLElement): {
  entered: Promise<void>
  release: () => void
  restore: () => void
} {
  type Read = (
    callback: (x: number, y: number, width: number, height: number) => void
  ) => void
  const measured = node as HTMLElement & { measureInWindow: Read }
  const descriptor = Object.getOwnPropertyDescriptor(
    measured,
    'measureInWindow'
  )!
  const entered = deferred<undefined>()
  let callback: Parameters<Read>[0] | undefined
  Object.defineProperty(measured, 'measureInWindow', {
    configurable: true,
    get: () => (next: Parameters<Read>[0]) => {
      callback = next
      entered.resolve(undefined)
    },
    set: () => {}
  })
  return {
    entered: entered.promise,
    release: () => {
      const b = node.getBoundingClientRect()
      callback?.(b.x, b.y, b.width, b.height)
    },
    restore: () =>
      Object.defineProperty(measured, 'measureInWindow', descriptor)
  }
}

describe('managed list measurement freshness', function () {
  for (const changed of [
    'layout',
    'data',
    'visibility',
    'gesture generation',
    'unmount and replacement'
  ])
    it(`rejects a native-window callback after ${changed} while retaining the previous saved position`, async function () {
      const pending = await returningList(true, 0)
      await pending.populate(8)
      setListRowMeasurement('cnv_return_0', 104)
      await pending.content(1800)
      await pending.scroll(0)
      measureListWindowFromDom(pending.node)
      await pending.scroll(120)
      const held = holdViewportMeasurement(pending.node)
      try {
        const capture = pending.capture()
        await held.entered
        // Commit the changed rendered owner before completing this callback.
        // An enclosing async act would defer that change until capture settles.
        if (changed === 'layout') {
          await pending.content(1856)
          expect(pending.node.scrollHeight).equals(1856)
        } else if (changed === 'data') {
          await pending.reorder()
          expect(
            document
              .querySelector('[data-testid^="chat-conversation-cnv_return_"]')
              ?.getAttribute('data-testid')
          ).equals('chat-conversation-cnv_return_3')
        } else if (changed === 'visibility') {
          await pending.hide()
          expect(
            pending.captureAvailable(),
            'The committed invisible owner disposed its public capture registration'
          ).equals(false)
        } else if (changed === 'gesture generation') {
          await act(async () => {
            nativeListStart(pending.node)
          })
        } else {
          await unmount()
          await render(<ReactNative.View testID="replacement-native-owner" />)
          expect(pending.node.isConnected).equals(false)
          expect(
            document.querySelector('[data-testid="replacement-native-owner"]')
          ).not.equals(null)
        }
        await act(async () => {
          held.release()
          await capture
        })
      } finally {
        held.restore()
      }
      expect(pending.offsets.at(-1)).equals(0)
      expect(pending.anchors.at(-1)).equals(undefined)
    })

  it('preserves a meaningful supplied zero-relative anchor through capture and changed-prefix return', async function () {
    const pending = await returningList(true, 0, {
      id: 'cnv_return_0',
      relativeY: 105
    })
    await pending.populate(8)
    setListRowMeasurement('cnv_return_0', 105)
    await pending.content(1800)
    await pending.scroll(0)
    measureListWindowFromDom(pending.node)
    await act(async () => {
      await pending.capture()
    })
    const saved = pending.anchors.at(-1)
    expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: 105 })
    await unmount()
    const returning = await returningList(true, 0, saved)
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 169)
    await returning.content(1800)
    await returning.scroll(returning.moves.at(-1)!)
    expect(returning.moves).deep.equals([64])
  })
})

describe('list navigation engine context ownership', function () {
  it('cancels only a destroyed engine context and keeps subsequent active navigation synchronous without a reader', async function () {
    const nav = new ChatListNavigationCapture()
    const pending = deferred<undefined>()
    nav.attach(async () => {
      await pending.promise
    })
    let old = false
    const previous = nav.navigate(() => {
      old = true
    })
    nav.setContextActive(false)
    pending.resolve(undefined)
    await previous
    expect(old).equals(false)
    nav.setContextActive(true)
    let current = false
    const next = nav.navigate(() => {
      current = true
    })
    expect(current).equals(true)
    await next
  })
})

async function responsiveWorkspaceList(
  listNavigation?: ChatListNavigationCapture
): Promise<{
  node: HTMLElement
  host: HTMLElement
  state: ChatWorkspaceState
}> {
  const engine = new ReviewEngine()
  engine.views = new Map(
    Array.from({ length: 8 }, (_, index) => {
      const conversation = chat({
        id: `cnv_return_${index}`,
        title: `Solstice ${index} Members`
      })
      return [conversation.id, view({ conversation, messages: [original()] })]
    })
  )
  const state = newChatWorkspaceState()
  await workspace(engine, state, 'cnv_return_0', 1, listNavigation)
  const host = document.querySelector<HTMLElement>(
    '[data-testid="chat-workspace"]'
  )!
  await layout(host, 1200, 500)
  const node = document.querySelector<HTMLElement>(
    '[data-testid="chat-conversation-list"]'
  )!
  expect(node, 'Actual workspace list scroll view').not.equals(null)
  const content = node.firstElementChild as HTMLElement
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1800 },
    clientHeight: { configurable: true, value: 400 }
  })
  node.scroll = options => {
    node.scrollTop = (options as ScrollToOptions).top ?? 0
  }
  await layout(node, 320, 400)
  setListRowMeasurement('cnv_return_0', 104, 120)
  await layout(content, 320, 1800)
  measureListWindowFromDom(node)
  await act(async () => {
    node.scrollTop = 0
    node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    await wait(150)
    node.scrollTop = 120
    node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    await wait(150)
  })
  return { node, host, state }
}

describe('responsive list position before a pane hide', function () {
  it('captures keyboard-selected list geometry on the actual Workspace layout boundary before Members and return', async function () {
    const { node, host, state } = await responsiveWorkspaceList()
    expect(node.scrollTop).equals(120)
    expect(
      state.listOffset,
      'Raw unowned input has not replaced the remembered top yet'
    ).equals(0)
    await layout(host, 640, 500)
    await act(async () => {
      await wait(40)
    })
    expect(
      document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
        .style.display
    ).equals('none')
    expect(
      state.listOffset,
      'Still-visible measurement must precede the hide'
    ).equals(120)
    const saved = state.listAnchor
    expect(saved).deep.equals({ id: 'cnv_return_0', relativeY: -16 })
    await unmount()
    // Members removes the workspace; Back restores its persisted list reading.
    const returning = await returningList(true, state.listOffset, saved)
    await returning.populate(8)
    setListRowMeasurement('cnv_return_0', 104, 120)
    await returning.content(1800)
    await returning.scroll(returning.moves.at(-1)!)
    expect(returning.node.scrollTop).equals(120)
  })

  it('keeps the newest layout when a pending hide measurement finishes after widening', async function () {
    const { node, host } = await responsiveWorkspaceList()
    const held = holdViewportMeasurement(node)
    try {
      await layout(host, 640, 500)
      await held.entered
      await layout(host, 1200, 500)
      await act(async () => {
        held.release()
        await wait(40)
      })
      expect(
        document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
          .style.display
      ).equals('flex')
    } finally {
      held.restore()
    }
  })

  it('rejects a disposed resize capture without publishing its old position', async function () {
    const { node, host, state } = await responsiveWorkspaceList()
    const held = holdViewportMeasurement(node)
    try {
      await layout(host, 640, 500)
      await held.entered
      await unmount()
      await act(async () => {
        held.release()
        await wait(40)
      })
      expect(document.querySelector('[data-testid="chat-workspace"]')).equals(
        null
      )
      expect(state.listOffset).equals(0)
      expect(state.listAnchor).equals(undefined)
    } finally {
      held.restore()
    }
  })

  it('continues the resize with the previous position after the bounded measurement failure', async function () {
    const { node, host, state } = await responsiveWorkspaceList()
    const held = holdViewportMeasurement(node)
    try {
      await layout(host, 640, 500)
      await held.entered
      await act(async () => {
        await wait(140)
      })
      expect(
        document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
          .style.display
      ).equals('none')
      expect(state.listOffset).equals(0)
      expect(state.listAnchor).equals(undefined)
    } finally {
      held.restore()
    }
  })
})

describe('coordinated responsive list capture', function () {
  it('remeasures current viewport geometry before hiding the keyboard-selected list', async function () {
    const { node, host, state } = await responsiveWorkspaceList()
    const held = holdViewportMeasurement(node)
    try {
      await layout(host, 640, 500)
      await held.entered
      Object.defineProperty(node, 'clientHeight', {
        configurable: true,
        value: 300
      })
      await layout(node, 320, 300)
      held.restore()
      await act(async () => {
        held.release()
        await wait(60)
      })
      expect(
        document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
          .style.display
      ).equals('none')
      expect(state.listOffset).equals(120)
      expect(state.listAnchor).deep.equals({
        id: 'cnv_return_0',
        relativeY: -16
      })
    } finally {
      held.restore()
    }
  })

  it('shares resize and managed-navigation measurements without either retiring the other', async function () {
    const nav = new ChatListNavigationCapture()
    const { node, host, state } = await responsiveWorkspaceList(nav)
    const held = holdViewportCaptureCallbacks(node)
    let navigated = false
    try {
      await layout(host, 640, 500)
      await held.entered
      const navigation = nav.navigate(() => {
        navigated = true
      })
      held.restore()
      await act(async () => {
        held.release(0)
        await wait(20)
      })
      await act(async () => {
        held.release(1)
        await navigation
        await wait(40)
      })
      expect(navigated).equals(true)
      expect(state.listOffset).equals(120)
      expect(
        document.querySelector<HTMLElement>('[data-testid="chat-list-pane"]')!
          .style.display
      ).equals('none')
      expect(state.listAnchor).deep.equals({
        id: 'cnv_return_0',
        relativeY: -16
      })
    } finally {
      held.restore()
    }
  })
})

function holdViewportCaptureCallbacks(node: HTMLElement): {
  release: (index: number) => void
  restore: () => void
  entered: Promise<void>
} {
  type Read = (
    callback: (x: number, y: number, width: number, height: number) => void
  ) => void
  const measured = node as HTMLElement & { measureInWindow: Read }
  const descriptor = Object.getOwnPropertyDescriptor(
    measured,
    'measureInWindow'
  )!
  const entered = deferred<undefined>()
  const callbacks: Array<Parameters<Read>[0]> = []
  Object.defineProperty(measured, 'measureInWindow', {
    configurable: true,
    get: () => (next: Parameters<Read>[0]) => {
      callbacks.push(next)
      entered.resolve(undefined)
    },
    set: () => {}
  })
  return {
    entered: entered.promise,
    restore: () =>
      Object.defineProperty(measured, 'measureInWindow', descriptor),
    release: index => {
      const b = node.getBoundingClientRect()
      callbacks[index]?.(b.x, b.y, b.width, b.height)
    }
  }
}

async function stationaryHoldPane(): Promise<{
  reading: ReturnType<typeof terminalReadingPane>
  target: HTMLElement
  pulses: number[]
  engine: ReviewEngine
  scroll: (x: number, y: number, height?: number) => void
  drag: () => void
}> {
  const engine = new ReviewEngine()
  engine.update('cnv_aurora', { messages: [original()] })
  const state = newChatWorkspaceState()
  state.drafts.set('cnv_aurora', { ...terminalDraft(), scrollOffset: 700 })
  const pulses: number[] = []
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (value: number) => {
      pulses.push(value)
      return true
    }
  })
  restoreViewport = measureChatTestViewport({ width: 390, height: 844 })
  await render(
    <HeaderSlotProvider headerHeight={48} onHandoff={() => {}}>
      <ChatOverlayHost>
        <ChatWorkspace
          engine={engine}
          userId={1}
          state={state}
          conversationId="cnv_aurora"
          onOpen={() => {}}
          onMembers={() => {}}
          onNewMessage={() => {}}
          onTitle={() => {}}
        />
      </ChatOverlayHost>
    </HeaderSlotProvider>,
    false
  )
  const reading = terminalReadingPane()
  await reading.measure()
  const target = document.querySelector<HTMLElement>(
    '[data-testid="chat-bubble-msg_original"]'
  )!
  Object.defineProperty(target, 'measureInWindow', {
    configurable: true,
    value: (
      accept: (x: number, y: number, width: number, height: number) => void
    ) => {
      accept(48, 160, 260, 100)
    }
  })
  const callbacks = renderedReadingCallbacks(
    reading.node
  ) as ScrollCallbacks & {
    onScrollBeginDrag: () => void
  }
  await act(async () => {
    await wait(150)
    callbacks.onScroll!({
      nativeEvent: {
        contentOffset: { x: 0, y: 700 },
        contentSize: { width: 640, height: 2200 },
        layoutMeasurement: { width: 640, height: 400 }
      }
    })
  })
  return {
    reading,
    target,
    engine,
    pulses,
    scroll: (x, y, height = 2200) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        ReactNative.Platform,
        'OS'
      )!
      try {
        Object.defineProperty(ReactNative.Platform, 'OS', {
          ...descriptor,
          value: 'ios'
        })
        callbacks.onScroll!({
          nativeEvent: {
            contentOffset: { x, y },
            contentSize: { width: 640, height },
            layoutMeasurement: { width: 640, height: 400 }
          }
        })
      } finally {
        Object.defineProperty(ReactNative.Platform, 'OS', descriptor)
      }
    },
    drag: () => {
      callbacks.onScrollBeginDrag()
    }
  }
}

const holdMouse = (
  target: HTMLElement,
  type: 'mousedown' | 'mouseup'
): void => {
  target.dispatchEvent(
    new window.MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === 'mousedown' ? 1 : 0,
      clientX: 100,
      clientY: 180
    })
  )
}

describe('stationary message hold after scrolling', function () {
  it('keeps a stationary hold when a throttled pre-hold offset is delivered later', async function () {
    const { reading, pulses } = await stationaryHoldPane()
    const text = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-body-msg_original"]'
    )!.firstElementChild as HTMLElement
    expect(text.textContent).equals('Practice notes')
    await act(async () => {
      reading.node.scrollTop = 700
      reading.node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      const firstAt = Date.now()
      await wait(20)
      reading.node.scrollTop = 701
      reading.node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      expect(
        Date.now() - firstAt,
        'Both physical offsets are within the real 100ms throttle window'
      ).lessThan(100)
      await wait(20)
      holdMouse(text, 'mousedown')
      await wait(600)
      holdMouse(text, 'mouseup')
      text.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          button: 0,
          clientX: 100,
          clientY: 180
        })
      )
      await wait()
    })
    expect(
      reading.node.scrollTop,
      'Physical 701 stays stationary during the hold'
    ).equals(701)
    expect(
      pulses,
      'One recognition after the final pre-hold movement'
    ).deep.equals([8])
    expect(
      document.querySelector('[data-testid="chat-message-spotlight"]'),
      'Spotlight remains after 600ms hold, release and click'
    ).not.equals(null)
    await settleChatMessageActions('open')
    expect(button('Reply')).not.equals(undefined)
  })

  it('recognizes one hold when the RNW scroll-end callback repeats an unchanged offset', async function () {
    const { reading, target, pulses } = await stationaryHoldPane()
    await act(async () => {
      reading.node.scrollTop = 700
      reading.node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      // Start after the real offset changed, before RNW's 100ms end callback.
      await wait(40)
      holdMouse(target, 'mousedown')
      await wait(560)
    })
    try {
      expect(reading.node.scrollTop, 'No movement during the hold').equals(700)
      expect(pulses, 'One 500ms recognition').deep.equals([8])
      expect(
        document.querySelector('[data-testid="chat-message-spotlight"]'),
        'Stationary hold survives a duplicate scroll-end notification'
      ).not.equals(null)
      await settleChatMessageActions('open')
      expect(button('Reply')).not.equals(undefined)
    } finally {
      await act(async () => {
        holdMouse(target, 'mouseup')
      })
    }
  })

  for (const axis of ['x', 'y'] as const)
    for (const phase of ['armed', 'measuring'] as const)
      it(`cancels a ${phase} web hold on raw physical ${axis} movement`, async function () {
        const { reading, target, pulses } = await stationaryHoldPane()
        await act(async () => {
          reading.node.scrollTop = 700
          reading.node.dispatchEvent(
            new window.Event('scroll', { bubbles: true })
          )
          await wait(150)
        })
        let accept:
          | ((x: number, y: number, width: number, height: number) => void)
          | undefined
        Object.defineProperty(target, 'measureInWindow', {
          configurable: true,
          value: (callback: typeof accept) => {
            accept = callback
          }
        })
        const callbacks = renderedPressCallbacks(target)
        await nativePress(callbacks, 'onPressIn', contact(1000))
        if (phase === 'measuring') {
          await nativePress(callbacks, 'onLongPress', contact(1500))
          expect(accept).not.equals(undefined)
        }
        await act(async () => {
          if (axis === 'x') reading.node.scrollLeft = 1
          else reading.node.scrollTop = 701
          reading.node.dispatchEvent(
            new window.Event('scroll', { bubbles: true })
          )
        })
        if (phase === 'armed')
          await nativePress(callbacks, 'onLongPress', contact(1500))
        else
          await act(async () => {
            accept!(48, 160, 260, 100)
          })
        await nativePress(callbacks, 'onPress', contact(1600))
        expect(pulses).deep.equals(phase === 'armed' ? [] : [8])
        expect(
          document.querySelector('[data-testid="chat-message-spotlight"]')
        ).equals(null)
      })

  for (const [name, x, y] of [
    ['horizontal movement', 1, 700],
    ['vertical movement', 0, 701],
    ['fractional movement', 0, 700.25],
    ['invalid horizontal coordinate', Number.NaN, 700],
    ['invalid vertical coordinate', 0, Number.NaN]
  ] as const)
    it(`cancels an armed hold on a native packet with ${name}`, async function () {
      const { target, scroll, pulses } = await stationaryHoldPane()
      const callbacks = renderedPressCallbacks(target)
      await nativePress(callbacks, 'onPressIn', contact(1000))
      await act(async () => {
        scroll(x, y)
      })
      await nativePress(callbacks, 'onLongPress', contact(1500))
      expect(pulses).deep.equals([])
      expect(
        document.querySelector('[data-testid="chat-message-spotlight"]')
      ).equals(null)
    })

  it('cancels an armed hold on explicit drag before the offset changes', async function () {
    const { target, drag, pulses } = await stationaryHoldPane()
    const callbacks = renderedPressCallbacks(target)
    await nativePress(callbacks, 'onPressIn', contact(1000))
    await act(async () => {
      drag()
    })
    await nativePress(callbacks, 'onLongPress', contact(1500))
    expect(pulses).deep.equals([])
    expect(
      document.querySelector('[data-testid="chat-message-spotlight"]')
    ).equals(null)
  })

  it('keeps early release from becoming a hold after the repeated scroll-end packet', async function () {
    const { reading, target, pulses } = await stationaryHoldPane()
    await act(async () => {
      reading.node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(40)
      holdMouse(target, 'mousedown')
      await wait(80)
      holdMouse(target, 'mouseup')
      await wait(520)
    })
    expect(pulses).deep.equals([])
    expect(
      document.querySelector('[data-testid="chat-message-spotlight"]')
    ).equals(null)
  })

  for (const change of [
    'duplicate',
    'x',
    'y',
    'drag',
    'invalid',
    'permission',
    'unmount'
  ] as const)
    it(`retains pending measurement ownership through ${change}`, async function () {
      const { target, scroll, drag, pulses, engine } =
        await stationaryHoldPane()
      let accept:
        | ((x: number, y: number, width: number, height: number) => void)
        | undefined
      Object.defineProperty(target, 'measureInWindow', {
        configurable: true,
        value: (callback: typeof accept) => {
          accept = callback
        }
      })
      const callbacks = renderedPressCallbacks(target)
      await nativePress(callbacks, 'onPressIn', contact(1000))
      await nativePress(callbacks, 'onLongPress', contact(1500))
      expect(pulses).deep.equals([8])
      expect(accept).not.equals(undefined)
      expect(
        document.querySelector('[data-testid="chat-message-spotlight"]')
      ).equals(null)
      await act(async () => {
        if (change === 'duplicate') scroll(0, 700, 2300)
        else if (change === 'x') scroll(1, 700)
        else if (change === 'y') scroll(0, 701)
        else if (change === 'drag') drag()
        else if (change === 'invalid') scroll(0, Number.NaN)
        else if (change === 'permission') {
          engine.update('cnv_aurora', { composer: 'locked' })
          await wait()
        } else await unmount()
      })
      await act(async () => {
        accept!(48, 160, 260, 100)
      })
      expect(
        document.querySelector('[data-testid="chat-message-spotlight"]') != null
      ).equals(change === 'duplicate')
      expect(pulses, 'No duplicated recognition').deep.equals([8])
      if (change === 'duplicate') {
        await settleChatMessageActions('open')
        expect(button('Reply')).not.equals(undefined)
      }
    })
})
