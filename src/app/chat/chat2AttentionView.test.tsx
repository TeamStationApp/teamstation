import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { HeaderSlotProvider } from '../components/headerSlot'
import {
  ScopedThemeProvider,
  type Theme,
  ThemeProvider
} from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { ChatAttentionControl } from './ChatAttentionControl'
import { ChatConversationIdentity } from './ChatConversationIdentity'
import { ChatInfoScreen } from './ChatInfoScreen'
import { ChatListScreen } from './ChatListScreen'
import { ChatOverlayHost } from './ChatOverlayHost'
import {
  measureChatTestViewport,
  message,
  view
} from './chatViews.test.helpers'
import { ChatWorkspace } from './ChatWorkspace'
import { ChatDraftOwner, newChatWorkspaceState } from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import { MentionPicker } from './MentionPicker'
import { MessageMenu } from './MessageMenu'
import { PinnedMessageSummary } from './PinnedMessageSummary'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
let host: HTMLElement | undefined
let restore: (() => void) | undefined
let restorePlatform: (() => void) | undefined
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
  restore?.()
  restore = undefined
  restorePlatform?.()
  restorePlatform = undefined
})
async function render(
  element: React.ReactElement,
  theme: Theme = tsBallpark
): Promise<HTMLElement> {
  restore ??= measureChatTestViewport({ width: 390, height: 844 })
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ScopedThemeProvider theme={theme}>
          <HeaderSlotProvider headerHeight={48} onHandoff={() => {}}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <ChatOverlayHost>{element}</ChatOverlayHost>
            </GestureHandlerRootView>
          </HeaderSlotProvider>
        </ScopedThemeProvider>
      </ThemeProvider>
    )
    await wait()
  })
  return host!
}
async function click(id: string): Promise<void> {
  await act(async () => {
    host!.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
    await wait()
  })
}
function fixture(initial: ConversationView): {
  engine: ChatScreenEngine
  update: (next: ConversationView) => void
  readonly reads: number
  readonly loads: number
  readonly opens: number
  setOpen: (work: () => Promise<ConversationView>) => void
  setLoad: (work: () => Promise<ConversationView>) => void
} {
  let shown = initial
  let reads = 0
  let loads = 0
  let opens = 0
  let open = async (): Promise<ConversationView> => shown
  let load = async (): Promise<ConversationView> => shown
  const listeners = new Set<ChatEngineListener>()
  const update = (next: ConversationView): void => {
    shown = next
    for (const listener of listeners)
      listener({ type: 'conversation', conversationId: next.conversation.id })
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
    open: async () => await open(),
    close: () => {},
    view: () => shown,
    loadEarlier: async () => {
      loads += 1
      return await load()
    },
    sendText: async () => undefined,
    attach: async () => undefined,
    react: async () => {},
    edit: async () => {},
    deleteMessage: async () => {},
    moderatorDelete: async () => {},
    report: async () => ({ id: 'crp_test', verified: true }),
    markRead: async () => {
      reads += 1
    },
    typing: () => true,
    openAttachment: async () => {
      opens += 1
      return new Uint8Array([1])
    },
    approvals: () => [],
    approve: async () => {},
    fillGrants: async () => 0,
    safetyNumber: async () => undefined
  }
  return {
    engine,
    update,
    get reads() {
      return reads
    },
    get loads() {
      return loads
    },
    get opens() {
      return opens
    },
    setOpen: work => {
      open = work
    },
    setLoad: work => {
      load = work
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
function screen(
  engine: ChatScreenEngine,
  owner?: ChatDraftOwner,
  active = true
): React.ReactElement {
  return (
    <ConversationScreen
      engine={engine}
      userId={1}
      conversationId="cnv_1"
      onMembers={() => {}}
      active={active}
      draftOwner={owner}
      onDraftChange={
        owner == null
          ? undefined
          : next => {
              owner.write('cnv_1', next)
            }
      }
      draft={owner?.draft('cnv_1')}
      files={files}
    />
  )
}
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
async function layout(
  node: HTMLElement,
  y: number,
  height: number,
  width = 360
): Promise<void> {
  await act(async () => {
    ;(
      node as HTMLElement & { __reactLayoutHandler: (event: unknown) => void }
    ).__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y, width, height } }
    })
    await wait()
  })
}
async function measureBodies(
  positions: Record<string, number>,
  height = 844
): Promise<void> {
  const frame = host!.querySelector<HTMLElement>(
    '[data-testid="chat-viewport"]'
  )!
  frame.getBoundingClientRect = () => rect(0, height)
  for (const [id, top] of Object.entries(positions)) {
    const node = host!.querySelector<HTMLElement>(
      `[data-testid="chat-message-body-${id}"]`
    )
    if (node != null) {
      node.getBoundingClientRect = () => rect(top, 2000)
      await layout(node, 0, 2000)
    }
  }
}
const luminance = (hex: string): number => {
  const values = [1, 3, 5].map(start => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}
describe('attention controls and synchronized reading visits', function () {
  for (const theme of [tsBallpark, tsDark])
    it(`keeps distinct native-safe targets and a fixed latest position in ${theme.isDark ? 'dark' : 'light'} presentation`, async function () {
      let latest = 0
      let next = 0
      let retry = 0
      const props = {
        count: 2,
        loading: false,
        failed: false,
        disabled: false,
        bottom: 144,
        right: 16,
        onLatest: () => {
          latest += 1
        },
        onNext: () => {
          next += 1
        },
        onRetry: () => {
          retry += 1
        }
      }
      const node = await render(<ChatAttentionControl {...props} />, theme)
      const outer = node.querySelector<HTMLElement>(
        '[data-testid="chat-attention-controls"]'
      )!
      const badge = node.querySelector<HTMLElement>(
        '[data-testid="chat-attention-count"]'
      )!
      expect(
        parseFloat(outer.style.height) -
          parseFloat(badge.style.bottom) -
          parseFloat(badge.style.minHeight)
      ).at.least(0)
      expect(
        parseFloat(outer.style.width) -
          parseFloat(badge.style.right) -
          parseFloat(badge.style.minWidth)
      ).at.least(0)
      const color = badge.firstElementChild as HTMLElement
      expect(color.style.backgroundColor).equals('rgb(0, 101, 209)')
      expect((color.firstElementChild as HTMLElement).style.color).equals(
        'rgb(255, 255, 255)'
      )
      expect(
        (luminance(theme.chatAttentionTextColor) + 0.05) /
          (luminance(theme.chatAttentionBackgroundColor) + 0.05)
      ).at.least(4.5)
      expect(
        badge.contains(node.querySelector('[data-testid="chat-jump-latest"]'))
      ).equals(false)
      await click('chat-attention-count')
      await click('chat-jump-latest')
      expect([next, latest]).deep.equals([1, 1])
      const surface = (): string =>
        node.querySelector<HTMLElement>('[data-testid="chat-latest-surface"]')!
          .style.cssText
      const fixed = surface()
      await render(<ChatAttentionControl {...props} loading />, theme)
      expect(surface()).equals(fixed)
      expect(
        node.querySelector('[data-testid="chat-attention-loading"]')
      ).not.equals(null)
      await render(<ChatAttentionControl {...props} failed />, theme)
      expect(surface()).equals(fixed)
      await click('chat-attention-retry')
      expect(retry).equals(1)
      await render(<ChatAttentionControl {...props} disabled />, theme)
      await click('chat-attention-count')
      expect(next).equals(1)
      await render(<ChatAttentionControl {...props} count={0} />, theme)
      expect(node.querySelector('[data-testid="chat-attention-count"]')).equals(
        null
      )
      expect(surface()).equals(fixed)
    })
  it('waits for this visit fresh read synchronization despite an old cached ready view, and preserves a real zero', async function () {
    const state = fixture(
      view({
        readsReady: true,
        ownReadSeq: 900,
        messages: [message({ seq: 220 })]
      })
    )
    let finish!: (value: ConversationView) => void
    state.setOpen(
      async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    )
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    const node = await render(screen(state.engine, owner))
    const input = node.querySelector<HTMLElement>(
      '[data-testid="chat-composer"]'
    )!
    await act(async () => {
      input.focus()
      await wait()
    })
    expect(state.reads).equals(0)
    expect(owner.attention('cnv_1')).equals(undefined)
    await act(async () => {
      finish(
        view({
          ownReadSeq: 0,
          readsReady: true,
          messages: [message({ seq: 220 })]
        })
      )
      await wait()
    })
    expect(owner.attention('cnv_1')!.boundary).equals(0)
    expect(state.reads).greaterThan(0)
    state.update(view({ ownReadSeq: 999, messages: [message({ seq: 220 })] }))
    await render(screen(state.engine, owner))
    expect(owner.attention('cnv_1')!.boundary).equals(0)
    owner.invalidate()
    expect(owner.attention('cnv_1')).equals(undefined)
  })
  it('counts below-body targets, consumes actual leading bodies once, excludes occluded bodies and retains the chevron at zero', async function () {
    const targets = [
      message({ id: 'msg_one', seq: 210, mentions: [1] }),
      message({ id: 'msg_two', seq: 220, mentions: [1] })
    ]
    const state = fixture(view({ ownReadSeq: 200, messages: targets }))
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    await render(screen(state.engine, owner))
    await measureBodies({ msg_one: 900, msg_two: 1200 })
    expect(
      host!.querySelector('[data-testid="chat-attention-count"]')?.textContent
    ).equals('2')
    await measureBodies({ msg_one: 30, msg_two: 1200 })
    expect(owner.attention('cnv_1')!.seen.has('msg_one')).equals(false)
    await measureBodies({ msg_one: 130, msg_two: 1200 })
    expect(owner.attention('cnv_1')!.seen.has('msg_one')).equals(true)
    expect(
      host!.querySelector('[data-testid="chat-attention-count"]')?.textContent
    ).equals('1')
    await measureBodies({ msg_one: 900, msg_two: 130 })
    expect(host!.querySelector('[data-testid="chat-attention-count"]')).equals(
      null
    )
    expect(owner.attention('cnv_1')!.seen.size).equals(2)
    await click('chat-jump-latest')
    expect(host!.querySelector('[data-testid="chat-jump-latest"]')).not.equals(
      null
    )
  })
  it('does not open a hidden photo while discovering an old original, then ordinary Load earlier reveals cached rows after exhaustion', async function () {
    const reply = message({
      id: 'msg_reply',
      seq: 220,
      quote: {
        id: 'msg_original',
        authorId: 1,
        authorName: 'Aaron Judge',
        snippet: '',
        status: 'unavailable'
      }
    })
    const initial = view({
      ownReadSeq: 200,
      historyBefore: 201,
      hasEarlier: true,
      messages: [reply]
    })
    const state = fixture(initial)
    const photo = message({
      id: 'msg_photo',
      seq: 100,
      attachments: [
        {
          id: 'cat_test',
          key: 'A'.repeat(43),
          digest: 'A'.repeat(43),
          size: 1,
          contentType: 'image/jpeg',
          fileName: 'photo.jpg',
          width: 640,
          height: 480
        }
      ]
    })
    const loaded = view({
      ...initial,
      hasEarlier: false,
      historyBefore: 20,
      messages: [
        message({ id: 'msg_original', seq: 20, mine: true, senderUserId: 1 }),
        photo,
        reply
      ]
    })
    state.setLoad(async () => {
      state.update(loaded)
      return loaded
    })
    await render(screen(state.engine))
    await act(async () => {
      await wait(120)
    })
    expect(state.loads).equals(1)
    expect(state.opens).equals(0)
    expect(
      host!.querySelector('[data-testid="chat-message-body-msg_photo"]')
    ).equals(null)
    expect(host!.textContent).contains('Load earlier')
    const earlier = [
      ...host!.querySelectorAll<HTMLElement>('[role="button"],button')
    ].find(
      node => node.textContent?.endsWith('Load earlier messages') === true
    )!
    await act(async () => {
      earlier.click()
      await wait(120)
    })
    expect(
      state.loads,
      'Cached reveal does not need another server page'
    ).equals(1)
    expect(
      host!.querySelector('[data-testid="chat-message-body-msg_photo"]')
    ).not.equals(null)
    expect(state.opens).equals(1)
  })
})

describe('attention history measured page ownership', function () {
  it('waits for delayed mounted quote layout before requesting another raw page and preserves the same physical reader', async function () {
    const current = message({
      id: 'msg_current',
      seq: 300,
      body: 'Reader stays here'
    })
    const initial = view({
      conversation: { ...view().conversation, lastSeq: 300 },
      ownReadSeq: 200,
      historyBefore: 280,
      hasEarlier: true,
      messages: [current]
    })
    const state = fixture(initial)
    let first!: (value: ConversationView) => void
    state.setLoad(
      async () =>
        await new Promise(resolve => {
          first = resolve
        })
    )
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: 'Keep this draft',
      picked: [],
      scrollOffset: 300,
      hasScrollPosition: true,
      followNewest: false,
      scrollAnchor: { id: current.id, relativeY: 100 }
    })
    const owner = new ChatDraftOwner(workspace)
    const node = await render(screen(state.engine, owner))
    const nativeRow = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-row-msg_current"]'
    )! as HTMLElement & { measureLayout: (...args: unknown[]) => void }
    const callbacks: Array<() => void> = []
    let hold = true
    const original = nativeRow.measureLayout
    Object.defineProperty(nativeRow, 'measureLayout', {
      configurable: true,
      get:
        () =>
        (...args: unknown[]) => {
          const success = args[1] as (
            x: number,
            y: number,
            width: number,
            height: number
          ) => void
          if (hold)
            callbacks.push(() => {
              success(0, 460, 360, 100)
            })
          else success(0, 460, 360, 100)
        },
      set: () => {}
    })
    try {
      expect(state.loads).equals(1)
      const second = { ...initial, historyBefore: 240 }
      state.setLoad(async () => {
        const terminal = { ...initial, historyBefore: 190, hasEarlier: false }
        state.update(terminal)
        return terminal
      })
      await act(async () => {
        state.update(second)
        first(second)
        await wait(70)
      })
      await until(() => callbacks.length > 0)
      expect(
        callbacks.length,
        'A mounted reader measurement is pending'
      ).greaterThan(0)
      expect(
        state.loads,
        'A second page cannot replace unsettled restoration ownership'
      ).equals(1)
      await act(async () => {
        hold = false
        for (const callback of callbacks.splice(0)) callback()
        await wait(100)
      })
      await until(() => state.loads === 2)
      expect(state.loads).equals(2)
      expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
        id: current.id,
        relativeY: 100
      })
      expect(owner.draft('cnv_1').scrollOffset).equals(360)
      expect(owner.draft('cnv_1').text).equals('Keep this draft')
      await until(
        () =>
          node.querySelector('[data-testid="chat-attention-loading"]') == null
      )
      expect(
        node.querySelector('[data-testid="chat-attention-loading"]')
      ).equals(null)
    } finally {
      Object.defineProperty(nativeRow, 'measureLayout', {
        configurable: true,
        writable: true,
        value: original
      })
    }
  })
})

