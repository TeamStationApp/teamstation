import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Dimensions,
  Platform
} from 'react-native'

import { MAX_BODY } from '../../common/chatContent'
import { userIdOfGumbo } from '../../common/userId'
import { AppHeader } from '../components/AppHeader'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
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
let restoreDimensions: (() => void) | undefined
let restoreBack: (() => void) | undefined
let restorePlatform: (() => void) | undefined
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
  restoreDimensions?.()
  restoreDimensions = undefined
  restorePlatform?.()
  restorePlatform = undefined
  restoreBack?.()
  restoreBack = undefined
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
      member(userIdOfGumbo(1), 'Trea Turner'),
      member(userIdOfGumbo(2), 'Aaron Judge', { label: 'Coach' }),
      member(userIdOfGumbo(3), 'Aaron Judge', { label: 'Guardian' })
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
    userId={userIdOfGumbo(1)}
    onMembers={() => {}}
    files={files}
    {...over}
  />
)
async function choose(id: string): Promise<void> {
  await click(
    host!.querySelector<HTMLElement>(
      `[data-testid="chat-mention-member-${id}"]`
    )!
  )
}

function nativePicker(platform: 'ios' | 'android' = 'ios'): {
  finish: () => Promise<void>
  back: () => void
  late: () => void
} {
  const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform })
  restorePlatform = () => Object.defineProperty(Platform, 'OS', saved)
  const timing = Object.getOwnPropertyDescriptor(Animated, 'timing')!
  const animations: Array<{
    value: Animated.Value
    end?: (result: { finished: boolean }) => void
  }> = []
  Object.defineProperty(Animated, 'timing', {
    configurable: true,
    value: (value: Animated.Value) => {
      const run: (typeof animations)[number] = { value }
      animations.push(run)
      return {
        start: (end: (result: { finished: boolean }) => void) => {
          run.end = end
        },
        stop: () => {},
        reset: () => {}
      }
    }
  })
  restoreAnimation = () => Object.defineProperty(Animated, 'timing', timing)
  let onBack: (() => boolean | null | undefined) | undefined
  const back = Object.getOwnPropertyDescriptor(BackHandler, 'addEventListener')!
  Object.defineProperty(BackHandler, 'addEventListener', {
    configurable: true,
    value: (_name: string, accept: () => boolean | null | undefined) => {
      onBack = accept
      return {
        remove: () => {
          onBack = undefined
        }
      }
    }
  })
  restoreBack = () =>
    Object.defineProperty(BackHandler, 'addEventListener', back)
  let completed: (typeof animations)[number] | undefined
  return {
    finish: async () => {
      completed = animations.at(-1)!
      await act(async () => {
        completed!.value.setValue(0)
        completed!.end?.({ finished: true })
        await wait()
      })
    },
    back: () => {
      onBack?.()
    },
    late: () => {
      completed?.end?.({ finished: true })
    }
  }
}

