import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { UmpireAvailability } from './umpires'
import {
  availabilityAllows,
  availabilityIsEmpty,
  normalAvailability,
  shortZoneName
} from './umpireTime'

/** Sundays from 17:00 to 20:00 in New York. */
const sundayEvenings: UmpireAvailability = {
  levels: [],
  days: [6],
  from: '17:00',
  to: '20:00',
  timezone: 'America/New_York'
}
const at = (
  iso: string,
  durationMinutes?: number
): { start: Date; durationMinutes?: number } => ({
  start: new Date(iso),
  ...(durationMinutes == null ? {} : { durationMinutes })
})

describe('availabilityAllows', function () {
  it('allows everything with no saved filter', function () {
    expect(availabilityAllows(null, at('2027-03-14T03:00:00Z'))).equals(true)
    expect(availabilityAllows(null, { day: 2, time: '03:00' }, 'ulv_a')).equals(
      true
    )
  })

  it('reads the day and the range in the saved zone across the spring DST change', function () {
    // 2027-03-14 is the Sunday clocks go forward: 17:00 is 21:00Z.
    expect(
      availabilityAllows(sundayEvenings, at('2027-03-14T21:00:00Z'))
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, at('2027-03-14T20:59:00Z'))
    ).equals(false)
    // The Saturday before, 21:00Z is 16:00 and the wrong day.
    expect(
      availabilityAllows(sundayEvenings, at('2027-03-13T22:00:00Z'))
    ).equals(false)
    // The Sunday before, still on standard time, 17:00 is 22:00Z.
    expect(
      availabilityAllows(sundayEvenings, at('2027-03-07T22:00:00Z'))
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, at('2027-03-07T21:30:00Z'))
    ).equals(false)
  })

  it('reads the day and the range in the saved zone across the autumn DST change', function () {
    // 2027-11-07 is the Sunday clocks go back: 17:00 is 22:00Z.
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-07T22:00:00Z'))
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-07T21:30:00Z'))
    ).equals(false)
    // A week earlier, on daylight time, 17:00 is 21:00Z.
    expect(
      availabilityAllows(sundayEvenings, at('2027-10-31T21:00:00Z'))
    ).equals(true)
  })

  it('takes both ends of the range as inclusive', function () {
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-08T01:00:00Z'))
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-08T01:01:00Z'))
    ).equals(false)
  })

  it('refuses a duration that ends past to, and one past local midnight', function () {
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-07T22:00:00Z', 180))
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, at('2027-11-07T22:00:00Z', 181))
    ).equals(false)
    const lateNights = { ...sundayEvenings, from: '20:00', to: '23:59' }
    // 23:00 on Sunday, two hours long: it ends at 01:00 on Monday.
    expect(
      availabilityAllows(lateNights, at('2027-11-08T04:00:00Z', 30))
    ).equals(true)
    expect(
      availabilityAllows(lateNights, at('2027-11-08T04:00:00Z', 120))
    ).equals(false)
  })

  it('ignores a duration when no range is saved, and any day when none are', function () {
    const anyTime = { ...sundayEvenings, days: [], from: null, to: null }
    expect(availabilityAllows(anyTime, at('2027-11-10T09:00:00Z', 900))).equals(
      true
    )
    const anyDay = { ...sundayEvenings, days: [] }
    expect(availabilityAllows(anyDay, at('2027-11-10T23:00:00Z'))).equals(true)
  })

  it('matches day and time with 0 as Monday', function () {
    expect(
      availabilityAllows(sundayEvenings, { day: 6, time: '17:00' })
    ).equals(true)
    expect(
      availabilityAllows(sundayEvenings, { day: 6, time: '20:01' })
    ).equals(false)
    expect(
      availabilityAllows(sundayEvenings, { day: 0, time: '18:00' })
    ).equals(false)
    const mondays = { ...sundayEvenings, days: [0] }
    expect(availabilityAllows(mondays, { day: 0, time: '18:00' })).equals(true)
    const anyTime = { ...mondays, from: null, to: null }
    expect(availabilityAllows(anyTime, { day: 0, time: '03:00' })).equals(true)
    expect(
      availabilityAllows({ ...anyTime, days: [] }, { day: 4, time: '03:00' })
    ).equals(true)
  })

  it('keeps a level that is saved, or any level when none are', function () {
    const majors = { ...sundayEvenings, levels: ['ulv_majors'] }
    const time = { day: 6, time: '18:00' }
    expect(availabilityAllows(majors, time, 'ulv_majors')).equals(true)
    expect(availabilityAllows(majors, time, 'ulv_minors')).equals(false)
    expect(availabilityAllows(majors, time)).equals(true)
    expect(availabilityAllows(sundayEvenings, time, 'ulv_minors')).equals(true)
  })
  it('normalises a filter: each level once, each day once in order', function () {
    const filter: UmpireAvailability = {
      levels: ['b', 'a', 'b'],
      days: [4, 0, 4, 2],
      from: '17:00',
      to: '20:00',
      timezone: 'America/New_York'
    }
    expect(normalAvailability(filter)).deep.equals({
      ...filter,
      levels: ['b', 'a'],
      days: [0, 2, 4]
    })
    expect(filter.days).deep.equals([4, 0, 4, 2])
  })
  it('reads a filter with no levels, days or range as empty', function () {
    const none: UmpireAvailability = {
      levels: [],
      days: [],
      from: null,
      to: null,
      timezone: 'America/New_York'
    }
    expect(availabilityIsEmpty(none)).equals(true)
    expect(availabilityIsEmpty({ ...none, levels: ['a'] })).equals(false)
    expect(availabilityIsEmpty({ ...none, days: [1] })).equals(false)
    expect(availabilityIsEmpty({ ...none, from: '09:00' })).equals(false)
    expect(availabilityIsEmpty({ ...none, to: '09:00' })).equals(false)
  })
  it('names a zone short, as it is at the time given', function () {
    expect(
      shortZoneName('America/Chicago', new Date('2026-12-01T12:00:00Z'))
    ).equals('CST')
    expect(
      shortZoneName('America/Chicago', new Date('2026-07-01T12:00:00Z'))
    ).equals('CDT')
    expect(shortZoneName('Not/AZone')).equals('Not/AZone')
  })
})