/** The app has no theme chooser; mounted scoped themes prove these changed surfaces. */
describe('changed chat surfaces in scoped light and dark themes', function () {
  for (const theme of [tsBallpark, tsDark])
    it(`renders shared identity, history, information, pins, actions and mentions in ${theme.isDark ? 'dark' : 'light'}`, async function () {
      const current = view({
        conversation: {
          ...view().conversation,
          title: 'Harbor Members',
          scopeName: 'Harbor'
        },
        messages: [
          message({ body: 'Current verified words', senderName: 'Aaron Judge' })
        ]
      })
      const state = fixture(current)
      const css = (color: string): string => {
        const node = document.createElement('span')
        node.style.color = color
        return node.style.color
      }
      const text = (value: string, within: ParentNode = host!): HTMLElement => {
        const found = [...within.querySelectorAll<HTMLElement>('*')].find(
          node => node.textContent === value && node.childElementCount === 0
        )
        expect(found, value).not.equals(undefined)
        return found!
      }
      let node = await render(
        <ChatConversationIdentity
          conversation={current.conversation}
          onPress={() => {}}
        />,
        theme
      )
      expect(getComputedStyle(text('Harbor', node)).color).equals(
        css(theme.headerTextColor)
      )
      node = await render(
        <ChatListScreen
          engine={state.engine}
          onOpen={() => {}}
          onNewMessage={() => {}}
        />,
        theme
      )
      expect(getComputedStyle(text('Harbor', node)).color).equals(
        css(theme.primaryTextColor)
      )
      node = await render(screen(state.engine), theme)
      expect(
        getComputedStyle(text('Current verified words', node)).color
      ).equals(css(theme.primaryTextColor))
      const input = node.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer"]'
      )!
      expect(getComputedStyle(input).color).equals(css(theme.inputTextColor))
      expect(
        node.querySelector('[data-testid="chat-composer-band"]')
      ).not.equals(null)
      node = await render(
        <ChatInfoScreen
          engine={state.engine}
          client={{ leaveDm: async () => ({ closed: false }) }}
          userId={1}
          conversationId="cnv_1"
          onLeft={() => {}}
        />,
        theme
      )
      expect(
        getComputedStyle(
          text('Harbor', node.querySelector('[data-testid="chat-info-hero"]')!)
        ).color
      ).equals(css(theme.primaryTextColor))
      node = await render(
        <PinnedMessageSummary
          pins={[{ messageId: 'msg_1', pinnedAt: '2027-04-01T00:00:00Z' }]}
          messages={current.messages}
          onJump={() => {}}
          onOpenList={() => {}}
        />,
        theme
      )
      expect(
        getComputedStyle(text('Current verified words', node)).color
      ).equals(css(theme.primaryTextColor))
      node = await render(
        <MessageMenu
          message={current.messages[0]}
          actions={['reply', 'copy']}
          desktop
          onClose={() => {}}
          onReply={() => {}}
          onReact={() => {}}
          onMoreEmoji={() => {}}
          onDelete={() => {}}
        />,
        theme
      )
      expect(getComputedStyle(text('Copy text', node)).color).equals(
        css(theme.activeColor)
      )
      node = await render(
        <MentionPicker
          members={[{ ...current.members[0], shortName: 'Shohei Ohtani' }]}
          onSelect={() => {}}
          onClose={() => {}}
        />,
        theme
      )
      expect(getComputedStyle(text('Shohei Ohtani', node)).color).equals(
        css(theme.primaryTextColor)
      )
      expect(getComputedStyle(text('Cancel', node)).color).equals(
        css(theme.dangerColor)
      )
    })
})

