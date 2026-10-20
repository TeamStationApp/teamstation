import { expect } from 'chai'
import Hls from 'hls.js'
import { afterEach, describe, it } from 'mocha'

import {
  aheadControl,
  APPLE_VENDOR,
  atLiveEdge,
  attachHls,
  attachNativeHls,
  HLS_MIME_TYPE,
  hlsEngine,
  type RetryClock
} from './attachHls'
import type { PlayIntent } from './playIntent'
import { shouldResumeAfterRecovery } from './resumeAfterRecovery'
import type { VideoHandle } from './videoHandle'

/**
 * What happens to a live game when the stream stumbles.
 *
 * `recoverMediaError` detaches the media element and attaches it again, and
 * detaching calls `load()` — which resets the element, and a reset element is
 * paused. Nothing put it back, so a hiccup stopped the picture and left it
 * stopped until somebody pressed play. To a parent watching a game that is
 * indistinguishable from the game ending.
 */
describe('coming back from a stumble', function () {
  it('plays again when the recovery is what stopped it', function () {
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: true,
        paused: true
      })
    ).equals(true)
  })

  it('leaves a pause the viewer asked for alone', function () {
    // The viewer pressed pause, and then the stream stumbled. Playing again
    // here would take the control away from the person holding it.
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: false,
        paused: true
      })
    ).equals(false)
  })

  it('does nothing when nothing stopped', function () {
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: true,
        paused: false
      })
    ).equals(false)
  })

  it('does nothing outside a recovery', function () {
    // A pause with no recovery in flight is the viewer's, whatever else is
    // true, and is never undone.
    expect(
      shouldResumeAfterRecovery({
        recovering: false,
        wantsToPlay: true,
        paused: true
      })
    ).equals(false)
  })
})

describe('how far ahead a grid tile loads', function () {
  it('recognizes the configured time-based live position after an outage', function () {
    expect(atLiveEdge(540, 600, 4, 3, 60)).equals(true)
    expect(atLiveEdge(500, 600, 4, 3, 60)).equals(false)
  })
  it('moves both of hls.js’s limits together', function () {
    const config = { maxBufferLength: 10, maxMaxBufferLength: 10 }
    const control = aheadControl(config, 10)
    control.setAheadSec(40)
    expect(config).deep.equals({ maxBufferLength: 40, maxMaxBufferLength: 40 })
    control.setAheadSec(15)
    expect(config).deep.equals({ maxBufferLength: 15, maxMaxBufferLength: 15 })
  })

  it('keeps under a cut hls.js made when the browser ran out of room', function () {
    const config = { maxBufferLength: 60, maxMaxBufferLength: 60 }
    const control = aheadControl(config, 60)
    // A refused append: hls.js halves its own ceiling.
    config.maxMaxBufferLength = 30
    control.setAheadSec(60)
    expect(config.maxMaxBufferLength).equals(30)
    expect(config.maxBufferLength).equals(30)
    // Lower still is always allowed.
    control.setAheadSec(20)
    expect(config.maxMaxBufferLength).equals(20)
    control.setAheadSec(60)
    expect(config.maxMaxBufferLength).equals(30)
  })
})

/** A `<video>` that records what it was told, for both paths. */
class FakeVideo {
  src = ''
  error: { code: number } | null = null
  paused = true
  muted = false
  ended = false
  currentTime = 0
  seekable = { length: 0, start: () => 0, end: () => 0 }
  readyState = 0
  loads = 0
  plays = 0
  removed: string[] = []
  native: string
  listeners = new Map<string, Set<() => void>>()
  constructor(native = 'maybe') {
    this.native = native
  }

  canPlayType(type: string): string {
    return type === HLS_MIME_TYPE ? this.native : ''
  }

  load(): void {
    this.loads += 1
  }

