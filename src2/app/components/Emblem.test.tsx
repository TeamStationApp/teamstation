import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { Emblem } from './Emblem'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** The tile: the element that holds the letters. */
function tileOf(container: HTMLElement, letters: string): HTMLElement {
  const text = Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    node => node.children.length === 0 && node.textContent === letters
  )
  if (text?.parentElement == null) throw new Error(`no tile with ${letters}`)
  return text.parentElement
}

/** `rgb(185, 28, 28)` → `#B91C1C`. */
function hex(color: string): string {
  const parts = color.match(/\d+/g)?.slice(0, 3) ?? []
  return `#${parts.map(part => Number(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

describe('Emblem', function () {
  it('draws a team’s tile in its colour, with white letters, where there is no picture', async function () {
    const container = await render(
      <Emblem uri={null} fallback="AG" tint="#0F766E" size={2} />
    )
    const tile = tileOf(container, 'AG')
    expect(hex(getComputedStyle(tile).backgroundColor)).equals('#0F766E')
    const letters = tile.firstElementChild as HTMLElement
    expect(hex(getComputedStyle(letters).color)).equals('#FFFFFF')
  })

  it('keeps the pale tile and the theme’s letters without a tint', async function () {
    const container = await render(<Emblem uri="" fallback="PP" />)
    const tile = tileOf(container, 'PP')
    expect(hex(getComputedStyle(tile).backgroundColor)).not.equals('#B91C1C')
    const letters = tile.firstElementChild as HTMLElement
    expect(hex(getComputedStyle(letters).color)).not.equals('#FFFFFF')
  })
})
