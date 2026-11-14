import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Video, { type OnLoadData, type OnProgressData } from 'react-native-video'

import { otherAudioSounding } from '../scoring/cueSoundsController'
import { bedGains, CHEER_GAIN, type Crowd, CROWD_IDLE_GAIN } from './crowdCheer'
import { CROWD_PROGRESS_MS, useCrowd } from './crowdPlayer.native'

/** A hidden player's props, as the crowd hands them to `<Video>`. */
interface Player {
  key: string | null
  repeat?: boolean
  volume?: number
  paused?: boolean
  source?: unknown
  mixWithOthers?: string
  ignoreSilentSwitch?: string
  disableFocus?: boolean
  progressUpdateInterval?: number
  onLoad?: (data: OnLoadData) => void
  onProgress?: (data: OnProgressData) => void
  onEnd?: () => void
  onError?: () => void
  /** The element it drew, and where its ref was asked to seek. */
  media: HTMLMediaElement
  seeks: number[]
}

/** The bed's file's length, in seconds. */
const LENGTH = 22
/** Where each element was asked to seek, by its player's ref. */
const seeks = new Map<HTMLMediaElement, number[]>()
const proto = window.HTMLMediaElement.prototype
const saved = {
  play: Object.getOwnPropertyDescriptor(proto, 'play'),
  pause: Object.getOwnPropertyDescriptor(proto, 'pause')
}

