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
})
