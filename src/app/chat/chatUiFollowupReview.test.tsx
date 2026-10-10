import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import type { PickedFile } from './chatFileTypes'
import { ChatListScreen } from './ChatListScreen'
import { ChatOverlayHost } from './ChatOverlayHost'
import { chat, member, message, view } from './chatViews.test.helpers'
import { ChatWorkspace } from './ChatWorkspace'
import {
  type ChatDraft,
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
const originalPointer = Object.getOwnPropertyDescriptor(
  globalThis,
  'matchMedia'
)
const originalVibration = Object.getOwnPropertyDescriptor(navigator, 'vibrate')

afterEach(async function () {
  await unmount()
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

  async loadPreview(): Promise<void> {}
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
  userId = 1
): Promise<void> {
  await render(
    <ChatOverlayHost>
      <ChatWorkspace
        engine={engine}
        userId={userId}
        state={state}
        conversationId={conversationId ?? undefined}
        onOpen={() => {}}
        onMembers={() => {}}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
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
      await workspace(next, state, 'cnv_aurora', userId)
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
        onFollowTeam={() => {}}
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
    const lastRow = document.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-cnv_return_1"]'
    )!.parentElement!
    // Native layout is delivered only if this rendered row observes it.
    // An unobserved row still participates in the final content geometry.
    if (
      typeof (lastRow as HTMLElement & { __reactLayoutHandler?: unknown })
        .__reactLayoutHandler === 'function'
    )
      await layout(lastRow, 320, 80)
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
  initialOffset = 240
): Promise<{
  node: HTMLElement
  moves: number[]
  offsets: number[]
  populate: (count: number) => Promise<void>
  refreshMetadata: () => Promise<void>
  setDomContent: (height: number) => void
  content: (height: number) => Promise<void>
  scroll: (top: number) => Promise<void>
  hide: () => Promise<void>
  show: () => Promise<void>
  replace: (count: number) => Promise<void>
}> {
  const engine = new ReviewEngine()
  const refreshed = deferred<ConversationListItem[]>()
  engine.refreshWork = refreshed.promise
  const offsets: number[] = []
  let rows: ConversationListItem[] = []
  await render(
    <ChatListScreen
      engine={engine}
      embedded
      initialOffset={initialOffset}
      onOffset={offset => offsets.push(offset)}
      onOpen={() => {}}
      onNewMessage={() => {}}
      onFollowTeam={() => {}}
    />
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
        <ChatListScreen
          engine={engine}
          embedded
          narrow
          selectedVisible
          initialOffset={initialOffset}
          onOffset={offset => offsets.push(offset)}
          onOpen={() => {}}
          onNewMessage={() => {}}
          onFollowTeam={() => {}}
        />
      )
    },
    show: async () => {
      await render(
        <ChatListScreen
          engine={engine}
          embedded
          narrow
          selectedVisible={false}
          initialOffset={initialOffset}
          onOffset={offset => offsets.push(offset)}
          onOpen={() => {}}
          onNewMessage={() => {}}
          onFollowTeam={() => {}}
        />
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

describe('chat review final native scroll positions', function () {
  it('saves the final drag and momentum zero offsets instead of the last throttled position and reopens at the first row', async function () {
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
        new window.WheelEvent('wheel', { bubbles: true, deltaY: -1 })
      )
      await wait()
    })
    const callbacks = renderedReadingCallbacks(reading.node)
    for (const phase of ['onScrollEndDrag', 'onMomentumScrollEnd'] as const) {
      await reading.deliver(callbacks, 'onScroll', 22.095)
      expect(state.drafts.get('cnv_aurora')!.scrollOffset).equals(22.095)
      await reading.deliver(callbacks, phase, 0)
      const saved = state.drafts.get('cnv_aurora')!
      expect(saved.scrollOffset, `${phase} carries the real final edge`).equals(
        0
      )
      expect(saved.hasScrollPosition).equals(true)
      expect(saved.followNewest).equals(false)
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
              onFollowTeam={() => {}}
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
          onFollowTeam={() => {}}
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
    return?: Fiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, Fiber>)[key]
  let appProps: ListLayoutCallbacks | undefined
  while (fiber != null) {
    if (
      fiber.memoizedProps?.testID === 'chat-conversation-list' &&
      Array.isArray(fiber.memoizedProps.data) &&
      typeof fiber.memoizedProps.onContentSizeChange === 'function'
    )
      appProps = fiber.memoizedProps
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
          renderedRowLayout('cnv_return_1')({
            nativeEvent: { layout: { height: 80 } }
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
  const node = document.querySelector<HTMLElement>(
    `[data-testid="chat-conversation-${id}"]`
  )!
  interface Fiber {
    memoizedProps?: {
      chat?: { id: string }
      onLayout?: ListLayoutCallbacks['onLayout']
    }
    return?: Fiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, Fiber | undefined>)[key]
  while (fiber != null) {
    if (
      fiber.memoizedProps?.chat?.id === id &&
      fiber.memoizedProps.onLayout != null
    )
      return fiber.memoizedProps.onLayout
    fiber = fiber.return
  }
  throw Error('Rendered app row layout callback unavailable')
}
