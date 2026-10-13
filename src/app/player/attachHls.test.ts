import { expect } from 'chai'
import Hls from 'hls.js'
import { afterEach, describe, it } from 'mocha'

import {
  aheadControl,
  APPLE_VENDOR,
  attachHls,
  attachNativeHls,
  HLS_MIME_TYPE,
  hlsEngine,
  type RetryClock
} from './attachHls'
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
  ended = false
  currentTime = 0
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
    proto.loadSource = (source: string) => {
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
    isLive?: () => boolean
  ): { detach: () => void; hls: Running } {
    let detach: () => void = () => undefined
    asBrowser('Google Inc.', () => {
      detach = attachHls(video as unknown as VideoHandle, url, undefined, {
        wantsToPlay: () => true,
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
