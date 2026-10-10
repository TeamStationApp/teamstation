import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { ChatListScreen } from './ChatListScreen'
import { ChatOverlayHost } from './ChatOverlayHost'
import { chat } from './chatViews.test.helpers'
import {
  bindPopupKeys,
  focusPopupControl,
  isRestoringPopupFocus
} from './chatWebInteractions'
import {
  bindPopupKeys as bindNativePopupKeys,
  focusPopupControl as focusNativePopupControl,
  isRestoringPopupFocus as isRestoringNativeFocus
} from './chatWebInteractions.native'
import { ConversationMenu } from './ConversationMenu'
import type { ConversationListItem } from './engine/engine'

let root: Root | undefined
let stopKeys: (() => void) | undefined
const originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate')

afterEach(async function () {
  stopKeys?.()
  stopKeys = undefined
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  mock.timers.reset()
  if (originalVibrate != null)
    Object.defineProperty(navigator, 'vibrate', originalVibrate)
  else Reflect.deleteProperty(navigator, 'vibrate')
})

const wait = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
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

function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.getAttribute('aria-label') === label ||
      (node.getAttribute('aria-label') == null &&
        node.textContent?.endsWith(label) === true)
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

function key(name: string, shiftKey = false): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', {
    key: name,
    shiftKey,
    bubbles: true,
    cancelable: true
  })
  document.dispatchEvent(event)
  return event
}

const sample = (
  over: Partial<ConversationListItem> = {}
): ConversationListItem =>
  chat({
    id: 'cnv_aurora',
    title: 'Aurora Members',
    scopeName: 'Aurora',
    ...over
  })

describe('chat UI follow-up popup keyboard', function () {
  it('cycles arrows and Tab inside the popup and supports Home, End and Escape', function () {
    const trigger = document.createElement('button')
    const panel = document.createElement('div')
    const first = document.createElement('button')
    const second = document.createElement('button')
    const third = document.createElement('button')
    panel.append(first, second, third)
    document.body.append(trigger, panel)
    const restored: Array<[boolean, boolean]> = []
    trigger.addEventListener('focus', () => {
      restored.push([isRestoringPopupFocus(), isRestoringNativeFocus()])
    })
    trigger.focus()
    let closed = 0
    stopKeys = bindPopupKeys(panel, () => {
      closed += 1
    })
    expect(document.activeElement).equals(first)
    expect(key('ArrowUp').defaultPrevented).equals(true)
    expect(document.activeElement).equals(third)
    key('ArrowDown')
    expect(document.activeElement).equals(first)
    key('Tab')
    expect(document.activeElement).equals(second)
    key('Tab', true)
    expect(document.activeElement).equals(first)
    key('End')
    expect(document.activeElement).equals(third)
    key('Home')
    expect(document.activeElement).equals(first)
    expect(key('x').defaultPrevented).equals(false)
    expect(key('Escape').defaultPrevented).equals(true)
    expect(closed).equals(1)
    stopKeys()
    stopKeys = undefined
    expect(document.activeElement).equals(trigger)
    expect(restored).deep.equals([
      [false, false],
      [true, false]
    ])
    expect(isRestoringPopupFocus()).equals(false)
    key('Escape')
    expect(closed).equals(1)
    const focused = document.createElement('button')
    document.body.append(focused)
    focused.focus()
    focusPopupControl(undefined)
    focusPopupControl(document.createElement('div'))
    focusNativePopupControl(panel)
    expect(document.activeElement).equals(focused)
  })

  it('closes an empty popup and tolerates a removed focus trigger or missing native view', function () {
    const trigger = document.createElement('button')
    const empty = document.createElement('div')
    document.body.append(trigger, empty)
    trigger.focus()
    let closed = 0
    stopKeys = bindPopupKeys(empty, () => {
      closed += 1
    })
    key('ArrowDown')
    key('ArrowUp')
    key('Home')
    key('End')
    key('Escape')
    expect(closed).equals(1)
    trigger.remove()
    expect(() => stopKeys?.()).not.throws()
    stopKeys = undefined
    const nativeStop = bindNativePopupKeys(undefined, () => {
      closed += 1
    })
    expect(() => {
      nativeStop()
    }).not.throws()
    expect(() => {
      bindPopupKeys(undefined, () => {
        closed += 1
      })()
    }).not.throws()
    expect(closed).equals(1)
  })
})