async function until(ready: () => boolean, timeout = 1800): Promise<void> {
  const deadline = Date.now() + timeout
  while (!ready() && Date.now() < deadline)
    await act(async () => {
      await wait(20)
    })
  expect(ready(), 'Expected public layout or request transition').equals(true)
}
interface NativeReadingCallbacks {
  onContentSizeChange: (width: number, height: number) => void
  onScrollBeginDrag: () => void
  onMomentumScrollBegin: () => void
  onScroll: (event: unknown) => void
  onScrollEndDrag: (event: unknown) => void
  onMomentumScrollEnd: (event: unknown) => void
}
/** Observe the rendered native ScrollView callbacks for a mounted unit test. */
function readingCallbacks(node: HTMLElement): NativeReadingCallbacks {
  interface Fiber {
    memoizedProps?: NativeReadingCallbacks & { onContentSizeChange?: unknown }
    return?: Fiber
  }
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, Fiber | undefined>)[key]
  while (fiber != null) {
    if (typeof fiber.memoizedProps?.onContentSizeChange === 'function')
      return fiber.memoizedProps
    fiber = fiber.return
  }
  throw new Error('Mounted message ScrollView missing')
}
function nativeEvent(offset: number): unknown {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 360, height: 3000 },
      layoutMeasurement: { width: 360, height: 844 }
    }
  }
}
describe('attention gestures, long quotes and retry intent', function () {
  it('consumes a skipped leading body exactly once during native drag and momentum callbacks', async function () {
    const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    restorePlatform = () => {
      Object.defineProperty(Platform, 'OS', saved)
    }
    const target = message({ id: 'msg_native', seq: 220, mentions: [1] })
    const state = fixture(view({ ownReadSeq: 200, messages: [target] }))
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    const node = await render(screen(state.engine, owner))
    await measureBodies({ msg_native: 1200 })
    const history = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    const callbacks = readingCallbacks(history)
    const body = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-body-msg_native"]'
    )!
    await act(async () => {
      callbacks.onScrollBeginDrag()
      await wait()
    })
    expect(owner.attention('cnv_1')!.seen.size).equals(0)
    await act(async () => {
      body.getBoundingClientRect = () => rect(-80, 2000)
      callbacks.onScroll(nativeEvent(1300))
      await wait(60)
    })
    expect(
      owner.attention('cnv_1')!.seen.has(target.id),
      'One authoritative native event retains manual-past visibility'
    ).equals(true)
    await act(async () => {
      callbacks.onScrollEndDrag(nativeEvent(1300))
      callbacks.onMomentumScrollBegin()
      callbacks.onMomentumScrollEnd(nativeEvent(1400))
      await wait()
    })
    expect(owner.attention('cnv_1')!.seen.size).equals(1)
    expect(node.querySelector('[data-testid="chat-attention-count"]')).equals(
      null
    )
  })
  for (const failMeasurement of [false, true])
    it(`anchors a long-quote attention jump through resize and ${failMeasurement ? 'failed measurement then Retry' : 'direct measurement'}`, async function () {
      const original = message({
        id: 'msg_original',
        seq: 20,
        senderUserId: 1,
        mine: true
      })
      const target = message({
        id: 'msg_quoted',
        seq: 220,
        quote: {
          id: original.id,
          authorId: 1,
          authorName: 'Aaron Judge',
          snippet: 'A long verified quote',
          status: 'ok'
        }
      })
      const initial = view({
        ownReadSeq: 200,
        historyBefore: 20,
        messages: [original, target]
      })
      const state = fixture(initial)
      const workspace = newChatWorkspaceState()
      workspace.drafts.set('cnv_1', {
        text: '',
        picked: [],
        scrollOffset: 0,
        hasScrollPosition: true,
        followNewest: false
      })
      const owner = new ChatDraftOwner(workspace)
      const node = await render(screen(state.engine, owner))
      const history = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-history"]'
      )!
      const content = history.firstElementChild as HTMLElement
      const frame = node.querySelector<HTMLElement>(
        '[data-testid="chat-viewport"]'
      )!
      frame.getBoundingClientRect = () => rect(0, 844)
      history.getBoundingClientRect = () => rect(0, 844)
      content.getBoundingClientRect = () => rect(-history.scrollTop, 3000)
      Object.defineProperties(history, {
        clientHeight: { configurable: true, value: 844 },
        scrollHeight: { configurable: true, value: 3000 }
      })
      history.scroll = options => {
        history.scrollTop = Math.min(
          (options as ScrollToOptions).top ?? 0,
          history.scrollHeight - history.clientHeight
        )
      }
      const row = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-row-msg_quoted"]'
      )!
      const body = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-body-msg_quoted"]'
      )!
      row.getBoundingClientRect = () => rect(600 - history.scrollTop, 2400)
      body.getBoundingClientRect = () => rect(1200 - history.scrollTop, 1800)
      for (const [element, parent, top, height] of [
        [content, history, 0, 3000],
        [row, content, 600, 2400],
        [body, content, 1200, 1800]
      ] as const) {
        Object.defineProperties(element, {
          offsetParent: { configurable: true, value: parent },
          offsetTop: { configurable: true, value: top },
          offsetWidth: { configurable: true, value: 360 },
          offsetHeight: { configurable: true, value: height }
        })
      }

      await layout(history, 0, 844)
      await layout(content, 0, 3000)
      await layout(row, 600, 2400)
      await layout(body, 600, 1800)
      await until(
        () => node.querySelector('[data-testid="chat-attention-count"]') != null
      )
      const measureDescriptor = Object.getOwnPropertyDescriptor(
        row,
        'measureLayout'
      )!
      if (failMeasurement)
        Object.defineProperty(row, 'measureLayout', {
          configurable: true,
          get:
            () =>
            (
              _content: unknown,
              success: (
                x: number,
                y: number,
                width: number,
                height: number
              ) => void
            ) => {
              success(0, 0, 0, 0)
            },
          set: () => {}
        })
      await click('chat-attention-count')
      if (failMeasurement) {
        expect(
          node.querySelector('[data-testid="chat-history-jump-cancel"]')
        ).not.equals(null)
        expect(owner.attention('cnv_1')!.seen.has(target.id)).equals(false)
        await until(
          () =>
            node.querySelector('[data-testid="chat-history-jump-retry"]') !=
            null,
          2800
        )
        expect(owner.attention('cnv_1')!.seen.has(target.id)).equals(false)
        Object.defineProperty(row, 'measureLayout', measureDescriptor)
        await click('chat-history-jump-retry')
      }
      await until(() => history.scrollTop === 1144)
      expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
        id: target.id,
        relativeY: -544,
        bodyInset: 600
      })
      expect(body.getBoundingClientRect().top).equals(56)
      await layout(
        node.querySelector<HTMLElement>('[data-testid="chat-composer-band"]')!,
        0,
        120
      )
      await act(async () => {
        await wait(60)
      })
      expect(body.getBoundingClientRect().top).equals(56)
      // Adding the first personal pin grows the measured top band.
      await act(async () => {
        state.update({
          ...initial,
          pins: [{ messageId: target.id, pinnedAt: '2027-04-01T00:00:00Z' }]
        })
        await wait()
      })
      await layout(
        node.querySelector<HTMLElement>('[data-testid="chat-pinned-band"]')!,
        0,
        64
      )
      await until(() => body.getBoundingClientRect().top === 120)
      expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
        id: target.id,
        relativeY: -480,
        bodyInset: 600
      })
      const savedPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'ios'
      })
      restorePlatform = () => {
        Object.defineProperty(Platform, 'OS', savedPlatform)
      }
      await act(async () => {
        const callbacks = readingCallbacks(history)
        callbacks.onScrollBeginDrag()
        history.scrollTop = 2130
        callbacks.onScroll(nativeEvent(2130))
        await wait()
      })
      expect(owner.draft('cnv_1').scrollOffset).equals(2130)
      expect(
        owner.draft('cnv_1').followNewest,
        'Within the ordinary 48px follow threshold'
      ).equals(true)
      await click('chat-jump-latest')
      expect(history.scrollTop, 'Latest still reaches the exact end').equals(
        2156
      )
    })
  it('queues Retry while a cancelled old discovery response still owns the history coordinator', async function () {
    const initial = view({
      conversation: { ...view().conversation, lastSeq: 300 },
      ownReadSeq: 200,
      historyBefore: 280,
      hasEarlier: true,
      messages: []
    })
    const state = fixture(initial)
    let finish!: (value: ConversationView) => void
    state.setLoad(
      async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    )
    const node = await render(screen(state.engine))
    const history = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    expect(state.loads).equals(1)
    await act(async () => {
      history.dispatchEvent(
        new window.WheelEvent('wheel', { deltaY: 100, bubbles: true })
      )
      await wait()
    })
    expect(
      node.querySelector('[data-testid="chat-attention-retry"]')
    ).not.equals(null)
    await click('chat-attention-retry')
    expect(state.loads, 'Retry never launches a parallel page').equals(1)
    state.setLoad(async () => {
      const terminal = { ...initial, historyBefore: 190, hasEarlier: false }
      state.update(terminal)
      return terminal
    })
    await act(async () => {
      const next = { ...initial, historyBefore: 240 }
      state.update(next)
      finish(next)
      await wait()
    })
    await until(() => state.loads === 2)
    await until(
      () => node.querySelector('[data-testid="chat-attention-loading"]') == null
    )
    expect(node.querySelector('[data-testid="chat-attention-retry"]')).equals(
      null
    )
  })
})

