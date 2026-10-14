import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Animated } from 'react-native'

import { MAX_BODY } from '../../common/chatContent'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { ChatOverlayHost } from './ChatOverlayHost'
import {
  measureChatTestViewport,
  member,
  message,
  view
} from './chatViews.test.helpers'
import { setComposerSelection } from './chatWebInteractions'
import { setComposerSelection as setNativeComposerSelection } from './chatWebInteractions.native'
import {
  ChatDraftOwner,
  emptyChatDraft,
  newChatWorkspaceState
} from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import { MentionPicker } from './MentionPicker'
import type { ChatScreenEngine } from './screenEngine'

let root: Root | undefined
let host: HTMLElement | undefined
let restoreViewport: (() => void) | undefined
let restoreMotion: (() => void) | undefined
let restoreAnimation: (() => void) | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  restoreViewport?.()
  restoreViewport = undefined
  restoreMotion?.()
  restoreMotion = undefined
  restoreAnimation?.()
  restoreAnimation = undefined
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
    root!.render(
      <ThemeProvider>
        <ChatOverlayHost>{element}</ChatOverlayHost>
      </ThemeProvider>
    )
    await wait()
  })
  return host!
}
function labelled(label: string): HTMLElement {
  return host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
}
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
async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await wait()
  })
}
async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  next: string
): Promise<void> {
  const prototype =
    field instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, next)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
    await wait()
  })
}
function fixture(): {
  engine: ChatScreenEngine
  calls: unknown[][]
  readonly shown: ConversationView
  update: (next: ConversationView) => void
  setFail: (value: boolean) => void
  setSend: (work: Promise<undefined>) => void
} {
  let shown = view({
    members: [
      member(1, 'Trea Turner'),
      member(2, 'Aaron Judge', { label: 'Coach' }),
      member(3, 'Aaron Judge', { label: 'Guardian' })
    ]
  })
  const listeners = new Set<ChatEngineListener>()
  const calls: unknown[][] = []
  let fail = false
  let sendWork: Promise<undefined> | undefined
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
    sendText: async (...args) => {
      calls.push(['text', ...args])
      if (fail) throw new Error('Unavailable')
      await sendWork
      return undefined
    },
    attach: async (...args) => {
      calls.push(['attach', ...args])
      return undefined
    },
    edit: async (...args) => {
      calls.push(['edit', ...args])
    },
    react: async () => {},
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
    calls,
    get shown(): ConversationView {
      return shown
    },
    update(next: ConversationView): void {
      shown = next
      for (const listener of listeners)
        listener({ type: 'conversation', conversationId: 'cnv_1' })
    },
    setFail(value: boolean): void {
      fail = value
    },
    setSend(work: Promise<undefined>): void {
      sendWork = work
    }
  }
}
const files = {
  PICK_SOURCES: [],
  pickFiles: async () => [],
  bytesUri: async () => 'blob:fixture',
  releaseUri: async () => {},
  saveFile: async () => {}
}
const screen = (
  engine: ChatScreenEngine,
  over: Partial<React.ComponentProps<typeof ConversationScreen>> = {}
): React.ReactElement => (
  <ConversationScreen
    engine={engine}
    conversationId="cnv_1"
    userId={1}
    onMembers={() => {}}
    files={files}
    {...over}
  />
)
async function choose(id: number): Promise<void> {
  await click(
    host!.querySelector<HTMLElement>(
      `[data-testid="chat-mention-member-${id}"]`
    )!
  )
}

