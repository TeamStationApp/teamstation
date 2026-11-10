import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import type { OnVideoErrorData, VideoRef } from 'react-native-video'

import { attachHls } from './attachHls.native'
import { seekTo } from './explicitSeek'
import { NativeVideoHandle } from './nativeVideoHandle'

const URL = 'https://media.example.test/videos/vid_00000000/index.m3u8'

/**
 * Android's player, as far as the recovery sees it: handed the source it
 * already holds, it does nothing; handed a new one, it loads it.
 */
function androidPlayer(): {
  ref: VideoRef
  loads: () => number
  sources: Array<{ uri: string } | undefined>
  seeks: number[]
} {
  let held: string | undefined = URL
  let loads = 0
  const sources: Array<{ uri: string } | undefined> = []
  const seeks: number[] = []
  const ref = {
    seek: (to: number) => {
      seeks.push(to)
    },
    resume: () => undefined,
    pause: () => undefined,
    setSource: (source?: { uri: string }) => {
      sources.push(source)
      if (source?.uri === held) return
      held = source?.uri
      if (held != null) loads += 1
    }
  } as unknown as VideoRef
  return { ref, loads: () => loads, sources, seeks }
}

/** What media3 reports when a live playlist has not changed for too long. */
const playlistStuck = {
  error: {
    errorString: 'ExoPlaybackException: ERROR_CODE_IO_UNSPECIFIED',
    errorException:
      'androidx.media3.exoplayer.ExoPlaybackException: Source error',
    errorStackTrace:
      'Caused by: androidx.media3.exoplayer.hls.playlist.HlsPlaylistTracker$PlaylistStuckException',
    errorCode: '22000'
  }
} as unknown as OnVideoErrorData

/**
 * What media3 reports when the server answers a playlist with a 502, as it
 * does for the seconds a restart takes: a deploy, or a worker the kernel
 * killed for memory.
 */
const serverDown = {
  error: {
    errorString: 'ExoPlaybackException: ERROR_CODE_IO_BAD_HTTP_STATUS',
    errorException:
      'androidx.media3.exoplayer.ExoPlaybackException: Source error',
    errorStackTrace:
      'Caused by: androidx.media3.datasource.HttpDataSource$InvalidResponseCodeException: Response code: 502',
    errorCode: '22004'
  }
} as unknown as OnVideoErrorData

