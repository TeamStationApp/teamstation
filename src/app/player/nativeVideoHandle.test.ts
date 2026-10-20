import { expect } from 'chai'
import { describe, it } from 'mocha'
import type { OnSeekData, VideoRef } from 'react-native-video'

import { MAX_INTERPOLATION_MS, NativeVideoHandle } from './nativeVideoHandle'

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
    },
    setSource: (source?: { uri: string }) => {
      calls.push(source == null ? 'clear' : `source ${source.uri}`)
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

  it('keeps playing through a stall: a player that has run dry is waiting, not paused', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    await handle.play()
    handle.handleReadyForDisplay()
    const events: string[] = []
    handle.addEventListener('pause', () => events.push('pause'))
    handle.addEventListener('play', () => events.push('play'))
    // Android, at the end of what a live playlist holds: the state first,
    // then "not playing".
    handle.handleBuffer({ isBuffering: true })
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(handle.paused, 'still wants to play').equals(false)
    // More picture, and the player carries on by itself.
    handle.handleBuffer({ isBuffering: false })
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    expect(handle.paused).equals(false)
    expect(events).deep.equals([])
    // Ready again, a "not playing" is a real pause once more.
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(handle.paused).equals(true)
    expect(events).deep.equals(['pause'])
  })

  it('takes back the pause Android reports just before it says it is buffering', async function () {
    let now = 0
    const handle = new NativeVideoHandle(
      () => undefined,
      () => now
    )
    handle.attach(fakePlayer().ref)
    await handle.play()
    handle.handleReadyForDisplay()
    const events: string[] = []
    handle.addEventListener('pause', () => events.push('pause'))
    handle.addEventListener('play', () => events.push('play'))
    // react-native-video on Android: "not playing" first, buffering after.
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    now += 20
    handle.handleBuffer({ isBuffering: true })
    expect(handle.paused, 'a stall, still meant to be playing').equals(false)
    expect(events).deep.equals(['pause', 'play'])
    handle.handleBuffer({ isBuffering: false })
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    expect(handle.paused).equals(false)
    // A real pause, with a buffering report long after it, stays a pause.
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    now += 5000
    handle.handleBuffer({ isBuffering: true })
    expect(handle.paused).equals(true)
    // So does one the viewer asked for.
    handle.handleBuffer({ isBuffering: false })
    await handle.play()
    handle.pause()
    handle.handleBuffer({ isBuffering: true })
    expect(handle.paused).equals(true)
  })

  it('is paused once it has ended, even after running dry first', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    await handle.play()
    const events: string[] = []
    handle.addEventListener('pause', () => events.push('pause'))
    handle.handleBuffer({ isBuffering: true })
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    // The playlist is closed while it waits: it plays out and ends.
    handle.handleEnd()
    expect(handle.paused).equals(true)
    expect(events).deep.equals(['pause'])
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(events).deep.equals(['pause'])
    // And plays again when asked.
    await handle.play()
    expect(handle.paused).equals(false)
  })

  it('clears the source before handing it again on Android, which ignores the same source twice', function () {
    const handle = new NativeVideoHandle(() => undefined)
    const { ref, calls } = fakePlayer()
    handle.attach(ref)
    handle.source = 'https://media.example.test/a/index.m3u8'
    handle.reload()
    expect(calls).deep.equals([
      'source https://media.example.test/a/index.m3u8'
    ])
    calls.length = 0
    handle.clearBeforeReload = true
    handle.reload()
    expect(calls).deep.equals([
      'clear',
      'source https://media.example.test/a/index.m3u8'
    ])
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

  it('says no pause for its own failure, whichever it reports first', async function () {
    let now = 0
    const handle = new NativeVideoHandle(
      () => undefined,
      () => now
    )
    handle.attach(fakePlayer().ref)
    handle.source = 'https://media.example.test/a/index.m3u8'
    await handle.play()
    handle.handleReadyForDisplay()
    const events: string[] = []
    handle.addEventListener('pause', () => events.push('pause'))
    handle.addEventListener('play', () => events.push('play'))
    const error = { error: { code: -1 } } as unknown as Parameters<
      NativeVideoHandle['handleError']
    >[0]
    // Media3: the error, then "not playing".
    handle.handleError(error)
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(events, 'nobody paused it').deep.equals([])
    expect(handle.paused, 'but it is not playing').equals(true)
    // A picture again, and a "not playing" is a pause once more.
    handle.handleReadyForDisplay()
    expect(handle.paused).equals(false)
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(events).deep.equals(['pause'])
    // The other way round: "not playing", then the error that caused it.
    await handle.play()
    events.length = 0
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    now += 20
    handle.handleError(error)
    expect(events, 'given back').deep.equals(['pause', 'play'])
    // A pause long before an error stays a pause.
    handle.handleReadyForDisplay()
    events.length = 0
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    now += 5000
    handle.handleError(error)
    expect(events).deep.equals(['pause'])
  })

  it('gives a stop back before the error is heard, so the recovery knows it is wanted', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    await handle.play()
    handle.handleReadyForDisplay()
    const heard: string[] = []
    handle.addEventListener('play', () => heard.push('play'))
    handle.onError = () => heard.push('error')
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    handle.handleError({ error: { code: -1 } })
    expect(heard).deep.equals(['play', 'error'])
  })

  it('says play when pressed while failed, and forgets a failure when reloaded, playing or given a new source', async function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    handle.source = 'https://media.example.test/a/index.m3u8'
    await handle.play()
    handle.handleReadyForDisplay()
    const events: string[] = []
    handle.addEventListener('play', () => events.push('play'))
    handle.addEventListener('pause', () => events.push('pause'))
    const error = { error: { code: -1 } }
    handle.handleError(error)
    // A press is passed on for the recovery.
    await handle.play()
    expect(events).deep.equals(['play'])
    // A reload is a fresh attempt, paused until it is played.
    handle.reload()
    expect(handle.paused).equals(true)
    await handle.play()
    expect(handle.paused).equals(false)
    expect(events).deep.equals(['play', 'play'])
    // Reporting that it plays clears it as a picture does.
    handle.handleError(error)
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(events).deep.equals(['play', 'play', 'pause'])
    // So does a new source.
    await handle.play()
    handle.handleError(error)
    handle.reset()
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    expect(events).deep.equals(['play', 'play', 'pause', 'play', 'pause'])
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

/** A handle on a clock the test moves, showing a picture and playing. */
async function playing(): Promise<{
  handle: NativeVideoHandle
  advance: (ms: number) => void
}> {
  let now = 1000
  const handle = new NativeVideoHandle(
    () => undefined,
    () => now
  )
  handle.attach(fakePlayer().ref)
  handle.handleLoad({
    currentTime: 0,
    duration: 600,
    naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
  } as unknown as Parameters<NativeVideoHandle['handleLoad']>[0])
  handle.handleReadyForDisplay()
  await handle.play()
  return {
    handle,
    advance: ms => {
      now += ms
    }
  }
}

function progress(handle: NativeVideoHandle, currentTime: number): void {
  handle.handleProgress({ currentTime } as unknown as Parameters<
    NativeVideoHandle['handleProgress']
  >[0])
}

describe('the native playhead between reports (U37)', function () {
  it('moves on at the rate it plays while playing', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(100)
    expect(handle.currentTime).closeTo(10.1, 1e-9)
    advance(140)
    expect(handle.currentTime).closeTo(10.24, 1e-9)
  })

  it('stands still while paused, from where the pause caught it', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(200)
    handle.pause()
    expect(handle.currentTime).closeTo(10.2, 1e-9)
    advance(500)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
    // Played again, it carries on from there.
    await handle.play()
    advance(100)
    expect(handle.currentTime).closeTo(10.3, 1e-9)
  })

  it('moves a quarter as far at a quarter of the speed', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(200)
    handle.playbackRate = 0.25
    advance(200)
    expect(handle.currentTime).closeTo(10.25, 1e-9)
    handle.playbackRate = 1
    advance(100)
    expect(handle.currentTime).closeTo(10.35, 1e-9)
  })

  it('starts again from a seek, held there until the player gets there', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(200)
    handle.currentTime = 40
    advance(300)
    expect(handle.currentTime).equals(40)
    handle.handleSeek(seeked(40))
    expect(handle.currentTime).equals(40)
    advance(100)
    expect(handle.currentTime).closeTo(40.1, 1e-9)
  })

  it('starts again from each report, forwards or back', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(240)
    expect(handle.currentTime).closeTo(10.24, 1e-9)
    // The player was a little behind the clock: its word stands.
    progress(handle, 10.2)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
    advance(50)
    expect(handle.currentTime).closeTo(10.25, 1e-9)
  })

  it('goes no further than a second past the last report, nor past the end', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(5000)
    expect(handle.currentTime).closeTo(10 + MAX_INTERPOLATION_MS / 1000, 1e-9)
    progress(handle, 599.5)
    advance(800)
    expect(handle.currentTime).equals(600)
  })

  it('stands still while it buffers, and after it ends', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(100)
    handle.handleBuffer({ isBuffering: true })
    advance(500)
    expect(handle.currentTime).closeTo(10.1, 1e-9)
    handle.handleBuffer({ isBuffering: false })
    advance(100)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
    handle.handleEnd()
    advance(500)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
  })

  it('stands still once the player has failed, until it shows a picture', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(100)
    handle.handleError({ error: { code: -1 } })
    advance(500)
    expect(handle.currentTime).closeTo(10.1, 1e-9)
    handle.handleReadyForDisplay()
    advance(100)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
  })

  it('stands still once the player pauses itself, and when reloaded', async function () {
    const { handle, advance } = await playing()
    progress(handle, 10)
    advance(100)
    handle.handlePlaybackState({ isPlaying: false, isSeeking: false })
    advance(500)
    expect(handle.currentTime).closeTo(10.1, 1e-9)
    handle.handlePlaybackState({ isPlaying: true, isSeeking: false })
    advance(100)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
    handle.source = 'https://media.example.test/a/index.m3u8'
    handle.reload()
    advance(500)
    expect(handle.currentTime).closeTo(10.2, 1e-9)
  })
})

