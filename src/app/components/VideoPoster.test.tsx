import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { applyCoverCrop, VideoPoster } from './VideoPoster'

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

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.firstElementChild as HTMLElement | null
  if (frame == null) throw new Error('no poster frame')
  return frame
}

/** The element that paints the picture: cover, filling the frame. */
function pictureOf(frame: HTMLElement): HTMLElement {
  const picture = Array.from(frame.querySelectorAll('div')).find(
    node => getComputedStyle(node).backgroundSize === 'cover'
  )
  if (picture == null) throw new Error('no picture')
  return picture
}

function ratioOf(value: string): number {
  const parts = value.split('/').map(part => Number.parseFloat(part))
  const width = parts[0] ?? Number.NaN
  const height = parts[1] ?? 1
  return width / height
}

describe('applyCoverCrop', function () {
  it('does nothing to a host node that has no CSS style', function () {
    const node = document.createElement('div')
    Object.defineProperty(node, 'style', {
      configurable: true,
      get() {
        return undefined
      }
    })
    expect(applyCoverCrop(node)).equals(undefined)
  })
})

describe('VideoPoster', function () {
  it('keeps a separate play control when a playback callback is supplied', async function () {
    let plays = 0
    const container = await render(
      <VideoPoster
        showPlay
        onPlay={() => {
          plays += 1
        }}
      />
    )
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Play"]')!.click()
    })
    expect(plays).equals(1)
  })

  it('keeps a hero at 16:9', async function () {
    const container = await render(
      <VideoPoster size="hero" uri="https://example.com/hero.jpg" showPlay />
    )
    // With its entire parent acting as the button, the icon is decorative.
    expect(container.querySelector('[role="button"]')).equals(null)
    const frame = frameOf(container)
    expect(ratioOf(getComputedStyle(frame).aspectRatio)).closeTo(16 / 9, 0.01)
    expect(getComputedStyle(frame).height).not.equals('100%')
  })

  it('sizes a list frame from pixel frameWidth at 4:3 and crops the center', async function () {
    const frameWidth = 90
    const container = await render(
      <VideoPoster
        uri="https://example.com/row.jpg"
        aspect="4:3"
        frameWidth={frameWidth}
        showPlay
      />
    )
    const frame = frameOf(container)
    const style = getComputedStyle(frame)
    expect(Number.parseFloat(style.width)).closeTo(frameWidth, 0.01)
    expect(Number.parseFloat(style.height)).closeTo(frameWidth * (3 / 4), 0.01)
    expect(style.height).not.equals('100%')
    const picture = pictureOf(frame)
    const pictureStyle = getComputedStyle(picture)
    expect(pictureStyle.backgroundSize).equals('cover')
    expect(pictureStyle.objectFit).equals('cover')
    expect(
      pictureStyle.objectPosition.includes('center') ||
        pictureStyle.objectPosition.includes('50%')
    ).equals(true)
  })
})
