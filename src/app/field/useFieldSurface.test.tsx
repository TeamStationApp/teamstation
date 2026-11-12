import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Insets } from '../platform/insets'
import { useFieldInsets } from './useFieldSurface'

/**
 * What the browser computes for the probe's `env()` padding: jsdom knows no
 * safe area, so the test says what a phone's browser would.
 */
let safeArea: Record<string, string> | null = null
const original = Object.getOwnPropertyDescriptor(window, 'getComputedStyle')
const computed = window.getComputedStyle.bind(window)

describe('field insets', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  let seen: Insets[] = []
  beforeEach(function () {
    seen = []
    safeArea = null
    window.getComputedStyle = (element, pseudo) => {
      const style = computed(element, pseudo)
      if (safeArea == null || !element.hasAttribute('data-field-insets'))
        return style
      const area = safeArea
      return new Proxy(style, {
        get: (target, key) =>
          typeof key === 'string' && key in area
            ? area[key]
            : (Reflect.get(target, key) as unknown)
      })
    }
  })
  afterEach(async function () {
    if (original == null) Reflect.deleteProperty(window, 'getComputedStyle')
    else Object.defineProperty(window, 'getComputedStyle', original)
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  function Probe(): null {
    seen.push(useFieldInsets())
    return null
  }
  async function render(): Promise<void> {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Probe />)
    })
  }

  it('reads the four safe-area insets from its probe', async function () {
    safeArea = {
      paddingTop: '59px',
      paddingBottom: '34px',
      paddingLeft: '0px',
      paddingRight: '0px'
    }
    await render()
    expect(seen.at(-1)).deep.equals({ top: 59, bottom: 34, left: 0, right: 0 })
    // The probe asks the browser for each inset, and draws nothing.
    const probe = document.querySelector<HTMLElement>('[data-field-insets]')
    expect(probe?.getAttribute('style')).includes(
      'env(safe-area-inset-top, 0px)'
    )
    expect(probe?.getAttribute('style')).includes('visibility: hidden')
  })

  it('reads them again when the window resizes or turns', async function () {
    safeArea = {
      paddingTop: '59px',
      paddingBottom: '34px',
      paddingLeft: '0px',
      paddingRight: '0px'
    }
    await render()
    const first = seen.at(-1)
    // The same insets again are the same value.
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    expect(seen.at(-1)).equals(first)
    safeArea = {
      paddingTop: '0px',
      paddingBottom: '21px',
      paddingLeft: '59px',
      paddingRight: '47px'
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    expect(seen.at(-1)).deep.equals({ top: 0, bottom: 21, left: 59, right: 47 })
    safeArea = { ...safeArea, paddingBottom: '0px' }
    await act(async () => {
      window.dispatchEvent(new window.Event('orientationchange'))
    })
    expect(seen.at(-1)).deep.equals({ top: 0, bottom: 0, left: 59, right: 47 })
  })

  it('reads them again on the next frame, once the browser has applied the cover viewport', async function () {
    // The first read comes before the browser applies `viewport-fit=cover`.
    await render()
    expect(seen.at(-1)).deep.equals({ top: 0, bottom: 0, left: 0, right: 0 })
    safeArea = {
      paddingTop: '59px',
      paddingBottom: '34px',
      paddingLeft: '0px',
      paddingRight: '0px'
    }
    await act(async () => {
      await new Promise(resolve => window.requestAnimationFrame(resolve))
    })
    expect(seen.at(-1)).deep.equals({ top: 59, bottom: 34, left: 0, right: 0 })
  })

  it('reads them again when the visual viewport resizes', async function () {
    const viewport = new window.EventTarget()
    const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport
    })
    try {
      await render()
      await act(async () => {
        await new Promise(resolve => window.requestAnimationFrame(resolve))
      })
      safeArea = {
        paddingTop: '0px',
        paddingBottom: '21px',
        paddingLeft: '59px',
        paddingRight: '47px'
      }
      await act(async () => {
        viewport.dispatchEvent(new window.Event('resize'))
      })
      expect(seen.at(-1)).deep.equals({
        top: 0,
        bottom: 21,
        left: 59,
        right: 47
      })
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      // Gone with the screen: the viewport's resize reads nothing more.
      const count = seen.length
      safeArea = { ...safeArea, paddingTop: '59px' }
      viewport.dispatchEvent(new window.Event('resize'))
      expect(seen).length(count)
    } finally {
      if (descriptor == null) Reflect.deleteProperty(window, 'visualViewport')
      else Object.defineProperty(window, 'visualViewport', descriptor)
    }
  })

  it('gives zeros in a browser with no env()', async function () {
    await render()
    expect(seen.at(-1)).deep.equals({ top: 0, bottom: 0, left: 0, right: 0 })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    // Gone with the screen, and deaf to the window.
    expect(document.querySelector('[data-field-insets]')).equals(null)
  })
})
