import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import { drawnVideos } from '../../../test/stubs/reactNativeVideo'
import type { FrameLoop } from '../scoreboardOverlay/usePlayheadStep'
import { SponsorReel } from './SponsorReel.native'

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

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
  drawnVideos.length = 0
})

async function draw(
  props: Partial<React.ComponentProps<typeof SponsorReel>> & {
    wall: { now: number | null }
    frames: FrameLoop
  }
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
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

const step = async (frames: { step: () => void }): Promise<void> => {
  await act(async () => {
    frames.step()
  })
}

const seeks = (): number[] =>
  (drawnVideos.at(-1)?.calls ?? [])
    .filter(call => call.name === 'seek')
    .map(call => call.args[0] as number)

/** U25: the phone's and the TV's sponsor reel on the game's clock. */
describe('U25 SponsorReel.native', function () {
  it('is drawn only while the game’s clock is inside a reel, at its rect', async function () {
    const frames = manualFrames()
    const wall = { now: (START - 1) as number | null }
    await draw({ wall, frames })
    expect(drawnVideos).length(0)
    wall.now = START + 100
    await step(frames)
    expect(drawnVideos).length(1)
    const props = drawnVideos[0].props
    expect(props.source).deep.equals({ uri: reel.url })
    expect(props.volume).equals(1)
    expect(props.paused).equals(false)
    expect(props.muted).equals(false)
    wall.now = START + reel.durationMs
    await step(frames)
    expect(document.querySelector('[data-video-props]')).equals(null)
    await draw({ wall: { now: START + 5 }, frames, rect: null })
    await step(frames)
    expect(document.querySelector('[data-video-props]')).equals(null)
  })

  it('seeks to the offset once loaded, and again only on a drift over 0.3 s', async function () {
    const frames = manualFrames()
    const wall = { now: (START + 4000) as number | null }
    await draw({ wall, frames })
    // Nothing is sought before the player has loaded.
    await step(frames)
    expect(seeks()).deep.equals([])
    const video = drawnVideos[0]
    await act(async () => {
      ;(video.props.onLoad as () => void)()
    })
    expect(seeks()).deep.equals([4])
    // The player says where it is: under 0.3 s off, left to play.
    await act(async () => {
      ;(video.props.onProgress as (event: { currentTime: number }) => void)({
        currentTime: 3.9
      })
    })
    await step(frames)
    expect(seeks()).deep.equals([4])
    // The game seeks on: put back.
    wall.now = START + 8000
    await step(frames)
    expect(seeks()).deep.equals([4, 8])
    wall.now = null
    await step(frames)
    expect(seeks()).deep.equals([4, 8])
  })

  it('follows the player’s pause and mute, and carries no position on while paused', async function () {
    const frames = manualFrames()
    const wall = { now: (START + 1000) as number | null }
    await draw({ wall, frames, paused: true, muted: true })
    await step(frames)
    const video = drawnVideos[0]
    expect([video.props.paused, video.props.muted]).deep.equals([true, true])
    await act(async () => {
      ;(video.props.onLoad as () => void)()
    })
    expect(seeks()).deep.equals([1])
    await step(frames)
    expect(seeks()).deep.equals([1])
    await draw({ wall, frames, paused: false, muted: false })
    expect([video.props.paused, video.props.muted]).deep.equals([false, false])
  })
})