describe('a phone watching a live game whose camera is away', function () {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realFetch = globalThis.fetch
  let timers: Array<() => void> = []
  /** The live playlist the cushion reads: 125 four-second segments. */
  const LISTED = `#EXTM3U\n${'#EXTINF:4.000000,\nseg.m4s\n'.repeat(125)}`

  beforeEach(function () {
    timers = []
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () => LISTED
    })) as unknown as typeof fetch
    globalThis.setTimeout = ((run: () => void) => {
      timers.push(run)
      return run
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((run: () => void) => {
      timers = timers.filter(timer => timer !== run)
    }) as unknown as typeof clearTimeout
  })
  afterEach(function () {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.fetch = realFetch
  })

  /**
   * The game page's player: the viewer pressed play, and the page counts any
   * pause it is told about as theirs, as `GameScreen` does.
   */
  async function watching(): Promise<{
    handle: NativeVideoHandle
    player: ReturnType<typeof androidPlayer>
    gaveUp: () => boolean
  }> {
    const handle = new NativeVideoHandle(() => undefined)
    handle.clearBeforeReload = true
    const player = androidPlayer()
    handle.attach(player.ref)
    handle.source = URL
    let viewerWants = false
    handle.addEventListener('play', () => {
      viewerWants = true
    })
    handle.addEventListener('pause', () => {
      viewerWants = false
    })
    let gaveUp = false
    attachHls(
      handle,
      URL,
      () => {
        gaveUp = true
      },
      { wantsToPlay: () => viewerWants, isLive: () => true }
    )
    await handle.play()
    handle.handleReadyForDisplay()
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    return { handle, player, gaveUp: () => gaveUp }
  }

  it('waits at the end of what was written and plays on when the camera is back', async function () {
    const { handle, player } = await watching()
    // The end of the first part: the player runs dry, and says so the way
    // Android does, "not playing" before buffering.
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    handle.handleBuffer({ isBuffering: true })
    expect(handle.paused, 'waiting, not paused').equals(false)
    // The camera is back and the playlist grows.
    handle.handleBuffer({ isBuffering: false })
    handle.handleReadyForDisplay()
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    expect(handle.paused).equals(false)
    expect(player.loads(), 'no reload was needed').equals(0)
  })

  it('reloads a stuck playlist for real and resumes, without a tap', async function () {
    const { handle, player, gaveUp } = await watching()
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    handle.handleBuffer({ isBuffering: true })
    // The live watch has its once-a-second tick; the reload is the timer the
    // error adds after it.
    const before = timers.length
    handle.handleError(playlistStuck)
    expect(timers.length, 'a reload is due').equals(before + 1)
    timers.pop()?.()
    expect(player.loads(), 'the player loaded the stream afresh').equals(1)
    // The fresh player has a picture.
    handle.handleBuffer({ isBuffering: false })
    handle.handleReadyForDisplay()
    expect(handle.paused, 'playing again by itself').equals(false)
    expect(gaveUp()).equals(false)
  })

  it('plays on after the server fails it mid-picture, without a tap', async function () {
    const { handle, player, gaveUp } = await watching()
    const pauses: string[] = []
    handle.addEventListener('pause', () => pauses.push('pause'))
    // A restarting server answers 502. Media3 fails the source with a minute
    // still in hand, reports the error, and then reports that it is not
    // playing — which is the failure, not the viewer pausing.
    const before = timers.length
    handle.handleError(serverDown)
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(pauses, 'nobody paused it').deep.equals([])
    expect(timers.length, 'a reload is due').equals(before + 1)
    timers.pop()?.()
    expect(player.loads(), 'the player loaded the stream afresh').equals(1)
    handle.handleReadyForDisplay()
    expect(handle.paused, 'playing again by itself').equals(false)
    expect(gaveUp()).equals(false)
  })

  it('restores the place a reloaded stream had reached, with the whole source', async function () {
    const { handle, player } = await watching()
    handle.sourceConfig = {
      uri: URL,
      bufferConfig: { live: { targetOffsetMs: 60_000 } }
    }
    handle.handleProgress({
      currentTime: 1200,
      playableDuration: 1210,
      seekableDuration: 1300
    })
    handle.handleError(playlistStuck)
    timers.pop()?.()
    expect(player.sources.at(-1), 'the settings went with it').deep.equals({
      uri: URL,
      bufferConfig: { live: { targetOffsetMs: 60_000 } }
    })
    // The fresh stream opens near its newest footage, and is put back.
    handle.handleLoad({
      currentTime: 1288,
      duration: 0,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<typeof handle.handleLoad>[0])
    expect(player.seeks.at(-1)).closeTo(1200, 1.5)
  })

  it('keeps loading the stream again while the publisher stays away, after the error ladder has had its go', async function () {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const { handle, player, gaveUp } = await watching()
      handle.handleProgress({
        currentTime: 2941,
        playableDuration: 2941,
        seekableDuration: 2941
      })
      // AVPlayer gives up on the standing playlist; the ladder reloads once,
      // and the reloaded stream shows nothing.
      handle.handleError(playlistStuck)
      for (let second = 0; second < 130; second++) {
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(
        player.loads(),
        'the ladder, then the watch, until the picture moves'
      ).greaterThan(2)
      expect(gaveUp()).equals(false)
    } finally {
      Date.now = realNow
    }
  })

  it('keeps trying after the ladder runs out, when every reload fails again', async function () {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const { handle, player } = await watching()
      handle.handleProgress({
        currentTime: 2941,
        playableDuration: 2941,
        seekableDuration: 2941
      })
      let seen = 0
      for (let second = 0; second < 400; second++) {
        // Every fresh stream fails as the publisher is still away.
        if (player.loads() !== seen || second === 0) {
          seen = player.loads()
          handle.handleError(playlistStuck)
        }
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(
        player.loads(),
        'more than the ladder’s three, the watch carrying on'
      ).greaterThan(6)
    } finally {
      Date.now = realNow
    }
  })

  it('keeps watching a failed player through a canplay that brought no picture', async function () {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const { handle, player } = await watching()
      handle.handleProgress({
        currentTime: 2941,
        playableDuration: 2941,
        seekableDuration: 2941
      })
      handle.handleBuffer({ isBuffering: true })
      handle.handleError(playlistStuck)
      // iOS reports "keeping up" changing, picture or not: a canplay.
      handle.handleBuffer({ isBuffering: false })
      for (let second = 0; second < 60; second++) {
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(player.loads(), 'the watch still restarted it').greaterThan(0)
    } finally {
      Date.now = realNow
    }
  })

  it('leaves a player that is only waiting for footage alone, however long', async function () {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const { handle, player } = await watching()
      handle.handleProgress({
        currentTime: 2941,
        playableDuration: 2950,
        seekableDuration: 2960
      })
      // Run dry on a slow line: buffering, no error, for ten minutes.
      handle.handleBuffer({ isBuffering: true })
      for (let second = 0; second < 600; second++) {
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(player.loads(), 'its buffer is not thrown away').equals(0)
    } finally {
      Date.now = realNow
    }
  })

  for (const requested of [80, 0])
    it(`keeps an explicit ${requested}s seek made while the replacement source loads`, () => {
      const realNow = Date.now
      let now = 10000
      Date.now = () => now
      const handle = new NativeVideoHandle(
        () => undefined,
        () => now
      )
      const player = androidPlayer()
      handle.attach(player.ref)
      handle.source = URL
      handle.clearBeforeReload = true
      const loaded: Parameters<typeof handle.handleLoad>[0] = {
        currentTime: 190,
        duration: 200,
        naturalSize: { width: 640, height: 360, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: []
      }
      handle.handleLoad(loaded)
      handle.handleReadyForDisplay()
      const detach = attachHls(handle, URL, undefined, {
        wantsToPlay: () => false,
        buffer: { aheadSec: 30 }
      })
      try {
        seekTo(handle, 100)
        now += 5001
        handle.checkSeekTimeout()
        now += 1000
        for (const run of timers.splice(0)) run()
        expect(player.loads()).equals(1)
        seekTo(handle, requested)
        handle.handleLoad({ ...loaded, currentTime: 0 })
        handle.handleReadyForDisplay()
        expect(player.seeks).deep.equals([100, requested])
        expect(handle.currentTime).equals(requested)
        expect(handle.paused).equals(true)
        handle.handleSeek({ currentTime: requested, seekTime: requested })
        expect(handle.seeking).equals(false)
      } finally {
        detach()
        Date.now = realNow
      }
    })

  for (const requested of [100, 80])
    it(`restores the requested ${requested}s after a timed-out seek and stale native callbacks`, () => {
      const realNow = Date.now
      let now = 10000
      Date.now = () => now
      const handle = new NativeVideoHandle(
        () => undefined,
        () => now
      )
      const player = androidPlayer()
      handle.attach(player.ref)
      handle.source = URL
      handle.clearBeforeReload = true
      const loaded: Parameters<typeof handle.handleLoad>[0] = {
        currentTime: 190,
        duration: 200,
        naturalSize: { width: 640, height: 360, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: []
      }
      handle.handleLoad(loaded)
      handle.handleReadyForDisplay()
      handle.handleProgress({
        currentTime: 190,
        playableDuration: 200,
        seekableDuration: 200
      })
      const detach = attachHls(handle, URL, undefined, {
        wantsToPlay: () => false,
        buffer: { aheadSec: 30 }
      })
      try {
        handle.currentTime = 100
        now += 5001
        handle.checkSeekTimeout()
        if (requested !== 100) handle.currentTime = requested
        handle.handleSeek({ currentTime: 100, seekTime: 100 })
        handle.handleProgress({
          currentTime: 190,
          playableDuration: 200,
          seekableDuration: 200
        })
        expect(handle.currentTime).equals(requested)
        expect(handle.seeking).equals(true)
        expect(player.seeks).deep.equals([100])
        now += 1000
        for (const run of timers.splice(0)) run()
        handle.handleLoad({ ...loaded, currentTime: 0 })
        expect(player.seeks).deep.equals([100, requested])
        expect(handle.currentTime).equals(requested)
        expect(handle.paused).equals(true)
      } finally {
        detach()
        Date.now = realNow
      }
    })

  for (const singleLive of [false, true])
    for (const completesAfter of [45, 145, null])
      it(`lets the seek watchdog supervise restoration (live=${singleLive}, completes=${completesAfter})`, () => {
        const realNow = Date.now
        let now = 10_000
        let sequence = 0
        let next = 0
        let restoring = false
        const scheduled = new Map<number, { run: () => void; at: number }>()
        Date.now = () => now
        globalThis.setTimeout = ((run: () => void, delay: number) => {
          const id = ++next
          scheduled.set(id, { run, at: now + delay })
          return id
        }) as unknown as typeof setTimeout
        globalThis.clearTimeout = ((id: number) =>
          scheduled.delete(id)) as unknown as typeof clearTimeout
        const handle = new NativeVideoHandle(
          () => undefined,
          () => now
        )
        const sources: number[] = []
        let completed = false
        const load: Parameters<NativeVideoHandle['handleLoad']>[0] = {
          duration: 600,
          currentTime: 120,
          naturalSize: { width: 640, height: 360, orientation: 'landscape' },
          audioTracks: [],
          textTracks: [],
          videoTracks: []
        }
        handle.source = URL
        handle.attach({
          pause: () => undefined,
          resume: () => undefined,
          seek: (seconds: number) => {
            if (!restoring) {
              handle.handleSeek({ seekTime: seconds, currentTime: seconds })
              return
            }
            const current = sequence
            handle.handleBuffer({ isBuffering: true })
            if (completesAfter === 145)
              setTimeout(() => {
                if (current === sequence) handle.handleTransferProgress()
              }, 90_000)
            if (completesAfter != null)
              setTimeout(() => {
                if (current !== sequence) return
                completed = true
                handle.handleBuffer({ isBuffering: false })
                handle.handleSeek({ seekTime: seconds, currentTime: seconds })
                setTimeout(() => {
                  if (current !== sequence) return
                  handle.handleProgress({
                    currentTime: seconds + 1,
                    playableDuration: 200,
                    seekableDuration: 600
                  })
                }, 10_000)
              }, completesAfter * 1000)
          },
          setSource: () => {
            restoring = true
            const current = ++sequence
            sources.push(now)
            setTimeout(() => {
              if (current === sequence)
                handle.handleLoad({ ...load, currentTime: 0 })
            }, 1000)
          }
        } as unknown as VideoRef)
        handle.handleLoad(load)
        handle.handleReadyForDisplay()
        handle.handleProgress({
          currentTime: 120,
          playableDuration: 200,
          seekableDuration: 600
        })
        const stop = attachHls(handle, URL, () => undefined, {
          wantsToPlay: () => true,
          wantsRecovery: () => true,
          ...(singleLive
            ? { isLive: () => true, startAtLiveEdge: false }
            : { buffer: { aheadSec: 30 } })
        })
        try {
          handle.handleError(serverDown)
          const until = now + ((completesAfter ?? 130) + 15) * 1000
          for (let step = 0; step < 1000; step++) {
            const nearest = [...scheduled]
              .filter(([, timer]) => timer.at <= until)
              .sort((a, b) => a[1].at - b[1].at)[0]
            if (nearest == null) break
            now = nearest[1].at
            scheduled.delete(nearest[0])
            nearest[1].run()
          }
          if (completesAfter == null) {
            expect(sources.length).greaterThan(1)
            expect(completed).equals(false)
          } else {
            expect(sources).deep.equals([11_000])
            expect(completed).equals(true)
            expect(handle.reportedTime).equals(121)
          }
        } finally {
          stop()
          Date.now = realNow
        }
      })

  for (const rewind of [false, true])
    it(`allows a healthy slow native reload to finish${rewind ? ' with a rewind while opening' : ''}`, () => {
      const realNow = Date.now
      let now = 10000
      let sequence = 0
      let opening = false
      let next = 0
      const scheduled = new Map<number, { run: () => void; at: number }>()
      Date.now = () => now
      globalThis.setTimeout = ((run: () => void, delay: number) => {
        const id = ++next
        scheduled.set(id, { run, at: now + delay })
        return id
      }) as unknown as typeof setTimeout
      globalThis.clearTimeout = ((id: number) =>
        scheduled.delete(id)) as unknown as typeof clearTimeout
      const handle = new NativeVideoHandle(
        () => undefined,
        () => now
      )
      const sources: number[] = []
      const completed: number[] = []
      const load: Parameters<NativeVideoHandle['handleLoad']>[0] = {
        duration: 200,
        currentTime: 120,
        naturalSize: { width: 640, height: 360, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: []
      }
      handle.source = URL
      handle.attach({
        pause: () => undefined,
        resume: () => undefined,
        seek: (seconds: number) => {
          if (!opening)
            handle.handleSeek({ seekTime: seconds, currentTime: seconds })
        },
        setSource: () => {
          opening = true
          const current = ++sequence
          sources.push(now - 10000)
          setTimeout(() => {
            if (current !== sequence) return
            completed.push(now - 10000)
            opening = false
            handle.handleLoad(load)
            handle.handleReadyForDisplay()
            handle.handleProgress({
              currentTime: rewind ? 80 : 121,
              playableDuration: 150,
              seekableDuration: 200
            })
          }, 24000)
        }
      } as unknown as VideoRef)
      handle.handleLoad(load)
      handle.handleReadyForDisplay()
      handle.handleProgress({
        currentTime: 120,
        playableDuration: 150,
        seekableDuration: 200
      })
      const stop = attachHls(handle, URL, () => undefined, {
        wantsToPlay: () => true,
        wantsRecovery: () => true,
        buffer: { aheadSec: 30 }
      })
      try {
        handle.handleError(serverDown)
        if (rewind)
          setTimeout(() => {
            seekTo(handle, 80)
          }, 2000)
        while (true) {
          const nearest = [...scheduled]
            .filter(([, timer]) => timer.at <= 40000)
            .sort((a, b) => a[1].at - b[1].at)[0]
          if (nearest === undefined) break
          now = nearest[1].at
          scheduled.delete(nearest[0])
          nearest[1].run()
        }
        expect(sources).deep.equals([1000])
        expect(completed).deep.equals([25000])
        expect(handle.reportedTime).equals(rewind ? 80 : 121)
      } finally {
        stop()
        Date.now = realNow
      }
    })
  it('recovers a held grid tile after a silent reload and refreshes an exhausted source', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const handle = new NativeVideoHandle(
      () => undefined,
      () => now
    )
    const player = androidPlayer()
    handle.attach(player.ref)
    handle.clearBeforeReload = true
    handle.source = URL
    let refreshes = 0
    const detach = attachHls(
      handle,
      URL,
      () => {
        refreshes++
      },
      {
        wantsToPlay: () => false,
        wantsRecovery: () => true,
        buffer: { aheadSec: 30 }
      }
    )
    try {
      handle.handleProgress({
        currentTime: 120,
        playableDuration: 130,
        seekableDuration: 200
      })
      handle.handleError(serverDown)
      // Three bounded 30-second opening attempts still escalate a silent source.
      for (let second = 0; second < 100; second++) {
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(player.loads()).greaterThan(1)
      expect(refreshes).equals(1)
      expect(handle.paused, 'a grid hold is not overridden').equals(true)
      detach()
      expect(timers).length(0)
    } finally {
      detach()
      Date.now = realNow
    }
  })

  for (const surface of ['single', 'grid'])
    for (const state of ['playing', 'paused', 'ended'] as const)
      it(`supervises a silent ${surface} recording only while ${state}`, async () => {
        const realNow = Date.now
        let now = realNow()
        Date.now = () => now
        const handle = new NativeVideoHandle(
          () => undefined,
          () => now
        )
        const player = androidPlayer()
        handle.attach(player.ref)
        handle.clearBeforeReload = true
        handle.source = URL
        const detach = attachHls(handle, URL, undefined, {
          wantsToPlay: () => state !== 'paused',
          ...(surface === 'grid' ? { buffer: { aheadSec: 30 } } : {})
        })
        try {
          const loaded: Parameters<typeof handle.handleLoad>[0] = {
            currentTime: 60,
            duration: 200,
            naturalSize: { width: 640, height: 360, orientation: 'landscape' },
            audioTracks: [],
            textTracks: [],
            videoTracks: []
          }
          handle.handleLoad(loaded)
          handle.handleReadyForDisplay()
          handle.handleProgress({
            currentTime: 60,
            playableDuration: 90,
            seekableDuration: 200
          })
          if (state !== 'paused') await handle.play()
          if (state === 'ended') handle.handleEnd()
          for (let second = 0; second < 21; second++) {
            now += 1000
            for (const run of timers.splice(0)) run()
          }
          expect(player.loads()).equals(state === 'playing' ? 1 : 0)
          if (state === 'playing') {
            handle.handleLoad({ ...loaded, currentTime: 0 })
            // The last native report plus the handle's bounded one-second carry.
            expect(
              player.seeks.at(-1),
              'retain the selected recording moment'
            ).equals(61)
            handle.handleSeek({ currentTime: 61, seekTime: 61 })
            handle.handleReadyForDisplay()
            handle.handleProgress({
              currentTime: 62,
              playableDuration: 90,
              seekableDuration: 200
            })
            expect(
              handle.paused,
              'resume automatically after fresh progress'
            ).equals(false)
          }
        } finally {
          detach()
          Date.now = realNow
        }
      })

  it('lets a seek made while the stream reopens stand', async function () {
    const { handle, player } = await watching()
    handle.handleProgress({
      currentTime: 1200,
      playableDuration: 1210,
      seekableDuration: 1300
    })
    handle.handleError(playlistStuck)
    timers.pop()?.()
    // The viewer taps a highlight before the fresh stream has opened.
    seekTo(handle, 300)
    handle.handleLoad({
      currentTime: 1288,
      duration: 0,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<typeof handle.handleLoad>[0])
    expect(player.seeks.includes(1200), 'not put back over it').equals(false)
  })

  it('stops reloading an address the server refused, and asks for a new one', async function () {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const { handle, player, gaveUp } = await watching()
      handle.handleError({
        error: { errorString: 'HTTP 403 Forbidden' }
      })
      expect(gaveUp()).equals(true)
      for (let second = 0; second < 200; second++) {
        now += 1000
        for (const run of timers.splice(0)) run()
      }
      expect(player.loads(), 'the same address is not asked for again').equals(
        0
      )
    } finally {
      Date.now = realNow
    }
  })

  it('never gives up because of a reload that a picture made unnecessary', async function () {
    const { handle, gaveUp } = await watching()
    handle.handleError(playlistStuck)
    // The viewer presses play on the failed player: it is loaded again now.
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    await handle.play()
    handle.handleReadyForDisplay()
    // The reload the error had scheduled was cancelled with it.
    for (const run of timers.splice(0)) run()
    expect(gaveUp()).equals(false)
  })

  it('loads the stream again when the viewer presses play on a player that gave up', async function () {
    const { handle, player } = await watching()
    // AVPlayer fails a live stream whose playlist stood still too long, and
    // its play button does nothing after that.
    handle.handleError({
      error: { code: -11866, localizedDescription: 'Playback Stopped' }
    })
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(handle.paused, 'not playing, so a tap plays it').equals(true)
    // A viewer who will not wait for the recovery presses play.
    await handle.play()
    expect(player.loads(), 'the press loaded the stream again').equals(1)
    expect(handle.paused, 'and asked it to play').equals(false)
    // A picture: the next press is an ordinary one.
    handle.handleReadyForDisplay()
    handle.pause()
    await handle.play()
    expect(player.loads()).equals(1)
  })

  it('moves a phone that opens near the newest footage back by the cushion', async function () {
    const { handle } = await watching()
    let seekedTo: number | undefined
    handle.attach({
      seek: (to: number) => {
        seekedTo = to
      },
      resume: () => undefined,
      pause: () => undefined,
      setSource: () => undefined
    } as unknown as VideoRef)
    handle.handleProgress({
      currentTime: 488,
      playableDuration: 488,
      seekableDuration: 488
    })
    // The playlist is read; its newest footage ends at 500 s.
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()
    expect(seekedTo, 'twelve seconds behind is moved to 45 s').closeTo(
      455,
      0.01
    )
  })
})

describe('a phone’s player and the wall clock (U23)', function () {
  it('says at once that it reads no dates, so its owner places it otherwise', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const said: unknown[] = []
    const detach = attachHls(
      handle,
      'https://media.example.test/v1/index.m3u8',
      undefined,
      {
        wantsToPlay: () => true,
        onWallMapping: mapping => said.push(mapping)
      }
    )
    expect(said).deep.equals([null])
    detach()
  })
})
