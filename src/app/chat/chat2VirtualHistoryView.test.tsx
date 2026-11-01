import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { userIdOfGumbo } from '../../common/userId'
import { HeaderSlotProvider } from '../components/headerSlot'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatOverlayHost } from './ChatOverlayHost'
import {
  measureChatTestViewport,
  message,
  view
} from './chatViews.test.helpers'
import { ChatDraftOwner, newChatWorkspaceState } from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { MessageView } from './engine/apply'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import type { ChatScreenEngine } from './screenEngine'

/**
 * The virtualized history in a browser layout: every message row is the
 * list's estimated 64px plus an 8px gap, the content starts below the
 * measured header clearance, and the viewport is 844px tall.
 */
const ROW = 64
const STEP = ROW + 8
const TOP = 64
const VIEWPORT = 844

let root: Root | undefined
let host: HTMLElement | undefined
const stops: Array<() => void> = []
const wait = async (ms = 30): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
afterEach(async function () {
  if (root != null)
    await act(async () => {
      root!.unmount()
    })
  root = undefined
  host?.remove()
  host = undefined
  for (const stop of stops.splice(0).reverse()) stop()
})

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 360,
    width: 360,
    height,
    toJSON: () => ({})
  }
}

/**
 * Lay out the history as a browser would: each row at its place in the
 * current message order, the content and the viewport around it. Rows the
 * window has not mounted have no element at all.
 */
function browserLayout(order: () => string[]): {
  scrollTop: () => number
  rowTop: (id: string) => number
  header: { height: number }
} {
  const header = { height: 0 }
  const history = (): HTMLElement | null =>
    document.querySelector('[data-testid="chat-message-history"]')
  const scrollTop = (): number => history()?.scrollTop ?? 0
  // The content's top padding clears the measured header and pin band.
  const top = (): number => {
    const padding = Number.parseFloat(
      (history()?.firstElementChild as HTMLElement | null)?.style.paddingTop ??
        ''
    )
    return Number.isFinite(padding) ? padding : TOP
  }
  const rowTop = (id: string): number =>
    top() + header.height + order().indexOf(id) * STEP
  const place = (node: HTMLElement): DOMRect | undefined => {
    // The list's container around a row carries the gap below it.
    const child = (node.firstElementChild as HTMLElement | null)?.dataset
      ?.testid
    const contained = /^chat-message-row-(.+)$/.exec(child ?? '')
    if (contained != null && order().includes(contained[1]))
      return rect(rowTop(contained[1]) - scrollTop(), STEP)
    const id = node.dataset?.testid
    if (id == null) return undefined
    if (id === 'chat-viewport' || id === 'chat-message-history')
      return rect(0, VIEWPORT)
    const row = /^chat-(?:message-row|message-body|bubble)-(.+)$/.exec(id)
    if (row != null && order().includes(row[1]))
      return rect(rowTop(row[1]) - scrollTop(), ROW)
    return undefined
  }
  const content = (): number =>
    top() + header.height + order().length * STEP + 200
  const bounds = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect'
  )
  const original = Reflect.get(HTMLElement.prototype, 'getBoundingClientRect')
  HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement
  ): DOMRect {
    if (this === history()?.firstElementChild)
      return rect(-scrollTop(), content())
    return place(this) ?? original.call(this)
  }
  stops.push(() => {
    if (bounds == null)
      Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    else
      Object.defineProperty(
        HTMLElement.prototype,
        'getBoundingClientRect',
        bounds
      )
  })
  // React Native Web measures a row within the content from its offsets.
  const measured = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'measureLayout'
  )
  Object.defineProperty(HTMLElement.prototype, 'measureLayout', {
    configurable: true,
    set(this: HTMLElement & { rnwMeasureLayout?: unknown }, value: unknown) {
      this.rnwMeasureLayout = value
    },
    get(this: HTMLElement & { rnwMeasureLayout?: unknown }) {
      const id = /^chat-message-row-(.+)$/.exec(this.dataset?.testid ?? '')
      if (id == null || !order().includes(id[1])) return this.rnwMeasureLayout
      return (
        _relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => {
        success(0, rowTop(id[1]), 360, ROW)
      }
    }
  })
  stops.push(() => {
    if (measured == null)
      Reflect.deleteProperty(HTMLElement.prototype, 'measureLayout')
    else Object.defineProperty(HTMLElement.prototype, 'measureLayout', measured)
  })
  return { scrollTop, rowTop, header }
}