  async play(): Promise<void> {
    this.plays += 1
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  removeAttribute(name: string): void {
    this.removed.push(name)
    if (name === 'src') this.src = ''
  }

  addEventListener(
    type: string,
    listener: () => void,
    options?: { once?: boolean }
  ): void {
    const set = this.listeners.get(type) ?? new Set()
    const run =
      options?.once === true
        ? (): void => {
            set.delete(run)
            listener()
          }
        : listener
    if (options?.once === true) onceOf.set(listener, run)
    set.add(run)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type)
    set?.delete(listener)
    const once = onceOf.get(listener)
    if (once != null) set?.delete(once)
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  /** How many listeners are still attached, of any kind. */
  attached(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}
const onceOf = new WeakMap<() => void, () => void>()

/** A clock that only moves when the test says so. */
function manualClock(): RetryClock & { advance: (ms: number) => void } {
  let now = 1_000_000
  let timers: Array<{ at: number; run: () => void; id: number }> = []
  let next = 1
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++
      timers.push({ at: now + ms, run, id })
      return id
    },
    clearTimeout: id => {
      timers = timers.filter(timer => timer.id !== id)
    },
    advance: ms => {
      now += ms
      const due = timers.filter(timer => timer.at <= now)
      timers = timers.filter(timer => timer.at > now)
      for (const timer of due) timer.run()
    }
  }
}

/** Runs `body` with `navigator.vendor` reading as given. */
function asBrowser(vendor: string, body: () => void): void {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { vendor }
  })
  try {
    body()
  } finally {
    if (before == null) Reflect.deleteProperty(globalThis, 'navigator')
    else Object.defineProperty(globalThis, 'navigator', before)
  }
}

describe('who plays the playlist', function () {
  it('is WebKit itself on Apple’s engine, even with Media Source', function () {
    expect(
      hlsEngine({ vendor: APPLE_VENDOR, nativeHls: true, mediaSource: true })
    ).equals('native')
  })

  it('is hls.js on Apple’s engine when native HLS is missing', function () {
    expect(
      hlsEngine({ vendor: APPLE_VENDOR, nativeHls: false, mediaSource: true })
    ).equals('hls.js')
  })

  it('is hls.js in Chrome, Edge, Brave and Firefox', function () {
    // Chrome answers `maybe` for HLS whether or not it can play it.
    for (const vendor of ['Google Inc.', '']) {
      expect(hlsEngine({ vendor, nativeHls: true, mediaSource: true })).equals(
        'hls.js'
      )
      expect(hlsEngine({ vendor, nativeHls: false, mediaSource: true })).equals(
        'hls.js'
      )
    }
  })

  it('is the browser where there is no Media Source but native HLS', function () {
    expect(
      hlsEngine({ vendor: APPLE_VENDOR, nativeHls: true, mediaSource: false })
    ).equals('native')
    expect(
      hlsEngine({ vendor: 'Google Inc.', nativeHls: true, mediaSource: false })
    ).equals('native')
  })

  it('is nobody without either', function () {
    expect(
      hlsEngine({ vendor: APPLE_VENDOR, nativeHls: false, mediaSource: false })
    ).equals('none')
  })
})