describe('attention cancellation preserves the current follow intent', function () {
  for (const manual of [false, true, 'end'] as const)
    it(
      manual === 'end'
        ? 'keeps follow-end on a no-motion wheel at the actual end before the first content callback'
        : `keeps ${manual ? 'a newer manual reader' : 'initial follow-end'} while a non-arriving history page precedes the first content callback`,
      async function () {
        const current = message({
          id: 'msg_initial_reader',
          seq: 290,
          mentions: [1]
        })
        const tail = message({
          id: 'msg_initial_tail',
          seq: 300,
          senderUserId: 1
        })
        const initial = view({
          conversation: { ...view().conversation, lastSeq: 300 },
          ownReadSeq: 200,
          historyBefore: 280,
          hasEarlier: true,
          messages: [current, tail]
        })
        const state = fixture(initial)
        let opened!: (next: ConversationView) => void
        let finish!: (next: ConversationView) => void
        state.setOpen(
          async () =>
            await new Promise(resolve => {
              opened = resolve
            })
        )
        state.setLoad(
          async () =>
            await new Promise(resolve => {
              finish = resolve
            })
        )
        const owner = new ChatDraftOwner(newChatWorkspaceState())
        const node = await render(screen(state.engine, owner))
        const history = node.querySelector<HTMLElement>(
          '[data-testid="chat-message-history"]'
        )!
        let extent = 3000
        Object.defineProperties(history, {
          clientHeight: { configurable: true, value: 844 },
          scrollHeight: { configurable: true, get: () => extent }
        })
        history.getBoundingClientRect = () => rect(0, 844)
        history.scrollTop = manual === 'end' ? 2156 : 61
        history.scroll = options => {
          history.scrollTop = Math.min(
            (options as ScrollToOptions).top ?? 0,
            extent - 844
          )
          readingCallbacks(history).onScroll(nativeEvent(history.scrollTop))
        }
        for (const [id, y] of [
          [current.id, 200],
          [tail.id, 2500]
        ] as const) {
          const row = node.querySelector<HTMLElement>(
            `[data-testid="chat-message-row-${id}"]`
          )!
          row.getBoundingClientRect = () => rect(y - history.scrollTop, 100)
          Object.defineProperty(row, 'measureLayout', {
            configurable: true,
            get:
              () =>
              (
                _parent: unknown,
                done: (
                  x: number,
                  y: number,
                  width: number,
                  height: number
                ) => void
              ) => {
                done(0, y, 360, 100)
              },
            set: () => {}
          })
          const body = node.querySelector<HTMLElement>(
            `[data-testid="chat-message-body-${id}"]`
          )!
          body.getBoundingClientRect = () => rect(y - history.scrollTop, 100)
          await layout(row, y, 100)
        }
        await layout(history, 0, 844)
        await act(async () => {
          opened(initial)
          await wait()
        })
        await until(() => state.loads === 1)
        if (manual === true)
          await act(async () => {
            history.dispatchEvent(
              new window.WheelEvent('wheel', { deltaY: 239, bubbles: true })
            )
            history.scrollTop = 300
            history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
            await wait()
          })
        if (manual === 'end') {
          await act(async () => {
            history.dispatchEvent(
              new window.WheelEvent('wheel', { deltaY: 1, bubbles: true })
            )
            await wait()
          })
          expect(
            history.scrollTop,
            'The outward wheel has no physical motion'
          ).equals(2156)
          extent = 3500
        }
        const expected = manual === true ? 300 : extent - 844
        await act(async () => {
          readingCallbacks(history).onContentSizeChange(360, extent)
          await wait()
        })
        expect(
          history.scrollTop,
          'The first content callback follows only the still-owned end'
        ).equals(expected)
        await act(async () => {
          const next = { ...initial, historyBefore: 190, hasEarlier: false }
          state.update(next)
          finish(next)
          await wait()
        })
        await until(
          () =>
            node.querySelector('[data-testid="chat-attention-loading"]') == null
        )
        expect(
          history.scrollTop,
          'Completing old history cannot reinstate the initially captured top over active follow intent'
        ).equals(expected)
        if (manual !== true)
          expect(owner.attention('cnv_1')!.seen.has(current.id)).equals(false)
        expect(state.loads).equals(1)
      }
    )

  it('follows an arrival after explicit Latest while an older discovery response remains pending', async function () {
    const initial = view({
      conversation: { ...view().conversation, lastSeq: 300 },
      ownReadSeq: 200,
      historyBefore: 280,
      hasEarlier: true,
      messages: [message({ id: 'msg_reader', seq: 300 })]
    })
    const state = fixture(initial)
    let finish!: (value: ConversationView) => void
    state.setLoad(
      async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    )
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: 'Unsent words',
      picked: [],
      hasScrollPosition: true,
      followNewest: false,
      scrollOffset: 100
    })
    const owner = new ChatDraftOwner(workspace)
    const node = await render(screen(state.engine, owner))
    const history = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    let extent = 3000
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 844 },
      scrollHeight: { configurable: true, get: () => extent }
    })
    history.scroll = options => {
      history.scrollTop = Math.min(
        (options as ScrollToOptions).top ?? 0,
        history.scrollHeight - history.clientHeight
      )
    }
    await layout(history, 0, 844)
    await layout(history.firstElementChild as HTMLElement, 0, extent)
    expect(state.loads).equals(1)
    await click('chat-jump-latest')
    expect(history.scrollTop).equals(2156)
    const arrived = {
      ...initial,
      conversation: { ...initial.conversation, lastSeq: 301 },
      messages: [
        ...initial.messages,
        message({ id: 'msg_arrival', seq: 301, mentions: [1] })
      ]
    }
    await act(async () => {
      extent = 3500
      state.update(arrived)
      await wait()
    })
    await act(async () => {
      readingCallbacks(history).onContentSizeChange(360, extent)
      await wait()
    })
    expect(
      history.scrollTop,
      'The arriving extent follows the current Latest intent'
    ).equals(2656)
    await act(async () => {
      const next = { ...arrived, historyBefore: 190, hasEarlier: false }
      state.update(next)
      finish(next)
      await wait()
    })
    await until(
      () => node.querySelector('[data-testid="chat-attention-loading"]') == null
    )
    expect(history.scrollTop).equals(2656)
    expect(owner.draft('cnv_1').text).equals('Unsent words')
  })
})