function fixture(initial: ConversationView): {
  engine: ChatScreenEngine
  readonly shown: ConversationView
  readonly reactions: string[]
  setLoad: (work: () => Promise<ConversationView>) => void
  update: (next: ConversationView) => void
} {
  let shown = initial
  const reactions: string[] = []
  let load = async (): Promise<ConversationView> => shown
  const listeners = new Set<ChatEngineListener>()
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
    loadEarlier: async () => {
      shown = await load()
      for (const listener of listeners)
        listener({ type: 'conversation', conversationId: 'cnv_1' })
      return shown
    },
    sendText: async () => undefined,
    attach: async () => undefined,
    react: async (_conversation, messageId, emoji, remove) => {
      reactions.push(`${messageId} ${emoji} ${String(remove)}`)
    },
    edit: async () => {},
    deleteMessage: async () => {},
    moderatorDelete: async () => {},
    report: async () => ({ id: 'crp_test', verified: true }),
    markRead: async () => {},
    typing: () => true,
    openAttachment: async () => new Uint8Array([1]),
    approvals: () => [],
    approve: async () => {},
    fillGrants: async () => 0,
    safetyNumber: async () => undefined
  }
  return {
    engine,
    get shown() {
      return shown
    },
    reactions,
    setLoad: work => {
      load = work
    },
    update: next => {
      shown = next
      for (const listener of listeners)
        listener({ type: 'conversation', conversationId: 'cnv_1' })
    }
  }
}

const files = {
  PICK_SOURCES: [],
  pickFiles: async () => [],
  bytesUri: async () => 'data:image/jpeg;base64,AA==',
  releaseUri: async () => {},
  saveFile: async () => {}
}

function history(count: number, first = 100): MessageView[] {
  return Array.from({ length: count }, (_, index) =>
    message({
      id: `msg_${first + index}`,
      seq: first + index,
      body: `Practice note ${first + index}`
    })
  )
}

async function render(
  engine: ChatScreenEngine,
  owner: ChatDraftOwner,
  conversationId: string | null = 'cnv_1'
): Promise<HTMLElement> {
  if (root == null) {
    stops.push(measureChatTestViewport({ width: 390, height: VIEWPORT }))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <HeaderSlotProvider headerHeight={48} onHandoff={() => {}}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <ChatOverlayHost>
              {/* No conversation: another route, such as its Info page. */}
              {conversationId != null && (
                <ConversationScreen
                  key={conversationId}
                  engine={engine}
                  userId={userIdOfGumbo(1)}
                  conversationId={conversationId}
                  onMembers={() => {}}
                  draftOwner={owner}
                  onDraftChange={next => {
                    owner.write(conversationId, next)
                  }}
                  draft={owner.draft(conversationId)}
                  files={files}
                />
              )}
            </ChatOverlayHost>
          </GestureHandlerRootView>
        </HeaderSlotProvider>
      </ThemeProvider>
    )
    await wait()
  })
  return host!
}

function scroller(): HTMLElement {
  return host!.querySelector<HTMLElement>(
    '[data-testid="chat-message-history"]'
  )!
}

/** A browser scroll element whose extent follows the laid-out history. */
function scrollExtent(order: () => string[]): number[] {
  const node = scroller()
  const moves: number[] = []
  Object.defineProperties(node, {
    clientHeight: { configurable: true, value: VIEWPORT },
    clientWidth: { configurable: true, value: 360 },
    scrollHeight: {
      configurable: true,
      get: () => TOP + order().length * STEP + 200
    },
    scrollWidth: { configurable: true, value: 360 }
  })
  node.scroll = options => {
    const top = (options as ScrollToOptions).top ?? 0
    moves.push(top)
    node.scrollTop = Math.max(
      0,
      Math.min(top, node.scrollHeight - node.clientHeight)
    )
    node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  }
  return moves
}

async function userScroll(offset: number): Promise<void> {
  const node = scroller()
  await act(async () => {
    node.dispatchEvent(
      new window.WheelEvent('wheel', {
        bubbles: true,
        deltaY: offset - node.scrollTop
      })
    )
    node.scrollTop = offset
    node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    await wait(150)
  })
}

/** Each act scope commits what the screen scheduled, as a browser would. */
async function settle(done: () => boolean): Promise<void> {
  // Bounded generously: a loaded machine delays layout and measurement work.
  for (let tick = 0; tick < 150 && !done(); tick += 1)
    await act(async () => {
      await wait(20)
    })
}

const mounted = (): string[] =>
  [
    ...host!.querySelectorAll<HTMLElement>('[data-testid^="chat-message-row-"]')
  ].map(node => node.dataset.testid!.slice('chat-message-row-'.length))

