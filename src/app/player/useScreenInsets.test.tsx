import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Insets } from '../platform/insets'
import { COVER_VIEWPORT, useScreenInsets } from './useScreenInsets'

const PAGE_VIEWPORT = 'width=device-width, initial-scale=1'

let root: Root | undefined
let meta: HTMLMetaElement | undefined
const realStyle = window.getComputedStyle.bind(window)
/** What the stubbed browser says `env(safe-area-inset-*)` is. */
let env: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

beforeEach(function () {
  meta = document.createElement('meta')
  meta.setAttribute('name', 'viewport')
  meta.setAttribute('content', PAGE_VIEWPORT)
  document.head.appendChild(meta)
  // jsdom has no `env()`: the probe's padding is answered from `env`.
  window.getComputedStyle = ((node: Element) => {
    const style = node.getAttribute('style') ?? ''
    if (!style.includes('safe-area-inset')) return realStyle(node)
    return {
      paddingTop: `${env.top}px`,
      paddingRight: `${env.right}px`,
      paddingBottom: `${env.bottom}px`,
      paddingLeft: `${env.left}px`
    }
  }) as typeof window.getComputedStyle
})

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  meta?.remove()
  window.getComputedStyle = realStyle
  env = { top: 0, right: 0, bottom: 0, left: 0 }
  document.body.replaceChildren()
})

function Probe(props: { seen: Insets[] }): null {
  props.seen.push(useScreenInsets())
  return null
}

async function mount(seen: Insets[]): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Probe seen={seen} />)
  })
}

describe("the full-screen grid's insets in a browser (U9)", function () {
  it('asks for cover while it is up, and gives the page its viewport back', async function () {
    await mount([])
    expect(meta!.getAttribute('content')).equals(COVER_VIEWPORT)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(meta!.getAttribute('content')).equals(PAGE_VIEWPORT)
    expect(
      document.querySelectorAll('[aria-hidden="true"][style*="safe-area"]')
    ).length(0)
  })

  it("reads the probe's padding, and again on a resize and a change of full screen", async function () {
    env = { top: 59, right: 0, bottom: 34, left: 0 }
    const seen: Insets[] = []
    await mount(seen)
    expect(seen.at(-1)).deep.equals(env)
    // Turned sideways: the camera's side and the indicator.
    env = { top: 0, right: 59, bottom: 21, left: 59 }
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    expect(seen.at(-1)).deep.equals(env)
    env = { top: 24, right: 0, bottom: 0, left: 0 }
    await act(async () => {
      document.dispatchEvent(new window.Event('fullscreenchange'))
    })
    expect(seen.at(-1)).deep.equals(env)
    // The same insets again are not a change: the same object comes back.
    const before = seen.at(-1)
    await act(async () => {
      window.dispatchEvent(new window.Event('orientationchange'))
    })
    expect(seen.at(-1)).equals(before)
  })

  it('reads nothing it cannot parse as an inset', async function () {
    window.getComputedStyle = ((node: Element) =>
      (node.getAttribute('style') ?? '').includes('safe-area-inset')
        ? {
            paddingTop: '',
            paddingRight: 'auto',
            paddingBottom: '3px',
            paddingLeft: '0px'
          }
        : realStyle(node)) as typeof window.getComputedStyle
    const seen: Insets[] = []
    await mount(seen)
    expect(seen.at(-1)).deep.equals({ top: 0, right: 0, bottom: 3, left: 0 })
  })
})
