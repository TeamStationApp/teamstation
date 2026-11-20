import { expect } from 'chai'
import Hls from 'hls.js'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import {
  APPLE_VENDOR,
  atLiveEdge,
  attachHls,
  attachNativeHls,
  HLS_MIME_TYPE,
  hlsEngine,
  reportsLiveStalls,
  RESTORE_PROGRESS_MS,
  RETRY_BACK_SEC,
  type RetryClock,
  SEEK_STUCK_MS
} from './attachHls'
import { LIVE_DELAY_SEC } from './liveDelay'
import { REJOIN_GIVE_UP_MS } from './liveRejoin'
import { playbackOf } from './playbackSession'
import type { PlayIntent } from './playIntent'
import { shouldResumeAfterRecovery } from './resumeAfterRecovery'
import type { VideoHandle } from './videoHandle'

// A browser whose Media Source takes HEVC, as every one these tests stand
// for does; the one that does not says so for itself.
const mediaSourceBefore = Object.getOwnPropertyDescriptor(
  globalThis,
  'MediaSource'
)
before(function () {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: { isTypeSupported: () => true }
  })
})
after(function () {
  if (mediaSourceBefore == null)
    Reflect.deleteProperty(globalThis, 'MediaSource')
  else Object.defineProperty(globalThis, 'MediaSource', mediaSourceBefore)
})

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
  seeking = false
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 }
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

/**
 * Safari's own player on an iPhone, which loads nothing into an element
 * until it is played: `load()` empties it and leaves it paused, blank, and
 * only a `play()` brings metadata and a picture. A desktop player would load
 * to its first frame by itself and say `canplay`; this one never does.
 */
class IphoneVideo extends FakeVideo {
  /** What the element reaches once it is played after a load. */
  reloadedAt = 0
  /** Whether `load()` says `pause`, as a playing element reset may. */
  pausesOnLoad = false

  load(): void {
    super.load()
    const wasPlaying = !this.paused
    this.paused = true
    this.readyState = 0
    this.currentTime = 0
    this.seekable = { length: 0, start: () => 0, end: () => 0 }
    if (wasPlaying && this.pausesOnLoad) this.emit('pause')
  }

