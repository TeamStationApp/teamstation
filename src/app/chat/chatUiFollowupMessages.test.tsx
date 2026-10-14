import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

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
import {
  bindMessageHover,
  bindMessageTooltips,
  bindUserScroll,
  isFinePointer,
  messageTooltipProps,
  watchMessageAnchor
} from './chatWebInteractions'
import type { ChatDraft } from './chatWorkspaceModel'
import {
  type ConversationFiles,
  ConversationScreen
} from './ConversationScreen'
import type { MessageView, QuoteView } from './engine/apply'
import type { ConversationView } from './engine/engine'
import type { ChatEngineListener } from './engine/store'
import { MessageActions } from './MessageActions'
import { MessageBubble } from './MessageBubble'
import { MessageMenu, type MessageMenuProps } from './MessageMenu'
import { PinnedMessages } from './PinnedMessages'
import { ReplyQuote } from './ReplyQuote'
import type { ChatScreenEngine } from './screenEngine'

const { InteractionManager } = require('react-native-web') as {
  InteractionManager: { runAfterInteractions: (task: () => void) => unknown }
}

let ownsTimeouts = false

async function resetTimeouts(): Promise<void> {
  if (!ownsTimeouts) return
  // Reset would otherwise discard RNW's queued idle callback while its shared
  // InteractionManager retains the handle and stops future list batching.
  await act(async () => {
    let completed = false
    InteractionManager.runAfterInteractions(() => {
      completed = true
    })
    mock.timers.tick(1)
    await Promise.resolve()
    expect(
      completed,
      'Owned interaction work drains before timer reset'
    ).equals(true)
  })
  mock.timers.reset()
  ownsTimeouts = false
}

let root: Root | undefined
let restoreViewport: (() => void) | undefined
const stops: Array<() => void> = []
const originals = new Map<string, PropertyDescriptor | undefined>(
  ['matchMedia', 'vibrate', 'clipboard'].map(key => [
    key,
    Object.getOwnPropertyDescriptor(
      key === 'matchMedia' ? globalThis : navigator,
      key
    )
  ])
)

afterEach(async function () {
  for (const stop of stops.splice(0)) stop()
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  restoreViewport?.()
  restoreViewport = undefined
  await resetTimeouts()
  for (const [key, original] of originals) {
    const target = key === 'matchMedia' ? globalThis : navigator
    if (original != null) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  }
})

const wait = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  restoreViewport ??= measureChatTestViewport()
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

function labelled(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[aria-label]')
  ].find(node => node.getAttribute('aria-label') === label)
  expect(found, label).not.equals(undefined)
  return found!
}

function button(label: string, within: ParentNode = document): HTMLElement {
  const found = [
    ...within.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label ||
      (node.getAttribute('aria-label') == null &&
        node.textContent?.endsWith(label) === true)
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

function pointer(fine: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: fine })
  })
}

const safeMessage = (over: Partial<MessageView> = {}): MessageView =>
  message({ senderName: 'Shohei Ohtani', ...over })
const files: ConversationFiles = {
  PICK_SOURCES: ['files'],
  pickFiles: async () => [],
  bytesUri: async () => 'blob:fixture',
  releaseUri: async () => {},
  saveFile: async () => {}
}

const menuProps = (over: Partial<MessageMenuProps> = {}): MessageMenuProps => ({
  message: safeMessage(),
  actions: ['reply', 'react', 'copy', 'pin'],
  onReply: () => {},
  onReact: () => {},
  onMoreEmoji: () => {},
  onCopy: async () => {},
  onPin: () => {},
  onDelete: () => {},
  onClose: () => {},
  ...over
})

describe('chat follow-up desktop message controls', function () {
  it('adds tooltip labels to named controls and removes them on cleanup', function () {
    const controls = document.createElement('div')
    const control = document.createElement('button')
    control.setAttribute('role', 'button')
    control.setAttribute('aria-label', 'Reply')
    controls.append(control)
    const stop = bindMessageTooltips(controls)
    expect(control.title).equals('Reply')
    stop()
    expect(control.hasAttribute('title')).equals(false)
    expect(() => {
      bindMessageTooltips(undefined)()
    }).not.throws()
  })

  it('marks reading only for deliberate user scrolling and detaches the reader on cleanup', function () {
    const scroller = document.createElement('div')
    document.body.append(scroller)
    let reads = 0
    const stop = bindUserScroll({ getScrollableNode: () => scroller }, () => {
      reads += 1
    })
    stops.push(stop)
    scroller.scrollTop = 40
    scroller.dispatchEvent(new window.Event('scroll'))
    scroller.focus()
    expect(reads).equals(0)
    scroller.dispatchEvent(new window.Event('wheel'))
    scroller.dispatchEvent(new window.Event('touchmove'))
    expect(reads).equals(2)
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      ' '
    ])
      scroller.dispatchEvent(new window.KeyboardEvent('keydown', { key }))
    expect(reads).equals(9)
    scroller.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' }))
    scroller.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }))
    expect(reads).equals(9)
    stop()
    scroller.dispatchEvent(new window.Event('wheel'))
    scroller.dispatchEvent(new window.Event('touchmove'))
    scroller.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown' })
    )
    expect(reads).equals(9)
    bindUserScroll(undefined, () => {
      reads += 1
    })()
    bindUserScroll(scroller, () => {
      reads += 1
    })()
    expect(reads).equals(9)
  })

  it('gives hover controls exact accessible names and tooltips and invokes each action', async function () {
    const calls: unknown[] = []
    await render(
      <MessageActions
        visible
        reply
        react
        onReply={() => calls.push('reply')}
        onReact={() => calls.push('react')}
        onMore={anchor => calls.push(anchor)}
      />
    )
    expect(
      [...document.querySelectorAll('[role="button"]')].map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals(['Reply', 'Send an emoji', 'More message actions'])
    for (const label of ['Reply', 'Send an emoji', 'More message actions'])
      expect(button(label).getAttribute('title')).equals(label)
    await press('Reply')
    await press('Send an emoji')
    const more = button('More message actions')
    await press('More message actions')
    expect(calls).deep.equals(['reply', 'react', more])
    await render(
      <MessageActions
        visible={false}
        reply={false}
        react={false}
        onReply={() => {}}
        onReact={() => {}}
        onMore={() => {}}
      />
    )
    expect(document.querySelector('[aria-label="Reply"]')).equals(null)
    expect(document.querySelector('[aria-label="Send an emoji"]')).equals(null)
    expect(button('More message actions').parentElement?.style.opacity).equals(
      '0'
    )
  })

  it('keeps a row visible while focus moves between bubble, controls and the menu bridge, then detaches', function () {
    pointer(true)
    expect(isFinePointer()).equals(true)
    expect(messageTooltipProps('Reply')).deep.equals({ title: 'Reply' })
    const row = document.createElement('div')
    const control = document.createElement('button')
    const bridge = document.createElement('button')
    row.append(control, bridge)
    document.body.append(row)
    const visible: boolean[] = []
    const stop = bindMessageHover(row, value => visible.push(value))
    stops.push(stop)
    row.dispatchEvent(new window.Event('pointerenter'))
    control.focus()
    row.dispatchEvent(new window.Event('pointerleave'))
    control.dispatchEvent(
      new window.FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: bridge
      })
    )
    expect(visible.every(value => value)).equals(true)
    control.blur()
    row.dispatchEvent(new window.Event('pointerleave'))
    expect(visible.at(-1)).equals(false)
    pointer(false)
    const context = new window.Event('contextmenu', { cancelable: true })
    row.dispatchEvent(context)
    expect(context.defaultPrevented).equals(true)
    pointer(true)
    const normalContext = new window.Event('contextmenu', { cancelable: true })
    row.dispatchEvent(normalContext)
    expect(normalContext.defaultPrevented).equals(false)
    stop()
    const count = visible.length
    row.dispatchEvent(new window.Event('pointerenter'))
    expect(visible).length(count)
    expect(() => {
      bindMessageHover(undefined, () => {})()
    }).not.throws()
  })

  it('updates an anchored menu after resize and scroll and closes when its trigger disappears', async function () {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    let x = 30
    anchor.getBoundingClientRect = () => ({
      x,
      y: 40,
      width: 24,
      height: 24,
      top: 40,
      right: x + 24,
      bottom: 64,
      left: x,
      toJSON: () => ({})
    })
    const positions: unknown[] = []
    let closed = 0
    const stop = watchMessageAnchor(
      anchor,
      bounds => positions.push(bounds),
      () => {
        closed += 1
      }
    )
    stops.push(stop)
    expect(positions).deep.equals([{ x: 30, y: 40, width: 24, height: 24 }])
    x = 60
    window.dispatchEvent(new window.Event('resize'))
    document.dispatchEvent(new window.Event('scroll'))
    expect(positions.slice(-2)).deep.equals([
      { x: 60, y: 40, width: 24, height: 24 },
      { x: 60, y: 40, width: 24, height: 24 }
    ])
    anchor.remove()
    await Promise.resolve()
    expect(closed).greaterThan(0)
    stop()
    const count = positions.length
    window.dispatchEvent(new window.Event('resize'))
    expect(positions).length(count)
    watchMessageAnchor(
      undefined,
      () => {},
      () => {
        closed += 1
      }
    )()
    expect(closed).greaterThan(1)
  })

  it('limits desktop ellipsis to Copy text, Pin or Unpin, and authorized Delete', async function () {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    let pinned: boolean | undefined
    await render(
      <MessageMenu
        key="pin-presentation"
        {...menuProps({
          desktop: true,
          anchor,
          message: safeMessage({ mine: true }),
          actions: ['reply', 'react', 'copy', 'pin', 'delete'],
          onPin: value => {
            pinned = value
          }
        })}
      />
    )
    const panel = labelled('Message from You')
    expect(
      [...panel.querySelectorAll('[role="button"]')].map(
        node => node.textContent
      )
    ).deep.equals(['Copy text', 'Pin', 'Delete'])
    for (const excluded of ['Reply', 'Edit', 'Forward', 'Remind me', 'Report'])
      expect(panel.textContent).not.contains(excluded)
    expect(document.querySelector('[aria-label="React with ❤️"]')).equals(null)
    await press('Pin')
    expect(pinned).equals(true)
    await render(
      <MessageMenu
        key="unpin-presentation"
        {...menuProps({
          desktop: true,
          anchor,
          actions: ['copy', 'unpin'],
          onPin: value => {
            pinned = value
          }
        })}
      />
    )
    await press('Unpin')
    expect(pinned).equals(false)
  })
})

