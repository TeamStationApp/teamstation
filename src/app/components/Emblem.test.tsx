import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { storedPictures } from '../../test/storedPictures'
import { ThemeProvider } from '../theme/ThemeContext'
import { PictureDirectoriesContext } from './CachedPicture'
import { Emblem } from './Emblem'

/** Every picture react-native-web asked the browser for. */
let requests: Array<{
  src: string
  onerror: ((event: unknown) => void) | null
}> = []
const originalImage = window.Image

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
  before(function () {
    window.Image = class {
      src = ''
      onerror: ((event: unknown) => void) | null = null
      onload: unknown
      constructor() {
        requests.push(this)
      }
    } as unknown as typeof Image
  })
  after(function () {
    window.Image = originalImage
  })
  afterEach(function () {
    requests = []
  })

  it('draws the initials when there is no picture', async function () {
    const container = await render(<Emblem uri={null} fallback="MP" />)
    expect(container.textContent).equals('MP')
    expect(requests).deep.equals([])
  })

  it('draws the initials when the picture will not load', async function () {
    const url = 'https://cdn.example.test/images/user/aa-96.png'
    const container = await render(<Emblem uri={url} fallback="LG" />)
    expect(container.textContent).equals('')
    const request = requests.find(each => each.src === url)
    expect(request).not.equals(undefined)
    await act(async () => {
      request!.onerror?.({})
    })
    expect(container.textContent).equals('LG')
  })

  it('draws the stored file offline, and the initials for a picture never stored', async function () {
    const url = 'https://cdn.example.test/images/team/bb-96.png'
    const { directories, fileOf } = await storedPictures([url])
    const container = await render(
      <PictureDirectoriesContext.Provider value={directories}>
        <Emblem uri={`${url}?X-Amz-Signature=1`} fallback="AG" />
        <Emblem uri={`${url}x`} fallback="ZZ" />
      </PictureDirectoriesContext.Provider>
    )
    expect(requests.map(each => each.src)).deep.equals([fileOf(url)])
    expect(container.textContent).equals('ZZ')
  })

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