  async play(): Promise<void> {
    this.plays += 1
    this.paused = false
    this.emit('play')
    if (this.readyState === 0 && this.src !== '') {
      this.readyState = 4
      this.currentTime = this.reloadedAt
      this.emit('loadedmetadata')
      this.emit('canplay')
    }
  }
}

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

  it('is the browser where there is no Media Source but Apple’s own HLS, and nobody else there', function () {
    expect(
      hlsEngine({ vendor: APPLE_VENDOR, nativeHls: true, mediaSource: false })
    ).equals('native')
    // Chrome answers `maybe` to HLS either way: without Media Source to
    // decode through, nothing plays it.
    expect(
      hlsEngine({ vendor: 'Google Inc.', nativeHls: true, mediaSource: false })
    ).equals('none')
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

  it('gives a single live viewer half a minute ahead, twenty seconds behind and 45 s of live delay (U24, U29)', function () {
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
      expect(config.maxBufferLength).equals(30)
      expect(config.maxMaxBufferLength).equals(30)
      expect(config.liveSyncDuration).equals(45)
      expect(config.backBufferLength).equals(20)
      detach()
    })
  })

  it('starts a tile where its grid placed it, and leaves the rest to hls.js', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser('Google Inc.', () => {
      attachHls(video as unknown as VideoHandle, url, undefined, {
        wantsToPlay: () => true,
        isLive: () => true,
        buffer: { aheadSec: 30 },
        startSec: 2009
      })()
      expect(config.startPosition).equals(2009)
      attachHls(video as unknown as VideoHandle, url)()
      expect(config.startPosition).equals(-1)
    })
  })

  it('keeps recording buffers, and a live grid tile’s limits with the same live delay (U24)', function () {
    withMediaSource()
    const video = new FakeVideo()
    asBrowser('Google Inc.', () => {
      attachHls(video as unknown as VideoHandle, url)()
      expect(config.maxBufferLength).equals(30)
      expect(config.maxMaxBufferLength).equals(30)
      expect(config.backBufferLength).equals(20)
      expect(config.liveSyncDuration).equals(undefined)
      attachHls(video as unknown as VideoHandle, url, undefined, {
        wantsToPlay: () => true,
        isLive: () => true,
        buffer: { aheadSec: 10 }
      })()
      expect(config.maxBufferLength).equals(10)
      expect(config.maxMaxBufferLength).equals(10)
      expect(config.liveSyncDuration).equals(45)
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
      expect(video.currentTime).equals(7155)
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
    asBrowser('Google Inc.', () => {
      const detach = attachHls(
        video as unknown as VideoHandle,
        url,
        undefined,
        { wantsToPlay: () => true, buffer: { aheadSec: 10 } }
      )
      expect(video.src).equals('')
      expect(calls).deep.equals([`loadSource ${url}`, 'attachMedia'])
      detach()
    })
    expect(calls).deep.equals([`loadSource ${url}`, 'attachMedia', 'destroy'])
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
      // Played with the load, since an iPhone loads nothing until it is.
      expect(video.plays, 'and played').equals(1)
      // A reloaded element starts at the newest footage; it is put back.
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

  it('plays an iPhone again after it loads a live game afresh, since it shows nothing until played', async function () {
    const video = new IphoneVideo()
    const clock = manualClock()
    // Safari stopped at 388 s after a long cut; the server's playlist has
    // come back and carries on growing.
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
      video.readyState = 4
      video.currentTime = 388
      video.reloadedAt = 450
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
      expect(video.plays, 'played, so it loads at all').equals(1)
      expect(video.paused, 'and is playing').equals(false)
      expect(video.currentTime, 'back where it was').equals(388)
      detach()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  /**
   * An iPhone that stood still at 388 s through a 64 s publisher cut, while
   * the server's playlist carried on after it, reloaded by the watch and put
   * back at 388 s. `progresses` says whether that position then plays.
   */
  async function reloadAfterCut(progresses: boolean): Promise<{
    video: IphoneVideo
    clock: ReturnType<typeof manualClock>
    said: boolean[]
    detach: () => void
    restore: () => void
  }> {
    const video = new IphoneVideo()
    const clock = manualClock()
    const said: boolean[] = []
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
    video.paused = false
    video.readyState = 4
    video.currentTime = 388
    video.reloadedAt = 522
    video.seekable = { length: 1, start: () => 0, end: () => 388 }
    const detach = attachNativeHls(
      video,
      url,
      undefined,
      {
        wantsToPlay: () => true,
        isLive: () => true,
        onRecovery: now => said.push(now)
      },
      clock
    )
    for (let i = 0; i < 12 && video.loads === 0; i++) {
      clock.advance(5000)
      for (let j = 0; j < 10; j++) await Promise.resolve()
    }
    expect(video.loads, 'loaded again').equals(1)
    expect(video.currentTime, 'put back where it stood').equals(388)
    // After the reload the playlist reaches 567 s, the cut a hole in it.
    video.seekable = { length: 1, start: () => 0, end: () => 567 }
    // The element pauses itself in the hole, as the iPhone's did.
    if (!progresses) {
      video.paused = true
      video.emit('pause')
    }
    for (let s = 1; s <= 9; s++) {
      if (progresses) video.currentTime = 388 + s
      clock.advance(1000)
    }
    return {
      video,
      clock,
      said,
      detach,
      restore: () => {
        globalThis.fetch = realFetch
      }
    }
  }

  it('rejoins the live point, playing, when the position put back after a cut never plays', async function () {
    const run = await reloadAfterCut(false)
    try {
      expect(run.video.currentTime, 'still waiting in the hole').equals(388)
      const plays = run.video.plays
      run.clock.advance(1000)
      expect(run.video.currentTime, 'the live point').equals(567 - 45)
      expect(run.video.plays, 'played again').equals(plays + 1)
      expect(run.video.paused).equals(false)
      expect(run.said, 'and the recovery is over').deep.equals([true, false])
      // It is not moved again.
      run.video.currentTime = 530
      run.clock.advance(20_000)
      expect(run.video.currentTime).equals(530)
      run.detach()
    } finally {
      run.restore()
    }
  })

  it('stays where the viewer was when the position put back after a reload plays on', async function () {
    const run = await reloadAfterCut(true)
    try {
      run.clock.advance(1000)
      run.clock.advance(20_000)
      expect(run.video.currentTime, 'where the viewer was').equals(397)
      expect(run.video.paused).equals(false)
      expect(run.said, 'and the recovery is over').deep.equals([true, false])
      run.detach()
    } finally {
      run.restore()
    }
  })

  it('puts a restored position that played on back where it got to, after a second error', async function () {
    const run = await reloadAfterCut(true)
    try {
      // Inside the restore's check, it has played on to 397 s: then an error.
      run.video.error = { code: 2 }
      run.video.emit('error')
      run.video.error = null
      run.clock.advance(1000)
      run.video.emit('loadedmetadata')
      expect(
        run.video.currentTime,
        'where it got to, not the first restore'
      ).equals(397)
      run.detach()
    } finally {
      run.restore()
    }
  })

  it('plays an iPhone again after an error’s reload, though the reset said pause', function () {
    const video = new IphoneVideo()
    video.pausesOnLoad = true
    const clock = manualClock()
    attachNativeHls(video, url, undefined, undefined, clock)
    video.src = url
    video.paused = false
    video.readyState = 4
    video.emit('play')
    video.currentTime = 120
    fail(video)
    clock.advance(1000)
    expect(video.loads).equals(1)
    expect(video.plays).equals(1)
    expect(video.paused).equals(false)
    expect(video.currentTime).equals(120)
  })

  it('leaves an iPhone paused after a reload when the viewer had paused it', function () {
    const video = new IphoneVideo()
    const clock = manualClock()
    attachNativeHls(video, url, undefined, { wantsToPlay: () => false }, clock)
    fail(video)
    clock.advance(1000)
    expect(video.loads).equals(1)
    expect(video.plays).equals(0)
  })

  it('tells its owner a reload is under way, so a pause it causes is not read as the viewer’s', function () {
    const video = new IphoneVideo()
    video.pausesOnLoad = true
    const clock = manualClock()
    const said: boolean[] = []
    // The owner's own pause listener, as the game page has: it runs first.
    let viewerWants = true
    let recovering = false
    video.addEventListener('pause', () => {
      if (!recovering) viewerWants = false
    })
    const detach = attachNativeHls(
      video,
      url,
      undefined,
      {
        wantsToPlay: () => viewerWants,
        onRecovery: now => {
          recovering = now
          said.push(now)
        }
      },
      clock
    )
    video.src = url
    video.paused = false
    video.readyState = 4
    fail(video)
    clock.advance(1000)
    expect(viewerWants).equals(true)
    expect(video.plays).equals(1)
    expect(said).deep.equals([true, false])
    // A later pause is the viewer's again.
    video.paused = true
    video.emit('pause')
    expect(viewerWants).equals(false)
    detach()
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

describe('a seek Safari’s own player never finishes (#326)', function () {
  const url = 'https://example.com/media/vid_example/index.m3u8'

  /**
   * Back from full screen, sent to 667.8 s, 0.2 s before the end of the one
   * segment it held (664.0–668.0): Safari began the seek and stood there.
   */
  function stuck(intent?: PlayIntent): {
    video: FakeVideo
    clock: ReturnType<typeof manualClock>
    detach: () => void
    seek: (to: number) => void
  } {
    const video = new FakeVideo()
    const clock = manualClock()
    const detach = attachNativeHls(
      video,
      url,
      undefined,
      intent ?? { wantsToPlay: () => true, isLive: () => true },
      clock
    )
    video.readyState = 1
    video.buffered = {
      length: 1,
      start: () => 664,
      end: () => 668
    }
    const seek = (to: number): void => {
      video.currentTime = to
      video.seeking = true
      video.emit('seeking')
    }
    seek(667.8)
    return { video, clock, detach, seek }
  }

  it('sends a seek still unfinished after 5 s to the start of the segment it holds, once', function () {
    const { video, clock } = stuck()
    clock.advance(SEEK_STUCK_MS - 1)
    expect(video.currentTime, 'not yet').equals(667.8)
    clock.advance(1)
    expect(video.currentTime).equals(664)
    expect(video.loads).equals(0)
  })

  it('leaves a seek that finishes in time alone', function () {
    const { video, clock } = stuck()
    clock.advance(2000)
    video.seeking = false
    video.emit('seeked')
    clock.advance(10_000)
    expect(video.currentTime).equals(667.8)
    expect(video.loads).equals(0)
  })

  it('reloads when the retried seek stands unfinished too, or no buffered range holds the target', function () {
    const twice = stuck()
    twice.clock.advance(SEEK_STUCK_MS)
    // The retry's own seek, from the segment's start, stands as well.
    twice.video.emit('seeking')
    twice.clock.advance(SEEK_STUCK_MS)
    expect(twice.video.loads).equals(1)

    const nowhere = stuck()
    nowhere.video.buffered = { length: 0, start: () => 0, end: () => 0 }
    nowhere.clock.advance(SEEK_STUCK_MS)
    expect(nowhere.video.loads).equals(1)
  })

  it('counts each new seek afresh, and stops watching once emptied or detached', function () {
    const { video, clock, seek } = stuck()
    clock.advance(SEEK_STUCK_MS)
    video.emit('seeking')
    // The viewer seeks again before the retry is judged: a new seek, a new retry.
    seek(667.5)
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(664)
    expect(video.loads).equals(0)

    const emptied = stuck()
    emptied.video.emit('emptied')
    emptied.clock.advance(SEEK_STUCK_MS * 3)
    expect(emptied.video.currentTime).equals(667.8)

    const gone = stuck()
    gone.detach()
    gone.clock.advance(SEEK_STUCK_MS * 3)
    expect(gone.video.currentTime).equals(667.8)
    expect(gone.video.loads).equals(1)
  })

  it('leaves a seek alone while its footage is still arriving, however slowly', function () {
    const { video, clock } = stuck()
    for (let i = 0; i < 5; i++) {
      clock.advance(2000)
      video.emit('progress')
    }
    expect(video.currentTime, 'still loading after 10 s').equals(667.8)
    expect(video.loads).equals(0)
    // Then nothing more arrives: stuck after all.
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(664)
  })

  it('reloads at most once a seek: the reload’s own seek back is never reloaded again', function () {
    const { video, clock } = stuck()
    // Nothing held at the target: straight to a reload.
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(1)
    // The reload loads it afresh and goes back to the target, slowly.
    video.emit('loadedmetadata')
    expect(video.currentTime).equals(667.8)
    video.seeking = true
    video.emit('seeking')
    for (let i = 0; i < 20; i++) clock.advance(SEEK_STUCK_MS)
    expect(video.loads, 'one reload, not one every 3 s').equals(1)
  })

  it('keeps a live viewer’s rewind after the watch reloads, and if the way back wedges too, moves it to live once instead of reloading again', function () {
    let recovering = false
    const { video, clock } = stuck({
      wantsToPlay: () => true,
      isLive: () => true,
      onRecovery: now => {
        recovering = now
      }
    })
    video.seekable = { length: 1, start: () => 0, end: () => 1200 }
    // Nothing held at the target: one reload.
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(1)
    video.emit('emptied')
    video.emit('loadedmetadata')
    expect(video.currentTime, 'back to the rewind').equals(667.8)
    // Safari says canplay before the queued seeking of the way back, so the
    // recovery has ended by the time that seeking is heard.
    video.readyState = 4
    video.emit('canplay')
    video.seeking = true
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS - 1)
    expect(
      video.currentTime,
      'the rewind is kept while it may still load'
    ).equals(667.8)
    // The way back wedged too: the last step, once.
    clock.advance(1)
    expect(video.currentTime).equals(1200 - LIVE_DELAY_SEC)
    expect(recovering, 'the viewer’s pauses count again').equals(false)
    video.emit('seeking')
    for (let i = 0; i < 40; i++) clock.advance(SEEK_STUCK_MS)
    expect(video.loads, 'still one reload after two minutes').equals(1)
  })

  it('ends the recovery of a recording whose way back wedges too, and leaves it where it is', function () {
    let recovering = false
    const { video, clock } = stuck({
      wantsToPlay: () => true,
      onRecovery: now => {
        recovering = now
      }
    })
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    expect(recovering).equals(true)
    video.emit('emptied')
    video.emit('loadedmetadata')
    video.seeking = true
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS)
    expect(recovering).equals(false)
    expect(video.currentTime).equals(667.8)
    expect(video.loads).equals(1)
  })

  it('leaves a stuck seek to an error’s reload already scheduled, and to a player that gave up', function () {
    const { video, clock } = stuck()
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    // An error first: its reload is scheduled a second on.
    video.error = { code: 2 }
    video.emit('error')
    clock.advance(SEEK_STUCK_MS - 1)
    expect(video.loads, 'the error’s own reload').equals(1)
  })

  it('starts each seek afresh once the last one finished, and forgets a retry’s seek a reload dropped', function () {
    const { video, clock, seek } = stuck()
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(1)
    video.emit('emptied')
    video.emit('loadedmetadata')
    video.emit('seeking')
    video.seeking = false
    video.emit('seeked')
    // Later, a seek of the viewer's wedges: it may reload in its turn.
    seek(300)
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(2)

    const dropped = stuck()
    dropped.clock.advance(SEEK_STUCK_MS)
    expect(dropped.video.currentTime, 'the retry').equals(664)
    // A reload drops the retry before its seeking is heard; the viewer seeks.
    dropped.video.emit('emptied')
    dropped.seek(667.8)
    dropped.clock.advance(SEEK_STUCK_MS)
    expect(
      dropped.video.currentTime,
      'a retry of its own, not taken for the old one'
    ).equals(664)
    expect(dropped.video.loads).equals(0)
  })

  it('reloads after a seek that went back to 0 without taking the next reload for the watch’s', function () {
    const { video, clock, seek } = stuck()
    video.buffered = { length: 1, start: () => 0, end: () => 4 }
    seek(0)
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(1)
    // Nothing to go back to: the flag is cleared all the same.
    video.emit('loadedmetadata')
    video.readyState = 4
    video.emit('canplay')
    // A cut later: an error's reload, which arms the restore check.
    video.currentTime = 500
    video.seekable = { length: 1, start: () => 0, end: () => 900 }
    video.error = { code: 2 }
    video.emit('error')
    clock.advance(1000)
    expect(video.loads).equals(2)
    video.emit('loadedmetadata')
    expect(video.currentTime).equals(500)
    clock.advance(RESTORE_PROGRESS_MS)
    expect(video.currentTime, 'the restore check moves it to live').equals(
      900 - LIVE_DELAY_SEC
    )
  })

  it('counts a viewer’s seek after a reload afresh, the reload’s pending seek being gone', function () {
    const { video, clock, seek } = stuck()
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(1)
    // Emptied before the way back's seeking was heard; the viewer seeks.
    video.emit('emptied')
    seek(300)
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads, 'the viewer’s own stuck seek may reload').equals(2)
  })

  it('retries a stuck seek no more than a segment back, however long the range it is in', function () {
    const { video, clock, seek } = stuck()
    // Played from the start: one range of everything held.
    video.buffered = { length: 1, start: () => 0, end: () => 90 }
    seek(80)
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(80 - RETRY_BACK_SEC)
  })

  it('takes its last step once: the jump to live, wedged as well, is not jumped again', function () {
    const { video, clock } = stuck()
    let end = 1200
    video.seekable = { length: 1, start: () => 0, end: () => end }
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    video.emit('emptied')
    video.emit('loadedmetadata')
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(1200 - LIVE_DELAY_SEC)
    // Safari says seeking for the jump, and it stands too while live grows.
    video.emit('seeking')
    end = 1300
    for (let i = 0; i < 10; i++) clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime, 'one jump, left to finish').equals(
      1200 - LIVE_DELAY_SEC
    )
    expect(video.loads).equals(1)
  })

  it('takes a seeking heard once for two seeks as the later one’s: a viewer’s seek over the last step is watched again', function () {
    const { video, clock } = stuck()
    video.seekable = { length: 1, start: () => 0, end: () => 1200 }
    video.buffered = { length: 0, start: () => 0, end: () => 0 }
    clock.advance(SEEK_STUCK_MS)
    video.emit('emptied')
    video.emit('loadedmetadata')
    video.emit('seeking')
    // The way back wedged: the last step jumps to live...
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(1200 - LIVE_DELAY_SEC)
    // ...and, in the same moment, the viewer seeks: one seeking, at theirs.
    video.currentTime = 500
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads, 'the viewer’s wedged seek is the watch’s again').equals(
      2
    )
  })

  it('keeps the restore check for a recovery’s own way back that wedged: a black hole still goes to live', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    attachNativeHls(
      video,
      url,
      undefined,
      { wantsToPlay: () => true, isLive: () => true },
      clock
    )
    // An error reload of a live player stood in a publisher's hole at 388 s.
    video.currentTime = 388
    video.seekable = { length: 1, start: () => 0, end: () => 900 }
    video.error = { code: 2 }
    video.emit('error')
    clock.advance(1000)
    expect(video.loads).equals(1)
    video.emit('loadedmetadata')
    // Its way back to 388 wedges: the watch reloads.
    video.seeking = true
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(2)
    video.emit('loadedmetadata')
    expect(video.currentTime).equals(388)
    // This time it lands, but stands black in the hole.
    video.emit('seeking')
    video.seeking = false
    video.emit('seeked')
    clock.advance(RESTORE_PROGRESS_MS)
    expect(video.currentTime, 'the restore check moves it to live').equals(
      900 - LIVE_DELAY_SEC
    )
  })

  it('goes back to a rewind made during a restore check, not to where the restore put it', function () {
    const video = new FakeVideo()
    const clock = manualClock()
    attachNativeHls(
      video,
      url,
      undefined,
      { wantsToPlay: () => true, isLive: () => true },
      clock
    )
    // An error reload restores a live player to 600 s; its check is armed.
    video.currentTime = 600
    video.seekable = { length: 1, start: () => 0, end: () => 900 }
    video.error = { code: 2 }
    video.emit('error')
    clock.advance(1000)
    video.emit('loadedmetadata')
    video.emit('seeking')
    video.seeking = false
    video.emit('seeked')
    // Inside the check's window, the viewer rewinds to 300 s; it wedges.
    video.currentTime = 300
    video.seeking = true
    video.emit('seeking')
    clock.advance(SEEK_STUCK_MS)
    expect(video.loads).equals(2)
    video.emit('loadedmetadata')
    expect(video.currentTime).equals(300)
  })

  it('watches a grid tile’s seeks the same way', function () {
    const { video, clock } = stuck({
      wantsToPlay: () => false,
      buffer: { aheadSec: 30 }
    })
    clock.advance(SEEK_STUCK_MS)
    expect(video.currentTime).equals(664)
  })
})

describe('Safari’s own live player, run out of footage during a long cut', function () {
  const url = 'https://example.com/media/vid_example/index.m3u8'
  const OPEN = '#EXTM3U\n#EXTINF:4.000000,\nseg1.m4s\n'
  const CLOSED = `${OPEN}#EXT-X-ENDLIST\n`
  const realFetch = globalThis.fetch
  /** What the stubbed server answers for the playlist, and how often it was read. */
  let playlist = OPEN
  let reads = 0
  beforeEach(function () {
    playlist = OPEN
    reads = 0
    globalThis.fetch = async () => {
      reads += 1
      return new Response(playlist)
    }
  })
  afterEach(function () {
    globalThis.fetch = realFetch
  })

  /** Lets the stubbed fetches and the rejoin's promises settle. */
  const settle = async (): Promise<void> => {
    // A Response's body is read on a later turn of the event loop.
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  /**
   * A live SynthA at 93.5 s when its camera went away for 64 s: Safari played
   * to the end of what it had, paused and said `ended`, and the playlist then
   * carried on growing under it while it stood there (#327).
   *
   * `followsPauses` is the game page's own wish, which a pause clears and a
   * play sets, heard before the player's; otherwise `wants` answers.
   */
  function ranOut(
    options: {
      wants?: () => boolean
      followsPauses?: boolean
      intent?: Partial<PlayIntent>
    } = {}
  ): {
    video: FakeVideo
    clock: ReturnType<typeof manualClock>
    grow: (endSec: number) => void
    detach: () => void
    viewer: { wants: boolean }
  } {
    const video = new FakeVideo()
    const clock = manualClock()
    const viewer = { wants: true }
    if (options.followsPauses === true) {
      video.addEventListener('pause', () => {
        viewer.wants = false
      })
      video.addEventListener('play', () => {
        viewer.wants = true
      })
    }
    const wants =
      options.wants ??
      (options.followsPauses === true ? () => viewer.wants : () => true)
    const detach = attachNativeHls(
      video,
      url,
      undefined,
      { wantsToPlay: wants, isLive: () => true, ...options.intent },
      clock
    )
    video.paused = false
    video.readyState = 4
    video.emit('play')
    video.currentTime = 93.5
    video.seekable = { length: 1, start: () => 0, end: () => 81.4 }
    video.paused = true
    video.ended = true
    video.emit('pause')
    video.emit('ended')
    return {
      video,
      clock,
      viewer,
      detach,
      grow: endSec => {
        video.ended = false
        video.seekable = { length: 1, start: () => 0, end: () => endSec }
      }
    }
  }

  it('plays on from where it stopped once there is footage after it', function () {
    const { video, clock, grow } = ranOut()
    clock.advance(4000)
    expect(video.plays, 'nothing to play yet').equals(0)
    grow(125.4)
    clock.advance(2000)
    expect(video.plays).equals(1)
    expect(video.paused).equals(false)
    expect(video.currentTime).equals(93.5)
    expect(video.loads, 'no reload').equals(0)
  })

  it('rejoins the live point when the game has moved further on than that', function () {
    const { video, clock, grow } = ranOut()
    grow(200)
    clock.advance(2000)
    expect(video.plays).equals(1)
    expect(video.currentTime).equals(200 - LIVE_DELAY_SEC)
  })

  it('plays again for the game page, whose wish the end’s own pause cleared', function () {
    const { video, clock, grow, viewer } = ranOut({ followsPauses: true })
    expect(viewer.wants, 'the page read the end as a pause').equals(false)
    grow(125.4)
    clock.advance(2000)
    expect(video.plays).equals(1)
    expect(video.paused).equals(false)
  })

  it('stays paused when it was wanted at the end and is not by the time there is footage', function () {
    let wanted = true
    const { video, clock, grow } = ranOut({ wants: () => wanted })
    wanted = false
    grow(125.4)
    clock.advance(2000)
    expect(video.plays).equals(0)
    expect(video.paused).equals(true)
  })

  it('leaves it where the viewer scrubbed during the wait, paused: their seek ends the run-out', function () {
    const { video, clock, grow } = ranOut({ followsPauses: true })
    video.currentTime = 50
    video.seeking = true
    video.emit('seeking')
    video.seeking = false
    video.emit('seeked')
    grow(200)
    clock.advance(4000)
    expect(video.currentTime).equals(50)
    expect(video.plays).equals(0)
  })

  it('stops looking after ten minutes, on a play, and once detached', function () {
    const late = ranOut()
    late.clock.advance(REJOIN_GIVE_UP_MS + 2000)
    late.grow(900)
    late.clock.advance(2000)
    expect(late.video.plays, 'given up').equals(0)

    const played = ranOut()
    played.video.emit('play')
    played.grow(125.4)
    played.clock.advance(4000)
    expect(played.video.plays, 'a play settled it').equals(0)

    const gone = ranOut()
    gone.detach()
    gone.grow(125.4)
    gone.clock.advance(4000)
    expect(gone.video.plays, 'detached').equals(0)
  })

  it('leaves an open playlist to the look: nothing reloads while the camera is away', async function () {
    const { video, clock, grow } = ranOut()
    for (let i = 0; i < 15; i++) {
      clock.advance(2000)
      await settle()
    }
    expect(reads, 'read every 10 s').greaterThan(1)
    expect(video.loads).equals(0)
    expect(video.plays).equals(0)
    grow(125.4)
    clock.advance(2000)
    expect(video.plays).equals(1)
    expect(video.loads).equals(0)
  })

  it('hands a closed playlist to the rejoin, which loads it afresh once it is open again', async function () {
    playlist = CLOSED
    const { video, clock, grow } = ranOut({ followsPauses: true })
    clock.advance(10_000)
    await settle()
    // The look's read, then liveRejoin's own at once: still closed.
    expect(reads).equals(2)
    expect(video.loads).equals(0)
    playlist = OPEN
    // liveRejoin looks again 5 s on, finds it open, and rejoins.
    clock.advance(5000)
    await settle()
    expect(video.loads).equals(1)
    expect(video.plays, 'played, so an iPhone loads it').equals(1)
    // Footage after the stop no longer moves it: the look was handed over.
    grow(300)
    const at = video.currentTime
    clock.advance(4000)
    expect(video.plays).equals(1)
    expect(video.currentTime).equals(at)
  })

  it('leaves it paused when the viewer played and paused it while the closed playlist was awaited', async function () {
    playlist = CLOSED
    const { video, clock } = ranOut({ followsPauses: true })
    clock.advance(10_000)
    await settle()
    // Before liveRejoin's look finds it open: a play and then a pause.
    video.paused = false
    video.emit('play')
    video.paused = true
    video.emit('pause')
    playlist = OPEN
    clock.advance(5000)
    await settle()
    expect(video.loads).equals(1)
    expect(video.plays).equals(0)
  })

  it('leaves a game that really ended alone: no footage a segment past the stop, and the closed playlist goes to the rejoin, which stops', async function () {
    playlist = CLOSED
    const { video, clock } = ranOut({
      intent: { isLive: () => false }
    })
    // The last seekable end a hair past where it stopped, as it can be.
    video.seekable = { length: 1, start: () => 0, end: () => 93.54 }
    for (let i = 0; i < 30; i++) {
      clock.advance(2000)
      await settle()
    }
    expect(video.plays).equals(0)
    expect(video.loads).equals(0)
  })

  it('leaves a grid tile, a recording and a player that has not run out alone', function () {
    const tile = ranOut({ intent: { buffer: { aheadSec: 30 } } })
    tile.grow(125.4)
    tile.clock.advance(4000)
    // Its one silent play at attach (`primeSilently`), and no other.
    expect(tile.video.plays, 'a grid tile').equals(1)

    const preview = ranOut({ intent: { preview: true } })
    preview.grow(125.4)
    preview.clock.advance(4000)
    expect(preview.video.plays, 'a card preview').equals(0)

    const recording = ranOut({ intent: { isLive: undefined } })
    recording.grow(125.4)
    recording.clock.advance(4000)
    expect(recording.video.plays, 'a recording').equals(0)
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

  it('closes its playback session before it empties the player', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const { detach, hls } = attach(video, () => true)
    const session = playbackOf(video)
    if (session == null) throw new Error('no playback session')
    const order: string[] = []
    session.detach = () => {
      order.push('session')
    }
    const running = hls as unknown as { destroy: () => void }
    const destroy = running.destroy.bind(running)
    running.destroy = () => {
      order.push('player')
      destroy()
    }
    detach()
    expect(order).deep.equals(['session', 'player'])
  })

  it('tells its playback session what hls.js reports', async function () {
    stubbed('#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n')
    const video = new FakeVideo()
    const proto = Hls.prototype as unknown as Stubbed
    const saved = {
      recoverMediaError: proto.recoverMediaError,
      startLoad: proto.startLoad,
      stopLoad: proto.stopLoad
    }
    proto.recoverMediaError = () => undefined
    proto.startLoad = () => undefined
    proto.stopLoad = () => undefined
    const realNow = Date.now
    try {
      const { detach, hls } = attach(video, () => true)
      const session = playbackOf(video)
      expect(session).not.equals(undefined)
      const said: unknown[][] = []
      if (session == null) return
      session.hlsError = (...args: unknown[]) => {
        said.push(['error', ...args])
      }
      session.recovery = (kind: string) => {
        said.push(['recovery', kind])
      }
      session.bandwidth = (bps: number) => {
        said.push(['bandwidth', bps])
      }
      session.bitrate = (bps: number) => {
        said.push(['bitrate', bps])
      }
      session.targetDuration = (sec: number) => {
        said.push(['target', sec])
      }
      Object.defineProperty(hls, 'levels', { value: [{ bitrate: 4_300_000 }] })
      Object.defineProperty(hls, 'bandwidthEstimate', { value: 8_000_000 })
      emit(hls, Hls.Events.ERROR, {
        type: 'networkError',
        details: 'fragLoadError',
        fatal: false
      })
      emit(hls, Hls.Events.ERROR, {
        type: 'mediaError',
        details: 'bufferStalledError',
        fatal: true
      })
      emit(hls, Hls.Events.ERROR, {
        type: 'networkError',
        details: 'levelLoadError',
        fatal: true
      })
      Date.now = () => realNow() + 10 * 60_000
      emit(hls, Hls.Events.ERROR, {
        type: 'networkError',
        details: 'levelLoadError',
        fatal: true
      })
      emit(hls, Hls.Events.FRAG_LOADED)
      emit(hls, Hls.Events.LEVEL_SWITCHED, { level: 0 })
      emit(hls, Hls.Events.LEVEL_SWITCHED, { level: 3 })
      emit(hls, Hls.Events.LEVEL_LOADED, {
        details: { live: true, targetduration: 6 }
      })
      expect(said).deep.equals([
        ['error', 'networkError', 'fragLoadError', false],
        ['error', 'mediaError', 'bufferStalledError', true],
        ['recovery', 'media_recover'],
        ['error', 'networkError', 'levelLoadError', true],
        ['recovery', 'network_retry'],
        ['error', 'networkError', 'levelLoadError', true],
        ['recovery', 'give_up'],
        ['bandwidth', 8_000_000],
        ['bitrate', 4_300_000],
        ['target', 6]
      ])
      detach()
      expect(playbackOf(video)).equals(undefined)
    } finally {
      Date.now = realNow
      proto.recoverMediaError = saved.recoverMediaError
      proto.startLoad = saved.startLoad
      proto.stopLoad = saved.stopLoad
    }
  })

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

describe('a browser that cannot play the video (U31)', function () {
  it('is told, and nothing is attached', function () {
    const video = new FakeVideo('maybe')
    const realMediaSource = Object.getOwnPropertyDescriptor(
      globalThis,
      'MediaSource'
    )
    Object.defineProperty(globalThis, 'MediaSource', {
      configurable: true,
      value: { isTypeSupported: () => false }
    })
    let told = 0
    try {
      asBrowser('Google Inc.', () => {
        const detach = attachHls(
          video as unknown as VideoHandle,
          'https://example.com/media/vid_example/master.m3u8',
          undefined,
          {
            wantsToPlay: () => true,
            onUnsupported: () => {
              told += 1
            }
          }
        )
        detach()
      })
    } finally {
      if (realMediaSource == null)
        Reflect.deleteProperty(globalThis, 'MediaSource')
      else Object.defineProperty(globalThis, 'MediaSource', realMediaSource)
    }
    expect(told).equals(1)
    expect(video.src).equals('')
    expect(video.attached()).equals(0)
  })
})

describe('which live players have their stalls reported', function () {
  it('reports the viewer’s own live player, and neither a grid tile nor a card preview', function () {
    const isLive = (): boolean => true
    const wantsToPlay = (): boolean => true
    expect(reportsLiveStalls({ wantsToPlay, isLive })).equals(true)
    expect(
      reportsLiveStalls({ wantsToPlay, isLive, buffer: { aheadSec: 30 } })
    ).equals(false)
    expect(reportsLiveStalls({ wantsToPlay, isLive, preview: true })).equals(
      false
    )
    // A recording has no live stalls to report.
    expect(reportsLiveStalls({ wantsToPlay })).equals(false)
    expect(reportsLiveStalls(undefined)).equals(false)
  })
})