describe('chat follow-up message overlay', function () {
  it('shows exact quick emoji actions plus More and gives each explicit action its own menu lifetime', async function () {
    const calls: string[] = []
    let instance = 0
    const fresh = async (): Promise<void> => {
      await render(
        <ChatOverlayHost>
          <button aria-label="Background">Background</button>
          <MessageMenu
            key={++instance}
            {...menuProps({
              onReply: () => calls.push('reply'),
              onReact: emoji => calls.push(emoji),
              onMoreEmoji: () => calls.push('more')
            })}
          />
        </ChatOverlayHost>
      )
    }
    await fresh()
    const panel = labelled('Message from Shohei Ohtani')
    expect(
      [...panel.querySelectorAll('[aria-label^="React with "]')].map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals([
      'React with ❤️',
      'React with 👍',
      'React with 👎',
      'React with 😂',
      'React with 😮',
      'React with 😢'
    ])
    expect(button('Background').closest('[aria-hidden="true"]')).not.equals(
      null
    )
    expect(document.activeElement?.getAttribute('aria-label')).equals(
      'React with ❤️'
    )
    for (const emoji of ['❤️', '👍', '👎', '😂', '😮', '😢']) {
      await fresh()
      await press(`React with ${emoji}`)
    }
    await fresh()
    await press('More emoji')
    await fresh()
    await press('Reply')
    expect(calls).deep.equals([
      '❤️',
      '👍',
      '👎',
      '😂',
      '😮',
      '😢',
      'more',
      'reply'
    ])
  })

  it('keeps a denied copy open with visible feedback, blocks duplicate copy and closes only after success', async function () {
    let resolveCopy: (() => void) | undefined
    let copies = 0
    let closed = 0
    let fail = true
    const copy = async (): Promise<void> => {
      copies += 1
      if (fail) throw new Error('Denied')
      await new Promise<void>(resolve => {
        resolveCopy = resolve
      })
    }
    await render(
      <MessageMenu
        {...menuProps({
          onCopy: copy,
          onClose: () => {
            closed += 1
          }
        })}
      />
    )
    await press('Copy')
    expect(document.body.textContent).contains('Could not copy this message.')
    expect(closed).equals(0)
    fail = false
    await press('Copy')
    expect(button('Copy').getAttribute('aria-disabled')).equals('true')
    await press('Copy')
    expect(copies).equals(2)
    await act(async () => {
      resolveCopy?.()
      await wait()
    })
    await settleChatMessageActions('closed')
    expect(closed).equals(1)
    expect(document.body.textContent).not.contains(
      'Could not copy this message.'
    )
  })

  it('reports a missing clipboard callback and uses safe Former member selection fallback', async function () {
    await render(
      <MessageMenu
        {...menuProps({
          message: safeMessage({ senderName: undefined }),
          actions: ['copy'],
          onCopy: undefined
        })}
      />
    )
    expect(labelled('Message from Former member').textContent).contains(
      'Former member'
    )
    await press('Copy')
    expect(document.body.textContent).contains('Could not copy this message.')
  })

  it('requires delete confirmation for own and moderator deletion and supports cancel', async function () {
    let deleted = 0
    let moderated = 0
    let closed = 0
    await render(
      <MessageMenu
        {...menuProps({
          actions: ['delete'],
          message: safeMessage({ mine: true }),
          onDelete: () => {
            deleted += 1
          },
          onClose: () => {
            closed += 1
          }
        })}
      />
    )
    await press('Delete')
    expect(deleted).equals(0)
    expect(document.body.textContent).contains(
      'This message will be removed for everyone.'
    )
    await press('Delete')
    expect(deleted).equals(1)
    expect(closed).equals(1)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await render(
      <MessageMenu
        {...menuProps({
          actions: ['deleteForEveryone'],
          onDeleteForEveryone: () => {
            moderated += 1
          }
        })}
      />
    )
    await press('Delete')
    await press('Delete')
    expect(moderated).equals(1)
  })
})

describe('chat follow-up message hold', function () {
  async function mount(generation = { current: 0 }): Promise<{
    target: HTMLElement
    opens: MessageView[]
    generation: { current: number }
  }> {
    pointer(false)
    const opens: MessageView[] = []
    await render(
      <MessageBubble
        message={safeMessage()}
        conversation={chat()}
        members={[member(2, 'Shohei Ohtani')]}
        engine={{ openAttachment: async () => new Uint8Array() }}
        files={files}
        maxWidth={320}
        swipe={false}
        gestureGeneration={generation}
        onLongPress={value => opens.push(value)}
        onReply={() => {}}
        onToggleReaction={() => {}}
      />
    )
    mock.timers.enable({ apis: ['setTimeout'] })
    ownsTimeouts = true
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_1"]'
    )!
    const body = [...row.querySelectorAll<HTMLElement>('*')].find(
      node => node.textContent === 'Game day'
    )
    expect(body).not.equals(undefined)
    const target = body!.parentElement!
    return { target, opens, generation }
  }
  async function mouse(
    node: HTMLElement,
    kind: string,
    x = 20,
    y = 20
  ): Promise<void> {
    await act(async () => {
      node.dispatchEvent(
        new window.MouseEvent(kind, {
          bubbles: true,
          button: 0,
          buttons: kind === 'mouseup' ? 0 : 1,
          clientX: x,
          clientY: y
        })
      )
      await Promise.resolve()
    })
  }
  async function tick(ms: number): Promise<void> {
    await act(async () => {
      mock.timers.tick(ms)
      await Promise.resolve()
    })
  }
  async function touch(
    node: HTMLElement,
    kind: string,
    x = 20,
    y = 20
  ): Promise<void> {
    const event = new window.Event(kind, { bubbles: true, cancelable: true })
    const point = {
      identifier: 1,
      target: node,
      pageX: x,
      pageY: y,
      clientX: x,
      clientY: y
    }
    Object.defineProperties(event, {
      touches: {
        value: kind === 'touchend' || kind === 'touchcancel' ? [] : [point]
      },
      changedTouches: { value: [point] }
    })
    await act(async () => {
      node.dispatchEvent(event)
      await Promise.resolve()
    })
  }

  async function nested(kind: 'file' | 'quote'): Promise<{
    target: HTMLElement
    opens: MessageView[]
    fetches: string[]
    jumps: string[]
    generation: { current: number }
  }> {
    await resetTimeouts()
    pointer(false)
    const opens: MessageView[] = []
    const fetches: string[] = []
    const jumps: string[] = []
    const generation = { current: 0 }
    const value = safeMessage({
      id: `msg_nested_${kind}`,
      attachments:
        kind === 'file'
          ? [
              {
                id: 'cat_nested',
                key: 'AA',
                digest: 'AA',
                contentType: 'application/pdf',
                fileName: 'notes.pdf',
                size: 1
              }
            ]
          : [],
      quote:
        kind === 'quote'
          ? {
              id: 'msg_original',
              authorId: 2,
              authorName: 'Shohei Ohtani',
              snippet: 'Original body',
              status: 'ok'
            }
          : undefined
    })
    await render(
      <MessageBubble
        key={kind}
        message={value}
        conversation={chat()}
        members={[member(2, 'Shohei Ohtani')]}
        engine={{
          openAttachment: async attachment => {
            fetches.push(attachment.id)
            return new Uint8Array([1])
          }
        }}
        files={files}
        maxWidth={320}
        swipe={false}
        gestureGeneration={generation}
        onLongPress={pressed => opens.push(pressed)}
        onReply={() => {}}
        onJump={id => jumps.push(id)}
        onToggleReaction={() => {}}
      />
    )
    const target =
      kind === 'file'
        ? button('Save notes.pdf')
        : button('Jump to message from Shohei Ohtani: Original body')
    mock.timers.enable({ apis: ['setTimeout'] })
    ownsTimeouts = true
    return { target, opens, fetches, jumps, generation }
  }

  it('keeps nested file-open and quote-jump short taps while cancelling a hold released before 500 ms', async function () {
    for (const kind of ['file', 'quote'] as const) {
      const value = await nested(kind)
      await mouse(value.target, 'mousedown')
      await tick(300)
      await mouse(value.target, 'mouseup')
      await act(async () => {
        value.target.click()
        await Promise.resolve()
      })
      await tick(200)
      expect(value.opens).length(0)
      expect(value.fetches).deep.equals(kind === 'file' ? ['cat_nested'] : [])
      expect(value.jumps).deep.equals(kind === 'quote' ? ['msg_original'] : [])
    }
  })

  it('recognizes a nested 500 ms file or quote hold once and suppresses the child short action', async function () {
    for (const kind of ['file', 'quote'] as const) {
      let pulses = 0
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: () => {
          pulses += 1
          return true
        }
      })
      const value = await nested(kind)
      await mouse(value.target, 'mousedown')
      await tick(499)
      expect(value.opens).length(0)
      await tick(1)
      expect(value.opens.map(pressed => pressed.id)).deep.equals([
        `msg_nested_${kind}`
      ])
      await tick(500)
      await mouse(value.target, 'mouseup')
      await act(async () => {
        value.target.click()
        await Promise.resolve()
      })
      expect(value.opens).length(1)
      expect(pulses).equals(1)
      expect(value.fetches).deep.equals([])
      expect(value.jumps).deep.equals([])
    }
  })

  it('cancels nested child holds and short actions after movement, touch cancellation or scrolling', async function () {
    for (const kind of ['file', 'quote'] as const) {
      for (const cancellation of ['movement', 'cancel', 'scroll'] as const) {
        const value = await nested(kind)
        await touch(value.target, 'touchstart')
        if (cancellation === 'movement')
          await touch(value.target, 'touchmove', 31, 20)
        else if (cancellation === 'cancel')
          await touch(value.target, 'touchcancel')
        else value.generation.current += 1
        await tick(500)
        await touch(value.target, 'touchend', 31, 20)
        await act(async () => {
          value.target.click()
          await Promise.resolve()
        })
        expect(value.opens).length(0)
        expect(
          value.fetches,
          `${kind} ${cancellation} must not open a file`
        ).deep.equals([])
        expect(
          value.jumps,
          `${kind} ${cancellation} must not jump`
        ).deep.equals([])
      }
    }
  })

  it('does not open a narrow conversation or its menu after a raw touch moves more than 10 pixels, while a later short tap still opens it', async function () {
    pointer(false)
    const engine = new FakeEngine()
    engine.current.conversation = chat({
      id: 'cnv_row_gesture',
      title: 'Aurora Members',
      scopeName: 'Aurora'
    })
    const opened: string[] = []
    await render(
      <ChatOverlayHost>
        <ChatListScreen
          engine={engine}
          narrow
          onOpen={conversation => opened.push(conversation.id)}
          onNewMessage={() => {}}
        />
      </ChatOverlayHost>
    )
    const target = button('Aurora Members')
    mock.timers.enable({ apis: ['setTimeout'] })
    ownsTimeouts = true
    await touch(target, 'touchstart')
    await touch(target, 'touchmove', 31, 20)
    await tick(500)
    await touch(target, 'touchend', 31, 20)
    await act(async () => {
      target.click()
      await Promise.resolve()
    })
    expect(opened).deep.equals([])
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)

    await touch(target, 'touchstart')
    await tick(300)
    await touch(target, 'touchend')
    // Browsers finish a touch tap with compatibility mouse events before click.
    await mouse(target, 'mouseup')
    await act(async () => {
      target.click()
      await Promise.resolve()
    })
    await tick(200)
    expect(opened).deep.equals(['cnv_row_gesture'])
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
  })

  it('recognizes exactly at 500 ms with one light pulse and also offers an accessible Actions entry', async function () {
    let pulses = 0
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        pulses += 1
        return true
      }
    })
    const { target, opens } = await mount()
    await mouse(target, 'mousedown')
    await tick(499)
    expect(opens).length(0)
    await tick(1)
    expect(opens).length(1)
    await tick(1000)
    await mouse(target, 'mouseup')
    expect(pulses).equals(1)
    await act(async () => {
      button('More message actions').click()
      await Promise.resolve()
    })
    await tick(0)
    expect(opens).length(2)
    expect(pulses).equals(1)
  })

  it('cancels early release and a scrolling generation before the hold threshold', async function () {
    const { target, opens, generation } = await mount()
    await mouse(target, 'mousedown')
    await tick(499)
    await mouse(target, 'mouseup')
    await tick(1)
    expect(opens).length(0)
    await mouse(target, 'mousedown')
    generation.current += 1
    await tick(500)
    expect(opens).length(0)
    await mouse(target, 'mouseup')
  })

  it('still opens actions when optional vibration throws', async function () {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('Unavailable')
      }
    })
    const { target, opens } = await mount()
    await mouse(target, 'mousedown')
    await tick(500)
    expect(opens).length(1)
    await mouse(target, 'mouseup')
  })

  it('cancels touch movement beyond ten points and pointer cancellation', async function () {
    const { target, opens } = await mount()
    await touch(target, 'touchstart')
    await touch(target, 'touchmove', 31, 20)
    await tick(500)
    expect(opens).length(0)
    await touch(target, 'touchend', 31, 20)
    await touch(target, 'touchstart')
    await touch(target, 'touchcancel')
    await tick(500)
    expect(opens).length(0)
  })
})