describe('conversation information navigation reader ownership', function () {
  for (const { deferred, offset, following, label } of [
    {
      deferred: false,
      offset: 550,
      following: false,
      label: 'immediate reader'
    },
    { deferred: true, offset: 550, following: false, label: 'deferred reader' },
    { deferred: true, offset: 0, following: false, label: 'explicit zero' },
    { deferred: true, offset: 2156, following: true, label: 'follow-end' }
  ])
    it(`captures ${label} before information navigation without a physical scroll gesture`, async function () {
      restore = measureChatTestViewport({ width: 1200, height: 844 })
      const current = message({ id: 'msg_info_reader', seq: 300 })
      const state = fixture(view({ messages: [current] }))
      const workspace = newChatWorkspaceState()
      const picked = {
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1])
      }
      workspace.drafts.set('cnv_1', {
        text: 'Unsent information draft',
        replyTo: current,
        picked: [picked],
        hasScrollPosition: true,
        followNewest: following,
        scrollOffset: 0
      })
      let leave: (() => void) | undefined
      let captured: ReturnType<ChatDraftOwner['draft']> | undefined
      function Routes(): React.ReactElement {
        const [information, setInformation] = useState(false)
        return information ? (
          <>
            <button
              data-testid="reading-test-back"
              onClick={() => {
                setInformation(false)
              }}
            >
              Back
            </button>
            <ChatInfoScreen
              engine={state.engine}
              client={{ leaveDm: async () => ({ closed: false }) }}
              conversationId="cnv_1"
              userId={1}
              onLeft={() => {}}
            />
          </>
        ) : (
          <ChatWorkspace
            engine={state.engine}
            userId={1}
            state={workspace}
            conversationId="cnv_1"
            onOpen={() => {}}
            onMembers={() => {
              captured = workspace.drafts.get('cnv_1')
              const change = (): void => {
                setInformation(true)
              }
              if (deferred) leave = change
              else change()
            }}
            onNewMessage={() => {}}
            onTitle={() => {}}
          />
        )
      }
      const node = await render(<Routes />)
      async function measuredReader(): Promise<{
        history: HTMLElement
        row: HTMLElement
      }> {
        const history = node.querySelector<HTMLElement>(
          '[data-testid="chat-message-history"]'
        )!
        const row = node.querySelector<HTMLElement>(
          '[data-testid="chat-message-row-msg_info_reader"]'
        )!
        history.getBoundingClientRect = () => rect(0, 844)
        row.getBoundingClientRect = () => rect(1000 - history.scrollTop, 100)
        Object.defineProperties(history, {
          clientHeight: { configurable: true, value: 844 },
          scrollHeight: { configurable: true, value: 3000 }
        })
        history.scroll = options => {
          history.scrollTop = Math.min(
            (options as ScrollToOptions).top ?? 0,
            2156
          )
          readingCallbacks(history).onScroll(nativeEvent(history.scrollTop))
        }
        Object.defineProperty(row, 'measureLayout', {
          configurable: true,
          value: (
            _parent: unknown,
            done: (x: number, y: number, width: number, height: number) => void
          ) => {
            done(0, 1000, 900, 100)
          }
        })
        await layout(row, 1000, 100, 900)
        await layout(history, 0, 844, 900)
        await act(async () => {
          readingCallbacks(history).onContentSizeChange(900, 3000)
          await wait()
        })
        return { history, row }
      }
      const before = await measuredReader()
      await act(async () => {
        // Public anchoring can move the DOM without a wheel/touch/key owner.
        before.history.scrollTop = offset
        readingCallbacks(before.history).onScroll(nativeEvent(offset))
        await wait()
      })
      const top = before.row.getBoundingClientRect().top
      expect(top).equals(1000 - offset)
      expect(workspace.drafts.get('cnv_1')?.scrollOffset).equals(
        following ? 2156 : 0
      )
      await click('chat-conversation-identity')
      if (deferred)
        await act(async () => {
          // The list may finish its navigation capture after another layout.
          readingCallbacks(before.history).onContentSizeChange(900, 3000)
          await wait()
          leave!()
          await wait()
        })
      expect(node.querySelector('[data-testid="chat-info-hero"]')).not.equals(
        null
      )
      await click('reading-test-back')
      const returned = await measuredReader()
      expect(
        Math.abs(returned.row.getBoundingClientRect().top - top),
        'Row-relative reader anchor must survive information navigation'
      ).at.most(3)
      expect(captured?.scrollOffset).equals(offset)
      expect(captured?.scrollAnchor).deep.equals(
        offset === 0 ? undefined : { id: current.id, relativeY: 1000 - offset }
      )
      expect(captured?.followNewest).equals(following)
      expect(workspace.drafts.get('cnv_1')?.text).equals(
        'Unsent information draft'
      )
      expect(workspace.drafts.get('cnv_1')?.replyTo?.id).equals(current.id)
      expect(workspace.drafts.get('cnv_1')?.picked).deep.equals([picked])
    })
})

