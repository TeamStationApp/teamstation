import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { UmpireAvailability } from './umpires'
import {
  availabilityAllows,
  availabilityIsEmpty,
  DATE_FORMAT_LIMIT,
  dateFormatBuilds,
  dateFormatCount,
  daysBetween,
  localDate,
  normalAvailability,
  shortZoneName,
  ZONE_SPELLING_LIMIT
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

describe('localDate', function () {
  const instant = Date.parse('2026-03-01T03:30:00Z')
  it('gives the calendar date in the zone', function () {
    expect(localDate(instant, 'America/New_York')).to.equal('2026-02-28')
    expect(localDate(instant, 'UTC')).to.equal('2026-03-01')
  })
  it('keeps one formatter for every spelling of a zone', function () {
    localDate(instant, 'America/Chicago')
    const count = dateFormatCount()
    expect(localDate(instant, 'aMeRiCa/cHiCaGo')).to.equal('2026-02-28')
    expect(localDate(instant, 'AMERICA/CHICAGO')).to.equal('2026-02-28')
    expect(localDate(instant, 'america/chicago')).to.equal('2026-02-28')
    expect(dateFormatCount()).to.equal(count)
  })
  it('builds no formatter for a spelling it has seen', function () {
    for (const spelling of ['US/Pacific', 'Etc/UTC', 'america/new_york']) {
      localDate(instant, spelling)
      const built = dateFormatBuilds()
      const count = dateFormatCount()
      localDate(instant, spelling)
      expect(dateFormatBuilds()).to.equal(built)
      expect(dateFormatCount()).to.equal(count)
    }
    expect(localDate(instant, 'US/Pacific')).to.equal('2026-02-28')
    expect(localDate(instant, 'Etc/UTC')).to.equal('2026-03-01')
  })
  it('resolves a new spelling of a known zone once', function () {
    localDate(instant, 'America/Denver')
    const built = dateFormatBuilds()
    const count = dateFormatCount()
    localDate(instant, 'america/denver')
    localDate(instant, 'america/denver')
    expect(dateFormatBuilds()).to.equal(built + 1)
    expect(dateFormatCount()).to.equal(count)
  })
  it('holds no more than its limit of zones', function () {
    for (let minutes = 1; minutes <= DATE_FORMAT_LIMIT * 3; minutes++) {
      const hours = String(Math.floor(minutes / 60)).padStart(2, '0')
      const rest = String(minutes % 60).padStart(2, '0')
      expect(localDate(instant, `+${hours}:${rest}`)).to.match(
        /^\d{4}-\d{2}-\d{2}$/
      )
    }
    expect(dateFormatCount()).to.equal(DATE_FORMAT_LIMIT)
    expect(localDate(instant, 'America/New_York')).to.equal('2026-02-28')
    expect(dateFormatCount()).to.equal(DATE_FORMAT_LIMIT)
  })
  it('remembers no more than its limit of spellings', function () {
    for (let index = 0; index <= ZONE_SPELLING_LIMIT; index++) {
      // Each index sets the case of the first nine letters its own way.
      let letter = 0
      const spelling = Array.from('america/new_york')
        .map(char =>
          /[a-z]/.test(char) && (index >> letter++) % 2 === 1
            ? char.toUpperCase()
            : char
        )
        .join('')
      expect(localDate(instant, spelling)).to.equal('2026-02-28')
    }
    // The first spelling was dropped, so it is resolved again.
    const built = dateFormatBuilds()
    localDate(instant, 'america/new_york')
    expect(dateFormatBuilds()).to.equal(built + 1)
  })
})

describe('daysBetween', () => {
  it('counts calendar days across month and year ends, either way', () => {
    expect(daysBetween('2027-01-31', '2027-02-01')).to.equal(1)
    expect(daysBetween('2027-02-28', '2027-03-01')).to.equal(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).to.equal(2)
    expect(daysBetween('2026-12-31', '2027-01-01')).to.equal(1)
    expect(daysBetween('2027-04-30', '2027-04-30')).to.equal(0)
    expect(daysBetween('2027-05-03', '2027-04-30')).to.equal(-3)
  })

  it('counts a day as a day across both daylight-saving changes', () => {
    // New York springs forward on 14 March 2027 and falls back on 7 November.
    const zone = 'America/New_York'
    const before = localDate(Date.parse('2027-03-13T15:00:00Z'), zone)
    const after = localDate(Date.parse('2027-03-15T03:30:00Z'), zone)
    expect(daysBetween(before, after)).to.equal(1)
    expect(
      daysBetween(
        localDate(Date.parse('2027-11-06T23:00:00Z'), zone),
        localDate(Date.parse('2027-11-08T04:30:00Z'), zone)
      )
    ).to.equal(1)
  })
})