function topZero(): ChatDraftOwner {
  const workspace = newChatWorkspaceState()
  workspace.drafts.set('cnv_1', {
    text: '',
    picked: [],
    hasScrollPosition: true,
    scrollOffset: 0,
    followNewest: false
  })
  return new ChatDraftOwner(workspace)
}

describe('virtualized chat message history', function () {
  it('mounts only the rows near the reading band and mounts again the rows a reader returns to', async function () {
    const state = fixture(
      view({
        messages: history(80).map(item =>
          item.id === 'msg_179'
            ? {
                ...item,
                reactions: [
                  { emoji: '👍', userIds: [userIdOfGumbo(2)], mine: false }
                ]
              }
            : item
        ),
        // After the last message: the notice follows the virtualized rows.
        safetyChanges: [
          {
            userId: userIdOfGumbo(2),
            name: 'Hank C',
            seq: 180,
            at: Date.parse('2027-04-02T00:00:00.000Z')
          }
        ]
      })
    )
    const order = (): string[] => state.shown.messages.map(item => item.id)
    browserLayout(order)
    await render(state.engine, topZero())
    scrollExtent(order)
    const first = mounted()
    expect(first).includes('msg_100')
    expect(first).not.includes('msg_179')
    expect(first.length, 'Only a window of the 80 rows').lessThan(40)
    const end = TOP + 80 * STEP + 200 - VIEWPORT
    await userScroll(end)
    expect(mounted()).includes('msg_179')
    expect(mounted(), 'The first row left the window').not.includes('msg_100')
    expect(
      host!.querySelector('[data-testid="chat-bubble-msg_179"]'),
      'Mounted rows keep their public bubble'
    ).not.equals(null)
    expect(host!.textContent).contains('Hank C’s safety words changed')
    // A mounted row still offers every action, here the emoji picker.
    await act(async () => {
      host!
        .querySelector<HTMLElement>(
          '[data-testid="chat-message-row-msg_179"] [aria-label="Send an emoji"]'
        )!
        .click()
      await wait()
    })
    expect(host!.querySelector('[aria-label="Emoji"]')).not.equals(null)
    await act(async () => {
      ;[
        ...host!.querySelectorAll<HTMLElement>(
          '[data-testid="chat-message-row-msg_179"] [role="button"]'
        )
      ]
        .find(node => node.textContent === '👍 1')!
        .click()
      await wait()
    })
    expect(state.reactions).deep.equals(['msg_179 👍 false'])
    await userScroll(0)
    expect(mounted()).includes('msg_100')
    expect(mounted()).not.includes('msg_179')
  })

  it('counts an unmounted target below the band and never consumes a target the window did not mount', async function () {
    const messages = history(80).map(item =>
      item.id === 'msg_100' || item.id === 'msg_140' || item.id === 'msg_178'
        ? { ...item, mentions: [userIdOfGumbo(1)] }
        : item
    )
    const state = fixture(
      view({
        conversation: { ...view().conversation, lastSeq: 179 },
        ownReadSeq: 99,
        // A cached row before the visible frontier is never laid out.
        historyBefore: 101,
        messages
      })
    )
    const order = (): string[] =>
      state.shown.messages.filter(item => item.seq >= 101).map(item => item.id)
    browserLayout(order)
    const owner = topZero()
    await render(state.engine, owner)
    scrollExtent(order)
    await userScroll(0)
    expect(mounted()).not.includes('msg_140')
    expect(mounted()).not.includes('msg_178')
    expect(
      host!.querySelector('[data-testid="chat-attention-count"]')?.textContent,
      'Both unmounted targets wait below the reading band'
    ).equals('2')
    // A manual scroll straight past one target: it never mounted.
    await userScroll(TOP + 80 * STEP + 200 - VIEWPORT)
    expect(mounted()).not.includes('msg_140')
    expect(mounted()).includes('msg_178')
    await settle(() => owner.attention('cnv_1')!.seen.has('msg_178'))
    expect(
      owner.attention('cnv_1')!.seen.has('msg_140'),
      'An unmounted row is never viewed'
    ).equals(false)
    expect(
      owner.attention('cnv_1')!.seen.has('msg_178'),
      'The mounted target in the band is viewed'
    ).equals(true)
    await userScroll(0)
    expect(
      host!.querySelector('[data-testid="chat-attention-count"]')?.textContent,
      'The skipped target is still pending below'
    ).equals('1')
  })

  it('mounts a pinned target before measuring and lands it below the overlays', async function () {
    const state = fixture(
      view({
        messages: history(80),
        pins: [{ messageId: 'msg_170', pinnedAt: '2027-04-01T17:00:00.000Z' }]
      })
    )
    const order = (): string[] => state.shown.messages.map(item => item.id)
    const layout = browserLayout(order)
    await render(state.engine, topZero())
    const moves = scrollExtent(order)
    await userScroll(0)
    expect(mounted()).not.includes('msg_170')
    let mountedAtTop = false
    const observer = new MutationObserver(() => {
      if (mounted().includes('msg_170') && scroller().scrollTop === 0)
        mountedAtTop = true
    })
    observer.observe(host!, { childList: true, subtree: true })
    stops.push(() => {
      observer.disconnect()
    })
    await act(async () => {
      host!
        .querySelector<HTMLElement>('[data-testid="chat-pinned-summary"]')!
        .click()
      await wait()
    })
    await settle(() => moves.length > 0)
    expect(mountedAtTop, 'The target mounted before the reader moved').equals(
      true
    )
    expect(moves.length).greaterThan(0)
    const landed = layout.rowTop('msg_170') - scroller().scrollTop
    expect(landed, 'The target sits below the header and pins').greaterThan(48)
    expect(landed).lessThan(VIEWPORT / 2)
    expect(
      host!.querySelector('[data-testid="chat-history-jump-retry"]')
    ).equals(null)
  })

  it('keeps the reader on the same row when an earlier page arrives above the window', async function () {
    const state = fixture(
      view({ messages: history(40, 200), hasEarlier: true, historyBefore: 200 })
    )
    state.setLoad(async () => ({
      ...state.shown,
      messages: [...history(20, 180), ...state.shown.messages],
      hasEarlier: false,
      historyBefore: 180
    }))
    const order = (): string[] => state.shown.messages.map(item => item.id)
    const layout = browserLayout(order)
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: '',
      picked: [],
      hasScrollPosition: true,
      scrollOffset: 600,
      followNewest: false,
      scrollAnchor: { id: 'msg_215', relativeY: 200 }
    })
    await render(state.engine, new ChatDraftOwner(workspace))
    scrollExtent(order)
    const content = scroller().firstElementChild as HTMLElement & {
      __reactLayoutHandler: (event: unknown) => void
    }
    const contentLayout = async (): Promise<void> => {
      await act(async () => {
        content.__reactLayoutHandler({
          nativeEvent: {
            layout: {
              x: 0,
              y: 0,
              width: 360,
              height: TOP + order().length * STEP + 200
            }
          }
        })
        await wait(60)
      })
    }
    // The earlier-page control above the rows is part of the list's header.
    const control = [
      ...host!.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Load earlier messages')!
    const headerNode = control.parentElement
    const headerLayout = async (height: number): Promise<void> => {
      layout.header.height = height
      await act(async () => {
        ;(
          headerNode as HTMLElement & {
            __reactLayoutHandler: (event: unknown) => void
          }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height } }
        })
        await wait()
      })
    }
    await headerLayout(48)
    await contentLayout()
    const reading = layout.rowTop('msg_215') - scroller().scrollTop
    expect(reading, 'The saved row-relative anchor is restored').equals(200)
    await act(async () => {
      ;[...host!.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(node => node.textContent === 'Load earlier messages')!
        .click()
      await wait(60)
    })
    expect(state.shown.messages).length(60)
    await headerLayout(0)
    await contentLayout()
    expect(
      layout.rowTop('msg_215') - scroller().scrollTop,
      'The reader did not move'
    ).equals(reading)
    expect(mounted()).includes('msg_215')
  })

  it('keeps the selected message mounted while its actions are open, wherever the reader scrolls', async function () {
    // A touch screen: the selected bubble lifts into the spotlight.
    const media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false })
    })
    stops.push(() => {
      if (media == null) Reflect.deleteProperty(globalThis, 'matchMedia')
      else Object.defineProperty(globalThis, 'matchMedia', media)
    })
    const state = fixture(view({ messages: history(80) }))
    const order = (): string[] => state.shown.messages.map(item => item.id)
    browserLayout(order)
    await render(state.engine, topZero())
    scrollExtent(order)
    const row = host!.querySelector<HTMLElement>(
      '[data-testid="chat-message-row-msg_101"]'
    )!
    await act(async () => {
      row
        .querySelector<HTMLElement>('[aria-label="More message actions"]')!
        .click()
      await wait()
    })
    await settle(
      () =>
        document.querySelector('[data-testid="chat-message-spotlight"]') != null
    )
    expect(
      document.querySelector('[data-testid="chat-message-spotlight"]')
    ).not.equals(null)
    const end = TOP + 80 * STEP + 200 - VIEWPORT
    await act(async () => {
      scroller().scrollTop = end
      scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(120)
    })
    expect(mounted()).includes('msg_179')
    expect(mounted(), 'The spotlight source stays mounted off screen').includes(
      'msg_101'
    )
    expect(mounted()).not.includes('msg_102')
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
    await settle(
      () =>
        document.querySelector('[data-testid="chat-message-spotlight"]') == null
    )
    expect(
      document.querySelector('[data-testid="chat-message-spotlight"]')
    ).equals(null)
    await userScroll(end - 10)
    expect(mounted(), 'Released once its actions close').not.includes('msg_101')
  })

  it('restores a saved row-relative anchor whose row starts outside the rendered window', async function () {
    const state = fixture(view({ messages: history(80) }))
    const order = (): string[] => state.shown.messages.map(item => item.id)
    const layout = browserLayout(order)
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: '',
      picked: [],
      hasScrollPosition: true,
      scrollOffset: 5000,
      followNewest: false,
      scrollAnchor: { id: 'msg_170', relativeY: 120 }
    })
    await render(state.engine, new ChatDraftOwner(workspace))
    const moves = scrollExtent(order)
    expect(mounted()).not.includes('msg_170')
    await act(async () => {
      ;(
        scroller() as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height: VIEWPORT } }
      })
      await wait()
    })
    await settle(() => mounted().includes('msg_170'))
    expect(moves.length).greaterThan(0)
    expect(mounted()).includes('msg_170')
    expect(layout.rowTop('msg_170') - scroller().scrollTop).equals(120)
  })
})