describe('conversation width reflow reader ownership', function () {
  it('keeps a genuine reader through transient widths and rejects a delayed old-width row measurement', async function () {
    const windowSize = { width: 1200, height: 844 }
    restore = measureChatTestViewport(windowSize)
    const current = message({ id: 'msg_width_reader', seq: 300 })
    const state = fixture(view({ messages: [current] }))
    const workspace = newChatWorkspaceState()
    const picked = {
      fileName: 'notes.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1])
    }
    workspace.drafts.set('cnv_1', {
      text: 'Unsent width draft',
      replyTo: current,
      picked: [picked],
      scrollOffset: 600,
      hasScrollPosition: true,
      followNewest: false,
      scrollAnchor: { id: current.id, relativeY: 100 }
    })
    const owner = new ChatDraftOwner(workspace)
    const node = await render(screen(state.engine, owner))
    const history = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    const content = history.firstElementChild as HTMLElement
    const row = node.querySelector<HTMLElement>(
      `[data-testid="chat-message-row-${current.id}"]`
    )!
    let paneWidth = 900
    let rowY = 700
    let extent = 3000
    let hold = false
    const moves: number[] = []
    const held: Array<() => void> = []
    const box = (top: number, height: number): DOMRect =>
      new window.DOMRect(0, top, paneWidth, height)
    history.getBoundingClientRect = () => box(0, 844)
    content.getBoundingClientRect = () => box(-history.scrollTop, extent)
    row.getBoundingClientRect = () => box(rowY - history.scrollTop, 100)
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 844 },
      scrollHeight: { configurable: true, get: () => extent }
    })
    history.scroll = options => {
      const top = Math.min((options as ScrollToOptions).top ?? 0, extent - 844)
      moves.push(top)
      history.scrollTop = top
      readingCallbacks(history).onScroll(nativeEvent(top))
    }
    Object.defineProperty(row, 'measureLayout', {
      configurable: true,
      get:
        () =>
        (
          _parent: unknown,
          done: (x: number, y: number, width: number, height: number) => void
        ) => {
          const y = rowY
          const width = paneWidth
          const deliver = (): void => {
            done(0, y, width, 100)
          }
          if (hold) held.push(deliver)
          else deliver()
        },
      set: () => {}
    })
    await layout(row, rowY, 100, paneWidth)
    await layout(history, 0, 844, paneWidth)
    await act(async () => {
      readingCallbacks(history).onContentSizeChange(paneWidth, extent)
      await wait()
    })
    await until(() => moves.includes(600))
    await act(async () => {
      history.dispatchEvent(
        new window.WheelEvent('wheel', { deltaY: 50, bubbles: true })
      )
      history.scrollTop = 650
      history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait()
    })
    expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
      id: current.id,
      relativeY: 50
    })
    moves.length = 0
    await act(async () => {
      windowSize.width = 390
      window.dispatchEvent(new window.Event('resize'))
      await wait()
    })
    paneWidth = 70
    rowY = 26000
    extent = 30000
    hold = true
    await layout(row, rowY, 100, paneWidth)
    await layout(history, 0, 844, paneWidth)
    expect(
      moves,
      'New-width rows cannot be clamped against old-width content'
    ).deep.equals([])
    expect(
      owner.draft('cnv_1').scrollAnchor,
      'Reflow cannot replace the owned reader with a transient row coordinate'
    ).deep.equals({ id: current.id, relativeY: 50 })
    await act(async () => {
      readingCallbacks(history).onContentSizeChange(paneWidth, extent)
      await wait()
    })
    await until(() => held.length > 0)
    paneWidth = 390
    rowY = 3000
    extent = 5000
    hold = false
    await act(async () => {
      ;(
        history as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: paneWidth, height: 844 } }
      })
      readingCallbacks(history).onContentSizeChange(paneWidth, extent)
      for (const deliver of held.splice(0)) deliver()
      await wait()
    })
    await until(() => history.scrollTop === 2950)
    expect(
      moves,
      'An old70px measurement never promotes its obsolete coordinate'
    ).not.contains(25950)
    expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
      id: current.id,
      relativeY: 50
    })
    await act(async () => {
      windowSize.width = 1200
      window.dispatchEvent(new window.Event('resize'))
      await wait()
    })
    paneWidth = 900
    rowY = 700
    extent = 3000
    await layout(row, rowY, 100, paneWidth)
    await layout(history, 0, 844, paneWidth)
    await act(async () => {
      readingCallbacks(history).onContentSizeChange(paneWidth, extent)
      await wait()
    })
    await until(() => history.scrollTop === 650)
    expect(row.getBoundingClientRect().y).equals(50)
    expect(owner.draft('cnv_1').text).equals('Unsent width draft')
    expect(owner.draft('cnv_1').replyTo?.id).equals(current.id)
    expect(owner.draft('cnv_1').picked).deep.equals([picked])
    expect(owner.draft('cnv_1').followNewest).equals(false)
    await act(async () => {
      windowSize.width = 390
      window.dispatchEvent(new window.Event('resize'))
      await wait()
    })
    paneWidth = 390
    rowY = 3000
    extent = 5000
    hold = true
    await layout(row, rowY, 100, paneWidth)
    await layout(history, 0, 844, paneWidth)
    await act(async () => {
      readingCallbacks(history).onContentSizeChange(paneWidth, extent)
      await wait()
    })
    await until(() => held.length > 0)
    moves.length = 0
    await act(async () => {
      history.dispatchEvent(
        new window.WheelEvent('wheel', { deltaY: 100, bubbles: true })
      )
      history.scrollTop = 2600
      history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      hold = false
      for (const deliver of held.splice(0)) deliver()
      await wait()
    })
    expect(
      moves,
      'A newer genuine reader cancels pending width restoration'
    ).deep.equals([])
    expect(owner.draft('cnv_1').scrollOffset).equals(2600)
    expect(owner.draft('cnv_1').scrollAnchor).deep.equals({
      id: current.id,
      relativeY: 400
    })
  })

  for (const following of [false, true])
    it(`retains ${following ? 'follow-end' : 'explicit zero'} through width changes`, async function () {
      const windowSize = { width: 1200, height: 844 }
      restore = measureChatTestViewport(windowSize)
      const state = fixture(view({ messages: [message({ seq: 300 })] }))
      const workspace = newChatWorkspaceState()
      workspace.drafts.set('cnv_1', {
        text: '',
        picked: [],
        scrollOffset: 0,
        hasScrollPosition: true,
        followNewest: following
      })
      const owner = new ChatDraftOwner(workspace)
      const node = await render(screen(state.engine, owner))
      const history = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-history"]'
      )!
      let extent = 3000
      Object.defineProperties(history, {
        clientHeight: { configurable: true, value: 844 },
        scrollHeight: { configurable: true, get: () => extent }
      })
      history.scroll = options => {
        history.scrollTop = Math.min(
          (options as ScrollToOptions).top ?? 0,
          extent - 844
        )
        readingCallbacks(history).onScroll(nativeEvent(history.scrollTop))
      }
      await layout(history, 0, 844, 900)
      await act(async () => {
        readingCallbacks(history).onContentSizeChange(900, extent)
        await wait()
      })
      expect(history.scrollTop).equals(following ? 2156 : 0)
      await act(async () => {
        windowSize.width = 390
        window.dispatchEvent(new window.Event('resize'))
        await wait()
      })
      extent = 4000
      await layout(history, 0, 844, 390)
      await act(async () => {
        readingCallbacks(history).onContentSizeChange(390, extent)
        await wait()
      })
      expect(history.scrollTop).equals(following ? 3156 : 0)
    })
})

