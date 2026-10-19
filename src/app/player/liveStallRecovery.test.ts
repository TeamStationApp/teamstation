import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { RetryClock } from './attachHls'
import {
  heldAhead,
  recoverLiveStalls,
  RESTART_AHEAD_SEC
} from './liveStallRecovery'

/** A playhead with less than a segment held after it: nudged, not restarted. */
const SHORT: Array<[number, number]> = [[100, 102]]

function fixture(ranges: Array<[number, number]> = SHORT): {
  video: {
    currentTime: number
    paused: boolean
    ended: boolean
    seeking: boolean
    buffered: TimeRanges
    pause: () => void
    play: () => Promise<void>
  }
  calls: string[]
  advance: (seconds: number) => void
  refuse: () => void
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
  const calls: string[] = []
  let refuse = false
  const video = {
    currentTime: 100,
    paused: false,
    ended: false,
    seeking: false,
    pause: () => {
      calls.push('pause')
    },
    play: async () => {
      calls.push('play')
      if (refuse) throw new Error('NotAllowedError')
    },
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
    calls,
    refuse: () => {
      refuse = true
    },
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

  it('pauses and plays an engine stopped with a segment held at the playhead', async function () {
    const f = fixture([[90, 130]])
    f.advance(9)
    expect(f.calls).deep.equals([])
    f.advance(1)
    expect(f.calls).deep.equals(['pause', 'play'])
    // Restarted, not moved: the viewer loses no footage.
    expect(f.video.currentTime).equals(100)
    f.advance(9)
    expect(f.calls).length(2)
    f.advance(1)
    expect(f.calls).length(4)
    f.stop()
  })

  it('restarts at most three times a stall, and again once it has moved', function () {
    const f = fixture([[90, 130]])
    f.advance(120)
    expect(f.calls).length(6)
    f.video.currentTime = 101
    f.advance(11)
    expect(f.calls).length(8)
    f.stop()
  })

  it('carries on when the browser refuses to play again', async function () {
    const f = fixture([[90, 130]])
    f.refuse()
    f.advance(10)
    await Promise.resolve()
    expect(f.calls).deep.equals(['pause', 'play'])
    f.stop()
  })

  it('measures footage held from the playhead onwards', function () {
    const ranges = (list: Array<[number, number]>): TimeRanges => ({
      length: list.length,
      start: (index: number) => list[index][0],
      end: (index: number) => list[index][1]
    })
    expect(heldAhead(ranges([]), 100)).equals(0)
    expect(heldAhead(ranges([[80, 100]]), 100)).equals(0)
    expect(heldAhead(ranges([[99, 110]]), 100)).equals(10)
    // A hole, however small, is the nudge's to cross.
    expect(heldAhead(ranges([[100.05, 110]]), 100)).equals(0)
    expect(
      heldAhead(
        ranges([
          [80, 90],
          [95, 104]
        ]),
        100
      )
    ).equals(4)
    expect(heldAhead(ranges([[101, 140]]), 100)).equals(0)
    expect(RESTART_AHEAD_SEC).equals(4)
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
    const f = fixture([[100, 104.5]])
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
    const f = fixture([[100, 103.5]])
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
