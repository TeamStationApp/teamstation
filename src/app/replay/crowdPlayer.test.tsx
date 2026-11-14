import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  bedGains,
  CHEER_GAIN,
  type Crowd,
  CROWD_IDLE_GAIN,
  MAX_CHEERS
} from './crowdCheer'
import {
  CHEER_SOUNDS,
  CROWD_IDLE_SOUND,
  CROWD_TICK_MS,
  useCrowd
} from './crowdPlayer'

/**
 * Every audio element the crowd played, in the order it first did, and how
 * often each was played.
 */
let made: HTMLAudioElement[] = []
/** Each play, in order: the element, its file and gain then, and whether muted. */
let played: Array<{
  audio: HTMLMediaElement
  src: string
  volume: number
  muted: boolean
  /** Its Web Audio gain node's gain then, if it was routed through one. */
  gain?: number
}> = []
/** Each element's gain node, as a fake AudioContext routed it. */
const routed = new Map<HTMLMediaElement, FakeGain>()

/** A Web Audio gain node, as the fake context makes it. */
class FakeGain {
  readonly gain = { value: 1 }
  readonly to: unknown[] = []
  connect(to: unknown): unknown {
    this.to.push(to)
    return to
  }
}

/** How the fake context answers: as a browser that routes, or refuses. */
let routing: 'routes' | 'throws' | 'no context' = 'routes'

/** A browser's AudioContext: routes each element once, as a real one does. */
class FakeContext {
  static made: FakeContext[] = []
  readonly destination = { destination: true }
  readonly sources = new Map<HTMLMediaElement, number>()
  resumed = 0
  closed = 0
  closing: 'closes' | 'throws' = 'closes'
  constructor() {
    if (routing === 'no context') throw new Error('NotSupportedError')
    FakeContext.made.push(this)
  }

  createMediaElementSource(audio: HTMLMediaElement): {
    connect: (to: FakeGain) => FakeGain
  } {
    if (routing === 'throws') throw new Error('NotSupportedError')
    // A second source on one element throws, as a browser's does.
    if (this.sources.has(audio)) throw new Error('InvalidStateError')
    this.sources.set(audio, 1)
    return {
      connect: (to: FakeGain) => {
        routed.set(audio, to)
        return to
      }
    }
  }

  createGain(): FakeGain {
    return new FakeGain()
  }

  async resume(): Promise<void> {
    this.resumed += 1
    await Promise.resolve()
  }

  async close(): Promise<void> {
    this.closed += 1
    if (this.closing === 'throws') throw new Error('InvalidStateError')
    await Promise.resolve()
  }
}
/** Whether a play is under way: a tap the test is inside. */
let inTap = false
/** The elements first played inside a tap: those a strict browser lets play. */
const tapped = new Set<HTMLMediaElement>()
const plays = new Map<HTMLMediaElement, number>()
/** Whether each element is sounding: jsdom plays nothing itself. */
const sounding = new Set<HTMLMediaElement>()
/** How `play` answers: as a browser that plays, refuses, or has no audio. */
let playing: 'plays' | 'refuses' | 'throws' = 'plays'

/** The idle crowd's file's length, in seconds, as each copy reports it. */
let bedLength = 22
/** The intervals the crowd set, as a fake clock holds them. */
const intervals = new Map<number, { run: () => void; ms: number }>()
let nextInterval = 1

const proto = window.HTMLMediaElement.prototype
const saved = {
  play: Object.getOwnPropertyDescriptor(proto, 'play'),
  pause: Object.getOwnPropertyDescriptor(proto, 'pause'),
  duration: Object.getOwnPropertyDescriptor(proto, 'duration')
}
const savedTimers = {
  setInterval: Object.getOwnPropertyDescriptor(window, 'setInterval'),
  clearInterval: Object.getOwnPropertyDescriptor(window, 'clearInterval')
}

