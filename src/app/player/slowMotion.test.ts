import { expect } from 'chai'
import { describe, it } from 'mocha'

import { SLOW_RATE, slowMotion } from './slowMotion'
import type { VideoHandle } from './videoHandle'

/** Just the parts slow motion touches, and a log of plays and pauses. */
function fakeVideo(start: { paused: boolean; muted: boolean }): {
  video: VideoHandle
  log: string[]
} {
  const log: string[] = []
  const state = { paused: start.paused, muted: start.muted, rate: 1 }
  const video = {
    get paused() {
      return state.paused
    },
    get muted() {
      return state.muted
    },
    set muted(value: boolean) {
      state.muted = value
    },
    get playbackRate() {
      return state.rate
    },
    set playbackRate(value: number) {
      state.rate = value
    },
    play: async () => {
      state.paused = false
      log.push('play')
    },
    pause: () => {
      state.paused = true
      log.push('pause')
    }
  } as unknown as VideoHandle
  return { video, log }
}

describe('slow motion', function () {
  it('plays a quarter speed in silence while held', function () {
    const { video, log } = fakeVideo({ paused: true, muted: false })
    const slow = slowMotion(() => video)
    slow.start()
    expect(video.playbackRate).equals(SLOW_RATE)
    expect(video.muted).equals(true)
    expect(log).deep.equals(['play'])
    expect(slow.rate()).equals(SLOW_RATE)
  })

  it('puts a paused, loud picture back exactly as it found it', function () {
    const { video, log } = fakeVideo({ paused: true, muted: false })
    const slow = slowMotion(() => video)
    slow.start()
    slow.stop()
    expect(video.playbackRate).equals(1)
    expect(video.muted).equals(false)
    expect(log).deep.equals(['play', 'pause'])
    expect(slow.rate()).equals(0)
  })

  it('leaves a playing, muted picture playing and muted', function () {
    const { video, log } = fakeVideo({ paused: false, muted: true })
    const slow = slowMotion(() => video)
    slow.start()
    slow.stop()
    expect(video.muted).equals(true)
    expect(video.paused).equals(false)
    expect(log).deep.equals(['play', 'play'])
  })

  it('ignores a second start, and a stop with nothing held', function () {
    const { video, log } = fakeVideo({ paused: true, muted: false })
    const slow = slowMotion(() => video)
    slow.stop()
    slow.start()
    slow.start()
    expect(log).deep.equals(['play'])
    expect(slowMotion(() => null).rate()).equals(0)
  })
})
