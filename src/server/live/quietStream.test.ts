import { expect } from 'chai'
import { describe, it } from 'mocha'

import { quietStreamCanEnd } from './quietStream'

const NOW = new Date('2030-01-01T12:00:00Z')
const TEN_MINUTES = 600_000
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
const ready = {
  state: 'idle',
  lastPublishedAt: ago(TEN_MINUTES),
  opensAt: ago(3_600_000),
  gameEndAt: ago(TEN_MINUTES)
}

describe('quiet stream expiry clocks', function () {
  it('ends at exactly ten minutes on both clocks', function () {
    expect(quietStreamCanEnd(ready, NOW)).equals(true)
  })

  for (const field of ['lastPublishedAt', 'gameEndAt'] as const) {
    for (const elapsed of [TEN_MINUTES - 1, 0, -TEN_MINUTES]) {
      it(`keeps the key when ${field} is only ${elapsed} ms old`, function () {
        expect(
          quietStreamCanEnd({ ...ready, [field]: ago(elapsed) }, NOW)
        ).equals(false)
      })
    }
    it(`does not end on an invalid ${field}`, function () {
      expect(quietStreamCanEnd({ ...ready, [field]: 'invalid' }, NOW)).equals(
        false
      )
    })
  }

  for (const state of ['publishing', 'ended', 'revoked']) {
    it(`leaves a ${state} row alone`, function () {
      expect(quietStreamCanEnd({ ...ready, state }, NOW)).equals(false)
    })
  }

  it('requires a scheduled end', function () {
    expect(quietStreamCanEnd({ ...ready, gameEndAt: null }, NOW)).equals(false)
  })

  it('uses URL opening time for a stream that never published', function () {
    const unused = { ...ready, lastPublishedAt: null }
    expect(
      quietStreamCanEnd({ ...unused, opensAt: ago(TEN_MINUTES - 1) }, NOW)
    ).equals(false)
    expect(
      quietStreamCanEnd({ ...unused, opensAt: ago(TEN_MINUTES) }, NOW)
    ).equals(true)
    expect(quietStreamCanEnd({ ...unused, opensAt: 'invalid' }, NOW)).equals(
      false
    )
  })

  it('reads persisted timestamp strings and ignores an old opening after a publish', function () {
    expect(
      quietStreamCanEnd(
        {
          ...ready,
          lastPublishedAt: ready.lastPublishedAt.toISOString(),
          gameEndAt: ready.gameEndAt.toISOString()
        },
        NOW
      )
    ).equals(true)
    expect(quietStreamCanEnd({ ...ready, lastPublishedAt: NOW }, NOW)).equals(
      false
    )
    expect(quietStreamCanEnd(ready, new Date('invalid'))).equals(false)
  })
})