describe('attention public browser scroll ordering', function () {
  it('retains manual pass intent when capturing wheel and bubbling ScrollView notifications describe the same offset', async function () {
    const first = message({ id: 'msg_web_pass', seq: 220, mentions: [1] })
    const state = fixture(view({ ownReadSeq: 200, messages: [first] }))
    const workspace = newChatWorkspaceState()
    workspace.drafts.set('cnv_1', {
      text: 'Keep the web draft',
      picked: [],
      hasScrollPosition: true,
      followNewest: false,
      scrollOffset: 0
    })
    const owner = new ChatDraftOwner(workspace)
    const node = await render(screen(state.engine, owner))
    const history = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    const frame = node.querySelector<HTMLElement>(
      '[data-testid="chat-viewport"]'
    )!
    frame.getBoundingClientRect = () => rect(0, 844)
    history.getBoundingClientRect = () => rect(0, 844)
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 844 },
      scrollHeight: { configurable: true, value: 3000 },
      offsetHeight: { configurable: true, value: 844 },
      offsetWidth: { configurable: true, value: 360 }
    })
    const body = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-body-msg_web_pass"]'
    )!
    body.getBoundingClientRect = () => rect(1200 - history.scrollTop, 1000)
    await layout(history, 0, 844)
    await layout(history.firstElementChild as HTMLElement, 0, 3000)
    await layout(body, 0, 1000)
    await until(
      () => node.querySelector('[data-testid="chat-attention-count"]') != null
    )
    await act(async () => {
      history.dispatchEvent(
        new window.WheelEvent('wheel', { deltaY: 1500, bubbles: true })
      )
      history.scrollTop = 1500
      history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(160)
    })
    expect(
      owner.attention('cnv_1')!.seen.has(first.id),
      'The bubbling programmatic notification cannot erase the capturing manual pass'
    ).equals(true)
    expect(node.querySelector('[data-testid="chat-attention-count"]')).equals(
      null
    )
    expect(owner.draft('cnv_1').text).equals('Keep the web draft')
    // A programmatic skip alone cannot claim that its leading body was viewed.
    const next = message({ id: 'msg_programmatic', seq: 230, mentions: [1] })
    await act(async () => {
      history.scrollTop = 0
      state.update(view({ ownReadSeq: 230, messages: [next] }))
      await wait()
    })
    const nextBody = node.querySelector<HTMLElement>(
      '[data-testid="chat-message-body-msg_programmatic"]'
    )!
    nextBody.getBoundingClientRect = () => rect(1200 - history.scrollTop, 1000)
    await layout(nextBody, 0, 1000)
    await act(async () => {
      history.scrollTop = 1500
      history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(160)
    })
    expect(owner.attention('cnv_1')!.seen.has(next.id)).equals(false)
    await act(async () => {
      history.scrollTop = 1070
      history.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await wait(160)
    })
    expect(
      owner.attention('cnv_1')!.seen.has(next.id),
      'A programmatic move that actually exposes the body still counts'
    ).equals(true)
  })
})

