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

describe('a phone watching a live game whose camera is away', function () {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let timers: Array<() => void> = []

  beforeEach(function () {
    timers = []
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
    expect(handle.paused).equals(true)
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
      playableDuration: 500,
      seekableDuration: 500
    })
    expect(seekedTo, 'twelve seconds behind is moved to a minute').closeTo(
      452,
      0.01
    )
  })
})
