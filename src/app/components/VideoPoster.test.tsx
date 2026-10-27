import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { playedFromStart } from '../../test/liveJoin'
import { LIVE_DELAY_SEC } from '../player/liveDelay'
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

describe('VideoPoster playing a live game', function () {
  /** Safari's own player, which opens a live playlist at its start. */
  async function onSafari(run: () => Promise<void>): Promise<void> {
    const proto = window.HTMLMediaElement.prototype
    const canPlay = Object.getOwnPropertyDescriptor(proto, 'canPlayType')!
    const play = Object.getOwnPropertyDescriptor(proto, 'play')!
    Object.defineProperty(proto, 'canPlayType', {
      configurable: true,
      value: () => 'maybe'
    })
    Object.defineProperty(proto, 'play', {
      configurable: true,
      value: async () => undefined
    })
    try {
      await run()
    } finally {
      Object.defineProperty(proto, 'canPlayType', canPlay)
      Object.defineProperty(proto, 'play', play)
    }
  }

  it('plays it from the newest footage less the live delay, not from its start', async function () {
    await onSafari(async () => {
      const container = await render(
        <VideoPoster size="hero" videoUrl="https://media/live.m3u8" live />
      )
      expect(
        await playedFromStart(container.querySelector('video')!)
      ).deep.equals([600 - LIVE_DELAY_SEC])
    })
  })

  it('keeps its player when its game ends, rather than opening the finished playlist at its start', async function () {
    await onSafari(async () => {
      const proto = window.HTMLMediaElement.prototype
      const load = Object.getOwnPropertyDescriptor(proto, 'load')!
      let loads = 0
      Object.defineProperty(proto, 'load', {
        configurable: true,
        value: () => {
          loads += 1
        }
      })
      try {
        const url = 'https://media/live.m3u8'
        const container = await render(
          <VideoPoster size="hero" videoUrl={url} live />
        )
        const video = container.querySelector('video')!
        const before = loads
        // The next look says the game has ended: the same address, not live.
        await act(async () => {
          root?.render(
            <ThemeProvider>
              <VideoPoster size="hero" videoUrl={url} live={false} />
            </ThemeProvider>
          )
        })
        expect(container.querySelector('video')).equals(video)
        expect(video.getAttribute('src')).equals(url)
        expect(loads, 'never torn down and loaded again').equals(before)
      } finally {
        Object.defineProperty(proto, 'load', load)
      }
    })
  })

  it('joins as a live viewer when its game turns live under the same address', async function () {
    await onSafari(async () => {
      const url = 'https://media/game.m3u8'
      const container = await render(<VideoPoster size="hero" videoUrl={url} />)
      await act(async () => {
        root?.render(
          <ThemeProvider>
            <VideoPoster size="hero" videoUrl={url} live />
          </ThemeProvider>
        )
      })
      expect(
        await playedFromStart(container.querySelector('video')!)
      ).deep.equals([600 - LIVE_DELAY_SEC])
    })
  })

  it('asks Safari to play once it knows what the video is', async function () {
    const asked: string[] = []
    await onSafari(async () => {
      const proto = window.HTMLMediaElement.prototype
      Object.defineProperty(proto, 'play', {
        configurable: true,
        value: async function (this: HTMLVideoElement) {
          asked.push('play')
        }
      })
      const container = await render(
        <VideoPoster size="hero" videoUrl="https://media/game.m3u8" />
      )
      const video = container.querySelector('video')!
      // Metadata, and no `canplay` after it: Safari waiting to be asked.
      await act(async () => {
        video.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(asked).deep.equals(['play'])
      // Moving: shown, and asked no more.
      await act(async () => {
        video.dispatchEvent(new window.Event('playing'))
      })
      expect(asked).deep.equals(['play'])
    })
  })

  it('leaves a recording where it opens', async function () {
    await onSafari(async () => {
      const container = await render(
        <VideoPoster size="hero" videoUrl="https://media/game.m3u8" />
      )
      expect(
        await playedFromStart(container.querySelector('video')!)
      ).deep.equals([])
    })
  })
})