describe('attention composer overlay visibility', function () {
  it('keeps an exposed target unseen while emoji covers the conversation and consumes it after ordinary dismissal', async function () {
    const target = message({ id: 'msg_overlay', seq: 220, mentions: [1] })
    const state = fixture(view({ ownReadSeq: 200, messages: [target] }))
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    const node = await render(screen(state.engine, owner))
    await measureBodies({ msg_overlay: 1200 })
    expect(
      node.querySelector('[data-testid="chat-attention-count"]')?.textContent
    ).equals('1')
    await act(async () => {
      node.querySelector<HTMLElement>('[aria-label="Emoji"]')!.click()
      await wait()
    })
    await measureBodies({ msg_overlay: 130 })
    expect(owner.attention('cnv_1')!.seen.has(target.id)).equals(false)
    await act(async () => {
      node.querySelector<HTMLElement>('[aria-label="Cancel"]')!.click()
      await wait()
    })
    await until(() => owner.attention('cnv_1')!.seen.has(target.id))
    expect(node.querySelector('[data-testid="chat-attention-count"]')).equals(
      null
    )
  })
})

describe('foreground history reading visit ownership', function () {
  for (const rejectOld of [false, true])
    it(`discards ${rejectOld ? 'rejected' : 'resolved'} retained and queued old-visit pages without changing the returned reader`, async function () {
      const recent = message({ id: 'msg_visit_recent', seq: 220 })
      const initial = view({
        ownReadSeq: 220,
        historyBefore: 220,
        hasEarlier: true,
        messages: [recent]
      })
      const state = fixture(initial)
      let finish!: (value: ConversationView) => void
      let fail!: (error: Error) => void
      state.setLoad(
        async () =>
          await new Promise((resolve, reject) => {
            finish = resolve
            fail = reject
          })
      )
      const workspace = newChatWorkspaceState()
      workspace.drafts.set('cnv_1', {
        text: 'Draft across visits',
        picked: [],
        scrollOffset: 0,
        hasScrollPosition: true,
        followNewest: false
      })
      const owner = new ChatDraftOwner(workspace)
      let node = await render(screen(state.engine, owner))
      const earlier = (): HTMLElement =>
        [...node.querySelectorAll<HTMLElement>('[role="button"],button')].find(
          button => button.textContent === 'Load earlier messages'
        )!
      await act(async () => {
        earlier().click()
        earlier().click()
        await wait()
      })
      expect(state.loads).equals(1)
      await render(screen(state.engine, owner, false))
      const older = message({ id: 'msg_visit_old', seq: 20 })
      const loaded = {
        ...initial,
        hasEarlier: false,
        historyBefore: 20,
        messages: [older, recent]
      }
      await act(async () => {
        state.update(loaded)
        await wait()
      })
      node = await render(screen(state.engine, owner, true))
      await act(async () => {
        state.update(loaded)
        await wait()
      })
      expect(
        node.querySelector('[data-testid="chat-message-body-msg_visit_old"]')
      ).equals(null)
      await act(async () => {
        if (rejectOld) fail(new Error('History unavailable'))
        else finish(loaded)
        await wait(80)
      })
      expect(state.loads, 'The queued old-visit request never starts').equals(1)
      expect(
        node.querySelector('[data-testid="chat-message-body-msg_visit_old"]')
      ).equals(null)
      expect(owner.draft('cnv_1').text).equals('Draft across visits')
      expect(owner.draft('cnv_1').scrollOffset).equals(0)
      expect(node.textContent).not.contains('Could not send')
      await act(async () => {
        earlier().click()
        await wait(80)
      })
      expect(
        state.loads,
        'A current explicit reveal uses already verified cache'
      ).equals(1)
      expect(
        node.querySelector('[data-testid="chat-message-body-msg_visit_old"]')
      ).not.equals(null)
    })
})

describe('attention unresolved arrivals after explicit navigation', function () {
  it('withholds a completed total and offers Retry for a new unresolved reply after Latest', async function () {
    const initial = view({
      conversation: { ...view().conversation, lastSeq: 300 },
      ownReadSeq: 200,
      historyBefore: 201,
      hasEarlier: true,
      messages: [message({ id: 'msg_reader', seq: 300 })]
    })
    const state = fixture(initial)
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    const node = await render(screen(state.engine, owner))
    expect(owner.attention('cnv_1')!.complete).equals(true)
    expect(state.loads).equals(0)
    await click('chat-jump-latest')
    const reply = message({
      id: 'msg_new_reply',
      seq: 301,
      mentions: [1],
      quote: {
        id: 'msg_old_original',
        authorId: 1,
        authorName: 'Aaron Judge',
        snippet: '',
        status: 'unavailable'
      }
    })
    const arrived = {
      ...initial,
      conversation: { ...initial.conversation, lastSeq: 301 },
      messages: [...initial.messages, reply]
    }
    await act(async () => {
      state.update(arrived)
      await wait()
    })
    await measureBodies({ msg_new_reply: 900 })
    expect(state.loads, 'Latest preserves paused discovery intent').equals(0)
    expect(
      node.querySelector('[data-testid="chat-attention-count"]'),
      'Unresolved references cannot produce a completed numeric total'
    ).equals(null)
    expect(owner.attention('cnv_1')!.complete).equals(false)
    expect(
      node.querySelector('[data-testid="chat-attention-retry"]')
    ).not.equals(null)
    state.setLoad(async () => {
      const loaded = {
        ...arrived,
        historyBefore: 20,
        hasEarlier: false,
        messages: [
          message({
            id: 'msg_old_original',
            seq: 20,
            mine: true,
            senderUserId: 1
          }),
          ...arrived.messages
        ]
      }
      state.update(loaded)
      return loaded
    })
    await click('chat-attention-retry')
    await until(() => owner.attention('cnv_1')!.complete)
    await measureBodies({ msg_new_reply: 900 })
    expect(state.loads).equals(1)
    expect(
      node.querySelector('[data-testid="chat-message-body-msg_old_original"]')
    ).equals(null)
    expect(
      node.querySelector('[data-testid="chat-attention-count"]')?.textContent
    ).equals('1')
    expect(node.querySelector('[data-testid="chat-attention-retry"]')).equals(
      null
    )
  })
})