describe('attaching in a browser', function () {
  const url = 'https://example.com/media/vid_example/master.m3u8'
  type Stubbed = Record<string, unknown>
  let saved: Stubbed = {}
  let calls: string[] = []
  let config: Hls['config']

  /** hls.js as if Media Source were here, recording what it was asked. */
  function withMediaSource(): void {
    const proto = Hls.prototype as unknown as Stubbed
    saved = {
      isSupported: (Hls as unknown as Stubbed).isSupported,
      loadSource: proto.loadSource,
      attachMedia: proto.attachMedia,
      destroy: proto.destroy
    }
    calls = []
    Hls.isSupported = () => true
    proto.loadSource = function (this: Hls, source: string) {
      config = this.config
      calls.push(`loadSource ${source}`)
    }
    proto.attachMedia = () => {
      calls.push('attachMedia')
    }
    proto.destroy = () => {
      calls.push('destroy')
    }
  }

  afterEach(function () {
    if (saved.isSupported == null) return
    const proto = Hls.prototype as unknown as Stubbed
    Hls.isSupported = saved.isSupported as typeof Hls.isSupported
    proto.loadSource = saved.loadSource
    proto.attachMedia = saved.attachMedia
    proto.destroy = saved.destroy
    saved = {}
  })

  it('hands Safari the address and takes it back on teardown', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser(APPLE_VENDOR, () => {
      const detach = attachHls(video as unknown as VideoHandle, url)
      expect(video.src).equals(url)
      expect(calls).deep.equals([])
      detach()
    })
    expect(video.src).equals('')
    expect(video.removed).deep.equals(['src'])
    expect(video.loads).equals(1)
    expect(video.attached()).equals(0)
  })

  it('gives a single live viewer a minute of buffer and live delay', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser('Google Inc.', () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          isLive: () => true
        }
      )
      expect(config.maxBufferLength).equals(60)
      expect(config.liveSyncDuration).equals(60)
      expect(config.backBufferLength).equals(30)
      detach()
    })
  })

  it('keeps recording buffers and coordinated live grid limits', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser('Google Inc.', () => {
      attachHls(video as unknown as VideoHandle, url)()
      expect(config.maxBufferLength).equals(30)
      expect(config.liveSyncDuration).equals(undefined)
      attachHls(video as unknown as VideoHandle, url, undefined, {
        wantsToPlay: () => true,
        isLive: () => true,
        buffer: { aheadSec: 10 }
      })()
      expect(config.maxBufferLength).equals(10)
      expect(config.maxMaxBufferLength).equals(10)
      expect(config.liveSyncDuration).equals(undefined)
    })
  })

  it('attaches live stall recovery to Safari without replacing its engine', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser(APPLE_VENDOR, () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => false,
          isLive: () => true
        }
      )
      expect(video.src).equals(url)
      expect(calls).deep.equals([])
      detach()
    })
    expect(video.attached()).equals(0)
  })

  it('joins the latest native HLS footage only on the first play', function () {
    withMediaSource()
    const video = new FakeVideo()
    video.seekable = { length: 1, start: () => 0, end: () => 7200 }
    video.paused = false
    asBrowser(APPLE_VENDOR, () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          isLive: () => true
        }
      )
      video.emit('play')
      expect(video.currentTime).equals(7140)
      video.currentTime = 300
      video.emit('play')
      expect(video.currentTime).equals(300)
      detach()
    })
    expect(video.attached()).equals(0)
  })

  it('preserves an explicit highlight or restored position on first play', function () {
    withMediaSource()
    const video = new FakeVideo()
    video.seekable = { length: 1, start: () => 0, end: () => 7200 }
    video.paused = false
    video.currentTime = 300
    asBrowser(APPLE_VENDOR, () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          isLive: () => true,
          startAtLiveEdge: false
        }
      )
      video.emit('play')
      expect(video.currentTime).equals(300)
      detach()
    })
  })

  it('uses hls.js in Chrome and destroys it on teardown', function () {
    withMediaSource()
    const video = new FakeVideo()
    let control: unknown = 'unset'
    asBrowser('Google Inc.', () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          buffer: {
            aheadSec: 10,
            onControl: next => {
              control = next
            }
          }
        }
      )
      expect(video.src).equals('')
      expect(calls).deep.equals([`loadSource ${url}`, 'attachMedia'])
      expect(control).not.equals(null)
      detach()
    })
    expect(calls).deep.equals([`loadSource ${url}`, 'attachMedia', 'destroy'])
    expect(control).equals(null)
    expect(video.attached()).equals(0)
  })

  it('uses hls.js on WebKit without native HLS', function () {
    withMediaSource()
    const video = new FakeVideo('')
    asBrowser(APPLE_VENDOR, () => {
      attachHls(video as unknown as VideoHandle, url)()
    })
    expect(calls).deep.equals([`loadSource ${url}`, 'attachMedia', 'destroy'])
    expect(video.src).equals('')
  })

  it('leaves the element alone with neither', function () {
    // No Media Source in Node, and this element plays no HLS.
    const video = new FakeVideo('')
    asBrowser('Google Inc.', () => {
      attachHls(video as unknown as VideoHandle, url)()
    })
    expect(video.src).equals('')
    expect(video.loads).equals(0)
    expect(video.attached()).equals(0)
  })
})