/**
 * A browser lays a virtualized row where the list's container puts it (its
 * `top` within the item area) at the row's own height. Rows of the earlier
 * page are taller than the list's estimate, so the list learns their sizes
 * only as they mount and measure.
 */
function listLayout(heights: Map<string, number>): {
  readerTop: (id: string) => number | undefined
} {
  const history = (): HTMLElement | null =>
    document.querySelector('[data-testid="chat-message-history"]')
  const scrollTop = (): number => history()?.scrollTop ?? 0
  const containerOf = (node: Element): HTMLElement | null => {
    for (let at: Element | null = node; at != null; at = at.parentElement) {
      const row = /^chat-message-row-(.+)$/.exec(
        (at.firstElementChild as HTMLElement | null)?.dataset?.testid ?? ''
      )
      if (row != null && (at as HTMLElement).style.top !== '')
        return at as HTMLElement
    }
    return null
  }
  const idOf = (container: HTMLElement): string =>
    (container.firstElementChild as HTMLElement).dataset.testid!.slice(
      'chat-message-row-'.length
    )
  const contentTop = (container: HTMLElement): number =>
    TOP + Number.parseFloat(container.style.top)
  const bounds = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect'
  )
  const original = Reflect.get(HTMLElement.prototype, 'getBoundingClientRect')
  HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement
  ): DOMRect {
    const id = this.dataset?.testid
    if (id === 'chat-viewport' || id === 'chat-message-history')
      return rect(0, VIEWPORT)
    const container = containerOf(this)
    if (container == null) return original.call(this)
    const height = heights.get(idOf(container)) ?? ROW
    return container === this
      ? rect(contentTop(container) - scrollTop(), height + 8)
      : rect(contentTop(container) - scrollTop(), height)
  }
  stops.push(() => {
    if (bounds == null)
      Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    else
      Object.defineProperty(
        HTMLElement.prototype,
        'getBoundingClientRect',
        bounds
      )
  })
  const measured = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'measureLayout'
  )
  Object.defineProperty(HTMLElement.prototype, 'measureLayout', {
    configurable: true,
    set(this: HTMLElement & { rnwMeasureLayout?: unknown }, value: unknown) {
      this.rnwMeasureLayout = value
    },
    get(this: HTMLElement & { rnwMeasureLayout?: unknown }) {
      const container = containerOf(this)
      if (container == null) return this.rnwMeasureLayout
      return (
        _relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => {
        success(
          0,
          contentTop(container),
          360,
          heights.get(idOf(container)) ?? ROW
        )
      }
    }
  })
  stops.push(() => {
    if (measured == null)
      Reflect.deleteProperty(HTMLElement.prototype, 'measureLayout')
    else Object.defineProperty(HTMLElement.prototype, 'measureLayout', measured)
  })
  return {
    readerTop: id => {
      const row = document.querySelector(
        `[data-testid="chat-message-row-${id}"]`
      )
      const container = row == null ? null : containerOf(row)
      return container == null ? undefined : contentTop(container) - scrollTop()
    }
  }
}