const token = {
  userId: userIdOfGumbo(2),
  start: 0,
  end: 12,
  label: '@Aaron Judge'
}
describe('current-member mention picker', function () {
  it('releases the native modal and competing Search before selecting after exit', async function () {
    const native = nativePicker()
    const calls: Array<{ id: string; hidden: boolean; search: boolean }> = []
    function Scene(): React.ReactElement {
      const [open, setOpen] = useState(true)
      return (
        <>
          <input aria-label="Native composer" />
          {open && (
            <MentionPicker
              members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
              onClose={() => {
                setOpen(false)
              }}
              onSelect={id => {
                const composer = labelled('Native composer')
                const hidden = composer.closest('[aria-hidden="true"]') != null
                const search =
                  host!.querySelector('[aria-label="Search members"]') != null
                calls.push({ id, hidden, search })
                if (!hidden && !search) composer.focus()
                setOpen(false)
              }}
            />
          )}
        </>
      )
    }
    await render(<Scene />)
    expect(document.activeElement).equals(labelled('Search members'))
    await choose(userIdOfGumbo(2))
    expect(
      calls,
      'Native selection must wait for Search unmount and the modal exit'
    ).deep.equals([])
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
    expect(labelled('Native composer').closest('[aria-hidden="true"]')).equals(
      null
    )
    const scene = host!.querySelector<HTMLElement>(
      '[data-testid="chat-picker-scene"]'
    )!
    expect(
      getComputedStyle(scene).pointerEvents,
      'Closing scene must shield the released chat'
    ).equals('auto')
    expect(
      getComputedStyle(scene.firstElementChild!).pointerEvents,
      'Closing controls must not receive another touch'
    ).equals('none')
    expect(scene.getAttribute('aria-hidden')).equals('true')
    await native.finish()
    expect(calls).deep.equals([
      { id: userIdOfGumbo(2), hidden: false, search: false }
    ])
    expect(document.activeElement).equals(labelled('Native composer'))
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
  })
  for (const platform of ['ios', 'android'] as const) {
    for (const method of ['Cancel', 'Back', 'Escape'] as const)
      it(`releases Search before ${platform} ${method} hands focus back once`, async () => {
        const native = nativePicker(platform)
        const calls: boolean[] = []
        function Scene(): React.ReactElement {
          const [open, setOpen] = useState(true)
          return (
            <>
              <input aria-label="Native composer" defaultValue="@" />
              {open && (
                <MentionPicker
                  members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
                  onSelect={() => {
                    throw Error('Cancelled selection')
                  }}
                  onClose={() => {
                    const composer = labelled('Native composer')
                    calls.push(
                      composer.closest('[aria-hidden="true"]') == null &&
                        host!.querySelector('[aria-label="Search members"]') ==
                          null
                    )
                    composer.focus()
                    setOpen(false)
                  }}
                />
              )}
            </>
          )
        }
        await render(<Scene />)
        await act(async () => {
          if (method === 'Cancel') button('Cancel').click()
          else if (method === 'Back') native.back()
          else
            labelled('Search members').dispatchEvent(
              new window.KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true
              })
            )
          await wait()
        })
        expect(calls).deep.equals([])
        expect(host!.querySelector('[aria-label="Search members"]')).equals(
          null
        )
        await native.finish()
        await act(async () => {
          native.late()
        })
        expect(calls).deep.equals([true])
        expect((labelled('Native composer') as HTMLInputElement).value).equals(
          '@'
        )
        expect(document.activeElement).equals(labelled('Native composer'))
      })

    it(`commits ${platform} selected ID/caret once and preserves reply/files`, async () => {
      const native = nativePicker(platform)
      const state = fixture()
      const owner = new ChatDraftOwner(newChatWorkspaceState())
      const draft = {
        ...emptyChatDraft(),
        replyTo: message({ id: 'msg_original' }),
        picked: [
          {
            bytes: new Uint8Array([1]),
            fileName: 'notes.pdf',
            contentType: 'application/pdf'
          }
        ]
      }
      await render(screen(state.engine, { draft, draftOwner: owner }))
      const input = host!.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer"]'
      )!
      await type(input, '@')
      const selected = host!.querySelector<HTMLElement>(
        `[data-testid="chat-mention-member-${userIdOfGumbo(3)}"]`
      )!
      await act(async () => {
        selected.click()
        selected.click()
        await wait()
      })
      expect(input.value).equals('@')
      await native.finish()
      await act(async () => {
        native.late()
        await wait()
      })
      expect(input.value).equals('@Aaron Judge ')
      expect(input.selectionStart).equals(13)
      expect(document.activeElement).equals(input)
      expect(owner.draft('cnv_1').replyTo?.id).equals('msg_original')
      expect(owner.draft('cnv_1').picked).deep.equals(draft.picked)
      expect(owner.draft('cnv_1').mentionTokens?.[0].userId).equals(
        userIdOfGumbo(3)
      )
      expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
      expect(state.calls).deep.equals([])
    })
  }

  for (const change of [
    'unmount',
    'background',
    'permission',
    'member loss'
  ] as const)
    it(`rejects pending native selection after ${change}`, async () => {
      const native = nativePicker()
      const state = fixture()
      await render(screen(state.engine))
      const input = host!.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer"]'
      )!
      await type(input, '@')
      await choose(userIdOfGumbo(2))
      if (change === 'unmount') await render(<div />)
      else if (change === 'background')
        await render(screen(state.engine, { active: false }))
      else
        await act(async () => {
          state.update({
            ...state.shown,
            ...(change === 'permission'
              ? { composer: 'locked' as const }
              : { members: [member(userIdOfGumbo(1), 'Trea Turner')] })
          })
          await wait()
        })
      await native.finish()
      expect(input.value).equals('@')
      expect(document.activeElement).not.equals(input)
      expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
      expect(state.calls).deep.equals([])
    })

  it('lets native Back replace a pending selection and ignores rapid rows/late completions', async () => {
    const native = nativePicker()
    const state = fixture()
    await render(screen(state.engine))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, '@')
    await choose(userIdOfGumbo(2))
    await act(async () => {
      native.back()
      native.back()
      await wait()
    })
    await native.finish()
    await act(async () => {
      native.late()
    })
    expect(input.value).equals('@')
    expect(document.activeElement).equals(input)
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
  })

  it('reopens native Search with its query/error after a rejected long insertion and allows retry', async () => {
    const native = nativePicker()
    const state = fixture()
    const draft = { ...emptyChatDraft(), text: 'x'.repeat(MAX_BODY - 2) + ' ' }
    await render(screen(state.engine, { draft }))
    const input = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-composer"]'
    )!
    await type(input, draft.text + '@')
    await type(labelled('Search members') as HTMLInputElement, 'Aaron')
    await choose(userIdOfGumbo(2))
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
    await native.finish()
    const search = labelled('Search members') as HTMLInputElement
    expect(search.value).equals('Aaron')
    expect(document.activeElement).equals(search)
    expect(host!.textContent).contains(
      'This mention would make the message too long.'
    )
    expect(input.value).equals(draft.text + '@')
    await type(input, '')
    await type(input, '@')
    await choose(userIdOfGumbo(3))
    await native.finish()
    expect(input.value).equals('@Aaron Judge ')
    expect(document.activeElement).equals(input)
    expect(host!.querySelector('[aria-label="Search members"]')).equals(null)
  })

  it('keeps web selection and Cancel synchronous in their trusted activation', async () => {
    let inPress = false
    const calls: boolean[] = []
    await render(
      <MentionPicker
        members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
        onSelect={() => {
          calls.push(inPress)
        }}
        onClose={() => {
          calls.push(inPress)
        }}
      />
    )
    await act(async () => {
      inPress = true
      host!
        .querySelector<HTMLElement>(
          `[data-testid="chat-mention-member-${userIdOfGumbo(2)}"]`
        )!
        .click()
      button('Cancel').click()
      inPress = false
    })
    expect(calls).deep.equals([true, true])
  })
  it('finishes a native handoff after StrictMode effect replay without a late callback after unmount', async () => {
    const native = nativePicker()
    let selections = 0
    await render(
      <React.StrictMode>
        <MentionPicker
          members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
          onSelect={() => {
            selections += 1
          }}
          onClose={() => {}}
        />
      </React.StrictMode>
    )
    await choose(userIdOfGumbo(2))
    await native.finish()
    expect(selections).equals(1)
    await render(<div />)
    await act(async () => {
      native.late()
    })
    expect(selections).equals(1)
  })
  for (const fontScale of [1, 1.5])
    it(`reserves the full Cancel label and target without shrinking at font scale ${fontScale}`, async function () {
      const saved = Object.getOwnPropertyDescriptor(Dimensions, 'get')!
      const get = Dimensions.get.bind(Dimensions)
      Object.defineProperty(Dimensions, 'get', {
        configurable: true,
        value: (key: Parameters<typeof Dimensions.get>[0]) => ({
          ...get(key),
          fontScale
        })
      })
      restoreDimensions = () => Object.defineProperty(Dimensions, 'get', saved)
      await render(
        <MentionPicker members={[]} onSelect={() => {}} onClose={() => {}} />
      )
      const cancel = button('Cancel')
      const style = getComputedStyle(cancel)
      expect(style.minWidth).equals(`${96 * fontScale}px`)
      expect(style.minHeight).equals('48px')
      expect(style.flexShrink).equals('0')
      expect(getComputedStyle(cancel.parentElement!).minWidth).equals(
        `${96 * fontScale}px`
      )
      const label = [...cancel.querySelectorAll<HTMLElement>('*')].find(
        node => node.childElementCount === 0 && node.textContent === 'Cancel'
      )!
      expect(getComputedStyle(label).fontSize).equals('14px')
      expect(getComputedStyle(label).color).equals('rgb(186, 26, 26)')
    })

  it('retains the shared header trailing-column default without a scene opt-in', async function () {
    await render(
      <AppHeader
        title="A screen"
        nav={<Button label="Cancel" kind="text" onPress={() => {}} />}
      />
    )
    const cancel = button('Cancel')
    expect(getComputedStyle(cancel.parentElement!).minWidth).equals('48px')
    expect(getComputedStyle(cancel).minWidth).equals('0px')
  })

  for (const width of [390, 1440])
    it(`anchors the glass title and Cancel above Search outside scroll flow (${width})`, async function () {
      restoreViewport = measureChatTestViewport({ width, height: 844 })
      let closed = 0
      const node = await render(
        <MentionPicker
          members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
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
          members={[member(userIdOfGumbo(2), 'Aaron Judge')]}
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
        `[data-testid="chat-mention-member-${userIdOfGumbo(2)}"]`
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
    const picked: string[] = []
    await render(
      <MentionPicker
        members={[
          member(userIdOfGumbo(3), 'Aaron Judge', { label: 'Guardian' }),
          member(userIdOfGumbo(2), 'Aaron Judge', { label: 'Coach' })
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
      `chat-mention-member-${userIdOfGumbo(2)}`
    )
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    )
    expect(document.activeElement?.getAttribute('data-testid')).equals(
      `chat-mention-member-${userIdOfGumbo(3)}`
    )
    await choose(userIdOfGumbo(3))
    expect(picked).deep.equals([userIdOfGumbo(3)])
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
    await choose(userIdOfGumbo(3))
    expect(input.value).equals('@Aaron Judge ')
    expect(document.activeElement).equals(input)
    expect(input.selectionStart).equals(13)
    await click(button('Send'))
    expect(state.calls).deep.equals([
      ['text', 'cnv_1', '@Aaron Judge', { mentions: [userIdOfGumbo(3)] }]
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
    await choose(userIdOfGumbo(2))
    await act(async () => {
      state.update({
        ...state.shown,
        members: [
          member(userIdOfGumbo(1), 'Trea Turner'),
          member(userIdOfGumbo(2), 'Renamed Member')
        ]
      })
      await wait()
    })
    expect(input.value).equals('@Aaron Judge ')
    await click(button('Send'))
    expect(state.calls.at(-1)).deep.equals([
      'text',
      'cnv_1',
      '@Aaron Judge',
      { mentions: [userIdOfGumbo(2)] }
    ])
    await type(input, '@')
    await choose(userIdOfGumbo(2))
    await act(async () => {
      state.update({
        ...state.shown,
        members: [member(userIdOfGumbo(1), 'Trea Turner')]
      })
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
    await choose(userIdOfGumbo(2))
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
        mentions: [userIdOfGumbo(2)]
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
          [userIdOfGumbo(2)]
        ])
      else
        expect(state.calls[0]).deep.equals([
          'attach',
          'cnv_1',
          draft.picked,
          '@Aaron Judge',
          { quoteId: 'msg_original', mentions: [userIdOfGumbo(2)] }
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
    await choose(userIdOfGumbo(2))
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
    await choose(userIdOfGumbo(3))
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
      { mentions: [userIdOfGumbo(3)] }
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
    await choose(userIdOfGumbo(2))
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
      { mentions: [userIdOfGumbo(2)] }
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

describe('mention search controlled input commit', function () {
  function insert(field: HTMLInputElement, text: string): void {
    const start = field.selectionStart!
    const end = field.selectionEnd!
    const next = field.value.slice(0, start) + text + field.value.slice(end)
    // Use the actual DOM value setter, without replacing it or calling React props.
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(field, next)
    field.setSelectionRange(start + text.length, start + text.length)
    field.dispatchEvent(
      new window.InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      })
    )
  }
  function rapidSearch(field: HTMLInputElement): void {
    const original = field
    let expected = ''
    for (const character of 'Bobby') {
      expected += character
      insert(field, character)
      expect(
        field.value,
        'Search retains each ordinary input immediately'
      ).equals(expected)
      expect(labelled('Search members'), 'Same connected Search node').equals(
        original
      )
      expect(field.isConnected).equals(true)
      expect(document.activeElement).equals(original)
      expect(field.selectionStart).equals(expected.length)
      expect(field.selectionEnd).equals(expected.length)
    }
  }
  it('retains unwaited per-key query, caret and exact duplicate filtering through the real host and chooser', async function () {
    const selected: string[] = []
    await render(
      <MentionPicker
        members={[
          member(userIdOfGumbo(2), 'Bobby Witt Jr.', { label: 'Coach' }),
          member(userIdOfGumbo(3), 'Bobby Witt Jr.', { label: 'Guardian' }),
          member(userIdOfGumbo(4), 'Aaron Judge', { label: 'Player' })
        ]}
        onSelect={id => selected.push(id)}
        onClose={() => {}}
      />
    )
    const search = labelled('Search members') as HTMLInputElement
    // Intentionally outside act and without waits/flushSync between native DOM
    // events: act-flushing each character would wait for passive publication.
    rapidSearch(search)
    await act(async () => {
      await wait()
    })
    expect(search.value).equals('Bobby')
    expect(
      [...host!.querySelectorAll('[data-testid^="chat-mention-member-"]')].map(
        node => node.getAttribute('data-testid')
      )
    ).deep.equals([
      `chat-mention-member-${userIdOfGumbo(2)}`,
      `chat-mention-member-${userIdOfGumbo(3)}`
    ])
    search.setSelectionRange(2, 2)
    insert(search, 'x')
    expect(search.value).equals('Boxbby')
    expect(search.selectionStart).equals(3)
    expect(search.selectionEnd).equals(3)
    await act(async () => {
      await wait()
    })
    expect(
      host!.querySelectorAll('[data-testid^="chat-mention-member-"]')
    ).length(0)
    expect(host!.textContent).contains('No members found.')
    search.setSelectionRange(2, 3)
    insert(search, '')
    expect(search.value).equals('Bobby')
    expect(search.selectionStart).equals(2)
    expect(document.activeElement).equals(search)
    await act(async () => {
      await wait()
    })
    await choose(userIdOfGumbo(3))
    expect(selected).deep.equals([userIdOfGumbo(3)])
  })
  it('keeps the same unwaited controlled editing contract without the overlay bridge', async function () {
    function DirectField(): React.ReactElement {
      const [value, setValue] = useState('')
      return (
        <TextField
          label="Search members"
          value={value}
          onChangeText={setValue}
          autoFocus
        />
      )
    }
    await render(<DirectField />)
    const search = labelled('Search members') as HTMLInputElement
    rapidSearch(search)
    await act(async () => {
      await wait()
    })
    expect(search.value).equals('Bobby')
    expect(document.activeElement).equals(search)
  })
})
