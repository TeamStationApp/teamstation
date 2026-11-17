import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asLiveStatus, type LiveStatus } from '../../common/api'
import {
  quietStreamCanEnd,
  quietStreamEndsAt,
  streamReceivedAt
} from './quietStream'

const NOW = new Date('2030-01-01T12:00:00Z')
const TEN_MINUTES = 600_000
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
const ready = {
  state: 'idle',
  lastReceivedAt: ago(TEN_MINUTES).getTime(),
  opensAt: ago(14_400_000),
  gameStartAt: ago(10_800_001),
  gameEndAt: ago(1)
}

describe('quiet stream expiry clocks', function () {
  for (const state of ['idle', 'publishing']) {
    it(`ends a ${state} stream at ten quiet minutes after game end`, function () {
      expect(quietStreamCanEnd({ ...ready, state }, NOW)).equals(true)
      expect(quietStreamEndsAt({ ...ready, state })).equals(NOW.getTime())
    })
  }

  for (const elapsed of [TEN_MINUTES - 1, 0, -TEN_MINUTES]) {
    it(`keeps bytes received only ${elapsed} ms ago`, function () {
      expect(
        quietStreamCanEnd(
          { ...ready, lastReceivedAt: ago(elapsed).getTime() },
          NOW
        )
      ).equals(false)
    })
  }
  for (const elapsed of [0, -1, -TEN_MINUTES]) {
    it(`waits until strictly past a game end ${elapsed} ms ago`, function () {
      const row = { ...ready, gameEndAt: ago(elapsed) }
      expect(quietStreamCanEnd(row, NOW)).equals(false)
      expect(quietStreamEndsAt(row)).equals(row.gameEndAt.getTime() + 1)
    })
  }
  it('uses the same three-hour fallback as the app', function () {
    expect(quietStreamCanEnd({ ...ready, gameEndAt: null }, NOW)).equals(true)
    const row = { ...ready, gameEndAt: null, gameStartAt: ago(10_800_000) }
    expect(quietStreamCanEnd(row, NOW)).equals(false)
    expect(quietStreamEndsAt(row)).equals(NOW.getTime() + 1)
    expect(
      quietStreamCanEnd({ ...row, gameStartAt: ago(3_600_000) }, NOW)
    ).equals(false)
  })
  it('honors an explicit end even when the fallback differs', function () {
    expect(quietStreamCanEnd({ ...ready, gameStartAt: NOW }, NOW)).equals(true)
    expect(
      quietStreamCanEnd({ ...ready, gameEndAt: ago(-60_000) }, NOW)
    ).equals(false)
  })
  for (const state of ['ended', 'revoked', 'unknown']) {
    it(`leaves a ${state} row alone`, function () {
      expect(quietStreamCanEnd({ ...ready, state }, NOW)).equals(false)
      expect(quietStreamEndsAt({ ...ready, state })).equals(undefined)
    })
  }
  it('measures never-received streams from their opening', function () {
    const row = { ...ready, lastReceivedAt: null }
    expect(
      quietStreamCanEnd({ ...row, opensAt: ago(TEN_MINUTES - 1) }, NOW)
    ).equals(false)
    expect(
      quietStreamCanEnd({ ...row, opensAt: ago(TEN_MINUTES) }, NOW)
    ).equals(true)
  })
  it('fails safely for invalid clocks and missing game dates', function () {
    for (const row of [
      { ...ready, lastReceivedAt: NaN },
      { ...ready, lastReceivedAt: Infinity },
      { ...ready, gameEndAt: 'invalid' },
      { ...ready, gameEndAt: null, gameStartAt: 'invalid' },
      { ...ready, gameEndAt: null, gameStartAt: null },
      { ...ready, lastReceivedAt: null, opensAt: 'invalid' }
    ]) {
      expect(quietStreamCanEnd(row, NOW)).equals(false)
      expect(quietStreamEndsAt(row)).equals(undefined)
    }
    expect(quietStreamCanEnd(ready, new Date('invalid'))).equals(false)
  })
  it('reads persisted timestamp strings', function () {
    expect(
      quietStreamCanEnd(
        {
          ...ready,
          opensAt: ready.opensAt.toISOString(),
          gameStartAt: ready.gameStartAt.toISOString(),
          gameEndAt: ready.gameEndAt.toISOString()
        },
        NOW
      )
    ).equals(true)
  })
})

describe('persisted byte clocks', function () {
  it('uses legacy publication only when the field is absent', function () {
    for (const status of [null, undefined, {}, { ingress: {} }]) {
      expect(streamReceivedAt(status, NOW)).equals(NOW.getTime())
      expect(streamReceivedAt(status, NOW.toISOString())).equals(NOW.getTime())
      expect(streamReceivedAt(status, null)).equals(null)
    }
    expect(streamReceivedAt({ ingress: { lastReceivedAt: null } }, NOW)).equals(
      null
    )
    expect(streamReceivedAt({ ingress: { lastReceivedAt: 123 } }, NOW)).equals(
      123
    )
    expect(
      Number.isNaN(
        streamReceivedAt({ ingress: { lastReceivedAt: 'invalid' } }, NOW)
      )
    ).equals(true)
  })
  it('accepts old and new API status snapshots', function () {
    const status: LiveStatus = {
      liveStreamId: 'liv_clock',
      ingress: {
        publishing: true,
        receivingPackets: false,
        bytesReceived: 0,
        bytesPerSecond: 0
      },
      outputs: []
    }
    expect(asLiveStatus(status).ingress.lastReceivedAt).equals(undefined)
    for (const lastReceivedAt of [null, NOW.getTime()])
      expect(
        asLiveStatus({
          ...status,
          ingress: { ...status.ingress, lastReceivedAt }
        }).ingress.lastReceivedAt
      ).equals(lastReceivedAt)
  })
})
