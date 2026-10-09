import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import type { PickedFile } from './chatFileTypes'
import { ChatOverlayHost } from './ChatOverlayHost'
import { chat, member, message, view } from './chatViews.test.helpers'
import {
  bindMessageHover,
  bindMessageTooltips,
  bindUserScroll,
  isFinePointer,
  messageTooltipProps,
  watchMessageAnchor
} from './chatWebInteractions'
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

let root: Root | undefined
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
  mock.timers.reset()
  for (const stop of stops.splice(0)) stop()
  await act(async () => {
    root?.unmount()
  })
  root = undefined
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
  it('shows exact quick emoji actions plus More and invokes reply, reaction and picker callbacks', async function () {
    const calls: string[] = []
    await render(
      <ChatOverlayHost>
        <button aria-label="Background">Background</button>
        <MessageMenu
          {...menuProps({
            onReply: () => calls.push('reply'),
            onReact: emoji => calls.push(emoji),
            onMoreEmoji: () => calls.push('more')
          })}
        />
      </ChatOverlayHost>
    )
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
    expect(button('More emoji')).not.equals(undefined)
    for (const emoji of ['❤️', '👍', '👎', '😂', '😮', '😢'])
      await press(`React with ${emoji}`)
    await press('More emoji')
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
    expect(button('Background').closest('[aria-hidden="true"]')).not.equals(
      null
    )
    expect(document.activeElement?.getAttribute('aria-label')).equals(
      'React with ❤️'
    )
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
    await press('Cancel', labelled('Message from You'))
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
  draft?: React.ComponentProps<typeof ConversationScreen>['draft']
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

describe('chat follow-up conversation message integration', function () {
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
    expect(moves).deep.equals([292])
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
    expect(moves).deep.equals([492])
    await act(async () => {
      button('Jump to message from Shohei Ohtani: First original').click()
      await Promise.resolve()
    })
    await act(async () => {
      root!.unmount()
      root = undefined
      await wait(80)
    })
    expect(moves).deep.equals([492])
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
    expect(moves.at(-1)).deep.equals([292, 'smooth'])
    expect(getComputedStyle(row).backgroundColor).not.equals(before)
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Draft body'
    )
    await act(async () => {
      await wait(1490)
    })
    expect(getComputedStyle(row).backgroundColor).equals(before)
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