describe('virtualized earlier pages in a browser layout', function () {
  async function earlierPage(
    scrollBeforeSize: boolean,
    reader = { id: 'msg_210', relativeY: 120, offset: 600 }
  ): Promise<void> {
    const heights = new Map<string, number>()
    for (const item of history(20, 180)) heights.set(item.id, 150)
    const state = fixture(
      view({ messages: history(40, 200), hasEarlier: true, historyBefore: 200 })
    )
    let release: (() => void) | undefined
    state.setLoad(
      async () =>
        await new Promise<ConversationView>(resolve => {
          release = () => {
            resolve({
              ...state.shown,
              messages: [...history(20, 180), ...state.shown.messages],
              hasEarlier: true,
              historyBefore: 180
            })
          }
        })
    )
    const layout = listLayout(heights)
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: '',
      picked: [],
      hasScrollPosition: true,
      scrollOffset: reader.offset,
      followNewest: false,
      scrollAnchor: { id: reader.id, relativeY: reader.relativeY }
    })
    await render(state.engine, new ChatDraftOwner(workspace))
    const node = scroller()
    // The content grows by the page's actual rows once they are laid out.
    const extent = (): number =>
      TOP +
      state.shown.messages.reduce(
        (total, item) => total + (heights.get(item.id) ?? ROW) + 8,
        0
      ) +
      400
    Object.defineProperties(node, {
      clientHeight: { configurable: true, value: VIEWPORT },
      clientWidth: { configurable: true, value: 360 },
      scrollHeight: { configurable: true, get: extent },
      scrollWidth: { configurable: true, value: 360 }
    })
    node.scroll = options => {
      node.scrollTop = (options as ScrollToOptions).top ?? 0
      node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    }
    const content = node.firstElementChild as HTMLElement & {
      __reactLayoutHandler: (event: unknown) => void
    }
    const contentLayout = async (): Promise<void> => {
      await act(async () => {
        content.__reactLayoutHandler({
          nativeEvent: {
            layout: { x: 0, y: 0, width: 360, height: extent() }
          }
        })
        await wait(60)
      })
    }
    await contentLayout()
    await settle(() => layout.readerTop(reader.id) === reader.relativeY)
    const reading = layout.readerTop(reader.id)
    expect(reading, 'The saved reader is restored').equals(reader.relativeY)
    // Every position the reader is shown at, at every scroll the list makes.
    const shown: Array<number | undefined> = []
    node.addEventListener('scroll', () => {
      shown.push(layout.readerTop(reader.id))
    })
    await act(async () => {
      ;[...host!.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(item => item.textContent === 'Load earlier messages')!
        .click()
      await wait()
    })
    expect(release, 'The page request is outstanding').not.equals(undefined)
    await act(async () => {
      release!()
      await wait(0)
    })
    expect(
      layout.readerTop(reader.id),
      'The page lands with the reader in place'
    ).equals(reading)
    if (scrollBeforeSize) {
      await act(async () => {
        node.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, deltaY: -50 })
        )
        node.scrollTop -= 50
        node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await wait(150)
      })
      const chosen = node.scrollTop
      // The content size notification arrives after the person's scroll.
      await contentLayout()
      await act(async () => {
        await wait(300)
      })
      expect(
        node.scrollTop,
        'No late correction replaces the person’s own scroll'
      ).equals(chosen)
      return
    }
    // The browser's content size notification and the new rows' sizes arrive
    // after the page; the reader must not move for either.
    await contentLayout()
    // Rows above measure across frames; a busy machine delays those frames.
    await settle(() => layout.readerTop(reader.id) === reading)
    await act(async () => {
      await wait(300)
    })
    expect(layout.readerTop(reader.id)).equals(reading)
    expect(
      shown.filter(top => top !== undefined && top !== reading),
      'No frame shows the reader elsewhere'
    ).deep.equals([])
    expect(mounted()).includes(reader.id)
  }

  it('keeps the reader row in place while the earlier page measures', async function () {
    await earlierPage(false)
  })

  it('drops a late correction once the person scrolls', async function () {
    await earlierPage(true)
  })

  it('keeps a reader at the top while the page rows above it measure taller than estimated', async function () {
    // The earlier control is in view: the new rows mount just above the
    // held reader and report their real, taller sizes after the page lands.
    await earlierPage(false, { id: 'msg_200', relativeY: TOP, offset: 0 })
  })
})

