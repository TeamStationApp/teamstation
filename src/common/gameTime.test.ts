import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameCalendarDay, gameTime } from './gameTime'

describe('explicit game calendar time', () => {
  it('converts local wall times independently of the server zone and keeps leap days', () => {
    expect(gameTime('2028-02-29', '18:00', 'America/Los_Angeles')).equals(
      '2028-03-01T02:00:00.000Z'
    )
    expect(gameTime('2026-07-01', '18:00', 'America/Los_Angeles')).equals(
      '2026-07-02T01:00:00.000Z'
    )
    expect(gameTime('2026-01-01', '00:00', 'Asia/Kolkata')).equals(
      '2025-12-31T18:30:00.000Z'
    )
    expect(
      gameCalendarDay('2028-03-01T02:00:00.000Z', 'America/Los_Angeles')
    ).equals('2028-02-29')
  })
  it('rejects invalid dates, times, zones and nonexistent daylight saving wall times', () => {
    expect(() => gameTime('2027-02-29', '18:00', 'UTC')).throws()
    for (const time of ['24:00', '23:60', 'bad'])
      expect(() => gameTime('2026-01-01', time, 'UTC')).throws('valid time')
    expect(() => gameTime('2026-03-08', '02:30', 'America/Los_Angeles')).throws(
      'does not exist'
    )
    expect(() => gameTime('2026-01-01', '18:00', 'invalid')).throws()
  })

  it('answers a wall time asked again the same, and refuses it again the same', () => {
    for (let i = 0; i < 3; i++) {
      expect(gameTime('2026-07-01', '18:00', 'America/New_York')).equals(
        '2026-07-01T22:00:00.000Z'
      )
      expect(() =>
        gameTime('2026-03-08', '02:30', 'America/Los_Angeles')
      ).throws('does not exist')
      expect(() => gameTime('2026-01-01', '18:00', 'invalid')).throws()
      expect(
        gameCalendarDay('2026-07-01T03:00:00.000Z', 'America/New_York')
      ).equals('2026-06-30')
    }
  })

  it('throws a fresh error for each refusal of a cached wall time', () => {
    const refusal = (): unknown => {
      try {
        gameTime('2026-03-08', '02:15', 'America/Los_Angeles')
      } catch (error) {
        return error
      }
      return undefined
    }
    const first = refusal()
    expect(first).instanceOf(TypeError)
    // A handler that changes its error changes no one else's.
    ;(first as TypeError).message = 'changed'
    const second = refusal()
    expect(second).instanceOf(TypeError)
    expect(second).not.equals(first)
    expect((second as TypeError).message).includes('does not exist')
  })
})