const token = { userId: 2, start: 0, end: 12, label: '@Aaron Judge' }
describe('current-member mention picker', function () {
  for (const width of [390, 1440])
    it(`anchors the glass title and Cancel above Search outside scroll flow (${width})`, async function () {
      restoreViewport = measureChatTestViewport({ width, height: 844 })
      let closed = 0
      const node = await render(
        <MentionPicker
          members={[member(2, 'Aaron Judge')]}
          onSelect={() => {}}
          onClose={() => {
            closed++
          }}
        />
      )
      const title = [...node.querySelectorAll<HTMLElement>('*')].find(
        element =>
          element.childElementCount === 0 &&
          element.textContent === 'Mention a member'
      )!
      const cancel = button('Cancel')
      let header = title.parentElement!
      while (!header.contains(cancel)) header = header.parentElement!
      const slot = header.parentElement!
      const transition = node.querySelector<HTMLElement>(
        '[data-testid="chat-picker-transition"]'
      )!
      const scroll = node.querySelector<HTMLElement>(
        '[data-testid="chat-picker-content"]'
      )!
      expect(getComputedStyle(slot).position).equals('absolute')
      expect(getComputedStyle(slot).top).equals('0px')
      expect(getComputedStyle(slot).left).equals('0px')
      expect(getComputedStyle(slot).right).equals('0px')
      expect(slot.parentElement).equals(transition)
      expect(scroll.parentElement).equals(transition)
      expect(slot.contains(title) && slot.contains(cancel)).equals(true)
      const search = labelled('Search members')
      expect(scroll.contains(search)).equals(true)
      expect(document.activeElement).equals(search)
      const measured = header as HTMLElement & {
        __reactLayoutHandler: (event: unknown) => void
      }
      for (const height of [76, 128]) {
        await act(async () => {
          measured.__reactLayoutHandler({
            nativeEvent: { layout: { x: 0, y: 0, width, height } }
          })
        })
        expect(getComputedStyle(scroll.firstElementChild!).paddingTop).equals(
          `${height + tsBallpark.rem(1)}px`
        )
        expect(getComputedStyle(slot).top).equals('0px')
        expect(document.activeElement).equals(search)
      }
      await click(cancel)
      expect(closed).equals(1)
    })

  for (const reduced of [false, true])
    it(`enters the shared full-height scene from below with a reduced-motion fade (${reduced})`, async function () {
      const saved = Object.getOwnPropertyDescriptor(
        AccessibilityInfo,
        'isReduceMotionEnabled'
      )!
      Object.defineProperty(AccessibilityInfo, 'isReduceMotionEnabled', {
        configurable: true,
        value: async () => reduced
      })
      restoreMotion = () =>
        Object.defineProperty(AccessibilityInfo, 'isReduceMotionEnabled', saved)
      const originalTiming = Object.getOwnPropertyDescriptor(
        Animated,
        'timing'
      )!
      const runs: Array<{
        value: Animated.Value
        duration: number | undefined
        stopped: boolean
      }> = []
      const timing: typeof Animated.timing = (value, options) => {
        const run = {
          value: value as Animated.Value,
          duration: options.duration,
          stopped: false
        }
        runs.push(run)
        return {
          start: () => {},
          stop: () => {
            run.stopped = true
          },
          reset: () => {}
        }
      }
      Object.defineProperty(Animated, 'timing', {
        configurable: true,
        writable: true,
        value: timing
      })
      restoreAnimation = () =>
        Object.defineProperty(Animated, 'timing', originalTiming)
      const node = await render(
        <MentionPicker
          members={[member(2, 'Aaron Judge')]}
          onSelect={() => {}}
          onClose={() => {}}
        />
      )
      const scene = node.querySelector<HTMLElement>(
        '[data-testid="chat-picker-scene"]'
      )!
      const transition = node.querySelector<HTMLElement>(
        '[data-testid="chat-picker-transition"]'
      )!
      expect(getComputedStyle(scene).position).equals('absolute')
      expect(
        node.querySelector('[data-testid="chat-picker-content"]')
      ).not.equals(null)
      const row = node.querySelector<HTMLElement>(
        '[data-testid="chat-mention-member-2"]'
      )!
      expect(parseFloat(getComputedStyle(row).minHeight)).at.least(48)
      expect(node.textContent)
        .contains('Mention a member')
        .and.contains('Cancel')
      if (reduced) expect(transition.style.transform).equals('')
      else
        expect(transition.style.transform)
          .contains('translateY(')
          .and.not.equals('translateY(0px)')
      expect(runs.at(-1)!.duration).equals(reduced ? 80 : 200)
      await act(async () => {
        runs.at(-1)!.value.setValue(1)
      })
      expect(getComputedStyle(transition).opacity).equals('1')
      if (!reduced) expect(transition.style.transform).equals('translateY(0px)')
      await render(<div />)
      expect(
        runs.every(run => run.stopped),
        'Scene teardown stops its animations'
      ).equals(true)
    })

  it('shows searchable rows with avatars and role detail; keyboard arrows skip the search clear control', async function () {
    const picked: number[] = []
    await render(
      <MentionPicker
        members={[
          member(3, 'Aaron Judge', { label: 'Guardian' }),
          member(2, 'Aaron Judge', { label: 'Coach' })
        ]}
        onSelect={id => picked.push(id)}
        onClose={() => {}}
      />
    )
    const search = labelled('Search members') as HTMLInputElement
    expect(document.activeElement).equals(search)
    expect(host!.querySelectorAll('[data-testid="chat-avatar"]')).length(2)
    expect(host!.textContent).contains('Coach').and.contains('Guardian')
    const cancelKey = button('Cancel')
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    expect(document.activeElement, 'Shift Tab reaches the scene Cancel').equals(
      cancelKey
    )
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true
      })
    )
    expect(document.activeElement, 'Tab returns to the search field').equals(
      search
    )
    const home = new window.KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
      cancelable: true
    })
    document.dispatchEvent(home)
    expect(
      home.defaultPrevented,
      'Home retains ordinary search editing'
    ).equals(false)
    await type(search, 'Aaron')
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    )
    expect(document.activeElement?.getAttribute('data-testid')).equals(
      'chat-mention-member-2'
    )
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    )
    expect(document.activeElement?.getAttribute('data-testid')).equals(
      'chat-mention-member-3'
    )
    await choose(3)
    expect(picked).deep.equals([3])
    await type(search, 'not a member')
    expect(host!.textContent).contains('No members found.')
    const cancel = [
      ...host!.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Cancel')!
    const red = document.createElement('span')
    red.style.color = tsBallpark.dangerColor
    expect(getComputedStyle(cancel.firstElementChild!).color).equals(
      red.style.color
    )
  })

  it('returns the exact stable ID and caret to the composer without changing bare @ on Cancel', async function () {
    const state = fixture()
    await render(screen(state.engine))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@')
    expect(labelled('Search members')).not.equals(null)
    await click(button('Cancel'))
    expect(input.value).equals('@')
    expect(document.activeElement).equals(input)
    await type(input, '')
    await type(input, '@')
    await choose(3)
    expect(input.value).equals('@Aaron Judge ')
    expect(document.activeElement).equals(input)
    expect(input.selectionStart).equals(13)
    await click(button('Send'))
    expect(state.calls).deep.equals([
      ['text', 'cnv_1', '@Aaron Judge', { mentions: [3] }]
    ])
  })

  it('preserves selected text after a rename, removes linked status after label edits or membership removal, and never infers IDs from pasted labels', async function () {
    const state = fixture()
    await render(screen(state.engine))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@Aaron Judge')
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Aaron Judge',
      {}
    ])
    await type(input, '@')
    await choose(2)
    await act(async () => {
      state.update({
        ...state.shown,
        members: [member(1, 'Trea Turner'), member(2, 'Renamed Member')]
      })
      await wait()
    })
    expect(input.value).equals('@Aaron Judge ')
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Aaron Judge',
      { mentions: [2] }
    ])
    await type(input, '@')
    await choose(2)
    await act(async () => {
      state.update({ ...state.shown, members: [member(1, 'Trea Turner')] })
      await wait()
    })
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Renamed Member',
      {}
    ])
  })

  it('disables selection/send when composer permissions change and rejects a departed row before insertion', async function () {
    const state = fixture()
    await render(screen(state.engine))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@')
    await act(async () => {
      state.update({ ...state.shown, composer: 'locked' })
      await wait()
    })
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
    expect(input.value).equals('@')
    expect(input.readOnly).equals(true)
    await click(button('Send'))
    expect(state.calls).deep.equals([])
  })

  it('leaves text and token ownership unchanged when a selection exceeds the existing body limit', async function () {
    const state = fixture()
    const draft = { ...emptyChatDraft(), text: 'x'.repeat(MAX_BODY - 2) + ' ' }
    await render(screen(state.engine, { draft }))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, draft.text + '@')
    await choose(2)
    expect(host!.textContent).contains(
      'This mention would make the message too long.'
    )
    expect(input.value).equals(draft.text + '@')
    await click(button('Cancel'))
    expect(input.value).equals(draft.text + '@')
  })
})

