import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { glassStyle } from './glass'
import { GlassView } from './GlassView'

let root: Root | undefined

/** The background a style paints, as jsdom reads it back. */
function painted(color: unknown): string {
  const probe = document.createElement('div')
  probe.style.backgroundColor = String(color)
  return probe.style.backgroundColor
}

describe('GlassView', function () {
  // Inside the suite, so the modal's portal is unmounted before any
  // root-level hook clears the document.
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('takes the dark theme’s glass when asked, whatever the app’s theme', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GlassView testID="light" />
          <GlassView testID="dark" dark />
        </ThemeProvider>
      )
    })
    const light = document.querySelector<HTMLElement>('[data-testid="light"]')!
    const dark = document.querySelector<HTMLElement>('[data-testid="dark"]')!
    expect(light.style.backgroundColor).equals(
      painted(glassStyle(tsBallpark).backgroundColor)
    )
    expect(dark.style.backgroundColor).equals(
      painted(glassStyle(tsDark).backgroundColor)
    )
    expect(dark.style.backgroundColor).not.equals(light.style.backgroundColor)
  })

  it('keeps the iOS backdrop option off the DOM and preserves the web material and opaque fallback', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GlassView testID="plain" />
          <GlassView testID="backdrop" backdropBlur />
          <GlassView testID="opaque" backdropBlur opaque />
        </ThemeProvider>
      )
    })
    const plain = host.querySelector<HTMLElement>('[data-testid="plain"]')!
    const backdrop = host.querySelector<HTMLElement>(
      '[data-testid="backdrop"]'
    )!
    const opaque = host.querySelector<HTMLElement>('[data-testid="opaque"]')!
    expect(backdrop.hasAttribute('backdropBlur')).equals(false)
    expect(backdrop.hasAttribute('glassBackdropBlur')).equals(false)
    expect(backdrop.className).equals(plain.className)
    expect(backdrop.style.cssText).equals(plain.style.cssText)
    expect(opaque.style.backgroundColor).equals(
      painted(glassStyle(tsBallpark, true).backgroundColor)
    )
  })
})