describe('a grid tile on the browser’s own player', function () {
  const url = 'https://example.com/media/vid_example/master.m3u8'
  const tile = (wants: () => boolean): PlayIntent => ({
    wantsToPlay: wants,
    buffer: { aheadSec: 30 }
  })

  it('is played silently to its first frame, so an iPhone loads it, and held there', async function () {
    const video = new FakeVideo()
    attachNativeHls(
      video,
      url,
      undefined,
      tile(() => false),
      manualClock()
    )
    expect(video.plays).equals(1)
    expect(video.muted).equals(true)
    video.emit('canplay')
    expect(video.paused).equals(true)
    expect(video.muted).equals(false)
    // Once: a later stall's recovery is not taken for the first frame.
    video.emit('canplay')
    expect(video.plays).equals(1)
  })

  it('plays on from its first frame when the grid wants it playing by then', function () {
    const video = new FakeVideo()
    video.muted = true
    attachNativeHls(
      video,
      url,
      undefined,
      tile(() => true),
      manualClock()
    )
    video.emit('canplay')
    expect(video.paused).equals(false)
    // Its sound as it was: muted.
    expect(video.muted).equals(true)
  })

  it('leaves a heard tile it keeps playing silent, and says its sound waits for a tap', function () {
    const video = new FakeVideo()
    let held = 0
    attachNativeHls(
      video,
      url,
      undefined,
      { ...tile(() => true), onSoundHeld: () => (held += 1) },
      manualClock()
    )
    video.emit('canplay')
    expect(video.paused).equals(false)
    // Unmuted without a tap, an iPhone would pause it.
    expect(video.muted).equals(true)
    expect(held).equals(1)
  })

  it('puts back the sound the owner wants now, not what the element had at the start', function () {
    // An angle nobody hears, its element not yet told so when it attached.
    const video = new FakeVideo()
    attachNativeHls(
      video,
      url,
      undefined,
      { ...tile(() => false), muted: () => true },
      manualClock()
    )
    video.emit('canplay')
    expect(video.paused).equals(true)
    expect(video.muted).equals(true)
  })

  it('puts the sound back if Safari refuses the play, or the tile goes first', async function () {
    const refused = new FakeVideo()
    refused.play = async () => {
      throw new Error('NotAllowedError')
    }
    attachNativeHls(
      refused,
      url,
      undefined,
      tile(() => false),
      manualClock()
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(refused.muted).equals(false)
    const gone = new FakeVideo()
    const detach = attachNativeHls(
      gone,
      url,
      undefined,
      tile(() => false),
      manualClock()
    )
    detach()
    expect(gone.muted).equals(false)
  })

  it('is left alone when already playing, and a single player is never primed', function () {
    const playing = new FakeVideo()
    playing.paused = false
    attachNativeHls(
      playing,
      url,
      undefined,
      tile(() => true),
      manualClock()
    )
    expect(playing.plays).equals(0)
    const single = new FakeVideo()
    attachNativeHls(
      single,
      url,
      undefined,
      { wantsToPlay: () => false },
      manualClock()
    )
    expect(single.plays).equals(0)
    expect(single.muted).equals(false)
  })
})

describe('the browser’s own player, when it stumbles', function () {
  const url = 'https://example.com/media/vid_example/master.m3u8'

  function fail(video: FakeVideo, code = 2): void {
    video.error = { code }
    video.emit('error')
  }

  it('loads again after a second, back at the same moment, playing', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let gaveUp = 0
    attachNativeHls(video, url, () => (gaveUp += 1), undefined, clock)
    video.emit('play')
    video.paused = false
    video.currentTime = 754.5
    fail(video)
    // The element resets itself after an error, and is paused.
    video.paused = true
    video.emit('pause')
    video.currentTime = 0
    clock.advance(999)
    expect(video.loads).equals(0)
    clock.advance(1)
    expect(video.loads).equals(1)
    video.emit('loadedmetadata')
    expect(video.currentTime).equals(754.5)
    video.emit('canplay')
    expect(video.plays).equals(1)
    expect(gaveUp).equals(0)
  })

  it('leaves a pause the viewer asked for alone', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    attachNativeHls(video, url, undefined, undefined, clock)
    video.emit('pause')
    fail(video)
    clock.advance(1000)
    video.emit('canplay')
    expect(video.plays).equals(0)
  })

  it('asks the caller what the viewer wants when it is told to', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let wants = false
    attachNativeHls(video, url, undefined, { wantsToPlay: () => wants }, clock)
    fail(video)
    clock.advance(1000)
    video.emit('canplay')
    expect(video.plays).equals(0)
    wants = true
    fail(video)
    clock.advance(2000)
    video.emit('canplay')
    expect(video.plays).equals(1)
  })

  it('loads a live game again once Safari has stopped reading its playlist, and plays on from there', async function () {
    const video = new FakeVideo()
    const clock = manualClock()
    // Safari stopped at 388 s; the server's playlist carries on growing.
    let count = 100
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      count += 3
      const segments = Array.from(
        { length: count },
        (_, i) => `#EXTINF:4.000000,\nseg${String(i)}.m4s`
      )
      return new Response(`#EXTM3U\n${segments.join('\n')}\n`)
    }
    try {
      video.paused = false
      video.currentTime = 388
      video.seekable = { length: 1, start: () => 0, end: () => 388 }
      const detach = attachNativeHls(
        video,
        url,
        undefined,
        { wantsToPlay: () => true, isLive: () => true },
        clock
      )
      for (let i = 0; i < 8; i++) {
        clock.advance(5000)
        for (let j = 0; j < 10; j++) await Promise.resolve()
      }
      expect(video.loads, 'loaded again').equals(1)
      // A reloaded element starts at the newest footage; it is put back.
      video.paused = true
      video.currentTime = 428
      video.emit('loadedmetadata')
      expect(video.currentTime).equals(388)
      video.emit('canplay')
      expect(video.plays, 'and played').equals(1)
      detach()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('ignores a load stopped on purpose, and a second error while waiting', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    attachNativeHls(video, url, undefined, undefined, clock)
    fail(video, 1)
    video.error = null
    video.emit('error')
    clock.advance(60_000)
    expect(video.loads).equals(0)
    fail(video)
    fail(video)
    clock.advance(1000)
    expect(video.loads).equals(1)
  })

  it('waits longer each time, and asks for a new address after three reloads', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let gaveUp = 0
    attachNativeHls(video, url, () => (gaveUp += 1), undefined, clock)
    fail(video)
    clock.advance(1000)
    expect(video.loads).equals(1)
    fail(video)
    clock.advance(1999)
    expect(video.loads).equals(1)
    clock.advance(1)
    expect(video.loads).equals(2)
    fail(video)
    clock.advance(4000)
    expect(video.loads).equals(3)
    fail(video)
    expect(gaveUp).equals(1)
    fail(video)
    clock.advance(60_000)
    expect(gaveUp).equals(1)
    expect(video.loads).equals(3)
  })

  it('starts the ladder again once pictures come back', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let gaveUp = 0
    attachNativeHls(video, url, () => (gaveUp += 1), undefined, clock)
    for (let round = 0; round < 5; round++) {
      fail(video)
      clock.advance(1000)
      video.emit('canplay')
    }
    expect(video.loads).equals(5)
    expect(gaveUp).equals(0)
  })

  it('gives up on the clock when five minutes pass without pictures', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let gaveUp = 0
    attachNativeHls(video, url, () => (gaveUp += 1), undefined, clock)
    fail(video)
    clock.advance(5 * 60_000 + 1)
    expect(gaveUp).equals(1)
    expect(video.loads).equals(0)
  })

  it('gives up at once on an error after five minutes of trouble', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    let gaveUp = 0
    attachNativeHls(video, url, () => (gaveUp += 1), undefined, clock)
    fail(video)
    clock.advance(1000)
    clock.advance(5 * 60_000)
    fail(video)
    expect(gaveUp).equals(1)
  })

  it('stops waiting and lets go of the element on teardown', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    const detach = attachNativeHls(video, url, undefined, undefined, clock)
    expect(video.src).equals(url)
    fail(video)
    detach()
    clock.advance(60_000)
    expect(video.loads).equals(1)
    expect(video.src).equals('')
    expect(video.attached()).equals(0)
  })

  it('runs on the real clock when none is given', function (done) {
    const video = new FakeVideo()
    const detach = attachNativeHls(video, url)
    fail(video)
    detach()
    setTimeout(() => {
      expect(video.loads).equals(1)
      done()
    }, 1100)
  })
})

