import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { RetryClock } from './attachHls'
import { recoverLiveStalls } from './liveStallRecovery'

function fixture(ranges: Array<[number, number]> = [[100, 130]]): {
  video: {
    currentTime: number
    paused: boolean
    ended: boolean
    seeking: boolean
    buffered: TimeRanges
  }
  advance: (seconds: number) => void
  stop: () => void
  want: (value: boolean) => void
} {
  let now = 0
  let run: (() => void) | undefined
  const clock: RetryClock = {
    now: () => now,
    setTimeout: next => {
      run = next
      return next
    },
    clearTimeout: () => {
      run = undefined
    }
  }
  const video = {
    currentTime: 100,
    paused: false,
    ended: false,
    seeking: false,
    buffered: {
      get length() {
        return ranges.length
      },
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1]
    }
  }
  let wanted = true
  const stop = recoverLiveStalls(video, () => wanted, clock)
  const advance = (seconds: number): void => {
    for (let i = 0; i < seconds; i++) {
      now += 1000
      run?.()
    }
  }
  return {
    video,
    advance,
    stop,
    want: (value: boolean) => {
      wanted = value
    }
  }
}

describe('a live web viewer stalled at buffered footage', function () {
  it('waits ten seconds before nudging a stuck decoder', function () {
    const f = fixture()
    f.advance(9)
    expect(f.video.currentTime).equals(100)
    f.advance(1)
    expect(f.video.currentTime).closeTo(100.05, 1e-9)
    f.stop()
  })

  it('crosses missing footage only once the next range has playable video', function () {
    const f = fixture([
      [80, 100],
      [141, 146]
    ])
    f.advance(10)
    expect(f.video.currentTime).closeTo(141.05, 1e-9)
    f.stop()
  })

  it('waits for footage rather than seeking into empty or distant buffers', function () {
    for (const ranges of [
      [],
      [[80, 100]],
      [[141, 141.5]],
      [[161, 170]],
      [[141, 146]],
      [
        [80, 90],
        [141, 146]
      ],
      [
        [80, 100],
        [161, 170]
      ],
      [[100, 101.02]]
    ] as Array<Array<[number, number]>>) {
      const f = fixture(ranges)
      f.advance(60)
      expect(f.video.currentTime).equals(100)
      f.stop()
    }
  })

  it('leaves pauses, ended videos, user seeks and suspended playback alone', function () {
    for (const state of ['paused', 'ended', 'seeking', 'unwanted'] as const) {
      const f = fixture()
      if (state === 'unwanted') f.want(false)
      else f.video[state] = true
      f.advance(60)
      expect(f.video.currentTime).equals(100)
      if (state === 'unwanted') f.want(true)
      else f.video[state] = false
      f.advance(9)
      expect(f.video.currentTime).equals(100)
      f.advance(1)
      expect(f.video.currentTime).closeTo(100.05, 1e-9)
      f.stop()
    }
  })

  it('resets the wait when the picture advances or the viewer seeks', function () {
    const f = fixture()
    f.advance(9)
    f.video.currentTime = 103
    f.advance(1)
    f.advance(9)
    expect(f.video.currentTime).equals(103)
    f.advance(1)
    expect(f.video.currentTime).closeTo(103.05, 1e-9)
    f.stop()
  })

  it('does not mistake slow motion for a stalled picture', function () {
    const f = fixture()
    for (let second = 0; second < 30; second++) {
      f.video.currentTime += 0.125
      f.advance(1)
    }
    expect(f.video.currentTime).equals(103.75)
    f.stop()
  })

  it('bounds unsuccessful nudges and starts again only after actual progress', function () {
    const f = fixture()
    f.advance(60)
    expect(f.video.currentTime).closeTo(100.15, 1e-9)
    f.video.currentTime = 102
    f.advance(11)
    expect(f.video.currentTime).closeTo(102.05, 1e-9)
    f.stop()
  })

  it('stops its clock when the player is detached', function () {
    const f = fixture()
    f.advance(9)
    f.stop()
    f.advance(60)
    expect(f.video.currentTime).equals(100)
  })

  it('can attach and cancel using browser timers', function () {
    const f = fixture()
    recoverLiveStalls(f.video, () => true)()
    f.stop()
  })
})