describe('chat follow-up reply and personal pin views', function () {
  it('exposes own-message controls on row focus and hover and routes its reply, picker and menu actions', async function () {
    pointer(true)
    const original = safeMessage({
      mine: true,
      senderUserId: 1,
      readBy: [2],
      edited: true,
      sentBeforeSafetyNumberChange: true
    })
    const calls: unknown[] = []
    await render(
      <MessageBubble
        message={original}
        conversation={chat()}
        members={[member(2, 'Shohei Ohtani')]}
        engine={{ openAttachment: async () => new Uint8Array() }}
        files={files}
        maxWidth={320}
        swipe={false}
        actions={['reply', 'react', 'copy', 'pin', 'delete']}
        onLongPress={(value, anchor) => calls.push(['menu', value.id, anchor])}
        onReply={value => calls.push(['reply', value.id])}
        onReact={value => calls.push(['react', value.id])}
        onToggleReaction={() => {}}
      />
    )
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_1"]'
    )!
    const controls = button('More message actions').parentElement!
    expect(controls.style.opacity).equals('0')
    await act(async () => {
      row.dispatchEvent(new window.Event('pointerenter'))
      await wait()
    })
    expect(controls.style.opacity).equals('1')
    await act(async () => {
      button('Reply').focus()
      await wait()
    })
    await act(async () => {
      row.dispatchEvent(new window.Event('pointerleave'))
      await wait()
    })
    expect(controls.style.opacity).equals('1')
    await press('Reply')
    await press('Send an emoji')
    const more = button('More message actions')
    await press('More message actions')
    expect(calls).deep.equals([
      ['reply', 'msg_1'],
      ['react', 'msg_1'],
      ['menu', 'msg_1', more]
    ])
    expect(document.body.textContent)
      .contains('Read by Shohei Ohtani')
      .and.contains('edited')
      .and.contains('safety number changed')
  })

  it('renders a current sender, You or Former member and jumps by the encrypted reference id', async function () {
    const jumps: string[] = []
    const quote: QuoteView = {
      id: 'msg_original',
      authorId: 2,
      authorName: 'Shohei Ohtani',
      snippet: 'Edited wording',
      status: 'ok'
    }
    await render(
      <ReplyQuote quote={quote} userId={1} onJump={id => jumps.push(id)} />
    )
    const target = button('Jump to message from Shohei Ohtani: Edited wording')
    expect(target.textContent).equals('Shohei OhtaniEdited wording')
    expect(
      target.firstElementChild instanceof HTMLElement &&
        getComputedStyle(target.firstElementChild).fontWeight
    ).equals('600')
    await press('Jump to message from Shohei Ohtani: Edited wording')
    expect(jumps).deep.equals(['msg_original'])
    await render(
      <ReplyQuote
        quote={{ ...quote, authorId: 1 }}
        userId={1}
        onJump={() => {}}
      />
    )
    expect(button('Jump to message from You: Edited wording')).not.equals(
      undefined
    )
    await render(
      <ReplyQuote
        quote={{ ...quote, authorName: undefined }}
        userId={1}
        onJump={() => {}}
      />
    )
    expect(
      button('Jump to message from Former member: Edited wording')
    ).not.equals(undefined)
    await render(
      <ReplyQuote
        quote={{
          ...quote,
          status: 'unavailable',
          snippet: 'Message unavailable'
        }}
        userId={1}
        onJump={() => {}}
      />
    )
    expect(
      button('Jump to message from Former member: Message unavailable')
    ).not.equals(undefined)
  })

  it('lists personal pins with current content and safe unavailable states and an empty state', async function () {
    const pins = ['msg_own', 'msg_locked', 'msg_missing'].map(messageId => ({
      messageId,
      pinnedAt: '2027-04-01T17:00:00Z'
    }))
    const jumps: string[] = []
    await render(
      <PinnedMessages
        pins={pins}
        messages={[
          safeMessage({ id: 'msg_own', mine: true, body: 'Current caption' }),
          safeMessage({
            id: 'msg_locked',
            status: 'locked',
            body: 'Stale caption'
          })
        ]}
        onJump={id => jumps.push(id)}
        onClose={() => {}}
      />
    )
    expect(labelled('Pinned messages').textContent)
      .contains('You')
      .and.contains('Current caption')
      .and.contains('Locked message')
      .and.contains('Message unavailable')
      .and.not.contains('Stale caption')
    await press('Current caption')
    await press('Locked message')
    await press('Message unavailable')
    expect(jumps).deep.equals(['msg_own', 'msg_locked', 'msg_missing'])
    await render(
      <PinnedMessages
        pins={[]}
        messages={[]}
        onJump={() => {}}
        onClose={() => {}}
      />
    )
    expect(document.body.textContent).contains('No pinned messages')
  })

  it('marks a personal pinned bubble without opening attachments in a selected overlay', async function () {
    let opened = 0
    pointer(true)
    await render(
      <MessageBubble
        message={safeMessage({
          body: 'Caption',
          attachments: [
            {
              id: 'cat_fixture',
              key: 'AA',
              digest: 'AA',
              contentType: 'application/pdf',
              fileName: 'notes.pdf',
              size: 1
            }
          ]
        })}
        conversation={chat()}
        members={[]}
        engine={{
          openAttachment: async () => {
            opened += 1
            return new Uint8Array()
          }
        }}
        files={files}
        maxWidth={320}
        swipe={false}
        selected
        pinned
        actions={[]}
        onLongPress={() => {}}
        onReply={() => {}}
        onToggleReaction={() => {}}
      />
    )
    expect(labelled('Pinned message')).not.equals(undefined)
    expect(document.body.textContent).contains('File: notes.pdf')
    expect(
      document.querySelector('[aria-label="More message actions"]')
    ).equals(null)
    expect(opened).equals(0)
  })
})

class FakeEngine implements ChatScreenEngine {
  current = view({
    conversation: chat({ id: 'cnv_fixture', scopeName: 'Aurora' }),
    members: [member(1, 'Mookie Betts'), member(2, 'Shohei Ohtani')],
    messages: [safeMessage()]
  })

  listeners = new Set<ChatEngineListener>()
  calls: unknown[] = []
  failSend = false
  async start(): Promise<'ready'> {
    return 'ready'
  }

  async refresh(): Promise<Array<ReturnType<typeof chat>>> {
    return [this.current.conversation]
  }

  conversations(): Array<ReturnType<typeof chat>> {
    return [this.current.conversation]
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async open(): Promise<ConversationView> {
    return this.current
  }

  close(): void {}
  view(): ConversationView {
    return this.current
  }

  async loadEarlier(): Promise<ConversationView> {
    this.calls.push('earlier')
    return this.current
  }

  async sendText(
    id: string,
    body: string,
    options: unknown
  ): Promise<undefined> {
    this.calls.push(['send', id, body, options])
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
    if (this.failSend) throw new Error('Unavailable')
    return undefined
  }

  async react(
    id: string,
    target: string,
    emoji: string,
    remove?: boolean
  ): Promise<void> {
    this.calls.push(['react', id, target, emoji, remove])
  }

  async edit(): Promise<void> {}
  async deleteMessage(id: string, target: string): Promise<void> {
    this.calls.push(['delete', id, target])
  }

  async moderatorDelete(id: string, target: string): Promise<void> {
    this.calls.push(['moderatorDelete', id, target])
  }

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

  async pinMessage(id: string, target: string, pinned: boolean): Promise<void> {
    this.calls.push(['pin', id, target, pinned])
    this.update({
      ...this.current,
      pins: pinned
        ? [{ messageId: target, pinnedAt: '2027-04-01T17:00:00Z' }]
        : []
    })
  }

  update(next: ConversationView): void {
    this.current = next
    for (const listener of this.listeners)
      listener({ type: 'conversation', conversationId: next.conversation.id })
  }
}

async function screen(
  engine: FakeEngine,
  draft?: React.ComponentProps<typeof ConversationScreen>['draft'],
  onDraftChange?: React.ComponentProps<
    typeof ConversationScreen
  >['onDraftChange']
): Promise<void> {
  pointer(true)
  await render(
    <ChatOverlayHost>
      <ConversationScreen
        engine={engine}
        conversationId="cnv_fixture"
        userId={1}
        onMembers={() => {}}
        files={files}
        swipe={false}
        embedded
        draft={draft}
        onDraftChange={onDraftChange}
      />
    </ChatOverlayHost>
  )
}

async function measured(
  node: HTMLElement,
  width: number,
  height: number,
  y = 0
): Promise<void> {
  const nativeNode = node as HTMLElement & {
    measureLayout?: (
      relative: unknown,
      success: (x: number, y: number, width: number, height: number) => void,
      failure?: () => void
    ) => void
  }
  if (nativeNode.measureLayout != null)
    nativeNode.measureLayout = (_relative, success) => {
      success(0, y, width, height)
    }
  const handler = (
    node as HTMLElement & { __reactLayoutHandler?: (event: unknown) => void }
  ).__reactLayoutHandler
  expect(handler, 'measured React Native layout callback').not.equals(undefined)
  await act(async () => {
    handler!({ nativeEvent: { layout: { x: 0, y, width, height } } })
    await wait()
  })
}

function positionWrapper(messageId: string): HTMLElement {
  let node = document.querySelector<HTMLElement>(
    `[data-testid="chat-message-${messageId}"]`
  )?.parentElement
  while (node != null && !('__reactLayoutHandler' in node))
    node = node.parentElement
  expect(node, 'message position wrapper').not.equals(null)
  return node!
}

interface ReadingGeometry {
  scroller: HTMLElement
  body: HTMLElement
  row: HTMLElement
  geometry: { y: number; height: number }
  moves: number[]
  layout: () => Promise<void>
  userScroll: (offset: number) => Promise<void>
}

function readingGeometry(
  messageId: string,
  y = 400,
  height = 2200,
  viewportHeight = 400
): ReadingGeometry {
  const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
    node => getComputedStyle(node).overflowY === 'auto'
  )!
  const body = scroller.firstElementChild as HTMLElement
  const row = positionWrapper(messageId)
  const geometry = { y, height }
  const moves: number[] = []
  scroller.getBoundingClientRect = () =>
    new window.DOMRect(0, 0, 640, viewportHeight)
  body.getBoundingClientRect = () =>
    new window.DOMRect(0, -scroller.scrollTop, 640, geometry.height)
  row.getBoundingClientRect = () =>
    new window.DOMRect(0, geometry.y - scroller.scrollTop, 640, 800)
  Object.defineProperties(scroller, {
    offsetHeight: { value: viewportHeight, configurable: true },
    offsetWidth: { value: 640, configurable: true },
    scrollHeight: { get: () => geometry.height, configurable: true }
  })
  Object.defineProperties(body, {
    offsetParent: { value: scroller, configurable: true },
    offsetHeight: { get: () => geometry.height, configurable: true },
    offsetWidth: { value: 640, configurable: true }
  })
  Object.defineProperties(row, {
    offsetParent: { value: body, configurable: true },
    offsetTop: { get: () => geometry.y, configurable: true },
    offsetHeight: { value: 800, configurable: true },
    offsetWidth: { value: 640, configurable: true }
  })
  scroller.scroll = options => {
    scroller.scrollTop = (options as ScrollToOptions).top ?? 0
    moves.push(scroller.scrollTop)
    scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  }
  const nativeRow = row as HTMLElement & {
    measureLayout: (
      relative: unknown,
      success: (x: number, y: number, width: number, height: number) => void
    ) => void
  }
  const measureCurrentRow = nativeRow.measureLayout
  return {
    scroller,
    body,
    row,
    geometry,
    moves,
    async layout(): Promise<void> {
      await measured(scroller, 640, viewportHeight)
      await measured(body, 640, geometry.height)
      await measured(row, 640, 800, geometry.y)
      nativeRow.measureLayout = measureCurrentRow
      await act(async () => {
        await wait(80)
      })
    },
    async userScroll(offset: number): Promise<void> {
      await act(async () => {
        scroller.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
        )
        scroller.scrollTop = offset
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await wait(120)
      })
    }
  }
}