describe('a live game whose playlist was closed under the player', function () {
  const url = 'https://example.com/media/vid_example/master.m3u8'
  type Stubbed = Record<string, unknown>
  type Listener = (event: string, data: unknown) => void
  interface Running {
    config: { startPosition: number }
    listeners: (event: string) => Listener[]
  }
  let saved: Stubbed = {}
  let loads: Array<{ hls: Running; source: string }> = []
  let fetched: string[] = []
  const realFetch = globalThis.fetch

  function stubbed(playlist: string): void {
    const proto = Hls.prototype as unknown as Stubbed
    saved = {
      isSupported: (Hls as unknown as Stubbed).isSupported,
      loadSource: proto.loadSource,
      attachMedia: proto.attachMedia
    }
    loads = []
    fetched = []
    Hls.isSupported = () => true
    proto.loadSource = function (this: Running, source: string) {
      loads.push({ hls: this, source })
    }
    proto.attachMedia = () => undefined
    globalThis.fetch = (async (input: string) => {
      fetched.push(input)
      return { text: async () => playlist }
    }) as unknown as typeof fetch
  }

  afterEach(function () {
    globalThis.fetch = realFetch
    if (saved.isSupported == null) return
    const proto = Hls.prototype as unknown as Stubbed
    Hls.isSupported = saved.isSupported as typeof Hls.isSupported
    proto.loadSource = saved.loadSource
    proto.attachMedia = saved.attachMedia
    saved = {}
  })

  /** Runs this file's own handler for an hls.js event, the last one added. */
  function emit(hls: Running, event: string, data: unknown = {}): void {
    hls.listeners(event).at(-1)?.(event, data)
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++)
      await new Promise(resolve => setImmediate(resolve))
  }

  function attach(
    video: FakeVideo,
    isLive?: () => boolean,
    wantsToPlay: () => boolean = () => true
  ): { detach: () => void; hls: Running } {
    let detach: () => void = () => undefined
    asBrowser('Google Inc.', () => {
      detach = attachHls(video as unknown as VideoHandle, url, undefined, {
        wantsToPlay,
        isLive
      })
    })
    return { detach, hls: loads[0].hls }
  }

  it('rejoins the live edge of a game it was following, playing again', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    let asked = 0
    const { detach, hls } = attach(video, () => {
      asked += 1
      return true
    })
    video.emit('play')
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    // Closed: it plays out what it has, and the end of it is not the viewer
    // pausing.
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    video.ended = true
    video.emit('pause')
    await settle()
    expect(asked).equals(1)
    expect(fetched).deep.equals([url])
    expect(loads.map(one => one.source)).deep.equals([url, url])
    expect(hls.config.startPosition).equals(-1)
    const plays = video.plays
    emit(hls, Hls.Events.FRAG_BUFFERED)
    expect(video.plays).equals(plays + 1)
    // Only the rejoin's first pictures play it; later ones are left alone.
    emit(hls, Hls.Events.FRAG_BUFFERED)
    expect(video.plays).equals(plays + 1)
    detach()
  })

  it('stays paused when the viewer paused the grid while the playlist was closed', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    // The grid's intent for this tile: the viewer's play and pause buttons.
    let gridPlays = true
    const { detach, hls } = attach(
      video,
      () => true,
      () => gridPlays
    )
    video.emit('play')
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    // Played to the closed edge: the end's pause, then `ended`.
    video.ended = true
    video.paused = true
    video.emit('pause')
    video.emit('ended')
    // The viewer pauses the grid. The tile is paused already, so it hears no
    // pause of its own.
    gridPlays = false
    await settle()
    expect(loads).has.length(2)
    const plays = video.plays
    emit(hls, Hls.Events.FRAG_BUFFERED)
    expect(video.plays).equals(plays)
    detach()
  })

  it('plays again after a rejoin when the end’s pause is all that stopped the intent', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    // The single player's intent: false on any pause it did not cause.
    let viewerWants = true
    video.addEventListener('pause', () => {
      viewerWants = false
    })
    const { detach, hls } = attach(
      video,
      () => true,
      () => viewerWants
    )
    video.emit('play')
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    video.ended = true
    video.paused = true
    video.emit('pause')
    video.emit('ended')
    await settle()
    const plays = video.plays
    emit(hls, Hls.Events.FRAG_BUFFERED)
    expect(video.plays).equals(plays + 1)
    detach()
  })

  it('stays where the viewer was watching, and paused if they paused it', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video, () => true)
    video.emit('play')
    video.emit('pause')
    video.currentTime = 42
    // Opened while the playlist was already closed: never followed live.
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    await settle()
    expect(loads).has.length(2)
    expect(hls.config.startPosition).equals(42)
    const plays = video.plays
    emit(hls, Hls.Events.FRAG_BUFFERED)
    expect(video.plays).equals(plays)
    detach()
  })

  it('stays on the earlier inning a viewer scrubbed back to while it followed', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video, () => true)
    video.emit('play')
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    // Back to the second inning, ten minutes behind the end.
    video.currentTime = 42
    emit(hls, Hls.Events.LEVEL_LOADED, {
      details: { live: false, edge: 642, targetduration: 4 }
    })
    await settle()
    expect(loads).has.length(2)
    expect(hls.config.startPosition).equals(42)
    detach()
  })

  it('rejoins the live edge from a playhead waiting at the end, not ended', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video, () => true)
    video.emit('play')
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    // Where hls.js holds a live player: three segments behind the end.
    video.currentTime = 630
    emit(hls, Hls.Events.LEVEL_LOADED, {
      details: { live: false, edge: 642, targetduration: 4 }
    })
    await settle()
    expect(loads).has.length(2)
    expect(hls.config.startPosition).equals(-1)
    detach()
  })

  it('counts a playhead as following within the live distance and a segment', function () {
    expect(atLiveEdge(626, 642, 4, 3)).equals(true)
    expect(atLiveEdge(625.9, 642, 4, 3)).equals(false)
  })

  it('lets a finished video end, as it always has', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video, () => false)
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: true } })
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    await settle()
    expect(fetched).deep.equals([])
    expect(loads).has.length(1)
    detach()
  })

  it('asks nothing for a video that was not live when it was opened', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video)
    emit(hls, Hls.Events.LEVEL_LOADED, { details: { live: false } })
    await settle()
    expect(fetched).deep.equals([])
    expect(loads).has.length(1)
    detach()
  })
})

