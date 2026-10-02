import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { largeViewportHeight, useFullScreen } from './fullScreen'

let root: Root | undefined
let host: HTMLElement | undefined

/** What the hook asked the browser for. */
let asked: string[] = []
let fullscreen: Element | null = null

const rootElement = document.documentElement as HTMLElement & {
  requestFullscreen?: () => Promise<void>
}

function giveApi(): void {
  rootElement.requestFullscreen = async () => {
    asked.push('fullscreen')
    fullscreen = rootElement
  }
}

function takeApi(): void {
  Reflect.deleteProperty(rootElement, 'requestFullscreen')
}

/** A finger, or a mouse, lifting anywhere on the page. */
function lift(pointerType: 'touch' | 'mouse'): void {
  const event = new window.Event('pointerup', { bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  document.body.dispatchEvent(event)
}

/** `100lvh`, as the probe reads it; jsdom lays nothing out. */
function lvh(px: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => px
  })
}

function coarse(isTouch: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: isTouch && query === '(pointer: coarse)'
  })) as unknown as typeof window.matchMedia
}

let latest: { swipeToHide: boolean } | undefined

function Probe(props: { landscape: boolean; height: number }): null {
  latest = useFullScreen(props.landscape, props.height)
  return null
}

async function mount(landscape: boolean, height: number): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root?.render(<Probe landscape={landscape} height={height} />)
  })
}

describe('the multi-camera view’s full screen', function () {
  beforeEach(function () {
    if (typeof globalThis.screen === 'undefined') {
      Object.defineProperty(globalThis, 'screen', {
        configurable: true,
        value: window.screen
      })
    }
    asked = []
    fullscreen = null
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreen
    })
    document.exitFullscreen = async () => {
      asked.push('exit')
      fullscreen = null
    }
    // A lock would be a call on this; there must never be one.
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: {
        lock: async () => {
          asked.push('lock')
        },
        unlock: () => {
          asked.push('unlock')
        }
      }
    })
    lvh(0)
    coarse(true)
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    host = undefined
    takeApi()
    lvh(0)
  })

  it('asks for full screen on opening, never locks the orientation, and leaves on closing', async function () {
    giveApi()
    await mount(false, 800)
    expect(asked).deep.equals(['fullscreen'])
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(asked).deep.equals(['fullscreen', 'exit'])
  })

  it('asks once more on the first touch after each turn, either way', async function () {
    giveApi()
    await mount(true, 400)
    // The first touch is still owed the try made at the start.
    fullscreen = null
    lift('touch')
    expect(asked).deep.equals(['fullscreen', 'fullscreen'])
    fullscreen = null
    lift('touch')
    expect(asked).length(2)
    // Turned upright: owed one more, and only to a finger.
    await mount(false, 800)
    lift('mouse')
    expect(asked).length(2)
    lift('touch')
    expect(asked).deep.equals(['fullscreen', 'fullscreen', 'fullscreen'])
    expect(asked).not.includes('lock')
  })

  it('does not ask again when the page is already full screen', async function () {
    giveApi()
    await mount(true, 400)
    lift('touch')
    expect(asked).deep.equals(['fullscreen'])
  })

  it('on an iPhone, says to swipe while Safari’s bars show, upright or sideways', async function () {
    takeApi()
    lvh(745)
    await mount(false, 659)
    expect(latest?.swipeToHide).equals(true)
    // Room for the swipe, put below the page.
    expect(document.body.lastElementChild?.getAttribute('aria-hidden')).equals(
      'true'
    )
    await mount(false, 745)
    expect(latest?.swipeToHide).equals(false)
    lvh(393)
    await mount(true, 340)
    expect(latest?.swipeToHide).equals(true)
  })

  it('never says to swipe with a mouse, or with a full-screen API', async function () {
    takeApi()
    lvh(745)
    coarse(false)
    await mount(false, 659)
    expect(latest?.swipeToHide).equals(false)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    giveApi()
    coarse(true)
    await mount(false, 659)
    expect(latest?.swipeToHide).equals(false)
  })

  it('falls back to the screen sideways where 100lvh is not understood', function () {
    lvh(0)
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 })
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 })
    expect(largeViewportHeight(true)).equals(373)
    expect(largeViewportHeight(false)).equals(0)
    lvh(812)
    expect(largeViewportHeight(false)).equals(812)
  })
})
