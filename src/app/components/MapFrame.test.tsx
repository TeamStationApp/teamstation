import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'

import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { MapFrame } from './MapFrame'

const READY = { type: 'teamstation:mapFrameReady' }
const point = { latitude: 40.02, longitude: -75.22 }
/** A wait the frame can answer inside, once `mount` has settled. */
const LONG_ENOUGH_TO_MOUNT = 800

const frame = (): HTMLIFrameElement | null =>
  document.querySelector<HTMLIFrameElement>('iframe[data-testid="a-map"]')

/** A message from `source`, as the frame's window would post it. */
function post(source: unknown, data: unknown): void {
  const event = new window.Event('message')
  Object.defineProperties(event, {
    data: { value: data },
    source: { value: source }
  })
  window.dispatchEvent(event)
}

/** What the frame on screen is sent, from here on. */
function sentTo(iframe: HTMLIFrameElement): unknown[] {
  const sent: unknown[] = []
  iframe.contentWindow!.postMessage = ((data: unknown) => {
    sent.push(data)
  }) as Window['postMessage']
  return sent
}

const shown = async (
  overrides: Partial<React.ComponentProps<typeof MapFrame>> = {}
): Promise<void> => {
  await mount(
    <MapFrame
      html="<p>A map</p>"
      title="A map"
      testID="a-map"
      point={point}
      {...overrides}
    />
  )
}

describe('the map frame', () => {
  afterEach(unmount)

  it('frames its own page in a sandbox with an opaque origin', async () => {
    await shown()
    const iframe = frame()!
    expect(iframe.getAttribute('src')).equals('/mapFrame.html')
    expect(iframe.getAttribute('srcdoc')).equals(null)
    const sandbox = iframe.getAttribute('sandbox')!.split(' ')
    expect(sandbox).includes('allow-scripts')
    expect(sandbox).not.includes('allow-same-origin')
    expect(iframe.getAttribute('title')).equals('A map')
  })

  it('sends the document when its own frame is ready, to nobody else', async () => {
    await shown()
    const iframe = frame()!
    const sent = sentTo(iframe)
    post(window, READY)
    post(null, READY)
    expect(sent).deep.equals([])
    post(iframe.contentWindow, READY)
    expect(sent).deep.equals([
      { type: 'teamstation:mapDocument', html: '<p>A map</p>' }
    ])
  })

  it('passes on what else its own frame posts, and nothing from elsewhere', async () => {
    const heard: unknown[] = []
    await shown({ onMessage: data => heard.push(data) })
    const iframe = frame()!
    post(window, { type: 'other' })
    post(iframe.contentWindow, { type: 'other' })
    post(iframe.contentWindow, 'text')
    post(iframe.contentWindow, null)
    expect(heard).deep.equals([{ type: 'other' }, 'text', null])
  })

  it('shows the panel when the frame never starts, and starts a new one on Retry', async () => {
    await shown({ readyMs: 10 })
    const first = frame()
    await settle(30)
    expect(frame()!.style.display).equals('none')
    expect(text()).includes('The map couldn’t load')
    expect(text()).includes('40.02000, -75.22000')
    await press('Retry')
    expect(frame()).not.equals(first)
    expect(frame()!.style.display).equals('block')
    expect(text()).not.includes('The map couldn’t load')
    // The new frame has a wait of its own.
    await settle(30)
    expect(text()).includes('The map couldn’t load')
  })

  it('keeps a slow frame loading beneath the panel, and shows it when it starts', async () => {
    await shown({ readyMs: 10 })
    const iframe = frame()!
    const sent = sentTo(iframe)
    await settle(30)
    expect(text()).includes('The map couldn’t load')
    await act(async () => {
      post(iframe.contentWindow, READY)
    })
    expect(frame()).equals(iframe)
    expect(iframe.style.display).equals('block')
    expect(text()).not.includes('The map couldn’t load')
    expect(sent).deep.equals([
      { type: 'teamstation:mapDocument', html: '<p>A map</p>' }
    ])
  })

  it('ends its wait once the frame is ready', async () => {
    await shown({ readyMs: LONG_ENOUGH_TO_MOUNT })
    const iframe = frame()!
    sentTo(iframe)
    post(iframe.contentWindow, READY)
    await settle(LONG_ENOUGH_TO_MOUNT + 50)
    expect(frame()).equals(iframe)
    expect(text()).not.includes('The map couldn’t load')
  })

  it('starts a new frame when its own document asks to retry, with a new wait', async () => {
    await shown({ readyMs: LONG_ENOUGH_TO_MOUNT })
    const first = frame()!
    sentTo(first)
    post(first.contentWindow, READY)
    post(window, { type: 'teamstation:mapRetry' })
    await settle(0)
    expect(frame()).equals(first)
    post(first.contentWindow, { type: 'teamstation:mapRetry' })
    await settle(0)
    expect(frame()).not.equals(first)
    await settle(LONG_ENOUGH_TO_MOUNT + 50)
    expect(text()).includes('The map couldn’t load')
  })

  it('starts a new frame, with a new wait, for a new document', async () => {
    let change: (html: string) => void = () => undefined
    function Changing(): React.ReactElement {
      const [html, setHtml] = useState('<p>A map</p>')
      change = setHtml
      return (
        <MapFrame
          html={html}
          title="A map"
          testID="a-map"
          point={point}
          readyMs={LONG_ENOUGH_TO_MOUNT}
        />
      )
    }
    await mount(<Changing />)
    const first = frame()!
    sentTo(first)
    post(first.contentWindow, READY)
    await act(async () => {
      change('<p>Another</p>')
    })
    const second = frame()!
    expect(second).not.equals(first)
    const sent = sentTo(second)
    post(second.contentWindow, READY)
    expect(sent).deep.equals([
      { type: 'teamstation:mapDocument', html: '<p>Another</p>' }
    ])
    // From the panel too: a new document is a new start.
    await act(async () => {
      change('<p>A third</p>')
    })
    await settle(LONG_ENOUGH_TO_MOUNT + 50)
    expect(text()).includes('The map couldn’t load')
    await act(async () => {
      change('<p>A fourth</p>')
    })
    expect(text()).not.includes('The map couldn’t load')
    // Back on a document that stalled, it is tried again.
    await act(async () => {
      change('<p>A third</p>')
    })
    expect(text()).not.includes('The map couldn’t load')
  })

  it('takes its listener and its wait away when it goes', async () => {
    const added: unknown[] = []
    const removed: unknown[] = []
    const cleared: unknown[] = []
    const addListener = window.addEventListener.bind(window)
    const removeListener = window.removeEventListener.bind(window)
    const clear = globalThis.clearTimeout
    window.addEventListener = ((type: string, listen: EventListener) => {
      if (type === 'message') added.push(listen)
      addListener(type, listen)
    }) as typeof window.addEventListener
    window.removeEventListener = ((type: string, listen: EventListener) => {
      if (type === 'message') removed.push(listen)
      removeListener(type, listen)
    }) as typeof window.removeEventListener
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      cleared.push(id)
      clear(id)
    }) as typeof clearTimeout
    try {
      await shown({ readyMs: 60000 })
      expect(added).lengthOf(1)
      cleared.length = 0
      await unmount()
      expect(removed).deep.equals(added)
      expect(cleared.length).greaterThan(0)
    } finally {
      window.addEventListener = addListener
      window.removeEventListener = removeListener
      globalThis.clearTimeout = clear
    }
  })
})
