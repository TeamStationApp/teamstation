import { expect } from 'chai'
import { describe, it } from 'mocha'

import { seekTo } from './explicitSeek'
import { HOLD_BACK_SEC, joinLiveWithCushion } from './liveCushion'
import type { VideoEventName } from './videoHandle'

function player(currentTime: number): {
  currentTime: number
  liveEdge: number | null
  fire: (type: VideoEventName) => void
  addEventListener: (type: VideoEventName, fn: () => void) => void
  removeEventListener: (type: VideoEventName, fn: () => void) => void
  listening: () => number
} {
  const listeners = new Map<VideoEventName, Set<() => void>>()
  return {
    currentTime,
    liveEdge: null,
    fire: type => {
      listeners.get(type)?.forEach(fn => {
        fn()
      })
    },
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn)
    },
    listening: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

describe('a phone joining a live game', function () {
  it('moves back to a minute behind the newest footage on the first play', function () {
    // The seekable range ends HOLD_BACK_SEC short of the newest footage.
    const p = player(488)
    const stop = joinLiveWithCushion(p)
    p.fire('play')
    expect(p.currentTime, 'nothing to measure against yet').equals(488)
    p.liveEdge = 500
    p.fire('timeupdate')
    expect(p.currentTime).equals(500 - (60 - HOLD_BACK_SEC))
    // Once only: a later play or a rewind is the viewer's.
    p.currentTime = 495
    p.fire('play')
    p.fire('timeupdate')
    expect(p.currentTime).equals(495)
    stop()
    expect(p.listening()).equals(0)
  })

  it('waits for a play, and for the edge, before moving', function () {
    const p = player(10)
    joinLiveWithCushion(p)
    p.liveEdge = 30
    p.fire('timeupdate')
    expect(p.currentTime).equals(10)
    p.fire('play')
    expect(p.currentTime, 'a short game starts at its beginning').equals(0)
  })

  it('leaves a start already about a minute back where it is', function () {
    const p = player(460)
    p.liveEdge = 500
    joinLiveWithCushion(p)
    p.fire('play')
    expect(p.currentTime).equals(460)
  })

  it('gives way to a seek of the viewer’s own', function () {
    const p = player(488)
    joinLiveWithCushion(p)
    seekTo(p, 100)
    p.liveEdge = 500
    p.fire('play')
    expect(p.currentTime).equals(100)
  })

  it('measures from where the player is when its range does not start at nought', function () {
    // AVPlayer opened at its live start, 2400 s in, but reports a range
    // whose length (1900 s) ends well before that.
    const p = player(2400)
    joinLiveWithCushion(p)
    p.liveEdge = 1900
    p.fire('play')
    expect(p.currentTime).equals(2400 - (60 - HOLD_BACK_SEC))
  })

  it('ignores an edge that is not a number', function () {
    const p = player(5)
    joinLiveWithCushion(p)
    p.liveEdge = Number.NaN
    p.fire('play')
    p.liveEdge = 0
    p.fire('timeupdate')
    expect(p.currentTime).equals(5)
  })
})
