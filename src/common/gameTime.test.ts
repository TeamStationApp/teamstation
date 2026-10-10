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
})