describe('mention send/edit and draft compatibility', function () {
  it('passes existing encrypted IDs for file replies and edits while leaving the payload shape unchanged', async function () {
    for (const editing of [false, true]) {
      const state = fixture()
      const original = message({
        id: 'msg_original',
        mine: true,
        body: '@Aaron Judge',
        mentions: [2]
      })
      const draft = {
        ...emptyChatDraft(),
        text: '@Aaron Judge ',
        mentionTokens: [token],
        ...(editing
          ? { editing: original }
          : {
              replyTo: original,
              picked: [
                {
                  bytes: new Uint8Array([1]),
                  fileName: 'notes.pdf',
                  contentType: 'application/pdf'
                }
              ]
            })
      }
      await render(
        <React.Fragment key={String(editing)}>
          {screen(state.engine, { draft })}
        </React.Fragment>
      )
      await click(button('Send'))
      if (editing)
        expect(state.calls[0]).deep.equals([
          'edit',
          'cnv_1',
          'msg_original',
          '@Aaron Judge',
          [2]
        ])
      else
        expect(state.calls[0]).deep.equals([
          'attach',
          'cnv_1',
          draft.picked,
          '@Aaron Judge',
          { quoteId: 'msg_original', mentions: [2] }
        ])
    }
  })

  it('retains failed submissions and newer mention state written while an earlier send is in flight', async function () {
    const state = fixture()
    state.setFail(true)
    await render(screen(state.engine))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@')
    await choose(2)
    await click(button('Send'))
    expect(host!.textContent).contains('That did not send. Try again.')
    expect(input.value).equals('@Aaron Judge ')
    state.setFail(false)
    let complete!: (value: undefined) => void
    state.setSend(
      new Promise<undefined>(resolve => {
        complete = resolve
      })
    )
    await click(button('Send'))
    await type(input, '')
    await type(input, '@')
    await choose(3)
    await act(async () => {
      complete(undefined)
      await wait()
    })
    expect(input.value).equals('@Aaron Judge ')
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Aaron Judge',
      { mentions: [3] }
    ])
  })

  it('preserves local ranges across a keyed return without focusing a restored draft', async function () {
    const state = fixture()
    const workspace = newChatWorkspaceState()
    const owner = new ChatDraftOwner(workspace)
    await render(screen(state.engine, { draftOwner: owner }))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@')
    await choose(2)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(owner.draft('cnv_1').mentionTokens).deep.equals([token])
    await render(
      screen(state.engine, {
        draftOwner: owner,
        draft: owner.draft('cnv_1'),
        paneHeader: true
      })
    )
    const restored = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    expect(restored.value).equals('@Aaron Judge ')
    expect(document.activeElement).not.equals(restored)
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Aaron Judge',
      { mentions: [2] }
    ])
  })

  it('applies platform caret offsets only to an input/native selection target', function () {
    const input = document.createElement('textarea')
    input.value = '🙂 @Aaron Judge '
    setComposerSelection(input, { start: 15, end: 15 })
    expect(input.selectionStart).equals(15)
    expect(() => {
      setComposerSelection(undefined, { start: 0, end: 0 })
    }).not.throws()
    const values: unknown[] = []
    setNativeComposerSelection(
      { setNativeProps: (props: unknown) => values.push(props) },
      { start: 3, end: 3 }
    )
    setNativeComposerSelection(undefined, { start: 0, end: 0 })
    expect(values).deep.equals([{ selection: { start: 3, end: 3 } }])
  })
})