describe('chat UI follow-up conversation menu', function () {
  it('keeps the exact personal actions available on a locked read-only conversation', async function () {
    const calls: unknown[] = []
    let closed = 0
    await render(
      <ConversationMenu
        conversation={sample({ locked: true, canPost: false, closed: true })}
        engine={{
          setPreferences: async (id, patch) => {
            calls.push([id, patch])
          }
        }}
        onClose={() => {
          closed += 1
        }}
      />
    )
    expect(
      [
        ...labelled('Conversation actions').querySelectorAll(
          '[role="button"],button'
        )
      ].map(node => node.textContent)
    ).deep.equals(['Mark unread', 'Mute', 'Pin'])
    expect(document.body.textContent).not.contains('Delete')
    await press('Mark unread')
    expect(calls).deep.equals([['cnv_aurora', { manualUnread: true }]])
    expect(closed).equals(1)
  })

  it('toggles existing mute and pin preferences and reports a failure without closing', async function () {
    const calls: unknown[] = []
    let refused = true
    let closed = 0
    const engine = {
      setPreferences: async (id: string, patch: object) => {
        calls.push([id, patch])
        if (refused) throw new Error('Unavailable')
      }
    }
    await render(
      <ConversationMenu
        conversation={sample({
          preview: 'Bring water',
          preferences: {
            pinned: true,
            muted: true,
            manualUnread: false,
            manualUnreadRevision: 0
          }
        })}
        engine={engine}
        onClose={() => {
          closed += 1
        }}
      />
    )
    expect(document.body.textContent).contains('Bring water')
    await press('Unmute')
    expect(document.body.textContent).contains(
      'Could not update this conversation. Try again.'
    )
    expect(closed).equals(0)
    refused = false
    await press('Unpin')
    expect(calls).deep.equals([
      ['cnv_aurora', { muted: false }],
      ['cnv_aurora', { pinned: false }]
    ])
    expect(closed).equals(1)
  })

  it('rejects an unavailable preference capability and prevents a second action while saving', async function () {
    let complete: (() => void) | undefined
    const calls: object[] = []
    await render(
      <ConversationMenu
        conversation={sample()}
        engine={{
          setPreferences: async (_id, patch) => {
            calls.push(patch)
            await new Promise<void>(resolve => {
              complete = resolve
            })
          }
        }}
        onClose={() => {}}
      />
    )
    await press('Mute')
    await press('Pin')
    expect(calls).deep.equals([{ muted: true }])
    await act(async () => {
      complete?.()
      await Promise.resolve()
    })
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ConversationMenu
            conversation={sample()}
            engine={{}}
            onClose={() => {}}
          />
        </ThemeProvider>
      )
      await wait()
    })
    await press('Pin')
    expect(document.body.textContent).contains(
      'Could not update this conversation. Try again.'
    )
  })

  it('uses the same-window overlay host, blocks background access and restores focus after outside dismissal', async function () {
    function App(): React.ReactElement {
      const [open, setOpen] = useState(false)
      return (
        <ChatOverlayHost>
          <button
            aria-label="Open actions"
            onClick={() => {
              setOpen(true)
            }}
          >
            Open actions
          </button>
          {open && (
            <ChatActionOverlay
              label="Fixture actions"
              selected={<div>Selected conversation</div>}
              onClose={() => {
                setOpen(false)
              }}
            >
              <button>Pin</button>
              <button>Mute</button>
            </ChatActionOverlay>
          )}
        </ChatOverlayHost>
      )
    }
    await render(<App />)
    const trigger = button('Open actions')
    trigger.focus()
    await press('Open actions')
    expect(labelled('Fixture actions').textContent).contains(
      'Selected conversation'
    )
    expect(trigger.closest('[aria-hidden="true"]')).not.equals(null)
    expect(document.activeElement?.textContent).equals('Pin')
    await press('Cancel')
    expect(document.querySelector('[aria-label="Fixture actions"]')).equals(
      null
    )
    expect(trigger.closest('[aria-hidden="true"]')).equals(null)
    expect(document.activeElement).equals(trigger)
    await press('Open actions')
    await act(async () => {
      key('Escape')
      await wait()
    })
    expect(document.querySelector('[aria-label="Fixture actions"]')).equals(
      null
    )
    expect(document.activeElement).equals(trigger)
  })
})

describe('chat UI follow-up conversation hold', function () {
  async function mount(onOpen: () => void = () => {}): Promise<HTMLElement> {
    const list = [sample()]
    await render(
      <ChatListScreen
        narrow
        embedded
        engine={{
          refresh: async () => list,
          conversations: () => list,
          subscribe: () => () => {}
        }}
        onOpen={onOpen}
        onNewMessage={() => {}}
        onFollowTeam={() => {}}
      />
    )
    mock.timers.enable({ apis: ['setTimeout'] })
    return labelled('Aurora Members')
  }
  async function mouse(
    node: HTMLElement,
    type: string,
    x = 20,
    y = 20
  ): Promise<void> {
    await act(async () => {
      node.dispatchEvent(
        new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
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

  it('recognizes at 500 ms exactly, pulses once and does not also open the conversation', async function () {
    let pulses = 0
    let opened = 0
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        pulses += 1
        return true
      }
    })
    const row = await mount(() => {
      opened += 1
    })
    await mouse(row, 'mousedown')
    await tick(499)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
    await tick(1)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).not.equals(null)
    await tick(1000)
    await mouse(row, 'mouseup')
    expect(pulses).equals(1)
    expect(opened).equals(0)
  })

  it('cancels an early release and still allows the explicit accessible actions entry', async function () {
    const row = await mount()
    await mouse(row, 'mousedown')
    await tick(499)
    await mouse(row, 'mouseup')
    await tick(1)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
    await act(async () => {
      labelled('Conversation actions: Aurora Members').click()
      await Promise.resolve()
    })
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).not.equals(null)
  })

  it('cancels a moved or scrolling hold before recognition', async function () {
    const row = await mount()
    await mouse(row, 'mousedown')
    await mouse(row, 'mousemove', 40, 20)
    await tick(500)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
    await mouse(row, 'mouseup', 40, 20)
    await mouse(row, 'mousedown')
    await act(async () => {
      const scroller = [...document.querySelectorAll<HTMLElement>('div')].find(
        node => getComputedStyle(node).overflowY === 'auto'
      )
      expect(scroller, 'scrollable conversation list').not.equals(undefined)
      scroller!.scrollTop = 30
      scroller!.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    await tick(500)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).equals(null)
    await mouse(row, 'mouseup')
  })

  it('still recognizes when optional browser vibration refuses', async function () {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('Unavailable')
      }
    })
    const row = await mount()
    await mouse(row, 'mousedown')
    await tick(500)
    expect(
      document.querySelector('[aria-label="Conversation actions"]')
    ).not.equals(null)
    await mouse(row, 'mouseup')
  })
})
