import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { VolumeButton } from './VolumeButton'

describe('volume button', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  async function render(
    on: boolean,
    onToggle = (): void => undefined
  ): Promise<HTMLElement> {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <VolumeButton on={on} onToggle={onToggle} testID="volume" />
        </ThemeProvider>
      )
    })
    const button = host.querySelector<HTMLElement>('[data-testid="volume"]')
    expect(button).not.equals(null)
    return button!
  }

  /** The glyph's own text node, whose colour is the glyph's. */
  function glyph(button: HTMLElement, name: string): HTMLElement {
    const found = [...button.querySelectorAll<HTMLElement>('*')].find(
      node => node.childElementCount === 0 && node.textContent === name
    )
    expect(found, name).not.equals(undefined)
    return found!
  }

  for (const on of [true, false]) {
    const name = on ? 'volume_up' : 'volume_off'
    const label = on ? 'Mute game sounds' : 'Unmute game sounds'
    it(`draws ${name} in black on white, labelled “${label}”, when ${on ? 'on' : 'off'}`, async function () {
      const button = await render(on)
      expect(button.getAttribute('aria-label')).equals(label)
      expect(button.getAttribute('role')).equals('button')
      expect(button.textContent).equals(name)
      expect(button.style.backgroundColor).equals('rgb(255, 255, 255)')
      expect(button.style.width).equals('48px')
      expect(button.style.height).equals('48px')
      expect(glyph(button, name).style.color).equals('rgb(0, 0, 0)')
    })
  }

  it('calls onToggle when pressed', async function () {
    let toggles = 0
    const button = await render(false, () => {
      toggles++
    })
    await act(async () => {
      button.click()
    })
    expect(toggles).equals(1)
  })
})
