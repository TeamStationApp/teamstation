import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import type { OnVideoErrorData, VideoRef } from 'react-native-video'

import { attachHls } from './attachHls.native'
import { NativeVideoHandle } from './nativeVideoHandle'

const URL = 'https://media.example.test/videos/vid_00000000/index.m3u8'

/**
 * Android's player, as far as the recovery sees it: handed the source it
 * already holds, it does nothing; handed a new one, it loads it.
 */
function androidPlayer(): { ref: VideoRef; loads: () => number } {
  let held: string | undefined = URL
  let loads = 0
  const ref = {
    seek: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    setSource: (source?: { uri: string }) => {
      if (source?.uri === held) return
      held = source?.uri
      if (held != null) loads += 1
    }
  } as unknown as VideoRef
  return { ref, loads: () => loads }
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
  let timers: Array<() => void> = []

  beforeEach(function () {
    timers = []
    globalThis.setTimeout = ((run: () => void) => {
      timers.push(run)
      return timers.length
    }) as unknown as typeof setTimeout
  })
  afterEach(function () {
    globalThis.setTimeout = realSetTimeout
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
    handle.handleError(playlistStuck)
    expect(timers.length, 'a reload is due').equals(1)
    timers.shift()?.()
    expect(player.loads(), 'the player loaded the stream afresh').equals(1)
    // The fresh player has a picture.
    handle.handleBuffer({ isBuffering: false })
    handle.handleReadyForDisplay()
    expect(handle.paused, 'playing again by itself').equals(false)
    expect(gaveUp()).equals(false)
  })
})