describe('virtualized reader saved under the floating pin band', function () {
  const pinned = {
    messageId: 'msg_170',
    pinnedAt: '2027-04-01T17:00:00.000Z'
  }
  type Layout = ReturnType<typeof browserLayout>
  async function handle(testId: string, height: number): Promise<void> {
    const node = host!.querySelector<
      HTMLElement & { __reactLayoutHandler: (event: unknown) => void }
    >(`[data-testid="${testId}"]`)
    expect(node, testId).not.equals(null)
    await act(async () => {
      node!.__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height } }
      })
      await wait(60)
    })
  }
  /** A browser lays out a (re)opened history, then its floating pin band. */
  async function open(
    state: ReturnType<typeof fixture>,
    owner: ChatDraftOwner,
    conversationId = 'cnv_1'
  ): Promise<void> {
    await render(state.engine, owner, conversationId)
    scrollExtent(() => state.shown.messages.map(item => item.id))
    await act(async () => {
      ;(
        scroller().firstElementChild as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 6000 } }
      })
      await wait(60)
    })
    await steady()
    // The browser's scroll event acknowledges the restoration before the
    // band has measured, as it can on a busy machine.
    await act(async () => {
      scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(150)
    })
    if (state.shown.pins != null && state.shown.pins.length > 0)
      await handle('chat-pinned-band', 58)
    await steady()
  }
  /** Until the history has not moved for 300ms: restorations have run. */
  async function steady(): Promise<void> {
    let last = Number.NaN
    let since = Date.now()
    for (let tick = 0; tick < 150; tick += 1) {
      const top = scroller().scrollTop
      if (top !== last) {
        last = top
        since = Date.now()
      } else if (Date.now() - since >= 300) return
      await act(async () => {
        await wait(20)
      })
    }
  }
  const shownAt = (layout: Layout, id: string): number =>
    layout.rowTop(id) - scroller().scrollTop

  async function readAt(layout: Layout, id: string, y: number): Promise<void> {
    await userScroll(layout.rowTop(id) - y)
    expect(shownAt(layout, id)).equals(y)
  }

  it('restores it exactly after Info and Back and after a conversation switch', async function () {
    const state = fixture(view({ messages: history(80), pins: [pinned] }))
    const layout = browserLayout(() =>
      state.shown.messages.map(item => item.id)
    )
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    await open(state, owner)
    // Partly behind the band (header 48 + band 58), as a person left it.
    await readAt(layout, 'msg_130', 70)
    expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
      id: 'msg_130',
      relativeY: 70,
      readableTop: 106
    })
    // Information, then Back: the history mounts again and the band measures
    // from zero.
    await render(state.engine, owner, null)
    await open(state, owner)
    expect(shownAt(layout, 'msg_130'), 'After Info and Back').equals(70)
    // Another conversation, then this one again.
    await render(state.engine, owner, 'cnv_2')
    await open(state, owner)
    expect(shownAt(layout, 'msg_130'), 'After a conversation switch').equals(70)
    expect(owner.draft('cnv_1').scrollAnchor?.relativeY).equals(70)
  })

  it('still clears a reader from a band that genuinely newly covers it', async function () {
    const state = fixture(view({ messages: history(80) }))
    const layout = browserLayout(() =>
      state.shown.messages.map(item => item.id)
    )
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    await open(state, owner)
    await readAt(layout, 'msg_130', 70)
    // A reader saved without pins, reopened, then a pin arrives.
    await render(state.engine, owner, null)
    await open(state, owner)
    expect(shownAt(layout, 'msg_130')).equals(70)
    await act(async () => {
      state.update({ ...state.shown, pins: [pinned] })
      await wait()
    })
    await handle('chat-pinned-band', 58)
    await steady()
    expect(
      shownAt(layout, 'msg_130'),
      'The new band uncovers the row it now covers'
    ).equals(114)
  })
})

