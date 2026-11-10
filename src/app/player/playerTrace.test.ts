import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { playerTrace, type PlayerTraceRecord } from './playerTrace'
import { NativeVideoHandle } from './nativeVideoHandle'

const target = globalThis as typeof globalThis & {
  __TS_PLAYER_TRACE__?: (record: PlayerTraceRecord) => void
}

describe('opt-in player diagnostics', () => {
  afterEach(() => {
    delete target.__TS_PLAYER_TRACE__
  })

  it('does nothing without a collector', () => {
    expect(() => playerTrace('seek', { target: 20 })).not.to.throw()
  })

  it('records a monotonic timestamp and numeric playback state', () => {
    const records: PlayerTraceRecord[] = []
    target.__TS_PLAYER_TRACE__ = record => records.push(record)
    const before = performance.now()
    playerTrace('seek', { target: 20, paused: false, active: null })
    expect(records).length(1)
    expect(records[0].at).at.least(before)
    expect(records[0].at).at.most(performance.now())
    expect(records[0].values).deep.equals({
      target: 20,
      paused: false,
      active: null
    })
    expect(records[0].event).equals('seek')
  })

  it('isolates playback from a failing collector', () => {
    target.__TS_PLAYER_TRACE__ = () => {
      throw new Error('Collector unavailable')
    }
    expect(() => playerTrace('seek', { target: 20 })).not.to.throw()
  })

  it('falls back to the system clock when a runtime has no performance clock', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'performance'
    )!
    const records: PlayerTraceRecord[] = []
    target.__TS_PLAYER_TRACE__ = record => records.push(record)
    try {
      Object.defineProperty(globalThis, 'performance', {
        value: undefined,
        configurable: true
      })
      const before = Date.now()
      playerTrace('seek', { target: 20 })
      expect(records[0].at).at.least(before)
      expect(records[0].at).at.most(Date.now())
    } finally {
      Object.defineProperty(globalThis, 'performance', descriptor)
    }
  })

  it('distinguishes a replaced seek, completion and timeout without recording the source', () => {
    const records: PlayerTraceRecord[] = []
    target.__TS_PLAYER_TRACE__ = record => records.push(record)
    let now = 0
    const handle = new NativeVideoHandle(
      () => undefined,
      () => now
    )
    handle.source = 'https://media.example.test/video?token=REDACTED'
    handle.currentTime = 10
    handle.currentTime = 20
    handle.handleSeek({ currentTime: 10, seekTime: 10 })
    now = 5000
    handle.checkSeekTimeout()
    expect(records.map(record => record.event)).deep.equals([
      'native.seek.request',
      'native.seek.send',
      'native.seek.request',
      'native.seek.send',
      'native.seek.callback',
      'native.seek.timeout',
      'native.error'
    ])
    expect(records[2].values.active).equals(10)
    expect(records[5].values.active).equals(20)
    expect(JSON.stringify(records)).not.includes('media.example.test')
    expect(JSON.stringify(records)).not.includes('REDACTED')
  })
})
