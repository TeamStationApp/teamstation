import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import type { FrameLoop } from '../scoreboardOverlay/usePlayheadStep'
import { SponsorReel } from './SponsorReel'

const START = 1_000_000

const reel: GameSponsorReel = {
  id: 'srp_a',
  reelId: 'srl_a',
  url: 'https://example.test/reel.mp4',
  width: 640,
  height: 360,
  startMs: START,
  durationMs: 12000
}
const RECT = { x: 10, y: 20, w: 320, h: 180 }

/** Display frames run by hand. */
function manualFrames(): FrameLoop & { step: () => void } {
  const waiting = new Map<number, () => void>()
  let handles = 0
  return {
    request: run => {
      waiting.set(++handles, run)
      return handles
    },
    cancel: handle => {
      waiting.delete(handle)
    },
    step: () => {
      const runs = [...waiting.values()]
      waiting.clear()
      for (const run of runs) run()
    }
  }
}

/** The `<video>` drawn, made to answer as a loaded player does. */
function playerOf(host: HTMLElement): {
  video: HTMLVideoElement
  seeks: number[]
  plays: number
  pauses: number
} {
  const video = host.querySelector('video')!
  const state = { seeks: [] as number[], plays: 0, pauses: 0, video }
  let at = 0
  let paused = true
  Object.defineProperties(video, {
    readyState: { get: () => 4, configurable: true },
    currentTime: {
      get: () => at,
      set: (value: number) => {
        at = value
        state.seeks.push(value)
      },
      configurable: true
    },
    paused: { get: () => paused, configurable: true },
    play: {
      value: async () => {
        paused = false
        state.plays++
      },
      configurable: true
    },
    pause: {
      value: () => {
        paused = true
        state.pauses++
      },
      configurable: true
    }
  })
  return state
}

let root: Root | undefined
let host: HTMLElement | undefined

// A browser's player plays and pauses; jsdom's only says it cannot.
let restore = (): void => undefined
before(function () {
  const media = window.HTMLMediaElement.prototype
  const play = Object.getOwnPropertyDescriptor(media, 'play')!
  const pause = Object.getOwnPropertyDescriptor(media, 'pause')!
  Object.defineProperty(media, 'play', {
    configurable: true,
    value: async () => undefined
  })
  Object.defineProperty(media, 'pause', {
    configurable: true,
    value: () => undefined
  })
  restore = () => {
    Object.defineProperty(media, 'play', play)
    Object.defineProperty(media, 'pause', pause)
  }
})
after(function () {
  restore()
})

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

async function draw(
  props: Partial<React.ComponentProps<typeof SponsorReel>> & {
    wall: { now: number | null }
    frames: FrameLoop
  }
): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  const { wall, ...rest } = props
  await act(async () => {
    root!.render(
      <SponsorReel
        reels={[reel]}
        wallNow={() => wall.now}
        rect={RECT}
        muted={false}
        paused={false}
        {...rest}
      />
    )
  })
}

/** U25: the web's sponsor reel on the game's clock. */
describe('U25 SponsorReel', function () {
  it('is drawn only while the game’s clock is inside a reel, at its rect, taking no touch', async function () {
    const frames = manualFrames()
    const wall = { now: (START - 1) as number | null }
    await draw({ wall, frames })
    expect(host!.querySelector('[data-testid="sponsor-reel"]')).equals(null)
    wall.now = START
    await act(async () => {
      frames.step()
    })
    const drawn = host!.querySelector<HTMLElement>(
      '[data-testid="sponsor-reel"]'
    )!
    expect(drawn).not.equals(null)
    expect(drawn.style.left).equals('10px')
    expect(drawn.style.top).equals('20px')
    expect(drawn.style.width).equals('320px')
    expect(drawn.style.pointerEvents).equals('none')
    // Above the grid's pictures, which stack at 1 and 2.
    expect(drawn.style.zIndex).equals('3')
    const video = host!.querySelector('video')!
    expect(video.getAttribute('src')).equals(reel.url)
    expect(video.getAttribute('data-reel')).equals('srp_a')
    wall.now = START + reel.durationMs
    await act(async () => {
      frames.step()
    })
    expect(host!.querySelector('video')).equals(null)
    // Nowhere to draw it, or a rect with no size: nothing.
    wall.now = START + 1000
    await draw({ wall, frames, rect: null })
    await act(async () => {
      frames.step()
    })
    expect(host!.querySelector('video')).equals(null)
    await draw({ wall, frames, rect: { ...RECT, w: 0 } })
    expect(host!.querySelector('video')).equals(null)
  })

  it('starts at the offset, and is put back only when it drifts more than 0.3 s from the game', async function () {
    const frames = manualFrames()
    const wall = { now: (START + 4000) as number | null }
    await draw({ wall, frames })
    const player = playerOf(host!)
    player.video.dispatchEvent(
      new host!.ownerDocument.defaultView!.Event('loadedmetadata')
    )
    expect(player.seeks).deep.equals([4])
    await act(async () => {
      frames.step()
    })
    expect(player.seeks).deep.equals([4])
    // Under 0.3 s of drift: left to play.
    wall.now = START + 4250
    await act(async () => {
      frames.step()
    })
    expect(player.seeks).deep.equals([4])
    // Over it: put back.
    wall.now = START + 4400
    await act(async () => {
      frames.step()
    })
    expect(player.seeks).deep.equals([4, 4.4])
    // A seek of the game mid-reel: to the new offset.
    wall.now = START + 9000
    await act(async () => {
      frames.step()
    })
    expect(player.seeks.at(-1)).equals(9)
    // No wall time: left where it is.
    wall.now = null
    await act(async () => {
      frames.step()
    })
    expect(player.seeks.at(-1)).equals(9)
  })

  it('follows the player’s pause and mute', async function () {
    const frames = manualFrames()
    const wall = { now: (START + 1000) as number | null }
    await draw({ wall, frames })
    const player = playerOf(host!)
    await act(async () => {
      frames.step()
    })
    expect(player.plays).equals(1)
    expect(player.video.muted).equals(false)
    await draw({ wall, frames, paused: true, muted: true })
    await act(async () => {
      frames.step()
    })
    expect(player.pauses).equals(1)
    expect(player.video.muted).equals(true)
    await draw({ wall, frames, paused: false, muted: false })
    await act(async () => {
      frames.step()
    })
    expect(player.plays).equals(2)
    expect(player.video.muted).equals(false)
  })
})