interface ScrollEvent {
  nativeEvent: {
    contentOffset: { x: number; y: number }
    contentSize: { width: number; height: number }
    layoutMeasurement: { width: number; height: number }
  }
}

function renderedScrollHandler(
  node: HTMLElement
): (event: ScrollEvent) => void {
  interface RenderedFiber {
    memoizedProps?: {
      onContentSizeChange?: unknown
      onScroll?: (event: ScrollEvent) => void
    }
    return?: RenderedFiber
  }
  const fiberKey = Object.keys(node).find(key =>
    key.startsWith('__reactFiber$')
  )!
  let fiber = (node as unknown as Record<string, RenderedFiber | undefined>)[
    fiberKey
  ]
  let handler: ((event: ScrollEvent) => void) | undefined
  while (fiber != null) {
    if (typeof fiber.memoizedProps?.onContentSizeChange === 'function') {
      handler = fiber.memoizedProps.onScroll
      break
    }
    fiber = fiber.return
  }
  expect(handler, 'the actual rendered ScrollView callback').not.equals(
    undefined
  )
  return handler!
}

describe('chat follow-up conversation message integration', function () {
  it('keeps the genuine scroll offset and measured-pane reading anchor when a scroll event carries stale viewport and content geometry', async function () {
    pointer(true)
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_stale_scroll_geometry',
      body: 'Current reading row'
    })
    engine.current.messages = [reading]
    let saved: ChatDraft = {
      text: 'Current draft',
      picked: [],
      scrollOffset: 6000,
      hasScrollPosition: true
    }
    const remember = (next: ChatDraft): void => {
      saved = next
    }
    const show = async (active = true): Promise<void> => {
      await render(
        <ChatOverlayHost>
          <ConversationScreen
            key="cnv_fixture"
            engine={engine}
            conversationId="cnv_fixture"
            userId={1}
            onMembers={() => {}}
            files={files}
            swipe={false}
            embedded
            active={active}
            draft={saved}
            onDraftChange={remember}
          />
        </ChatOverlayHost>
      )
    }
    await show()
    let visible = readingGeometry(reading.id, 6700, 7424, 472)
    await visible.layout()
    await act(async () => {
      visible.scroller.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 795 })
      )
      visible.scroller.scrollTop = 6795
      renderedScrollHandler(visible.scroller)({
        nativeEvent: {
          contentOffset: { x: 0, y: 6795 },
          contentSize: { width: 640, height: 786 },
          layoutMeasurement: { width: 640, height: 628 }
        }
      })
    })
    expect(
      saved.scrollOffset,
      'the genuine gesture position is recorded'
    ).equals(6795)
    expect(saved.followNewest, 'the current viewport is not at the end').equals(
      false
    )
    expect(saved.scrollAnchor).deep.equals({ id: reading.id, relativeY: -95 })
    expect(visible.row.getBoundingClientRect().top).equals(-95)

    await show(false)
    const other = new FakeEngine()
    other.current.conversation = chat({
      id: 'cnv_other',
      scopeName: 'Solstice'
    })
    await render(
      <ChatOverlayHost>
        <ConversationScreen
          key="cnv_other"
          engine={other}
          conversationId="cnv_other"
          userId={1}
          onMembers={() => {}}
          files={files}
          swipe={false}
          embedded
        />
      </ChatOverlayHost>
    )
    await show()
    visible = readingGeometry(reading.id, 6700, 7424, 472)
    await visible.layout()
    expect(visible.moves.length).greaterThan(0)
    expect(visible.moves.every(offset => offset === 6795)).equals(true)
    expect(visible.scroller.scrollTop).equals(6795)
    expect(visible.row.getBoundingClientRect().top).equals(-95)
    expect(saved.scrollOffset).equals(6795)
    expect(saved.followNewest).equals(false)
  })

  it('keeps newly typed text, reply context and prepared files after queued scrolling and a retained older active-pane scroll callback', async function () {
    pointer(true)
    const engine = new FakeEngine()
    const original = safeMessage({ body: 'Current reply target' })
    engine.current.messages = [original]
    const prepared: PickedFile = {
      fileName: 'notes.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1])
    }
    let saved: ChatDraft = {
      text: 'Older draft',
      picked: [],
      scrollOffset: 647,
      hasScrollPosition: true
    }
    const changes: ChatDraft[] = []
    await render(
      <ChatOverlayHost>
        <ConversationScreen
          engine={engine}
          conversationId="cnv_fixture"
          userId={1}
          onMembers={() => {}}
          files={{ ...files, pickFiles: async () => [prepared] }}
          swipe={false}
          embedded
          draft={saved}
          onDraftChange={next => {
            saved = next
            changes.push(next)
          }}
        />
      </ChatOverlayHost>
    )
    const visible = readingGeometry(original.id)
    await visible.layout()
    await visible.userScroll(647)
    const olderScroll = renderedScrollHandler(visible.scroller)
    // Hold the real RNW end timer deterministically while composing; wall-clock
    // load must not let it fire before the assertion checkpoint is captured.
    mock.timers.enable({ apis: ['setTimeout'] })
    ownsTimeouts = true
    await act(async () => {
      visible.scroller.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
      visible.scroller.scrollTop = 700
      visible.scroller.dispatchEvent(
        new window.Event('scroll', { bubbles: true })
      )
    })
    await act(async () => {
      const input = labelled('Message') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )!.set!.call(input, 'Latest draft body')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      button('Reply').click()
      button('Attach').click()
    })
    expect(saved.text).equals('Latest draft body')
    expect(saved.replyTo?.id).equals(original.id)
    expect(saved.picked).deep.equals([prepared])
    const beforeQueuedCallback = changes.length
    await act(async () => {
      mock.timers.tick(101)
    })
    expect(
      changes.length,
      'the queued scroll-end callback was delivered'
    ).equals(beforeQueuedCallback + 1)
    // RNW forwards that end event through its current ScrollView props.
    // Also deliver the retained native callback from the earlier render.
    await act(async () => {
      olderScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 700 },
          contentSize: { width: 640, height: visible.geometry.height },
          layoutMeasurement: { width: 640, height: 400 }
        }
      })
    })
    expect(changes.length).equals(beforeQueuedCallback + 2)
    expect(saved.text).equals('Latest draft body')
    expect(saved.replyTo?.id).equals(original.id)
    expect(saved.picked).deep.equals([prepared])
    expect(saved.scrollOffset).equals(700)
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Latest draft body'
    )
    expect(document.body.textContent)
      .contains('Replying to Shohei Ohtani')
      .and.contains('notes.pdf')
    expect(engine.calls).deep.equals([])
  })

  it('discards a pending saved-anchor measurement after newer layout moves the row and restores from fresh geometry', async function () {
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_saved_overlapping_measurement',
      body: 'Current reading row'
    })
    engine.current.messages = [reading]
    let saved: ChatDraft = {
      text: 'Current draft',
      picked: [],
      scrollOffset: 647,
      hasScrollPosition: true,
      scrollAnchor: { id: reading.id, relativeY: -247 }
    }
    await render(
      <ChatOverlayHost>
        <ConversationScreen
          engine={engine}
          conversationId="cnv_fixture"
          userId={1}
          onMembers={() => {}}
          files={files}
          swipe={false}
          embedded
          draft={saved}
          onDraftChange={next => {
            saved = next
          }}
        />
      </ChatOverlayHost>
    )
    const visible = readingGeometry(reading.id)
    type Measurement = (
      x: number,
      y: number,
      width: number,
      height: number
    ) => void
    const nativeRow = visible.row as HTMLElement & {
      measureLayout: (relative: unknown, success: Measurement) => void
    }
    const measureLiveRow = nativeRow.measureLayout
    const pending: Measurement[] = []
    nativeRow.measureLayout = (_relative, success) => {
      pending.push(success)
    }
    const layout = (node: HTMLElement, y: number, height: number): void => {
      const handler = (
        node as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler
      handler({ nativeEvent: { layout: { x: 0, y, width: 640, height } } })
    }
    await act(async () => {
      layout(visible.scroller, 0, 400)
      await wait()
    })
    expect(pending).lengthOf(1)
    visible.geometry.y += 157
    visible.geometry.height += 157
    await act(async () => {
      layout(visible.row, visible.geometry.y, 800)
      layout(visible.body, 0, visible.geometry.height)
    })
    expect(pending, 'the original measurement is still pending').lengthOf(1)
    visible.moves.length = 0
    await act(async () => {
      pending.shift()!(0, 400, 640, 800)
      await wait()
    })
    expect(
      visible.moves,
      'do not apply the obsolete row measurement'
    ).deep.equals([])
    expect(pending, 'measure the row again after the newer layout').lengthOf(1)
    nativeRow.measureLayout = measureLiveRow
    await act(async () => {
      pending.shift()!(0, visible.geometry.y, 640, 800)
      await wait()
    })
    expect(visible.scroller.scrollTop).equals(804)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    expect(saved.scrollOffset).equals(804)
    expect(saved.scrollAnchor).deep.equals({ id: reading.id, relativeY: -247 })
    await visible.layout()
    expect(visible.scroller.scrollTop).equals(804)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    expect(visible.moves.every(offset => offset === 804)).equals(true)
  })

  it('restores the same partially visible saved row after switching conversations and changed prefix or layout geometry', async function () {
    pointer(true)
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_saved_partial_row',
      seq: 2,
      body: Array.from(
        { length: 24 },
        (_, index) => `Practice ${index + 1}`
      ).join('\n')
    })
    engine.current.messages = [
      safeMessage({ id: 'msg_saved_prefix', seq: 1 }),
      reading,
      safeMessage({ id: 'msg_saved_following', seq: 3 })
    ]
    let saved: ChatDraft = {
      text: 'First draft line\nSecond draft line',
      picked: [],
      scrollOffset: 647,
      hasScrollPosition: true
    }
    const remember = (next: ChatDraft): void => {
      saved = next
    }
    const show = async (active = true): Promise<void> => {
      await render(
        <ChatOverlayHost>
          <ConversationScreen
            key="cnv_fixture"
            engine={engine}
            conversationId="cnv_fixture"
            userId={1}
            onMembers={() => {}}
            files={files}
            swipe={false}
            embedded
            active={active}
            draft={saved}
            onDraftChange={remember}
          />
        </ChatOverlayHost>
      )
    }
    await show()
    let visible = readingGeometry(reading.id)
    await visible.layout()
    await measured(positionWrapper('msg_saved_prefix'), 640, 400)
    await measured(positionWrapper('msg_saved_following'), 640, 100, 1200)
    await visible.userScroll(647)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    expect(saved.scrollAnchor).deep.equals({
      id: reading.id,
      relativeY: -247
    })

    await show(false)
    const other = new FakeEngine()
    other.current = {
      ...other.current,
      conversation: chat({ id: 'cnv_other', scopeName: 'Solstice' }),
      messages: [safeMessage({ id: 'msg_other_conversation' })]
    }
    await render(
      <ChatOverlayHost>
        <ConversationScreen
          key="cnv_other"
          engine={other}
          conversationId="cnv_other"
          userId={1}
          onMembers={() => {}}
          files={files}
          swipe={false}
          embedded
        />
      </ChatOverlayHost>
    )
    await show()
    visible = readingGeometry(reading.id, 557, 2357)
    await visible.layout()
    expect(visible.scroller.scrollTop).equals(804)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    expect(saved.scrollOffset).equals(804)
    expect(saved.scrollAnchor).deep.equals({ id: reading.id, relativeY: -247 })

    visible.geometry.y += 63
    visible.geometry.height += 63
    await visible.layout()
    expect(visible.scroller.scrollTop).equals(867)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    visible.geometry.height += 34
    await visible.layout()
    await visible.layout()
    expect(visible.scroller.scrollTop).equals(867)
    expect(visible.row.getBoundingClientRect().top).equals(-247)
    expect(saved.scrollOffset).equals(867)
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'First draft line\nSecond draft line'
    )
  })

  it('ignores queued scroll and layout resets from a hidden or unmounted pane without replacing its saved row anchor', async function () {
    pointer(true)
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_saved_late_event_row',
      seq: 2,
      body: 'A long current reading row'
    })
    engine.current.messages = [reading]
    let saved: ChatDraft = {
      text: 'Current draft',
      picked: [],
      scrollOffset: 647,
      hasScrollPosition: true,
      scrollAnchor: { id: reading.id, relativeY: -247 }
    }
    const changes: ChatDraft[] = []
    const remember = (next: ChatDraft): void => {
      saved = next
      changes.push(next)
    }
    const show = async (active: boolean): Promise<void> => {
      await render(
        <ChatOverlayHost>
          <ConversationScreen
            engine={engine}
            conversationId="cnv_fixture"
            userId={1}
            onMembers={() => {}}
            files={files}
            swipe={false}
            embedded
            active={active}
            draft={saved}
            onDraftChange={remember}
          />
        </ChatOverlayHost>
      )
    }
    for (const transition of ['hidden', 'unmounted'] as const) {
      await show(true)
      const visible = readingGeometry(reading.id)
      await visible.layout()
      await visible.userScroll(647)
      const before = { ...saved, scrollAnchor: { ...saved.scrollAnchor! } }
      const oldLayout = (
        visible.scroller as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler
      const oldContentLayout = (
        visible.body as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler
      await act(async () => {
        visible.scroller.dispatchEvent(
          new window.Event('scroll', { bubbles: true })
        )
      })
      if (transition === 'hidden') await show(false)
      else await render(<div>Conversation list</div>)
      const beforeLateEvents = changes.length
      visible.moves.length = 0
      await act(async () => {
        visible.scroller.scrollTop = 0
        visible.geometry.height = 0
        const event = {
          nativeEvent: { layout: { x: 0, y: 0, width: 0, height: 0 } }
        }
        oldLayout(event)
        oldContentLayout(event)
        // RNW delivers its queued scroll-end callback after the pane changes.
        await wait(120)
      })
      expect(changes.length, `${transition} late draft writes`).equals(
        beforeLateEvents
      )
      expect(saved).deep.equals(before)
      expect(visible.moves, `${transition} late scroll commands`).deep.equals(
        []
      )
    }
    await show(true)
    const reopened = readingGeometry(reading.id, 557, 2357)
    await reopened.layout()
    expect(reopened.scroller.scrollTop).equals(804)
    expect(reopened.row.getBoundingClientRect().top).equals(-247)
    expect(saved.scrollAnchor).deep.equals({ id: reading.id, relativeY: -247 })
  })

  it('preserves the current reading anchor when a cancelled history request later prepends, including append growth and late scroll/layout events', async function () {
    for (const [browserAnchors, downstreamGrowth] of [
      [false, 0],
      [true, 0],
      [false, 34]
    ] as const) {
      if (root != null) {
        await act(async () => {
          root!.unmount()
        })
        root = undefined
      }
      const engine = new FakeEngine()
      const original = safeMessage({
        id: 'msg_cancelled_page_original',
        seq: 1,
        body:
          downstreamGrowth === 0
            ? 'Older original'
            : 'Practice notes '.repeat(15)
      })
      const reading = safeMessage({
        id: 'msg_current_reading_anchor',
        seq: 19,
        body: 'Current reading anchor'
      })
      const reply = safeMessage({
        id: 'msg_cancelled_page_reply',
        seq: 20,
        quote: {
          id: original.id,
          authorId: 2,
          authorName: undefined,
          snippet: 'Message unavailable',
          status: 'unavailable'
        }
      })
      engine.current = {
        ...engine.current,
        messages: [reading, reply],
        historyBefore: 19,
        hasEarlier: true
      }
      let finish: ((next: ConversationView) => void) | undefined
      let loads = 0
      engine.loadEarlier = async () => {
        loads += 1
        if (loads === 1) {
          engine.update({ ...engine.current, historyBefore: 10 })
          return engine.current
        }
        return await new Promise(resolve => {
          finish = resolve
        })
      }
      await screen(engine, {
        text: 'Current draft',
        picked: [],
        scrollOffset: 80
      })
      const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
        node => getComputedStyle(node).overflowY === 'auto'
      )!
      const body = scroller.firstElementChild as HTMLElement
      let contentHeight = 1000
      const anchor = positionWrapper(reading.id)
      let anchorContentY = 400
      scroller.getBoundingClientRect = () => new window.DOMRect(0, 0, 640, 400)
      body.getBoundingClientRect = () =>
        new window.DOMRect(0, -scroller.scrollTop, 640, contentHeight)
      anchor.getBoundingClientRect = () =>
        new window.DOMRect(0, anchorContentY - scroller.scrollTop, 640, 100)
      positionWrapper(reply.id).getBoundingClientRect = () =>
        new window.DOMRect(
          0,
          anchorContentY + 100 - scroller.scrollTop,
          640,
          100 + (engine.current.hasEarlier ? 0 : downstreamGrowth)
        )
      Object.defineProperties(scroller, {
        offsetHeight: { value: 400, configurable: true },
        offsetWidth: { value: 640, configurable: true },
        scrollHeight: { get: () => contentHeight, configurable: true }
      })
      Object.defineProperties(body, {
        offsetParent: { value: scroller, configurable: true },
        offsetHeight: { get: () => contentHeight, configurable: true },
        offsetWidth: { value: 640, configurable: true }
      })
      Object.defineProperties(anchor, {
        offsetParent: { value: body, configurable: true },
        offsetTop: { get: () => anchorContentY, configurable: true },
        offsetHeight: { value: 100, configurable: true },
        offsetWidth: { value: 640, configurable: true }
      })
      const moves: Array<[number, string | undefined]> = []
      scroller.scroll = options => {
        const value = options as ScrollToOptions
        scroller.scrollTop = value.top ?? 0
        moves.push([scroller.scrollTop, value.behavior])
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      }
      await measured(scroller, 640, 400)
      await measured(body, 640, contentHeight)
      const nativeAnchor = anchor as HTMLElement & {
        measureLayout: (
          relative: unknown,
          success: (x: number, y: number, width: number, height: number) => void
        ) => void
      }
      const measureCurrentAnchor = nativeAnchor.measureLayout
      await measured(anchor, 640, 100, anchorContentY)
      nativeAnchor.measureLayout = measureCurrentAnchor
      expect(scroller.scrollTop).equals(80)
      await press('Load earlier messages')
      expect(loads).equals(1)
      expect(engine.current.historyBefore).equals(10)
      expect(engine.current.messages.map(value => value.id)).deep.equals([
        reading.id,
        reply.id
      ])
      expect(anchor.getBoundingClientRect().top).equals(320)
      expect(scroller.scrollTop).equals(80)
      await press('Jump to message from Former member: Message unavailable')
      expect(loads).equals(2)
      expect(finish).not.equals(undefined)

      await act(async () => {
        scroller.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, deltaY: 160 })
        )
        scroller.scrollTop = 240
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await wait(120)
      })
      const currentAnchor = anchor.getBoundingClientRect().top
      expect(currentAnchor).equals(160)

      const appended = safeMessage({
        id: 'msg_appended_during_paging',
        seq: 21
      })
      await act(async () => {
        engine.update({
          ...engine.current,
          messages: [reading, reply, appended]
        })
        await wait()
      })
      contentHeight = 1150
      await measured(body, 640, contentHeight)
      expect(scroller.scrollTop).equals(240)
      expect(anchor.getBoundingClientRect().top).equals(currentAnchor)

      const next = {
        ...engine.current,
        messages: [
          original,
          reading,
          {
            ...reply,
            quote: {
              id: original.id,
              authorId: original.senderUserId,
              authorName: original.senderName,
              snippet:
                downstreamGrowth === 0
                  ? original.body
                  : `${original.body.slice(0, 200)}…`,
              status: 'ok' as const
            }
          },
          appended
        ],
        historyBefore: 1,
        hasEarlier: false
      }
      await act(async () => {
        engine.update(next)
        await wait()
      })
      await measured(positionWrapper(original.id), 640, 100, 100)
      anchorContentY += 600
      contentHeight += 600 + downstreamGrowth
      if (browserAnchors) {
        await act(async () => {
          scroller.scrollTop = 840
          scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
          await wait(120)
        })
      }
      await act(async () => {
        finish!(next)
        await wait(80)
      })
      await measured(body, 640, contentHeight)
      expect(
        scroller.scrollTop,
        `browser anchoring: ${browserAnchors}, growth below anchor: ${downstreamGrowth}`
      ).equals(840)
      expect(anchor.getBoundingClientRect().top).equals(currentAnchor)

      await act(async () => {
        scroller.scrollTop = 920
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await wait(120)
      })
      await measured(scroller, 640, 400)
      await measured(body, 640, contentHeight)
      await measured(body, 640, contentHeight)
      expect(scroller.scrollTop).equals(840)
      expect(anchor.getBoundingClientRect().top).equals(currentAnchor)
      expect(moves.some(([, behavior]) => behavior === 'smooth')).equals(false)
      expect(document.body.textContent).not.contains('Message unavailable')
      expect((labelled('Message') as HTMLTextAreaElement).value).equals(
        'Current draft'
      )
    }
  })

  it('waits for a delayed nonzero mounted-row measurement instead of failing at a fixed delay', async function () {
    const engine = new FakeEngine()
    const original = safeMessage({
      id: 'msg_delayed',
      body: 'Delayed original'
    })
    engine.current.messages = [
      original,
      safeMessage({
        id: 'msg_delayed_reply',
        seq: 2,
        quote: {
          id: original.id,
          authorId: 2,
          authorName: 'Shohei Ohtani',
          snippet: original.body,
          status: 'ok'
        }
      })
    ]
    await screen(engine)
    const node = positionWrapper(original.id) as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    let measuredCalls = 0
    let complete:
      | ((x: number, y: number, width: number, height: number) => void)
      | undefined
    node.measureLayout = (_relative, success) => {
      measuredCalls += 1
      if (measuredCalls === 1) success(0, 0, 0, 0)
      else complete = success
    }
    const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
      element => getComputedStyle(element).overflowY === 'auto'
    )!
    const moves: number[] = []
    scroller.scroll = options =>
      moves.push((options as ScrollToOptions).top ?? 0)
    await act(async () => {
      button('Jump to message from Shohei Ohtani: Delayed original').click()
      await wait(80)
    })
    expect(measuredCalls).greaterThan(1)
    expect(moves).deep.equals([])
    expect(document.body.textContent).not.contains('Message unavailable')
    expect(complete).not.equals(undefined)
    await act(async () => {
      complete!(0, 300, 640, 100)
      await wait(30)
    })
    expect(moves).deep.equals([244])
  })

  it('discards a delayed measurement after genuine user scrolling cancels the jump', async function () {
    const engine = new FakeEngine()
    const original = safeMessage({
      id: 'msg_cancelled',
      body: 'Cancelled original'
    })
    engine.current.messages = [
      original,
      safeMessage({
        id: 'msg_cancelled_reply',
        seq: 2,
        quote: {
          id: original.id,
          authorId: 2,
          authorName: 'Shohei Ohtani',
          snippet: original.body,
          status: 'ok'
        }
      })
    ]
    await screen(engine)
    const node = positionWrapper(original.id) as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: (x: number, y: number, width: number, height: number) => void
      ) => void
    }
    let complete:
      | ((x: number, y: number, width: number, height: number) => void)
      | undefined
    node.measureLayout = (_relative, success) => {
      complete = success
    }
    const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
      element => getComputedStyle(element).overflowY === 'auto'
    )!
    const moves: number[] = []
    scroller.scroll = options =>
      moves.push((options as ScrollToOptions).top ?? 0)
    await act(async () => {
      button('Jump to message from Shohei Ohtani: Cancelled original').click()
      await wait(20)
    })
    expect(complete).not.equals(undefined)
    await act(async () => {
      scroller.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 10 })
      )
      complete!(0, 500, 640, 100)
      await wait(50)
    })
    expect(moves).deep.equals([])
    expect(document.body.textContent).not.contains('Message unavailable')
  })

  it('replaces an earlier jump and discards a pending jump after unmount', async function () {
    const engine = new FakeEngine()
    const first = safeMessage({
      id: 'msg_first',
      seq: 1,
      body: 'First original'
    })
    const second = safeMessage({
      id: 'msg_second',
      seq: 2,
      body: 'Second original'
    })
    const reply = (id: string, original: MessageView): MessageView =>
      safeMessage({
        id,
        seq: 3,
        quote: {
          id: original.id,
          authorId: 2,
          authorName: 'Shohei Ohtani',
          snippet: original.body,
          status: 'ok'
        }
      })
    engine.current.messages = [
      first,
      second,
      reply('msg_reply_first', first),
      reply('msg_reply_second', second)
    ]
    await screen(engine)
    await measured(positionWrapper(first.id), 640, 100, 100)
    await measured(positionWrapper(second.id), 640, 100, 500)
    const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
      node => getComputedStyle(node).overflowY === 'auto'
    )!
    const moves: number[] = []
    scroller.scroll = options => {
      moves.push((options as ScrollToOptions).top ?? 0)
    }
    await act(async () => {
      button('Jump to message from Shohei Ohtani: First original').click()
      button('Jump to message from Shohei Ohtani: Second original').click()
      await wait(80)
    })
    expect(moves).deep.equals([444])
    await act(async () => {
      button('Jump to message from Shohei Ohtani: First original').click()
      await Promise.resolve()
    })
    await act(async () => {
      root!.unmount()
      root = undefined
      await wait(80)
    })
    expect(moves).deep.equals([444])
  })

  it('preserves prepend position, jumps to a verified older original and highlights it for 1.5 seconds', async function () {
    const engine = new FakeEngine()
    const original = safeMessage({
      id: 'msg_original',
      seq: 1,
      body: 'Original body'
    })
    const reply = safeMessage({
      id: 'msg_reply',
      seq: 20,
      body: 'Reply body',
      quote: {
        id: original.id,
        authorId: 2,
        authorName: 'Shohei Ohtani',
        snippet: 'Message unavailable',
        status: 'unavailable'
      }
    })
    engine.current = {
      ...engine.current,
      messages: [reply],
      hasEarlier: true,
      historyBefore: 20
    }
    let finish: ((next: ConversationView) => void) | undefined
    let loads = 0
    engine.loadEarlier = async () => {
      loads += 1
      if (loads === 1) {
        engine.update({ ...engine.current, historyBefore: 10 })
        return engine.current
      }
      engine.update({
        ...engine.current,
        messages: [original, reply],
        historyBefore: 1,
        hasEarlier: false
      })
      return await new Promise(resolve => {
        finish = resolve
      })
    }
    await screen(engine, { text: 'Draft body', picked: [], scrollOffset: 120 })
    const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
      node => getComputedStyle(node).overflowY === 'auto'
    )!
    const moves: Array<[number, string | undefined]> = []
    scroller.scroll = options => {
      moves.push([
        (options as ScrollToOptions).top ?? 0,
        (options as ScrollToOptions).behavior
      ])
    }
    await measured(scroller, 640, 400)
    await measured(scroller.firstElementChild as HTMLElement, 640, 1000)
    expect(moves.at(-1)?.[0]).equals(120)
    await press('Jump to message from Former member: Message unavailable')
    expect(loads).equals(2)
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-msg_original"]'
    )!
    const before = getComputedStyle(row).backgroundColor
    await measured(positionWrapper(original.id), 640, 100, 300)
    await measured(scroller.firstElementChild as HTMLElement, 640, 1300)
    expect(moves.at(-1)).deep.equals([420, 'auto'])
    await act(async () => {
      finish?.(engine.current)
      await wait(80)
    })
    expect(moves.at(-1)).deep.equals([244, 'smooth'])
    expect(getComputedStyle(row).backgroundColor).not.equals(before)
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Draft body'
    )
    await act(async () => {
      await wait(1490)
    })
    expect(getComputedStyle(row).backgroundColor).equals(before)
  })

  for (const [cancelAt, layoutBeforeResolution] of [
    [undefined, false],
    [undefined, true],
    ['before-removal', false],
    ['before-removal', true],
    ['native-window', true],
    ['after-removal', true],
    ['after-resolution', false],
    ['after-resolution-auto-anchor', false],
    ['after-resolution-growth', false],
    ['after-resolution-equal-size', false],
    ['after-removal-no-row-layout', true],
    ['manual-overlap', true]
  ] as const) {
    it(`preserves the reading anchor when an empty older page removes the paging header (${cancelAt ?? 'no cancellation'}, layout first: ${layoutBeforeResolution})`, async function () {
      this.timeout(10000)
      const cancel = cancelAt != null && cancelAt !== 'manual-overlap'
      if (root != null) {
        await act(async () => {
          root!.unmount()
        })
        root = undefined
      }
      const engine = new FakeEngine()
      const reading = safeMessage({
        id: 'msg_empty_page_reading',
        seq: 19,
        body: 'Current reading anchor'
      })
      const reply = safeMessage({
        id: 'msg_empty_page_reply',
        seq: 20,
        quote: {
          id: 'msg_unavailable_original',
          authorId: 2,
          authorName: undefined,
          snippet: 'Message unavailable',
          status: 'unavailable'
        }
      })
      engine.current = {
        ...engine.current,
        messages: [reading, reply],
        historyBefore: 19,
        hasEarlier: true
      }
      let finish: ((next: ConversationView) => void) | undefined
      engine.loadEarlier = async () =>
        await new Promise(resolve => {
          finish = resolve
        })
      await screen(engine, {
        text: 'Current draft',
        picked: [],
        scrollOffset: 80,
        scrollAnchor:
          cancelAt === 'manual-overlap'
            ? { id: reading.id, relativeY: 320 }
            : undefined
      })
      const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
        node => getComputedStyle(node).overflowY === 'auto'
      )!
      const body = scroller.firstElementChild as HTMLElement
      const anchor = positionWrapper(reading.id)
      let contentHeight = 1000
      let anchorContentY = 400
      scroller.getBoundingClientRect = () => new window.DOMRect(0, 0, 640, 400)
      body.getBoundingClientRect = () =>
        new window.DOMRect(0, -scroller.scrollTop, 640, contentHeight)
      anchor.getBoundingClientRect = () =>
        new window.DOMRect(0, anchorContentY - scroller.scrollTop, 640, 100)
      Object.defineProperties(scroller, {
        offsetHeight: { value: 400, configurable: true },
        offsetWidth: { value: 640, configurable: true },
        scrollHeight: { get: () => contentHeight, configurable: true }
      })
      Object.defineProperties(body, {
        offsetParent: { value: scroller, configurable: true },
        offsetHeight: { get: () => contentHeight, configurable: true },
        offsetWidth: { value: 640, configurable: true }
      })
      Object.defineProperties(anchor, {
        offsetParent: { value: body, configurable: true },
        offsetTop: { get: () => anchorContentY, configurable: true },
        offsetHeight: { value: 100, configurable: true },
        offsetWidth: { value: 640, configurable: true }
      })
      scroller.scroll = options => {
        scroller.scrollTop = (options as ScrollToOptions).top ?? 0
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      }
      await measured(scroller, 640, 400)
      await measured(body, 640, contentHeight)
      const nativeAnchor = anchor as HTMLElement & {
        measureLayout: (
          relative: unknown,
          success: (x: number, y: number, width: number, height: number) => void
        ) => void
      }
      const measureCurrentAnchor = nativeAnchor.measureLayout
      await measured(anchor, 640, 100, anchorContentY)
      nativeAnchor.measureLayout = measureCurrentAnchor
      expect(scroller.scrollTop).equals(80)
      expect(button('Load earlier messages').textContent).equals(
        'Load earlier messages'
      )
      if (cancelAt === 'native-window') {
        // Native measureLayout excludes the ScrollView content offset; only
        // the public window measurements establish the visible row position.
        scroller.getBoundingClientRect = () => new window.DOMRect()
        nativeAnchor.measureLayout = (_relative, success) => {
          success(0, anchorContentY, 640, 100)
        }
        const windowRow = nativeAnchor as typeof nativeAnchor & {
          measureInWindow: (
            done: (x: number, y: number, width: number, height: number) => void
          ) => void
        }
        windowRow.measureInWindow = done => {
          done(0, 40 + anchorContentY - scroller.scrollTop, 640, 100)
        }
        const windowPane = scroller as HTMLElement & {
          measureInWindow: typeof windowRow.measureInWindow
        }
        windowPane.measureInWindow = done => {
          done(0, 40, 640, 400)
        }
      }
      const measurements: Array<() => void> = []
      if (cancelAt === 'manual-overlap') {
        nativeAnchor.measureLayout = (_relative, success) => {
          measurements.push(() => {
            success(0, anchorContentY, 640, 100)
          })
        }
        // A saved anchor is still being measured when manual paging starts.
        await measured(body, 640, contentHeight)
      }
      await press(
        cancelAt === 'manual-overlap'
          ? 'Load earlier messages'
          : 'Jump to message from Former member: Message unavailable'
      )
      expect(finish).not.equals(undefined)
      const userScroll = async (): Promise<void> => {
        await act(async () => {
          scroller.dispatchEvent(
            new window.WheelEvent('wheel', { bubbles: true, deltaY: 160 })
          )
          scroller.scrollTop = 240
          scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
          await wait(cancelAt === 'after-resolution-auto-anchor' ? 120 : 5)
        })
      }
      if (cancelAt === 'before-removal' || cancelAt === 'native-window')
        await userScroll()
      let selectedY = anchor.getBoundingClientRect().top
      const next = { ...engine.current, hasEarlier: false }
      await act(async () => {
        engine.update(next)
        await wait()
      })
      expect(
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
          node => node.textContent === 'Load earlier messages'
        )
      ).equals(false)
      const removeHeaderGeometry = async (): Promise<void> => {
        anchorContentY -= 56
        contentHeight -= 56
        if (
          cancelAt !== 'after-removal-no-row-layout' &&
          cancelAt !== 'manual-overlap'
        ) {
          await measured(anchor, 640, 100, anchorContentY)
          nativeAnchor.measureLayout = measureCurrentAnchor
        }
        await measured(body, 640, contentHeight)
      }
      if (layoutBeforeResolution) await removeHeaderGeometry()
      if (
        cancelAt === 'after-removal' ||
        cancelAt === 'after-removal-no-row-layout'
      ) {
        await userScroll()
        selectedY = anchor.getBoundingClientRect().top
      }
      await act(async () => {
        if (cancelAt === 'manual-overlap')
          nativeAnchor.measureLayout = measureCurrentAnchor
        finish!(next)
        if (cancelAt === 'manual-overlap') {
          // Let paging replace the anchor while the earlier measurement is
          // still pending, then retire that earlier measurement.
          await wait(10)
          expect(measurements.length).equals(1)
          measurements.forEach(finishMeasurement => {
            finishMeasurement()
          })
        }
        await wait(cancelAt === 'manual-overlap' ? 20 : 80)
      })
      if (cancelAt === 'after-resolution-growth') {
        // An append or image below this row can grow content before the
        // paging header's delayed layout. It must not retire compensation.
        contentHeight += 100
        await measured(body, 640, contentHeight)
      }
      if (
        cancelAt === 'after-resolution' ||
        cancelAt === 'after-resolution-auto-anchor' ||
        cancelAt === 'after-resolution-equal-size' ||
        cancelAt === 'after-resolution-growth'
      ) {
        await userScroll()
        selectedY = anchor.getBoundingClientRect().top
      }
      if (cancelAt === 'after-resolution-equal-size') {
        // Header removal and downstream growth cancel in total height.
        // Only the genuine first-row layout reports the changed position.
        anchorContentY -= 56
        await measured(anchor, 640, 100, anchorContentY)
        nativeAnchor.measureLayout = measureCurrentAnchor
      } else if (cancelAt === 'after-resolution-auto-anchor') {
        // Browser anchoring adjusts the offset before content size is reported,
        // while position-only row movement does not emit ResizeObserver.
        anchorContentY -= 56
        contentHeight -= 56
        await act(async () => {
          scroller.scrollTop -= 56
          scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
          await wait()
        })
        await measured(body, 640, contentHeight)
      } else if (!layoutBeforeResolution) await removeHeaderGeometry()
      await act(async () => {
        await wait(80)
      })
      expect(
        anchor.getBoundingClientRect().top,
        `cancel at: ${cancelAt}, layout before resolution: ${layoutBeforeResolution}`
      ).equals(selectedY)
      expect(scroller.scrollTop).equals(
        cancelAt === 'after-removal' ||
          cancelAt === 'after-removal-no-row-layout'
          ? 240
          : cancel
            ? 184
            : 24
      )
      expect((labelled('Message') as HTMLTextAreaElement).value).equals(
        'Current draft'
      )
    })
  }

  for (const [phase, afterCompensation] of [
    ['ongoing', false],
    ['drag-end', false],
    ['momentum-end', false],
    ['programmatic', false],
    ['ongoing', true],
    ['drag-end', true],
    ['momentum-end', true]
  ] as const) {
    it(`preserves the native reader across exhausted header layout (${phase}, movement after compensation: ${afterCompensation})`, async function () {
      const engine = new FakeEngine()
      const reading = safeMessage({
        id: 'msg_native_page_reading',
        seq: 19,
        body: 'Current reading anchor'
      })
      engine.current = {
        ...engine.current,
        messages: [reading],
        hasEarlier: true,
        historyBefore: 19
      }
      let finish: ((next: ConversationView) => void) | undefined
      engine.loadEarlier = async () =>
        await new Promise(resolve => {
          finish = resolve
        })
      let saved: ChatDraft = {
        text: 'Current draft',
        picked: [],
        scrollOffset: 80
      }
      await screen(engine, saved, next => {
        saved = next
      })
      const geometry = readingGeometry(reading.id, 400, 1000)
      await geometry.layout()
      // Public native ref stand-ins: layout coordinates deliberately exclude
      // scrolling, while window coordinates expose the actual visible row.
      geometry.scroller.getBoundingClientRect = () => new window.DOMRect()
      const windowRow = geometry.row as HTMLElement & {
        measureInWindow: (
          done: (x: number, y: number, width: number, height: number) => void
        ) => void
      }
      windowRow.measureInWindow = done => {
        done(
          0,
          40 + geometry.geometry.y - geometry.scroller.scrollTop,
          640,
          800
        )
      }
      const windowPane = geometry.scroller as HTMLElement & {
        measureInWindow: typeof windowRow.measureInWindow
      }
      windowPane.measureInWindow = done => {
        done(0, 40, 640, 400)
      }
      await press('Load earlier messages')
      interface ScrollEvent {
        nativeEvent: {
          contentOffset: { x: number; y: number }
          contentSize: { width: number; height: number }
          layoutMeasurement: { width: number; height: number }
        }
      }
      interface Callbacks {
        onContentSizeChange?: unknown
        onScrollBeginDrag: () => void
        onScroll: (event: ScrollEvent) => void
        onScrollEndDrag: (event: ScrollEvent) => void
        onMomentumScrollBegin?: () => void
        onMomentumScrollEnd: (event: ScrollEvent) => void
      }
      const callbacks = (): Callbacks => {
        interface Fiber {
          memoizedProps?: Callbacks
          return?: Fiber
        }
        const key = Object.keys(geometry.scroller).find(name =>
          name.startsWith('__reactFiber$')
        )!
        let fiber = (
          geometry.scroller as unknown as Record<string, Fiber | undefined>
        )[key]
        while (fiber != null) {
          if (typeof fiber.memoizedProps?.onContentSizeChange === 'function')
            return fiber.memoizedProps
          fiber = fiber.return
        }
        throw Error('Rendered message ScrollView callbacks unavailable')
      }
      const native = (action: () => void): void => {
        const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!
        try {
          Object.defineProperty(Platform, 'OS', { ...descriptor, value: 'ios' })
          action()
        } finally {
          Object.defineProperty(Platform, 'OS', descriptor)
        }
      }
      const event = (offset: number): ScrollEvent => ({
        nativeEvent: {
          contentOffset: { x: 0, y: offset },
          contentSize: { width: 640, height: geometry.geometry.height },
          layoutMeasurement: { width: 640, height: 400 }
        }
      })
      if (phase !== 'programmatic')
        await act(async () => {
          native(() => {
            callbacks().onScrollBeginDrag()
          })
          await wait(5)
        })
      await act(async () => {
        engine.update({ ...engine.current, hasEarlier: false })
        await wait()
      })
      // RNW refreshes host methods on render; reinstall the public native
      // window stand-ins on this newly rendered native event sequence.
      windowRow.measureInWindow = done => {
        done(
          0,
          40 + geometry.geometry.y - geometry.scroller.scrollTop,
          640,
          800
        )
      }
      windowPane.measureInWindow = done => {
        done(0, 40, 640, 400)
      }
      await act(async () => {
        if (phase === 'momentum-end') {
          geometry.scroller.scrollTop = 160
          native(() => {
            callbacks().onScrollEndDrag(event(160))
          })
          native(() => {
            callbacks().onMomentumScrollBegin?.()
          })
        } else if (phase === 'programmatic')
          native(() => {
            callbacks().onMomentumScrollBegin?.()
          })
        geometry.scroller.scrollTop = 240
        native(() => {
          if (phase === 'ongoing' || afterCompensation)
            callbacks().onScroll(event(240))
          else if (phase === 'drag-end') callbacks().onScrollEndDrag(event(240))
          else callbacks().onMomentumScrollEnd(event(240))
        })
        await wait(5)
      })
      const chosenY =
        phase === 'programmatic'
          ? 320
          : geometry.row.getBoundingClientRect().top
      geometry.geometry.y -= 56
      geometry.geometry.height -= 56
      await measured(geometry.body, 640, geometry.geometry.height)
      await act(async () => {
        finish!(engine.current)
        await wait(80)
      })
      if (afterCompensation) {
        await measured(geometry.row, 640, 800, geometry.geometry.y)
        await act(async () => {
          geometry.scroller.scrollTop = 220
          native(() => {
            if (phase === 'ongoing') callbacks().onScroll(event(220))
            else if (phase === 'drag-end')
              callbacks().onScrollEndDrag(event(220))
            else callbacks().onMomentumScrollEnd(event(220))
          })
          await wait(5)
        })
        expect(saved.scrollOffset).equals(220)
        expect(saved.scrollAnchor).deep.equals({
          id: reading.id,
          relativeY: 124
        })
        expect(geometry.row.getBoundingClientRect().top).equals(124)
      } else {
        expect(geometry.row.getBoundingClientRect().top).equals(chosenY)
        expect(geometry.scroller.scrollTop).equals(
          phase === 'programmatic' ? 24 : 184
        )
      }
      expect((labelled('Message') as HTMLTextAreaElement).value).equals(
        'Current draft'
      )
    })
  }

  it('recaptures the reading anchor after hiding during an exhaustion header measurement', async function () {
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_hidden_page_reading',
      seq: 19,
      body: 'Current reading anchor'
    })
    engine.current = {
      ...engine.current,
      messages: [reading],
      hasEarlier: true,
      historyBefore: 19
    }
    let finish: ((next: ConversationView) => void) | undefined
    engine.loadEarlier = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    let saved: ChatDraft = {
      text: 'Current draft',
      picked: [],
      scrollOffset: 80
    }
    const show = async (active = true): Promise<void> => {
      await render(
        <ChatOverlayHost>
          <ConversationScreen
            engine={engine}
            conversationId="cnv_fixture"
            userId={1}
            onMembers={() => {}}
            files={files}
            swipe={false}
            embedded
            active={active}
            draft={saved}
            onDraftChange={next => {
              saved = next
            }}
          />
        </ChatOverlayHost>
      )
    }
    await show()
    let geometry = readingGeometry(reading.id, 400, 1000)
    await geometry.layout()
    await geometry.userScroll(80)
    await press('Load earlier messages')
    let complete:
      | ((x: number, y: number, width: number, height: number) => void)
      | undefined
    const nativeRow = geometry.row as HTMLElement & {
      measureLayout: (
        relative: unknown,
        success: NonNullable<typeof complete>
      ) => void
    }
    nativeRow.measureLayout = (_relative, success) => {
      complete = success
    }
    await act(async () => {
      engine.update({ ...engine.current, hasEarlier: false })
      finish!(engine.current)
      await wait(10)
    })
    expect(complete).not.equals(undefined)
    await show(false)
    await act(async () => {
      complete!(0, 344, 640, 800)
      await wait()
    })
    await show(true)
    geometry = readingGeometry(reading.id, 344, 944)
    await geometry.layout()
    await geometry.userScroll(80)
    await measured(geometry.row, 640, 800, 444)
    expect(saved.scrollAnchor).deep.equals({ id: reading.id, relativeY: 364 })
  })

  it('retires an exhausted page without prior row geometry so a later layout can capture the reading anchor', async function () {
    const engine = new FakeEngine()
    const reading = safeMessage({
      id: 'msg_later_reading_anchor',
      seq: 19,
      body: 'Current reading anchor'
    })
    engine.current = {
      ...engine.current,
      messages: [reading],
      historyBefore: 19,
      hasEarlier: true
    }
    engine.loadEarlier = async () => {
      engine.update({ ...engine.current, hasEarlier: false })
      return engine.current
    }
    let saved: ChatDraft | undefined
    await render(
      <ChatOverlayHost>
        <ConversationScreen
          engine={engine}
          conversationId="cnv_fixture"
          userId={1}
          onMembers={() => {}}
          files={files}
          swipe={false}
          embedded
          draft={{ text: 'Current draft', picked: [], scrollOffset: 80 }}
          onDraftChange={next => {
            saved = next
          }}
        />
      </ChatOverlayHost>
    )
    const geometry = readingGeometry(reading.id, 400, 1000)
    const visibleRowBounds = geometry.row.getBoundingClientRect.bind(
      geometry.row
    )
    geometry.row.getBoundingClientRect = () => new window.DOMRect()
    await measured(geometry.scroller, 640, 400)
    await measured(geometry.body, 640, 1000)
    await act(async () => {
      geometry.scroller.dispatchEvent(
        new window.WheelEvent('wheel', { bubbles: true, deltaY: 1 })
      )
      await wait()
    })
    expect(saved?.scrollAnchor).equals(undefined)
    await press('Load earlier messages')
    expect(engine.current.hasEarlier).equals(false)
    geometry.geometry.y = 344
    geometry.geometry.height = 944
    geometry.row.getBoundingClientRect = visibleRowBounds
    await measured(geometry.body, 640, 944)
    await measured(geometry.row, 640, 800, 344)
    expect(saved?.scrollAnchor).deep.equals({
      id: reading.id,
      relativeY: 264
    })
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Current draft'
    )
  })

  it('leaves position unchanged when the original is unavailable or paging fails', async function () {
    const engine = new FakeEngine()
    engine.current.messages = [
      safeMessage({
        quote: {
          id: 'msg_missing',
          authorId: 2,
          authorName: undefined,
          snippet: 'Message unavailable',
          status: 'unavailable'
        }
      })
    ]
    await screen(engine)
    const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
      node => getComputedStyle(node).overflowY === 'auto'
    )!
    const moves: unknown[] = []
    scroller.scroll = options => {
      moves.push(options)
    }
    await press('Jump to message from Former member: Message unavailable')
    expect(document.body.textContent).contains('Message unavailable')
    expect(moves).length(0)
    engine.current = { ...engine.current, hasEarlier: true, historyBefore: 10 }
    engine.loadEarlier = async () => {
      throw new Error('Unavailable')
    }
    await press('Jump to message from Former member: Message unavailable')
    expect(moves).length(0)
  })

  it('allows unpinning an unreadable personal placeholder while its composer is locked', async function () {
    const engine = new FakeEngine()
    engine.current = {
      ...engine.current,
      composer: 'locked',
      pins: [{ messageId: 'msg_1', pinnedAt: '2027-04-01T17:00:00Z' }],
      messages: [safeMessage({ status: 'locked', body: 'Stale body' })]
    }
    await screen(engine)
    await press('More message actions')
    expect(document.querySelector('[aria-label="Copy text"]')).equals(null)
    expect(document.body.textContent).not.contains('Stale body')
    await press('Unpin')
    expect(engine.calls.at(-1)).deep.equals([
      'pin',
      'cnv_fixture',
      'msg_1',
      false
    ])
    expect(document.querySelector('[aria-label="Pinned messages: 1"]')).equals(
      null
    )
  })

  it('copies the latest decrypted body or caption and revalidates changed permissions before action', async function () {
    const engine = new FakeEngine()
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text)
        }
      }
    })
    await screen(engine)
    await press('More message actions')
    engine.current = {
      ...engine.current,
      messages: [safeMessage({ body: 'Updated caption' })]
    }
    await press('Copy text')
    expect(copied).deep.equals(['Updated caption'])
    await press('More message actions')
    engine.current = {
      ...engine.current,
      messages: [safeMessage({ status: 'removed', body: '' })]
    }
    await press('Copy text')
    expect(copied).length(1)
    expect(document.body.textContent).contains('Message unavailable')
  })

  it('updates the personal pin badge and header count, opens the list and unpins through the original menu', async function () {
    const engine = new FakeEngine()
    await screen(engine)
    await press('More message actions')
    await press('Pin')
    expect(engine.calls).deep.equals([['pin', 'cnv_fixture', 'msg_1', true]])
    expect(labelled('Pinned message')).not.equals(undefined)
    await press('Pinned messages: 1')
    expect(labelled('Pinned messages').textContent).contains('Game day')
    await press('Cancel')
    await press('More message actions')
    await press('Unpin')
    expect(engine.calls.at(-1)).deep.equals([
      'pin',
      'cnv_fixture',
      'msg_1',
      false
    ])
    expect(document.querySelector('[aria-label="Pinned message"]')).equals(null)
    expect(document.querySelector('[aria-label="Pinned messages: 1"]')).equals(
      null
    )
  })

  it('cancelling a reply preserves body and prepared files, while failed sending preserves the reply context', async function () {
    const engine = new FakeEngine()
    const picked: PickedFile[] = [
      {
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1])
      }
    ]
    const draft = {
      text: 'Prepared caption',
      picked,
      replyTo: safeMessage(),
      scrollOffset: 0
    }
    await screen(engine, draft)
    expect(document.body.textContent).contains('Replying to Shohei Ohtani')
    await press('Cancel reply')
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Prepared caption'
    )
    expect(document.body.textContent).contains('notes.pdf')
    await press('Reply')
    engine.failSend = true
    await press('Send')
    expect(document.body.textContent)
      .contains('Replying to Shohei Ohtani')
      .and.contains('That did not send. Try again.')
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Prepared caption'
    )
    expect(engine.calls.at(-1)).deep.equals([
      'attach',
      'cnv_fixture',
      picked,
      'Prepared caption',
      { quoteId: 'msg_1' }
    ])
    engine.failSend = false
    await press('Send')
    expect((labelled('Message') as HTMLTextAreaElement).value).equals('')
    expect(document.querySelector('[aria-label="Cancel reply"]')).equals(null)
    expect(
      document.querySelector('[data-testid="chat-attachment-chip"]')
    ).equals(null)
  })

  it('refreshes reply compose text after edit and deletion and never uses a stale draft snapshot', async function () {
    const engine = new FakeEngine()
    await screen(engine, {
      text: 'Draft body',
      picked: [],
      replyTo: safeMessage({ body: 'Stale snapshot' }),
      scrollOffset: 0
    })
    expect(document.body.textContent).not.contains('Stale snapshot')
    await act(async () => {
      engine.update({
        ...engine.current,
        messages: [safeMessage({ body: 'Edited original' })]
      })
      await wait()
    })
    expect(document.body.textContent).contains('Edited original')
    await act(async () => {
      engine.update({
        ...engine.current,
        messages: [safeMessage({ status: 'removed', body: '' })]
      })
      await wait()
    })
    expect(document.body.textContent)
      .contains('Message deleted')
      .and.not.contains('Edited original')
    await act(async () => {
      engine.update({ ...engine.current, messages: [] })
      await wait()
    })
    expect(document.body.textContent).contains('Message unavailable')
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Draft body'
    )
  })

  it('toggles an existing reaction through the mobile quick reaction menu', async function () {
    const engine = new FakeEngine()
    engine.current.messages = [
      safeMessage({ reactions: [{ emoji: '👍', mine: true, userIds: [1] }] })
    ]
    await screen(engine)
    pointer(false)
    await act(async () => {
      engine.update({ ...engine.current })
      await wait()
    })
    await press('More message actions')
    await press('React with 👍')
    expect(engine.calls.at(-1)).deep.equals([
      'react',
      'cnv_fixture',
      'msg_1',
      '👍',
      true
    ])
    expect(
      document.querySelector('[aria-label="Message from Shohei Ohtani"]')
    ).equals(null)
  })
})