describe('crowd player', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  let crowd: Crowd | undefined

  beforeEach(function () {
    made = []
    played = []
    routed.clear()
    FakeContext.made = []
    routing = 'routes'
    tapped.clear()
    inTap = false
    plays.clear()
    sounding.clear()
    playing = 'plays'
    bedLength = 22
    intervals.clear()
    window.setInterval = ((run: () => void, ms: number) => {
      const id = nextInterval++
      intervals.set(id, { run, ms })
      return id
    }) as unknown as typeof window.setInterval
    window.clearInterval = ((id: number) => {
      intervals.delete(id)
    }) as typeof window.clearInterval
    // jsdom knows no file's length: the bed's is bedLength.
    Object.defineProperty(proto, 'duration', {
      configurable: true,
      get: function (this: HTMLMediaElement): number {
        return this.src.includes('crowd-idle') ? bedLength : NaN
      }
    })
    Object.defineProperty(proto, 'play', {
      configurable: true,
      value: async function (this: HTMLMediaElement): Promise<void> {
        if (!made.includes(this)) {
          made.push(this)
          if (inTap) tapped.add(this)
        }
        played.push({
          audio: this,
          src: this.src,
          volume: this.volume,
          muted: this.muted,
          gain: routed.get(this)?.gain.value
        })
        plays.set(this, (plays.get(this) ?? 0) + 1)
        if (playing === 'throws') throw new Error('not supported')
        if (playing === 'refuses') {
          await Promise.reject(new Error('NotAllowedError'))
          return
        }
        sounding.add(this)
        await Promise.resolve()
      }
    })
    Object.defineProperty(proto, 'pause', {
      configurable: true,
      value: function (this: HTMLMediaElement): void {
        sounding.delete(this)
      }
    })
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    for (const name of ['setInterval', 'clearInterval'] as const) {
      const descriptor = savedTimers[name]
      if (descriptor == null) Reflect.deleteProperty(window, name)
      else Object.defineProperty(window, name, descriptor)
    }
    for (const name of ['play', 'pause', 'duration'] as const) {
      const descriptor = saved[name]
      if (descriptor == null) Reflect.deleteProperty(proto, name)
      else Object.defineProperty(proto, name, descriptor)
    }
  })

  function Probe(props: { on: boolean; paused: boolean; over: boolean }): null {
    crowd = useCrowd({ on: props.on, paused: props.paused, over: props.over })
    return null
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

  const isBed = (audio: HTMLAudioElement): boolean =>
    audio.src.endsWith(CROWD_IDLE_SOUND.replace(/^\.?\//, ''))
  const bed = (): HTMLAudioElement | undefined => made.find(isBed)
  /** The idle crowd's copies, in the order each first played. */
  const copies = (): HTMLAudioElement[] => made.filter(isBed)
  /** A copy's gain: on its node if routed, else its volume. */
  const gainOf = (audio: HTMLMediaElement): number =>
    routed.get(audio)?.gain.value ?? audio.volume
  /**
   * Moves the fake clock on by `seconds`, a tick at a time: each element
   * sounding moves on, a copy at its end ends, and the crowd's interval runs.
   */
  const advance = async (seconds: number): Promise<void> => {
    await act(async () => {
      for (let ms = 0; ms < seconds * 1000 - 1e-6; ms += CROWD_TICK_MS) {
        for (const audio of [...sounding]) {
          audio.currentTime += CROWD_TICK_MS / 1000
          if (isBed(audio) && audio.currentTime >= bedLength) {
            audio.currentTime = bedLength
            sounding.delete(audio)
            audio.onended?.(new window.Event('ended'))
          }
        }
        for (const { run } of [...intervals.values()]) run()
      }
    })
  }
  /** Each cheer played, in order: its element, file and gain then. */
  const cheers = (): typeof played =>
    played.filter(play => play.src.includes('cheer-'))
  const cheer = async (
    ...sizes: Array<Parameters<Crowd['cheer']>[0]>
  ): Promise<void> => {
    await act(async () => {
      for (const size of sizes) crowd!.cheer(size)
    })
  }

  const SILENT = /^data:audio\/wav/
  const tap = async (): Promise<void> => {
    await act(async () => {
      inTap = true
      crowd!.unlock()
      inTap = false
    })
  }

  it('brings the idle crowd in over two seconds while on and playing', async function () {
    await render(false)
    expect(made).length(0)
    expect(crowd?.element).equals(null)
    expect(intervals.size).equals(0)
    await render(true)
    const [audio] = copies()
    expect(copies()).length(1)
    expect(audio.loop).equals(false)
    expect(audio.currentTime).equals(0)
    expect(audio.volume).equals(0)
    expect(sounding.has(audio)).equals(true)
    expect(CROWD_IDLE_SOUND).match(/crowd-idle.*\.m4a$/)
    expect(document.contains(audio)).equals(false)
    expect([...intervals.values()].map(timer => timer.ms)).deep.equals([
      CROWD_TICK_MS
    ])
    await advance(1)
    expect(audio.volume).closeTo(CROWD_IDLE_GAIN * Math.SQRT1_2, 0.01)
    await advance(1.5)
    expect(audio.volume).closeTo(CROWD_IDLE_GAIN, 1e-9)
  })

  it('starts the second copy two seconds before the first ends, crossing their gains', async function () {
    await render(true)
    await advance(19.9)
    const [first] = copies()
    expect(copies()).length(1)
    expect(first.volume).closeTo(CROWD_IDLE_GAIN, 1e-9)
    await advance(0.15)
    // Past 20 s: the other copy starts from its beginning, silent.
    const [, second] = copies()
    expect(second).not.equals(undefined)
    expect(second.src).equals(first.src)
    expect(sounding.has(second)).equals(true)
    expect(played.at(-1)).deep.include({ audio: second })
    const startedAt = first.currentTime
    expect(startedAt).closeTo(20, 0.06)
    // Through the overlap one falls as the other rises, at equal power.
    let last = { out: first.volume, in: second.volume }
    for (let i = 0; i < 38; i++) {
      await advance(0.05)
      const now = { out: first.volume, in: second.volume }
      expect(now.out).lessThan(last.out + 1e-9)
      expect(now.in).greaterThan(last.in - 1e-9)
      expect(now.out ** 2 + now.in ** 2).closeTo(CROWD_IDLE_GAIN ** 2, 1e-9)
      // Both follow the outgoing copy's position.
      expect(now.out).closeTo(
        CROWD_IDLE_GAIN * bedGains(first.currentTime, bedLength),
        1e-9
      )
      last = now
    }
    expect(first.volume).lessThan(CROWD_IDLE_GAIN * 0.2)
    expect(second.volume).greaterThan(CROWD_IDLE_GAIN * 0.98)
    // The first ends and rests, silent; the second plays on alone, and
    // hands back to the first two seconds before its own end.
    await advance(0.3)
    expect(sounding.has(first)).equals(false)
    expect(first.volume).equals(0)
    expect(second.volume).closeTo(CROWD_IDLE_GAIN, 0.001)
    await advance(18)
    expect(sounding.has(first)).equals(true)
    expect(first.currentTime).lessThan(0.3)
    expect(second.currentTime - first.currentTime).closeTo(20, 0.06)
    expect(copies()).length(2)
  })

  it('holds both copies when paused mid-fade, and fades on from there', async function () {
    await render(true)
    await advance(21)
    const [first, second] = copies()
    const held = { out: first.volume, in: second.volume }
    expect(held.out).closeTo(CROWD_IDLE_GAIN * Math.SQRT1_2, 0.02)
    await render(true, true)
    expect(sounding.has(first)).equals(false)
    expect(sounding.has(second)).equals(false)
    expect(intervals.size).equals(0)
    // Time passes while paused: nothing moves.
    await advance(5)
    expect({ out: first.volume, in: second.volume }).deep.equals(held)
    await render(true, false)
    expect(sounding.has(first)).equals(true)
    expect(sounding.has(second)).equals(true)
    expect(first.volume).closeTo(held.out, 1e-9)
    expect(second.volume).closeTo(held.in, 1e-9)
    await advance(0.5)
    expect(first.volume).lessThan(held.out)
    expect(second.volume).greaterThan(held.in)
    expect(first.volume ** 2 + second.volume ** 2).closeTo(
      CROWD_IDLE_GAIN ** 2,
      1e-9
    )
  })

  it('stops both copies once the replay is over, and plays them on after a rewind', async function () {
    await render(true)
    await advance(21)
    const [first, second] = copies()
    await render(true, false, true)
    expect(sounding.has(first)).equals(false)
    expect(sounding.has(second)).equals(false)
    expect(intervals.size).equals(0)
    await render(true, false, false)
    expect(sounding.has(first)).equals(true)
    expect(sounding.has(second)).equals(true)
    expect(first.currentTime).closeTo(21, 0.06)
  })

  it('rests both copies when turned off, and brings the crowd in again when on', async function () {
    await render(true)
    await advance(21)
    const [first, second] = copies()
    await render(false)
    expect(sounding.size).equals(0)
    expect(intervals.size).equals(0)
    expect(first.currentTime).equals(0)
    expect(second.currentTime).equals(0)
    await render(true)
    expect(copies()).length(2)
    expect(sounding.has(first)).equals(true)
    expect(sounding.has(second)).equals(false)
    expect(first.volume).equals(0)
    await advance(2.1)
    expect(first.volume).closeTo(CROWD_IDLE_GAIN, 1e-9)
  })

  it('starts the next copy at once if the one playing ended before it could hand over', async function () {
    await render(true)
    const [first] = copies()
    // A throttled tab: the copy ends between two ticks.
    first.currentTime = bedLength
    sounding.delete(first)
    await act(async () => {
      first.onended?.(new window.Event('ended'))
    })
    await advance(0.05)
    expect(sounding.has(first)).equals(true)
    expect(first.currentTime).equals(0)
    expect(copies()).length(1)
  })

  it('brings the first copy in over its own clock until its length is known', async function () {
    bedLength = NaN
    await render(true)
    await advance(30)
    const [first] = copies()
    expect(copies()).length(1)
    expect(first.volume).equals(CROWD_IDLE_GAIN)
  })

  it('primes the bed and a pool of two cheers inside the tap, once', async function () {
    await render(false)
    await tap()
    // Played in the tap: both copies of the bed muted and paused again,
    // each cheer's element a moment of silence.
    expect(made).length(2 + MAX_CHEERS)
    for (const audio of made) expect(tapped.has(audio)).equals(true)
    const [audio, other] = copies()
    expect(played[0]).deep.include({ audio, muted: true })
    expect(played[1]).deep.include({ audio: other, muted: true })
    for (const copy of [audio, other]) {
      expect(copy.muted).equals(false)
      expect(copy.loop).equals(false)
      expect(sounding.has(copy)).equals(false)
    }
    const pool = made.filter(other => !isBed(other))
    for (const cheer of pool) expect(cheer.src).match(SILENT)
    await tap()
    expect(played).length(2 + MAX_CHEERS)
    // The sound comes on: the copies it primed play, and each cheer takes
    // a primed element.
    await render(true)
    expect(sounding.has(audio)).equals(true)
    await advance(20.1)
    expect(sounding.has(other)).equals(true)
    await cheer('small', 'medium', 'huge')
    expect(made).length(2 + MAX_CHEERS)
    expect(cheers().map(play => play.audio)).deep.equals([
      pool[0],
      pool[1],
      pool[0]
    ])
  })

  it('plays each cheer at its gain from the start, two at most, the oldest stopped', async function () {
    await render(true)
    await tap()
    await cheer('small')
    const [small] = cheers()
    expect(small.src).contains(CHEER_SOUNDS.small.replace(/^\.?\//, ''))
    expect(small.volume).equals(CHEER_GAIN.small)
    expect(sounding.has(small.audio)).equals(true)
    await cheer('medium')
    const medium = cheers()[1]
    expect(medium.audio).not.equals(small.audio)
    // A third takes the oldest's element, stopped, from the start.
    small.audio.currentTime = 2
    await cheer('huge')
    const huge = cheers()[2]
    expect(huge.audio).equals(small.audio)
    expect(huge.audio.currentTime).equals(0)
    expect(huge.volume).equals(CHEER_GAIN.huge)
    expect(huge.src).contains(CHEER_SOUNDS.huge.replace(/^\.?\//, ''))
    expect(sounding.has(medium.audio)).equals(true)
    expect(sounding.has(huge.audio)).equals(true)
    // One ended: another takes its element without stopping the one left.
    huge.audio.onended?.(new window.Event('ended'))
    sounding.delete(huge.audio)
    await cheer('large')
    const large = cheers()[3]
    expect(large.audio).equals(huge.audio)
    expect(large.volume).equals(CHEER_GAIN.large)
    expect(sounding.has(medium.audio)).equals(true)
    expect(sounding.has(large.audio)).equals(true)
  })

  it('pauses the cheers sounding with the replay, and plays them on', async function () {
    await render(true)
    await cheer('small', 'huge')
    const [small, huge] = cheers().map(play => play.audio)
    await render(true, true)
    expect(sounding.has(small)).equals(false)
    expect(sounding.has(huge)).equals(false)
    expect(sounding.has(bed()!)).equals(false)
    await render(true, false)
    expect(sounding.has(small)).equals(true)
    expect(sounding.has(huge)).equals(true)
    expect(sounding.has(bed()!)).equals(true)
    // One that ended is not played again.
    small.onended?.(new window.Event('ended'))
    sounding.delete(small)
    await render(true, true)
    await render(true, false)
    expect(sounding.has(small)).equals(false)
    expect(sounding.has(huge)).equals(true)
  })

  it('holds a cheer raised while paused, and starts it on play', async function () {
    await render(true, true)
    await tap()
    const pool = made.filter(other => !isBed(other))
    await cheer('large')
    // Ready, from the start, but not sounding: a phone's paused cheer.
    expect(cheers()).length(0)
    const audio = pool.find(other =>
      other.src.includes(CHEER_SOUNDS.large.replace(/^\.?\//, ''))
    )!
    expect(audio.volume).equals(CHEER_GAIN.large)
    expect(audio.currentTime).equals(0)
    // Played only in the tap, to prime it.
    expect(plays.get(audio)).equals(1)
    await render(true, false)
    expect(cheers().map(play => play.audio)).deep.equals([audio])
    expect(sounding.has(audio)).equals(true)
    expect(sounding.has(bed()!)).equals(true)
    // Raised while playing, it starts at once.
    await cheer('small')
    expect(cheers()).length(2)
  })

  it('stops the bed once the replay is over, and lets a cheer play out', async function () {
    await render(true)
    await cheer('huge')
    const [huge] = cheers().map(play => play.audio)
    await render(true, false, true)
    expect(sounding.has(bed()!)).equals(false)
    expect(sounding.has(huge)).equals(true)
    // A rewind plays it again.
    await render(true, false, false)
    expect(sounding.has(bed()!)).equals(true)
  })

  it('stops everything when turned off, and cheers nothing while off', async function () {
    await render(true)
    await cheer('small', 'large')
    await render(false)
    expect(sounding.size).equals(0)
    await cheer('huge')
    expect(cheers()).length(2)
  })

  it('stops everything on leaving', async function () {
    await render(true)
    const later = crowd!.cheer
    await cheer('medium')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(sounding.size).equals(0)
    later('huge')
    expect(cheers()).length(1)
  })

  it('swallows a browser’s refusal to play, and one with no audio at all', async function () {
    playing = 'refuses'
    await render(true)
    await act(async () => {
      crowd!.cheer('small')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(plays.get(bed()!)).equals(1)
    expect(plays.get(cheers()[0].audio)).equals(1)
    playing = 'throws'
    await tap()
    await cheer('medium')
    expect(cheers()).length(2)
  })

  describe('through Web Audio', function () {
    const page = window as unknown as Record<string, unknown>
    const volume = Object.getOwnPropertyDescriptor(proto, 'volume')
    beforeEach(function () {
      page.AudioContext = FakeContext
    })
    afterEach(function () {
      Reflect.deleteProperty(page, 'AudioContext')
      Reflect.deleteProperty(page, 'webkitAudioContext')
      if (volume == null) Reflect.deleteProperty(proto, 'volume')
      else Object.defineProperty(proto, 'volume', volume)
    })
    /** As iPhone Safari: an element's volume set from script is ignored. */
    const ignoreVolume = (): void => {
      Object.defineProperty(proto, 'volume', {
        configurable: true,
        get: () => 1,
        set: () => undefined
      })
    }

    it('sets each cheer’s and the bed’s gain on its node, where the element ignores volume', async function () {
      ignoreVolume()
      await render(true)
      // Before the tap there is no context: the bed is not routed yet.
      expect(FakeContext.made).length(0)
      await tap()
      expect(FakeContext.made).length(1)
      const [context] = FakeContext.made
      expect(context.resumed).equals(1)
      const [audio, other] = copies()
      // Routed in the tap, coming in from silence.
      expect(routed.get(audio)?.gain.value).equals(0)
      expect(routed.get(audio)?.to).deep.equals([context.destination])
      expect(routed.get(other)?.gain.value).equals(0)
      await advance(21)
      // Each copy's gain on its own node, the elements at 1, crossing.
      expect(routed.get(audio)?.gain.value).closeTo(
        CROWD_IDLE_GAIN * Math.SQRT1_2,
        0.02
      )
      expect(
        routed.get(audio)!.gain.value ** 2 + routed.get(other)!.gain.value ** 2
      ).closeTo(CROWD_IDLE_GAIN ** 2, 1e-9)
      expect(audio.volume).equals(1)
      expect(other.volume).equals(1)
      await cheer('small', 'medium')
      await cheer('huge')
      await cheer('large')
      const heard = cheers().filter(play => !play.src.startsWith('data:'))
      expect(heard.map(play => play.gain)).deep.equals([
        CHEER_GAIN.small,
        CHEER_GAIN.medium,
        CHEER_GAIN.huge,
        CHEER_GAIN.large
      ])
      for (const play of heard) expect(play.volume).equals(1)
      // Each element has one source, though the pool's are reused.
      expect([...context.sources.keys()]).length(2 + MAX_CHEERS)
      for (const count of context.sources.values()) expect(count).equals(1)
      // Another tap makes no second context.
      await tap()
      expect(FakeContext.made).length(1)
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      expect(context.closed).equals(1)
    })

    it('routes a bed made in the tap once, at its gain, under webkitAudioContext too', async function () {
      Reflect.deleteProperty(page, 'AudioContext')
      page.webkitAudioContext = FakeContext
      await render(false)
      await tap()
      await render(true)
      await advance(3)
      const [audio, other] = copies()
      expect(routed.get(audio)?.gain.value).equals(CROWD_IDLE_GAIN)
      expect(gainOf(other)).equals(0)
      expect(audio.volume).equals(1)
      // Made in the tap, after the context: routed once though levelled
      // every tick. The pool is routed as each element first cheers.
      expect([...FakeContext.made[0].sources.keys()]).deep.equals([
        audio,
        other
      ])
      // A context that will not close is let go all the same.
      FakeContext.made[0].closing = 'throws'
    })

    for (const how of ['throws', 'no context'] as const)
      it(`falls back to volume where ${how === 'throws' ? 'routing an element throws' : 'no context can be made'}`, async function () {
        routing = how
        await render(true)
        await tap()
        // Made before the tap, the playing copy is levelled by volume.
        await advance(21)
        const [audio, other] = copies()
        expect(audio.volume ** 2 + other.volume ** 2).closeTo(
          CROWD_IDLE_GAIN ** 2,
          1e-9
        )
        expect(audio.volume).lessThan(CROWD_IDLE_GAIN)
        await cheer('small', 'huge')
        expect(cheers().map(play => play.volume)).deep.equals([
          CHEER_GAIN.small,
          CHEER_GAIN.huge
        ])
        expect(cheers().map(play => play.gain)).deep.equals([
          undefined,
          undefined
        ])
        expect(routed.size).equals(0)
      })
  })
})