describe('virtualized reader reopened onto a longer history', function () {
  it('restores the saved row when the opened view adds taller rows above it', async function () {
    // Rows above the reader are taller than the list's estimate.
    const heights = new Map<string, number>()
    for (const item of history(42, 198)) heights.set(item.id, 150)
    const listed = view({ messages: history(40, 200) })
    const opened = view({ messages: history(42, 198) })
    let open = false
    const state = fixture(listed)
    // The list's cached view shows first; opening adds two earlier rows.
    const engine: ChatScreenEngine = {
      ...state.engine,
      view: () => (open ? opened : listed),
      open: async () => {
        await wait(40)
        open = true
        return opened
      }
    }
    const layout = listLayout(heights)
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: '',
      picked: [],
      hasScrollPosition: true,
      scrollOffset: 2000,
      followNewest: false,
      scrollAnchor: { id: 'msg_215', relativeY: 200 }
    })
    await render(engine, new ChatDraftOwner(workspace))
    const node = scroller()
    const extent = (): number =>
      TOP +
      (open ? opened : listed).messages.reduce(
        (total, item) => total + (heights.get(item.id) ?? ROW) + 8,
        0
      ) +
      400
    Object.defineProperties(node, {
      clientHeight: { configurable: true, value: VIEWPORT },
      clientWidth: { configurable: true, value: 360 },
      scrollHeight: { configurable: true, get: extent },
      scrollWidth: { configurable: true, value: 360 }
    })
    node.scroll = options => {
      node.scrollTop = (options as ScrollToOptions).top ?? 0
      node.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    }
    const content = node.firstElementChild as HTMLElement & {
      __reactLayoutHandler: (event: unknown) => void
    }
    for (let pass = 0; pass < 3; pass += 1)
      await act(async () => {
        content.__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height: extent() } }
        })
        await wait(80)
      })
    await settle(() => open && layout.readerTop('msg_215') === 200)
    expect(open).equals(true)
    expect(
      layout.readerTop('msg_215'),
      'The saved row, not the row at its old index'
    ).equals(200)
  })
})

