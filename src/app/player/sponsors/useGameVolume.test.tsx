import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import type { FrameLoop } from '../scoreboardOverlay/usePlayheadStep'
import { type GameAudio, useGameVolume, volumeSettable } from './useGameVolume'

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

/** Display frames run by hand. */
function manualFrames(): FrameLoop & { step: () => void; waiting: number } {
  let next: (() => void) | null = null
  const loop = {
    waiting: 0,
    request: (run: () => void): number => {
      next = run
      loop.waiting = 1
      return 1
    },
    cancel: (): void => {
      next = null
      loop.waiting = 0
    },
    step: (): void => {
      const run = next
      next = null
      loop.waiting = 0
      run?.()
    }
  }
  return loop
}

/** A game element as a browser has it: volume settable unless it is iOS Safari's. */
class GameElement {
  muted = false
  private level = 1
  constructor(private readonly settable = true) {}
  get volume(): number {
    return this.level
  }

  set volume(value: number) {
    if (this.settable) this.level = value
  }
}

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

async function mount(options: {
  reels: GameSponsorReel[] | null
  wall: { now: number | null }
  audio: GameAudio | null
  frames: FrameLoop
}): Promise<(next: Partial<typeof options>) => Promise<void>> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  let current = options
  function Harness(props: typeof options): null {
    useGameVolume({
      reels: props.reels,
      wallNow: () => props.wall.now,
      audio: props.audio,
      frames: props.frames
    })
    return null
  }
  await act(async () => {
    root!.render(<Harness {...current} />)
  })
  return async next => {
    current = { ...current, ...next }
    await act(async () => {
      root!.render(<Harness {...current} />)
    })
  }
}

/** The audio of one element, muting it for a reel with the viewer's mute kept. */
function audioOf(
  element: GameElement,
  viewer: { muted: boolean }
): GameAudio & { volumes: number[]; ducks: boolean[] } {
  const volumes: number[] = []
  const ducks: boolean[] = []
  return {
    volumes,
    ducks,
    setVolume: volume => {
      volumes.push(volume)
      element.volume = volume
    },
    settable: () => volumeSettable(element),
    setDucked: ducked => {
      ducks.push(ducked)
      element.muted = ducked || viewer.muted
    }
  }
}

/** U26: the game's sound under its sponsor reels. */
describe('U26 useGameVolume', function () {
  it('finds whether an element takes a volume, and puts back the one it had', function () {
    const settable = new GameElement()
    settable.volume = 0.7
    expect(volumeSettable(settable)).equals(true)
    expect(settable.volume).equals(0.7)
    expect(volumeSettable(new GameElement(false))).equals(false)
    const throwing = {
      get volume(): number {
        return 1
      },
      set volume(_value: number) {
        throw new Error('read only')
      }
    }
    expect(volumeSettable(throwing)).equals(false)
  })

  it('gives a settable element the ramp, frame by frame, and full again once the reels go', async function () {
    const element = new GameElement()
    const audio = audioOf(element, { muted: false })
    const frames = manualFrames()
    const wall = { now: (START - 2000) as number | null }
    const update = await mount({ reels: [reel], wall, audio, frames })
    expect(element.volume).equals(1)
    for (const [at, volume] of [
      [START - 500, 0.6],
      [START, 0.2],
      [START + 6000, 0.2],
      [START + 12500, 0.6],
      [START + 13000, 1]
    ] as const) {
      wall.now = at
      frames.step()
      expect(element.volume, String(at)).closeTo(volume, 1e-9)
    }
    // Nothing written while nothing changes.
    const written = audio.volumes.length
    frames.step()
    expect(audio.volumes).length(written)
    // A seek into the reel: quiet at once.
    wall.now = START + 3000
    frames.step()
    expect(element.volume).closeTo(0.2, 1e-9)
    await update({ reels: [] })
    expect(element.volume).equals(1)
    expect(frames.waiting).equals(0)
    expect(audio.ducks).deep.equals([])
  })

  it('mutes an element whose volume cannot be set for the reel, and gives the sound back after', async function () {
    const element = new GameElement(false)
    const audio = audioOf(element, { muted: false })
    const frames = manualFrames()
    const wall = { now: (START - 500) as number | null }
    await mount({ reels: [reel], wall, audio, frames })
    // The fade before the reel: not muted, and the volume left alone.
    expect(element.muted).equals(false)
    expect(audio.volumes).deep.equals([])
    wall.now = START
    frames.step()
    expect(element.muted).equals(true)
    wall.now = START + 11999
    frames.step()
    expect(element.muted).equals(true)
    wall.now = START + 12000
    frames.step()
    expect(element.muted).equals(false)
    expect(audio.ducks).deep.equals([false, true, false])
  })

  it('asks again whether the volume can be set until there is an element to answer', async function () {
    const element = new GameElement(false)
    const audio = audioOf(element, { muted: false })
    let attached = false
    const asked: Array<boolean | null> = []
    const late: GameAudio = {
      ...audio,
      settable: () => {
        const answer = attached ? audio.settable() : null
        asked.push(answer)
        return answer
      }
    }
    const frames = manualFrames()
    const wall = { now: (START + 1000) as number | null }
    await mount({ reels: [reel], wall, audio: late, frames })
    frames.step()
    expect(audio.volumes).deep.equals([])
    expect(audio.ducks).deep.equals([])
    // The player's element arrives: iOS Safari's, so the game is muted.
    attached = true
    frames.step()
    expect(element.muted).equals(true)
    frames.step()
    expect(asked).deep.equals([null, null, false])
    expect(audio.volumes).deep.equals([])
  })

  it('leaves a player the viewer muted muted after the reel', async function () {
    const element = new GameElement(false)
    const viewer = { muted: true }
    element.muted = true
    const audio = audioOf(element, viewer)
    const frames = manualFrames()
    const wall = { now: (START + 1000) as number | null }
    const update = await mount({ reels: [reel], wall, audio, frames })
    expect(element.muted).equals(true)
    // Gone mid-reel: the sound is given back, which is the viewer's mute.
    await update({ reels: null })
    expect(element.muted).equals(true)
    expect(audio.ducks).deep.equals([true, false])
  })

  it('does nothing with no audio, and full volume with no wall time', async function () {
    const frames = manualFrames()
    await mount({
      reels: [reel],
      wall: { now: START },
      audio: null,
      frames
    })
    expect(frames.waiting).equals(0)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    const element = new GameElement()
    const audio = audioOf(element, { muted: false })
    await mount({ reels: [reel], wall: { now: null }, audio, frames })
    expect(audio.volumes).deep.equals([1])
  })
})