describe('the player’s dates, handed out as a mapping (U21)', function () {
  const url = 'https://example.com/media/vid_example/master.m3u8'
  const T0 = Date.parse('2026-10-19T18:00:00Z')
  type Stubbed = Record<string, unknown>
  let saved: Stubbed = {}
  /** What `attachHls` asked hls.js to call, by event. */
  let handlers: Array<[string, (event: unknown, data: unknown) => void]> = []

  afterEach(function () {
    if (saved.isSupported == null) return
    const proto = Hls.prototype as unknown as Stubbed
    Hls.isSupported = saved.isSupported as typeof Hls.isSupported
    proto.loadSource = saved.loadSource
    proto.attachMedia = saved.attachMedia
    proto.destroy = saved.destroy
    proto.on = saved.on
    saved = {}
    handlers = []
  })

  /** hls.js as if Media Source were here, keeping the instance. */
  function withMediaSource(): void {
    const proto = Hls.prototype as unknown as Stubbed
    saved = {
      isSupported: (Hls as unknown as Stubbed).isSupported,
      loadSource: proto.loadSource,
      attachMedia: proto.attachMedia,
      destroy: proto.destroy,
      on: proto.on
    }
    Hls.isSupported = () => true
    proto.loadSource = () => undefined
    proto.attachMedia = () => undefined
    proto.destroy = () => undefined
    const on = saved.on as (...args: unknown[]) => unknown
    proto.on = function (
      this: Hls,
      event: string,
      listener: never,
      context: unknown
    ) {
      // hls.js's own controllers register with themselves as the context;
      // `attachHls` registers with none.
      if (context === undefined) handlers.push([event, listener])
      return on.call(this, event, listener, context)
    }
  }
  /** Calls what `attachHls` registered for `event`, as hls.js would. */
  const fire = (event: string, data: unknown): void => {
    for (const [name, listener] of handlers)
      if (name === event) listener(event, data)
  }
  const level = (
    fragments: Array<{
      start: number
      duration: number
      programDateTime: number | null
    }>
  ): unknown => ({ details: { live: true, fragments } })

  it('maps hls.js’s dated fragments on every load and update, and says so when there are none', function () {
    withMediaSource()
    const video = new FakeVideo()
    const handed: Array<ReturnType<typeof Object> | null> = []
    asBrowser('Google Inc.', () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          onWallMapping: mapping => handed.push(mapping)
        }
      )
      fire(
        Hls.Events.LEVEL_LOADED,
        level([
          { start: 0, duration: 4, programDateTime: T0 },
          { start: 4, duration: 4, programDateTime: T0 + 38_000 }
        ])
      )
      fire(
        Hls.Events.LEVEL_UPDATED,
        level([
          { start: 0, duration: 4, programDateTime: T0 },
          { start: 4, duration: 4, programDateTime: T0 + 38_000 },
          { start: 8, duration: 4, programDateTime: T0 + 42_000 }
        ])
      )
      fire(
        Hls.Events.LEVEL_LOADED,
        level([{ start: 0, duration: 4, programDateTime: null }])
      )
      detach()
    })
    expect(handed).length(3)
    const [first, second, none] = handed as Array<{
      wallAt: (sec: number) => number | null
      newestWall: () => number | null
    } | null>
    expect(first?.wallAt(5)).equals(T0 + 39_000)
    expect(second?.newestWall()).equals(T0 + 46_000)
    expect(none).equals(null)
  })

  it('maps Safari’s start date, again as its seekable end grows, and says so without one', function () {
    const video = new FakeVideo() as FakeVideo & { getStartDate?: () => Date }
    let date = Number.NaN
    video.getStartDate = () => new Date(date)
    const handed: Array<{
      wallAt: (sec: number) => number | null
      newestWall: () => number | null
    } | null> = []
    asBrowser(APPLE_VENDOR, () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        {
          wantsToPlay: () => true,
          onWallMapping: mapping => handed.push(mapping)
        }
      )
      // No date yet and no metadata: nothing to say.
      video.emit('progress')
      expect(handed).deep.equals([])
      video.readyState = 1
      video.emit('loadedmetadata')
      expect(handed).deep.equals([null])
      date = T0
      video.seekable = { length: 1, start: () => 0, end: () => 30 }
      video.emit('durationchange')
      // The same end again is no news.
      video.emit('progress')
      video.seekable = { length: 1, start: () => 0, end: () => 34 }
      video.emit('progress')
      detach()
    })
    expect(handed).length(3)
    expect(handed[1]?.wallAt(10)).equals(T0 + 10_000)
    expect(handed[2]?.newestWall()).equals(T0 + 34_000)
    // Detached, it listens to nothing more.
    expect(video.attached()).equals(0)
  })
})
