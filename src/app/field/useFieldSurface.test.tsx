import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Insets } from '../platform/insets'
import { useFieldInsets, useFieldSurface } from './useFieldSurface'

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

describe('the surface that owns the scoring viewport', function () {
  it('keeps the scoring root on the small viewport, restoring the page on navigation', async function () {
    const host = document.createElement('div')
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width'
    const previousMeta = document.querySelector('meta[name="viewport"]')
    previousMeta?.replaceWith(meta)
    if (previousMeta == null) document.head.append(meta)
    const html = document.documentElement
    const background = html.style.backgroundColor
    html.style.backgroundColor = 'maroon'
    document.body.append(host)
    const root = createRoot(host)
    function Surface({
      mode,
      active = true
    }: {
      mode: 'field' | 'scoring' | 'contained'
      active?: boolean
    }): React.ReactElement {
      const { root: style } = useFieldSurface(mode, active)
      return <div style={style as React.CSSProperties} />
    }
    try {
      await act(async () => {
        root.render(
          <>
            <Surface mode="scoring" />
            <Surface mode="contained" />
          </>
        )
      })
      const outer = host.firstElementChild as HTMLElement
      const panel = host.lastElementChild as HTMLElement
      expect(outer.style.height).equals(
        'var(--scoring-viewport-height, 100svh)'
      )
      expect(panel.style.height).equals('100%')
      expect(panel.style.position).equals('absolute')
      expect(html.classList.contains('scoring-viewport')).equals(true)
      expect(html.style.backgroundColor).equals('rgb(79, 121, 56)')
      expect(meta.content).includes('viewport-fit=cover')
      // A retained scoring scene gives the viewport back when a page covers it.
      await act(async () => {
        root.render(<Surface mode="scoring" active={false} />)
      })
      expect(html.classList.contains('scoring-viewport')).equals(false)
      expect(html.style.backgroundColor).equals('maroon')
      expect(meta.content).equals('width=device-width')
      await act(async () => {
        root.render(<Surface mode="field" />)
      })
      expect((host.firstElementChild as HTMLElement).style.height).equals(
        '100dvh'
      )
      expect(html.style.backgroundColor).equals('maroon')
      expect(meta.content).includes('viewport-fit=cover')
    } finally {
      await act(async () => {
        root.unmount()
      })
      html.style.backgroundColor = background
      if (previousMeta != null) meta.replaceWith(previousMeta)
      else meta.remove()
      host.remove()
    }
  })

  it('supplies the dynamic-viewport fallback only where the browser lacks small viewport units', function () {
    const template = readFileSync(resolve('src/app/web/index.html'), 'utf8')
    expect(template).matches(
      /html\.scoring-viewport\s*\{\s*--scoring-viewport-height: 100svh;/
    )
    expect(template).matches(
      /@supports not \(height: 100svh\)\s*\{\s*html\.scoring-viewport\s*\{\s*--scoring-viewport-height: 100dvh;/
    )
  })
})