describe('crowd player on a phone', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  let crowd: Crowd | undefined

  beforeEach(function () {
    seeks.clear()
    // jsdom plays nothing: the players' play and pause are quiet.
    for (const name of ['play', 'pause'] as const)
      Object.defineProperty(proto, name, {
        configurable: true,
        value: async () => undefined
      })
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    for (const name of ['play', 'pause'] as const) {
      const descriptor = saved[name]
      if (descriptor == null) Reflect.deleteProperty(proto, name)
      else Object.defineProperty(proto, name, descriptor)
    }
  })

  function Probe(props: {
    on: boolean
    paused: boolean
    over: boolean
  }): React.ReactElement | null {
    crowd = useCrowd({ on: props.on, paused: props.paused, over: props.over })
    return crowd.element
  }

  async function render(
    on: boolean,
    paused = false,
    over = false
  ): Promise<void> {
    if (host == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(<Probe on={on} paused={paused} over={over} />)
    })
  }

  /**
   * The hidden players the crowd mounted, the bed's two copies first: each
   * `<Video>`'s props as last rendered, read from React's current tree, and
   * the element it drew. Its ref seeks by setting the element's
   * `currentTime`, which is recorded.
   */
  function players(): Player[] {
    const found: Player[] = []
    const containerKey = Object.keys(host ?? {}).find(name =>
      name.startsWith('__reactContainer$')
    )
    if (host == null || containerKey == null) return found
    const root = (host as never)[containerKey] as Fiber
    const visit = (fiber: Fiber | null): void => {
      for (let at = fiber; at != null; at = at.sibling) {
        if (at.elementType === Video) found.push(playerOf(at))
        else visit(at.child)
      }
    }
    visit((root.stateNode as { current: Fiber }).current.child)
    return found
  }
  /** A `<Video>`'s props and the element under it. */
  function playerOf(fiber: Fiber): Player {
    let drawn: Fiber | null = fiber.child
    while (
      drawn != null &&
      !(drawn.stateNode instanceof window.HTMLMediaElement)
    )
      drawn = drawn.child
    const media = drawn!.stateNode as HTMLMediaElement
    if (!seeks.has(media)) {
      const asked: number[] = []
      seeks.set(media, asked)
      Object.defineProperty(media, 'duration', { get: () => LENGTH })
      Object.defineProperty(media, 'currentTime', {
        get: () => asked.at(-1) ?? 0,
        set: (time: number) => asked.push(time)
      })
    }
    return {
      ...(fiber.memoizedProps as Omit<Player, 'key' | 'media' | 'seeks'>),
      key: fiber.key,
      media,
      seeks: seeks.get(media)!
    }
  }
  /** What of React's fibers the test reads. */
  interface Fiber {
    elementType: unknown
    child: Fiber | null
    sibling: Fiber | null
    key: string | null
    memoizedProps: unknown
    stateNode: unknown
  }
  /** The idle crowd's two copies. */
  const beds = (): Player[] =>
    players().filter(player => player.progressUpdateInterval != null)
  const bed = (): Player | undefined => beds()[0]
  const cheers = (): Player[] =>
    players().filter(player => player.progressUpdateInterval == null)
  /** A copy reports it has loaded, and its length. */
  const load = async (copy: number): Promise<void> => {
    await act(async () => {
      // Only its length is read.
      const data = { currentTime: 0, duration: LENGTH } as unknown
      beds()[copy].onLoad?.(data as OnLoadData)
    })
  }
  /** A copy reports where it is. */
  const progress = async (copy: number, currentTime: number): Promise<void> => {
    await act(async () => {
      beds()[copy].onProgress?.({
        currentTime,
        playableDuration: LENGTH,
        seekableDuration: LENGTH
      })
    })
  }

  it('mounts two copies of the idle crowd while on, the first playing, paused with the replay, and nothing while off', async function () {
    await render(false)
    expect(crowd?.element).equals(null)
    expect(players()).length(0)
    await render(true)
    const [first, second] = beds()
    expect(beds()).length(2)
    for (const copy of [first, second]) {
      expect(copy).deep.include({
        progressUpdateInterval: CROWD_PROGRESS_MS,
        mixWithOthers: 'mix',
        ignoreSilentSwitch: 'ignore',
        volume: 0
      })
      expect(copy.repeat).equals(undefined)
    }
    expect(CROWD_PROGRESS_MS).equals(50)
    expect(first.source).not.equals(undefined)
    expect(second.source).equals(first.source)
    expect(first.paused).equals(false)
    expect(second.paused).equals(true)
    await render(true, true)
    expect(beds().map(copy => copy.paused)).deep.equals([true, true])
    await render(false, true)
    expect(crowd?.element).equals(null)
  })

  it('brings the first copy in by its progress, and starts the second from 0 two seconds before the end', async function () {
    await render(true)
    await load(0)
    await progress(0, 1)
    expect(bed()?.volume).closeTo(CROWD_IDLE_GAIN * bedGains(1, LENGTH), 1e-9)
    await progress(0, 10)
    expect(bed()?.volume).equals(CROWD_IDLE_GAIN)
    expect(beds()[1].paused).equals(true)
    expect(beds()[1].seeks).deep.equals([])
    await progress(0, 19.95)
    expect(beds()[1].paused).equals(true)
    // Past 20 s: the other seeks to its start and plays, silent.
    await progress(0, 20.02)
    const [first, second] = beds()
    expect(second.paused).equals(false)
    expect(second.seeks).deep.equals([0])
    expect(first.paused).equals(false)
    // Both follow the outgoing copy's position, crossing at equal power,
    // whatever the incoming one reports.
    for (const at of [20.5, 21, 21.5, 21.95]) {
      await progress(1, at - 20.1)
      await progress(0, at)
      const [out, incoming] = beds().map(copy => copy.volume!)
      expect(out).closeTo(CROWD_IDLE_GAIN * bedGains(at, LENGTH), 1e-9)
      expect(incoming).closeTo(
        CROWD_IDLE_GAIN * bedGains(at - 20, LENGTH),
        1e-9
      )
      expect(out ** 2 + incoming ** 2).closeTo(CROWD_IDLE_GAIN ** 2, 1e-9)
    }
    expect(beds()[0].volume).lessThan(beds()[1].volume!)
    // The first ends: it pauses and rests at its start; the second goes on
    // by its own clock.
    await act(async () => {
      beds()[0].onEnd?.()
    })
    expect(beds()[0].paused).equals(true)
    expect(beds()[0].seeks).deep.equals([0])
    expect(beds()[0].volume).equals(0)
    await progress(1, 2.5)
    expect(beds()[1].volume).equals(CROWD_IDLE_GAIN)
    // Its own length known from its progress, it hands back at 20 s.
    await progress(1, 20.05)
    expect(beds()[0].paused).equals(false)
    expect(beds()[0].seeks).deep.equals([0, 0])
    // A stray end of a copy that is resting changes nothing.
    await act(async () => {
      beds()[1].onEnd?.()
      beds()[1].onEnd?.()
    })
    expect(beds()[1].paused).equals(true)
    expect(beds()[0].paused).equals(false)
  })

  it('holds both copies when paused mid-fade, and plays them on', async function () {
    await render(true)
    await load(0)
    await progress(0, 20.01)
    await progress(0, 21)
    const held = beds().map(copy => copy.volume)
    await render(true, true)
    expect(beds().map(copy => copy.paused)).deep.equals([true, true])
    expect(beds().map(copy => copy.volume)).deep.equals(held)
    await render(true, false)
    expect(beds().map(copy => copy.paused)).deep.equals([false, false])
    // Once over, both stop.
    await render(true, false, true)
    expect(beds().map(copy => copy.paused)).deep.equals([true, true])
  })

  it('starts the other copy at once if the one playing ended before it handed over', async function () {
    await render(true)
    await act(async () => {
      beds()[0].onEnd?.()
    })
    expect(beds().map(copy => copy.paused)).deep.equals([true, false])
    expect(beds()[1].seeks).deep.equals([0])
    // Progress from a copy that is not playing changes nothing.
    await progress(0, 21)
    expect(beds().map(copy => copy.volume)).deep.equals([0, 0])
  })

  it('mounts the copies afresh when the sound comes on again, the first rising from silence', async function () {
    await render(true)
    await load(0)
    await progress(0, 21)
    await render(false)
    await render(true)
    expect(beds().map(copy => copy.volume)).deep.equals([0, 0])
    expect(beds().map(copy => copy.paused)).deep.equals([false, true])
  })

  it('mounts a keyed player for each cheer, removed when it ends or fails, two at most', async function () {
    await render(true)
    await act(async () => {
      crowd!.cheer('small')
      crowd!.cheer('medium')
    })
    expect(cheers().map(player => player.volume)).deep.equals([
      CHEER_GAIN.small,
      CHEER_GAIN.medium
    ])
    const [first, second] = cheers()
    expect(first.key).not.equals(second.key)
    expect(first.source).not.equals(second.source)
    expect(first.mixWithOthers).equals('mix')
    await act(async () => {
      crowd!.cheer('huge')
    })
    expect(cheers().map(player => player.volume)).deep.equals([
      CHEER_GAIN.medium,
      CHEER_GAIN.huge
    ])
    await act(async () => {
      cheers()[0].onEnd?.()
    })
    expect(cheers().map(player => player.volume)).deep.equals([CHEER_GAIN.huge])
    await act(async () => {
      cheers()[0].onError?.()
    })
    expect(cheers()).length(0)
    expect(bed()).not.equals(undefined)
  })

  it('pauses the cheers with the replay, and plays them on', async function () {
    await render(true)
    await act(async () => {
      crowd!.cheer('small')
      crowd!.cheer('huge')
    })
    for (const player of cheers()) expect(player.paused).equals(false)
    await render(true, true)
    expect(cheers()).length(2)
    for (const player of cheers()) expect(player.paused).equals(true)
    expect(bed()?.paused).equals(true)
    await render(true, false)
    for (const player of cheers()) expect(player.paused).equals(false)
    expect(bed()?.paused).equals(false)
  })

  it('stops the bed once the replay is over, and lets a cheer play out', async function () {
    await render(true)
    await act(async () => {
      crowd!.cheer('huge')
    })
    await render(true, false, true)
    expect(bed()?.paused).equals(true)
    expect(cheers()[0].paused).equals(false)
    // A rewind plays it again.
    await render(true, false, false)
    expect(bed()?.paused).equals(false)
  })

  it('needs no tap to play: unlock does nothing', async function () {
    await render(false)
    crowd!.unlock()
    expect(crowd?.element).equals(null)
    await render(true)
    const before = players().map(player => player.key)
    crowd!.unlock()
    expect(players().map(player => player.key)).deep.equals(before)
  })

  it('never takes Android audio focus, so the crowd mixes under the announcer', async function () {
    await render(true)
    await act(async () => {
      crowd!.cheer('small')
      crowd!.cheer('huge')
    })
    // Both copies of the bed and the two cheers.
    expect(players()).length(4)
    expect(beds()).length(2)
    for (const player of players()) expect(player.disableFocus).equals(true)
  })

  it('cheers nothing while off, and drops its cheers when turned off', async function () {
    await render(false)
    await act(async () => {
      crowd!.cheer('huge')
    })
    expect(crowd?.element).equals(null)
    await render(true)
    await act(async () => {
      crowd!.cheer('large')
    })
    expect(cheers()).length(1)
    await render(false)
    expect(crowd?.element).equals(null)
  })

  it('leaves the audio session to the crowd while any player is mounted', async function () {
    await render(false)
    expect(otherAudioSounding()).equals(false)
    await render(true)
    expect(otherAudioSounding()).equals(true)
    await render(false)
    expect(otherAudioSounding()).equals(false)
    await render(true)
    const cheer = crowd!.cheer
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(otherAudioSounding()).equals(false)
    cheer('small')
  })
})
