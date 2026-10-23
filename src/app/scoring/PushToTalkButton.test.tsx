import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import type { Dictation } from './dictationTypes'
import {
  PushToTalkButton,
  type PushToTalkButtonProps
} from './PushToTalkButton'

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** The hook's state, set by each test, and what the button asked of it. */
interface Fake extends Dictation {
  calls: string[]
  since: number[]
}
function fake(more: Partial<Dictation> = {}): Fake {
  const self: Fake = {
    enabled: true,
    connected: true,
    holding: false,
    busy: false,
    text: null,
    message: null,
    ask: null,
    calls: [],
    since: [],
    setEnabled: on => {
      self.calls.push(on ? 'on' : 'off')
    },
    hold: since => {
      self.calls.push('hold')
      if (since != null) self.since.push(since)
    },
    release: () => {
      self.calls.push('release')
    },
    answer: () => undefined,
    dismiss: () => undefined,
    ...more
  }
  return self
}

/** The element the button drew, for the props only a phone calls. */
const drawn: { element?: React.ReactElement<Record<string, any>> } = {}
function Drawn(props: PushToTalkButtonProps): React.ReactElement {
  const element = PushToTalkButton(props) as React.ReactElement<
    Record<string, any>
  >
  drawn.element = element
  return element
}

async function render(props: PushToTalkButtonProps): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Drawn {...props} />
      </ThemeProvider>
    )
  })
}
const button = (): HTMLElement =>
  document.body.querySelector<HTMLElement>('[aria-label="Dictation"]')!
async function dispatch(event: Event): Promise<void> {
  await act(async () => {
    button().dispatchEvent(event)
  })
}
const pointer = async (
  type: 'pointerdown' | 'pointerup' | 'pointercancel'
): Promise<void> => {
  await dispatch(new window.MouseEvent(type, { bubbles: true }))
}
/** Calls one of the drawn element's own handlers, as React Native would. */
async function handler(name: string, ...args: unknown[]): Promise<unknown> {
  let result: unknown
  await act(async () => {
    result = (drawn.element!.props[name] as (...a: unknown[]) => unknown)(
      ...args
    )
  })
  return result
}
const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('the push-to-talk button', function () {
  it('is round and its size for Tess and the roster sheet, a pill by default', async function () {
    await render({
      dictation: fake({ enabled: false }),
      shape: 'round',
      size: 56
    })
    expect(button().style.width).equals('56px')
    expect(button().style.height).equals('56px')
    expect(button().getAttribute('aria-pressed')).equals('false')
    await render({ dictation: fake() })
    expect(button().style.width).not.equal('56px')
    expect(button().getAttribute('aria-pressed')).equals('true')
    // On, but neither connected nor holding: dimmed until it is ready.
    await render({ dictation: fake({ connected: false }), shape: 'round' })
    expect(button().style.opacity).equals('0.7')
  })

  it('switches on with a tap, and off with a tap once on', async function () {
    const off = fake({ enabled: false })
    await render({ dictation: off, tapMs: 5000 })
    await pointer('pointerdown')
    await pointer('pointerup')
    expect(off.calls).deep.equals(['on'])

    const on = fake()
    await render({ dictation: on, tapMs: 5000 })
    await pointer('pointerdown')
    await pointer('pointerup')
    expect(on.calls).deep.equals(['off'])
  })

  it('holds once a press outlasts a tap, from when it began, and lets go on release', async function () {
    const dictation = fake()
    await render({ dictation, tapMs: 20 })
    const before = Date.now()
    await pointer('pointerdown')
    expect(dictation.calls).deep.equals([])
    await wait(40)
    expect(dictation.calls).deep.equals(['hold'])
    expect(dictation.since[0]).within(before, before + 20)
    await pointer('pointerup')
    expect(dictation.calls).deep.equals(['hold', 'release'])
  })

  it('holds at once with no tap time, and counts two reports of one press once', async function () {
    const dictation = fake()
    await render({ dictation, tapMs: 0 })
    await act(async () => {
      button().dispatchEvent(
        new window.MouseEvent('pointerdown', { bubbles: true })
      )
      ;(drawn.element!.props.onResponderGrant as () => void)()
    })
    expect(dictation.calls).deep.equals(['hold'])
    await pointer('pointerup')
    expect(dictation.calls).deep.equals(['hold', 'release'])
  })

  it('holds only while ready, when pressed and when the tap has passed', async function () {
    const busy = fake({ busy: true })
    await render({ dictation: busy, tapMs: 10 })
    await pointer('pointerdown')
    await wait(30)
    expect(busy.calls).deep.equals([])

    const turning = fake()
    await render({ dictation: turning, tapMs: 20 })
    await pointer('pointerdown')
    // The last sentence's answer is still coming when the tap time is up.
    const later = fake({ busy: true })
    await render({ dictation: later, tapMs: 20 })
    await wait(40)
    expect(turning.calls).deep.equals([])
    expect(later.calls).deep.equals([])
    await pointer('pointerup')
    expect(later.calls).deep.equals(['release'])
  })

  it('lets go when the press is cancelled, and holds nothing after unmounting', async function () {
    const dictation = fake()
    await render({ dictation, tapMs: 5000 })
    const target = button() as HTMLElement & {
      setPointerCapture: (id: number) => void
    }
    target.setPointerCapture = () => {
      throw new Error('No such pointer')
    }
    await pointer('pointerdown')
    await pointer('pointercancel')
    expect(dictation.calls).deep.equals(['release'])
    // A release with no press in flight does nothing.
    await pointer('pointerup')
    expect(dictation.calls).deep.equals(['release'])

    const left = fake()
    await render({ dictation: left, tapMs: 20 })
    await pointer('pointerdown')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await wait(40)
    expect(left.calls).deep.equals([])
  })

  it('switches with Enter and ignores other keys', async function () {
    const dictation = fake()
    await render({ dictation })
    for (const key of ['Enter', 'a'])
      await dispatch(
        new window.KeyboardEvent('keydown', { key, bubbles: true })
      )
    expect(dictation.calls).deep.equals(['off'])
  })

  it('answers the responder system as a press', async function () {
    const dictation = fake({ enabled: false })
    await render({ dictation, tapMs: 5000 })
    expect(await handler('onStartShouldSetResponder')).equals(true)
    expect(await handler('onResponderTerminationRequest')).equals(false)
    await handler('onResponderGrant')
    await handler('onResponderRelease')
    expect(dictation.calls).deep.equals(['on'])
    await wait(0)
    await handler('onResponderGrant')
    await handler('onResponderTerminate')
    expect(dictation.calls).deep.equals(['on', 'release'])
  })

  it('gives assistive technology a switch and push to talk', async function () {
    const off = fake({ enabled: false })
    await render({ dictation: off })
    const action = async (actionName: string): Promise<void> => {
      await handler('onAccessibilityAction', { nativeEvent: { actionName } })
    }
    await handler('onAccessibilityTap')
    await action('activate')
    await action('pushToTalk')
    expect(off.calls).deep.equals(['on', 'on'])

    const ready = fake()
    await render({ dictation: ready })
    await handler('onAccessibilityTap')
    await action('pushToTalk')
    expect(ready.calls).deep.equals(['off', 'hold'])

    const holding = fake({ holding: true })
    await render({ dictation: holding })
    await action('pushToTalk')
    expect(holding.calls).deep.equals(['release'])

    const busy = fake({ busy: true })
    await render({ dictation: busy })
    await action('pushToTalk')
    expect(busy.calls).deep.equals([])
  })
})