describe('NativeVideoHandle’s length on a live game', function () {
  const load = (handle: NativeVideoHandle, duration: number): void => {
    handle.handleLoad({
      currentTime: 0,
      duration,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<NativeVideoHandle['handleLoad']>[0])
  }
  const progress = (
    handle: NativeVideoHandle,
    seekableDuration: number
  ): void => {
    handle.handleProgress({
      currentTime: 1200,
      seekableDuration
    } as unknown as Parameters<NativeVideoHandle['handleProgress']>[0])
  }

  it('grows with the footage it can reach, as a browser’s does, not held at its length when it opened', function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    const heard: string[] = []
    handle.addEventListener('durationchange', () =>
      heard.push('durationchange')
    )
    // AVPlayer gives a live EVENT playlist's length on load, once.
    load(handle, 1237)
    progress(handle, 1249)
    expect(handle.duration).equals(1249)
    progress(handle, 1284)
    expect(handle.duration).equals(1284)
    expect(heard).deep.equals([
      'durationchange',
      'durationchange',
      'durationchange'
    ])
  })

  it('keeps a recording’s length, and a live one with none', function () {
    const recording = new NativeVideoHandle(() => undefined)
    recording.attach(fakePlayer().ref)
    load(recording, 600)
    progress(recording, 600)
    expect(recording.duration).equals(600)
    const live = new NativeVideoHandle(() => undefined)
    live.attach(fakePlayer().ref)
    // ExoPlayer's live stream: no length at all.
    load(live, 0)
    progress(live, 1284)
    expect(live.duration).equals(Number.POSITIVE_INFINITY)
  })
})

describe('NativeVideoHandle’s seekable end, for a resume that waits on it (U23)', function () {
  it('reports progress and a new length, and the newest footage it could seek to', function () {
    const handle = new NativeVideoHandle(() => undefined)
    handle.attach(fakePlayer().ref)
    const heard: string[] = []
    for (const name of ['progress', 'durationchange', 'timeupdate'] as const)
      handle.addEventListener(name, () => heard.push(name))
    expect(handle.seekableEnd).equals(null)
    handle.handleLoad({
      currentTime: 0,
      duration: 600,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<NativeVideoHandle['handleLoad']>[0])
    expect(heard).deep.equals(['durationchange'])
    // The same length again is no change.
    handle.handleLoad({
      currentTime: 0,
      duration: 600,
      naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
    } as unknown as Parameters<NativeVideoHandle['handleLoad']>[0])
    expect(heard).deep.equals(['durationchange'])
    handle.handleProgress({
      currentTime: 3,
      seekableDuration: 64
    } as unknown as Parameters<NativeVideoHandle['handleProgress']>[0])
    expect(heard).deep.equals(['durationchange', 'progress', 'timeupdate'])
    expect(handle.seekableEnd).equals(64)
    expect(handle.liveEdge).equals(64)
  })
})
