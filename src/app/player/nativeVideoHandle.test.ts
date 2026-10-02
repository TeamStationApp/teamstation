import { expect } from 'chai'
import { describe, it } from 'mocha'
import type { OnSeekData, VideoRef } from 'react-native-video'

import { NativeVideoHandle } from './nativeVideoHandle'

/** The calls a handle makes on the player, in order. */
function fakePlayer(): { ref: VideoRef; calls: string[] } {
  const calls: string[] = []
  const ref = {
    seek: (to: number) => {
      calls.push(`seek ${to}`)
    },
    resume: () => {
      calls.push('resume')
    },
    pause: () => {
      calls.push('pause')
    }
  } as unknown as VideoRef
  return { ref, calls }
}

function seeked(seekTime: number): OnSeekData {
  return { currentTime: seekTime, seekTime }
}

describe('NativeVideoHandle', function () {
  it('starts a playing video again after a seek, which iOS leaves paused', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    const { ref, calls } = fakePlayer()
    handle.attach(ref)
    await handle.play()
    handle.currentTime = 40
    handle.handleSeek(seeked(40))
    expect(calls).deep.equals(['seek 40', 'resume'])
    expect(handle.paused).equals(false)
  })

  it('leaves a paused video paused after a seek', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const { ref, calls } = fakePlayer()
    handle.attach(ref)
    handle.currentTime = 40
    handle.handleSeek(seeked(40))
    expect(calls).deep.equals(['seek 40'])
    expect(handle.paused).equals(true)
  })

  it('takes no notice of a state change reported mid-seek', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    const { ref } = fakePlayer()
    handle.attach(ref)
    await handle.play()
    const paused: string[] = []
    handle.addEventListener('pause', () => paused.push('pause'))
    handle.handlePlaybackState({
      isPlaying: false,
      isSeeking: true
    })
    expect(handle.paused).equals(false)
    expect(paused).deep.equals([])
  })

  it('follows the player when it really does pause', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    await handle.play()
    handle.handlePlaybackState({
      isPlaying: false,
      isSeeking: false
    })
    expect(handle.paused).equals(true)
  })

  it('says it has a picture once the player is ready to show one', function () {
    const handle = new NativeVideoHandle(() => undefined)
    expect(handle.readyState).equals(0)
    handle.handleReadyForDisplay()
    expect(handle.readyState).equals(4)
    handle.reset()
    expect(handle.readyState).equals(0)
  })

  it('drops back while its player is buffering, and says when it has enough again', function () {
    const handle = new NativeVideoHandle(() => undefined)
    let canPlay = 0
    handle.addEventListener('canplay', () => {
      canPlay += 1
    })
    // Still opening: buffering says nothing about a picture it never had.
    handle.handleBuffer({ isBuffering: true })
    expect(handle.readyState).equals(0)
    handle.handleReadyForDisplay()
    expect(handle.readyState).equals(4)
    canPlay = 0
    handle.handleBuffer({ isBuffering: true })
    expect(handle.readyState).equals(2)
    handle.handleBuffer({ isBuffering: false })
    expect(handle.readyState).equals(4)
    expect(canPlay).equals(1)
    // Already ready: nothing to say again.
    handle.handleBuffer({ isBuffering: false })
    expect(canPlay).equals(1)
  })

  it('has ended once it plays to the end, until it is moved back', function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    handle.handleLoad({
      currentTime: 0,
      duration: 600,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<NativeVideoHandle['handleLoad']>[0])
    expect(handle.ended).equals(false)
    handle.handleEnd()
    expect(handle.ended).equals(true)
    handle.currentTime = 599.8
    expect(handle.ended).equals(true)
    handle.currentTime = 300
    expect(handle.ended).equals(false)
  })

  it('follows the player’s progress, except while a seek it asked for is in flight', function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    const ticks: string[] = []
    handle.addEventListener('timeupdate', () => ticks.push('t'))
    handle.handleProgress({ currentTime: 12 } as unknown as Parameters<
      NativeVideoHandle['handleProgress']
    >[0])
    expect(handle.currentTime).equals(12)
    handle.currentTime = 100
    // A report from before the seek landed is not believed.
    handle.handleProgress({ currentTime: 13 } as unknown as Parameters<
      NativeVideoHandle['handleProgress']
    >[0])
    expect(handle.currentTime).equals(100)
    expect(ticks).length(2)
  })

  it('learns the picture’s shape from its tracks or its aspect, once', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const resized: string[] = []
    handle.addEventListener('resize', () => resized.push('r'))
    handle.handleVideoTracks({
      videoTracks: [{ selected: true, width: 1920, height: 1080 }]
    } as unknown as Parameters<NativeVideoHandle['handleVideoTracks']>[0])
    handle.handleAspectRatio({ width: 1920, height: 1080 })
    handle.handleAspectRatio({ width: 0, height: 0 })
    expect([handle.videoWidth, handle.videoHeight]).deep.equals([1920, 1080])
    expect(resized).length(1)
  })

  it('tells its player about sound and speed, and only on a change', function () {
    let changes = 0
    const handle = new NativeVideoHandle(() => {
      changes++
    })
    handle.muted = true
    handle.muted = true
    handle.playbackRate = 0.25
    handle.playbackRate = 0.25
    expect(handle.muted).equals(true)
    expect(handle.playbackRate).equals(0.25)
    expect(changes).equals(2)
  })

  it('hears each listener once when asked, and stops hearing one removed', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const heard: string[] = []
    const always = (): void => {
      heard.push('always')
    }
    handle.addEventListener('canplay', () => heard.push('once'), { once: true })
    handle.addEventListener('canplay', always)
    handle.handleReadyForDisplay()
    handle.removeEventListener('canplay', always)
    handle.handleReadyForDisplay()
    expect(heard).deep.equals(['once', 'always'])
  })

  it('hands an error to whoever is watching for one', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const errors: unknown[] = []
    handle.onError = error => errors.push(error)
    const error = { error: { code: -1 } } as unknown as Parameters<
      NativeVideoHandle['handleError']
    >[0]
    handle.handleError(error)
    expect(errors).deep.equals([error])
  })
})
