import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { RetryClock } from './attachHls'
import {
  type LiveStallSnapshot,
  liveStallSnapshot,
  observeLiveStalls,
  reportLiveStall
} from './liveStallDiagnostics'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: i => values[i][0],
    end: i => values[i][1]
  }
}

type MutableVideo = {
  -readonly [Key in keyof Parameters<typeof observeLiveStalls>[0]]: Parameters<
    typeof observeLiveStalls
  >[0][Key]
}

function fixture(): {
  video: MutableVideo
  state: {
    visible: boolean
    wanted: boolean
    live: () => boolean | Promise<boolean>
  }
  reports: LiveStallSnapshot[]
  checks: () => number
  advance: (seconds: number) => Promise<void>
  tick: () => void
  jump: (seconds: number, tick?: boolean) => void
  stop: () => void
} {
  const video = {
    currentTime: 100,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 2,
    networkState: 2,
    buffered: ranges([[80, 102]]),
    seekable: ranges([[0, 160]]),
    error: null
  }
  const state = {
    visible: true,
    wanted: true,
    live: (): boolean | Promise<boolean> => true
  }
  let now = 0
  let run: (() => void) | undefined
  let checks = 0
  const reports: LiveStallSnapshot[] = []
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
  const stop = observeLiveStalls(
    video,
    {
      engine: 'native',
      wantsToPlay: () => state.wanted,
      isLive: async () => {
        checks++
        return await state.live()
      }
    },
    {
      clock,
      visible: () => state.visible,
      report: (snapshot, engine) => {
        expect(engine).equals('native')
        reports.push(snapshot)
      }
    }
  )
  const tick = (): void => {
    now += 1000
    run?.()
  }
  return {
    video,
    state,
    reports,
    checks: () => checks,
    stop,
    tick,
    jump: (seconds, tick = true) => {
      now += seconds * 1000
      if (tick) run?.()
    },
    advance: async seconds => {
      for (let i = 0; i < seconds; i++) {
        tick()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
  }
}

describe('silent live stall diagnostics', function () {
  for (const seconds of [60, -60]) {
    it(`resets after a ${seconds}-second clock jump`, async function () {
      const f = fixture()
      await f.advance(14)
      f.jump(seconds)
      await f.advance(14)
      expect(f.reports).length(0)
      await f.advance(1)
      expect(f.reports).length(1)
      f.stop()
    })
  }

  for (const event of ['visibilitychange', 'pageshow', 'pagehide']) {
    it(`restarts the grace period on ${event}`, async function () {
      const f = fixture()
      await f.advance(14)
      const target = event === 'visibilitychange' ? document : window
      target.dispatchEvent(new window.Event(event))
      await f.advance(14)
      expect(f.reports).length(0)
      await f.advance(1)
      expect(f.reports).length(1)
      f.stop()
    })
  }

  it('discards a live-status reply that arrives after sleep before the timer', async function () {
    const f = fixture()
    let answer: (live: boolean) => void = () => undefined
    f.state.live = async () =>
      await new Promise(resolve => {
        answer = resolve
      })
    await f.advance(15)
    f.jump(60, false)
    answer(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.reports).length(0)
    f.state.live = () => true
    await f.advance(14)
    expect(f.reports).length(0)
    await f.advance(1)
    expect(f.reports).length(1)
    f.stop()
  })

  it('reports a sustained foreground stall once without changing playback', async function () {
    const f = fixture()
    await f.advance(14)
    expect(f.reports).length(0)
    await f.advance(1)
    expect(f.reports).deep.equals([
      {
        positionSeconds: 100,
        stalledSeconds: 15,
        bufferedAheadSeconds: 2,
        nextBufferGapSeconds: null,
        seekableStartSeconds: 0,
        seekableEndSeconds: 160,
        readyState: 2,
        networkState: 2,
        seeking: false,
        error_code: null
      }
    ])
    await f.advance(120)
    expect(f.checks()).equals(1)
    expect(f.reports).length(1)
    expect(f.video.currentTime).equals(100)
    expect(f.video.paused).equals(false)
    f.stop()
  })

  it('does not mistake network stalled events for frozen playback', async function () {
    const f = fixture()
    for (let second = 0; second < 60; second++) {
      f.video.currentTime += 0.125
      await f.advance(1)
    }
    expect(f.checks()).equals(0)
    f.stop()
  })

  it('allows tiny recovery nudges but reports a seek that remains stuck', async function () {
    const f = fixture()
    f.video.seeking = true
    await f.advance(10)
    f.video.currentTime += 0.05
    await f.advance(5)
    expect(f.reports).length(1)
    expect(f.reports[0].seeking).equals(true)
    f.stop()
  })

  for (const key of ['paused', 'ended', 'visible', 'wanted'] as const) {
    it(`restarts the grace period after ${key} suppresses observation`, async function () {
      const f = fixture()
      if (key === 'paused' || key === 'ended') f.video[key] = true
      else f.state[key] = false
      await f.advance(60)
      expect(f.checks()).equals(0)
      if (key === 'paused' || key === 'ended') f.video[key] = false
      else f.state[key] = true
      await f.advance(14)
      expect(f.reports).length(0)
      await f.advance(1)
      expect(f.reports).length(1)
      f.stop()
    })
  }

  it('does not report a broadcast that has ended', async function () {
    const f = fixture()
    f.state.live = () => false
    await f.advance(120)
    expect(f.checks()).equals(1)
    expect(f.reports).length(0)
    f.stop()
  })

  it('retries failed live-status checks at most once a minute', async function () {
    const f = fixture()
    f.state.live = () => {
      throw new Error('Status unavailable')
    }
    await f.advance(74)
    expect(f.checks()).equals(1)
    expect(f.reports).length(0)
    f.state.live = () => true
    await f.advance(1)
    expect(f.checks()).equals(2)
    expect(f.reports).length(1)
    f.stop()
  })

  for (const action of [
    'detach',
    'progress',
    'pause',
    'ended',
    'hidden',
    'unwanted',
    'seek'
  ] as const) {
    it(`discards a pending report after ${action}`, async function () {
      const f = fixture()
      let answer: (live: boolean) => void = () => undefined
      f.state.live = async () =>
        await new Promise(resolve => {
          answer = resolve
        })
      await f.advance(75)
      expect(f.checks()).equals(1)
      if (action === 'detach') f.stop()
      if (action === 'progress') {
        f.video.currentTime += 1
        await f.advance(1)
      }
      if (action === 'seek') f.video.currentTime += 30
      if (action === 'pause') f.video.paused = true
      if (action === 'ended') f.video.ended = true
      if (action === 'hidden') f.state.visible = false
      if (action === 'unwanted') f.state.wanted = false
      answer(true)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(f.reports).length(0)
      f.stop()
    })
  }

  it('cancels before the first check and supports browser timer cleanup', async function () {
    const f = fixture()
    f.stop()
    await f.advance(20)
    expect(f.checks()).equals(0)
    observeLiveStalls(f.video, {
      engine: 'native',
      isLive: () => true,
      wantsToPlay: () => true
    })()
  })

  it('records only numeric state, gap size and seekable bounds', function () {
    const f = fixture()
    f.video.buffered = ranges([
      [0, 50],
      [105, 110]
    ])
    f.video.seekable = ranges([
      [0, 50],
      [80, 200]
    ])
    const error: MediaError = {
      code: 3,
      message: 'Private URL must never be sent',
      MEDIA_ERR_ABORTED: 1,
      MEDIA_ERR_NETWORK: 2,
      MEDIA_ERR_DECODE: 3,
      MEDIA_ERR_SRC_NOT_SUPPORTED: 4
    }
    f.video.error = error
    expect(liveStallSnapshot(f.video, 15000)).includes({
      bufferedAheadSeconds: 0,
      nextBufferGapSeconds: 5,
      seekableStartSeconds: 0,
      seekableEndSeconds: 200,
      error_code: 3
    })
    f.video.buffered = ranges([])
    f.video.seekable = ranges([])
    expect(liveStallSnapshot(f.video, 15000)).includes({
      bufferedAheadSeconds: 0,
      nextBufferGapSeconds: null,
      seekableStartSeconds: null,
      seekableEndSeconds: null
    })
    f.video.currentTime = Number.NaN
    f.video.seekable = ranges([[0, Infinity]])
    expect(liveStallSnapshot(f.video, 15000)).includes({
      positionSeconds: null,
      seekableEndSeconds: null
    })
    f.stop()
  })

  it('sends a fixed error and the allowlisted snapshot to the existing reporter', function () {
    const f = fixture()
    const snapshot = liveStallSnapshot(f.video, 15000)
    let calls = 0
    reportLiveStall(snapshot, 'native', (error, context) => {
      calls++
      expect(error).instanceOf(Error)
      expect((error as Error).message).equals(
        'Live video playback stopped advancing'
      )
      expect(context).deep.equals({
        tags: { feature: 'live-playback', playbackEngine: 'native' },
        extra: { playback: snapshot }
      })
      return ''
    })
    expect(calls).equals(1)
    f.stop()
  })
})