/**
 * A pinned jump from the end of the history to its first row, whose smooth
 * scroll passes three unread mentions. The reported landing frame is the
 * browser's; a throttled Android stream may leave it out.
 */
async function jumpPastTargets(reportLanding: boolean): Promise<void> {
  // Three mentions sit just above the band of a reader at the end, inside
  // the draw distance; the pinned row is the first one.
  const targets = ['msg_208', 'msg_209', 'msg_210']
  const state = fixture(
    view({
      conversation: { ...view().conversation, lastSeq: 219 },
      ownReadSeq: 99,
      messages: history(120).map(item =>
        targets.includes(item.id)
          ? { ...item, mentions: [userIdOfGumbo(1)] }
          : item
      ),
      pins: [{ messageId: 'msg_100', pinnedAt: '2027-04-01T17:00:00.000Z' }]
    })
  )
  const order = (): string[] => state.shown.messages.map(item => item.id)
  const layout = browserLayout(order)
  const end = TOP + 120 * STEP + 200 - VIEWPORT
  const workspace = newChatWorkspaceState()
  workspace.drafts.set('cnv_1', {
    text: '',
    picked: [],
    hasScrollPosition: true,
    scrollOffset: end,
    followNewest: false
  })
  const owner = new ChatDraftOwner(workspace)
  await render(state.engine, owner)
  const moves = scrollExtent(order)
  const instant = scroller().scroll.bind(scroller())
  // A smooth scroll reports frames on its way: one with the targets in
  // the reading band, held long enough for any attention measurement.
  let flown = false
  scroller().scroll = (options?: ScrollToOptions | number) => {
    const smooth = (options as ScrollToOptions).behavior === 'smooth'
    if (!smooth) {
      instant(options as ScrollToOptions)
      return
    }
    const passing = layout.rowTop('msg_209') - VIEWPORT / 2
    const land = (): void => {
      if (reportLanding) instant(options as ScrollToOptions)
      else {
        const node = scroller()
        node.scrollTop = Math.max(
          0,
          Math.min(
            (options as ScrollToOptions).top ?? 0,
            node.scrollHeight - node.clientHeight
          )
        )
      }
    }
    instant({ top: passing })
    setTimeout(() => {
      flown = true
      land()
    }, 400)
  }
  await act(async () => {
    ;(
      scroller() as HTMLElement & {
        __reactLayoutHandler: (event: unknown) => void
      }
    ).__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: VIEWPORT } }
    })
    await wait()
  })
  await settle(() => moves.length > 0 && scroller().scrollTop === end)
  await settle(() => mounted().includes('msg_208'))
  expect(mounted(), 'The targets are mounted above the band').includes(
    'msg_208'
  )
  expect(layout.rowTop('msg_210') - scroller().scrollTop).lessThan(0)
  await act(async () => {
    host!
      .querySelector<HTMLElement>('[data-testid="chat-pinned-summary"]')!
      .click()
    await wait()
  })
  await settle(() => flown)
  expect(flown, 'The jump scrolled smoothly past the targets').equals(true)
  await settle(
    () =>
      host!.querySelector('[data-testid="chat-attention-count"]')
        ?.textContent === '3'
  )
  expect(layout.rowTop('msg_100') - scroller().scrollTop).lessThan(VIEWPORT / 2)
  for (const id of targets)
    expect(
      owner.attention('cnv_1')!.seen.has(id),
      'A row the jump flew past is not viewed: ' + id
    ).equals(false)
  expect(
    host!.querySelector('[data-testid="chat-attention-count"]')?.textContent,
    'Every target waits below the landed reader'
  ).equals('3')
}

describe('virtualized jump past unread targets', function () {
  it('never counts a target an animated jump only flew past as viewed', async function () {
    await jumpPastTargets(true)
  })

  it('counts the jump landed when the scroll stops reporting before its last frame', async function () {
    await jumpPastTargets(false)
  })
})
