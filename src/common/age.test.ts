import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ageOn, asBirthMonthBody, birthMonthText, parseBirthMonth } from './age'

describe('ageOn', function () {
  it('reaches an age on the first of the month after the birth month', function () {
    expect(ageOn(2013, 3, new Date('2026-03-31T23:59:59Z'))).equals(12)
    expect(ageOn(2013, 3, new Date('2026-04-01T00:00:00Z'))).equals(13)
    expect(ageOn(2013, 3, new Date('2026-02-01T00:00:00Z'))).equals(12)
  })

  it('rolls a December birth into January of the next year', function () {
    expect(ageOn(2013, 12, new Date('2026-12-31T23:59:59Z'))).equals(12)
    expect(ageOn(2013, 12, new Date('2027-01-01T00:00:00Z'))).equals(13)
  })

  it('reads the day in UTC', function () {
    // Still 31 March in UTC, already 1 April somewhere east of it.
    expect(ageOn(2013, 3, new Date('2026-04-01T05:00:00+08:00'))).equals(12)
  })
})

describe('asBirthMonthBody', function () {
  it('takes a year and a month, or both null, or null', function () {
    expect(asBirthMonthBody({ year: 2012, month: 7 })).deep.equals({
      year: 2012,
      month: 7
    })
    expect(asBirthMonthBody({ year: null, month: null })).equals(null)
    expect(asBirthMonthBody(null)).equals(null)
  })

  it('refuses a day, a bad month or year, and anything not an object', function () {
    for (const body of [
      { year: 2012, month: 7, day: 3 },
      { year: 2012, month: 0 },
      { year: 2012, month: 13 },
      { year: 2012, month: null },
      { year: 1899, month: 1 },
      { year: new Date().getUTCFullYear() + 1, month: 1 },
      { month: 1 },
      [2012, 7],
      '2012-07',
      7
    ]) {
      expect(() => asBirthMonthBody(body), JSON.stringify(body)).to.throw(
        TypeError
      )
    }
  })
})

describe('birth month text', function () {
  it('writes and reads YYYY-MM', function () {
    expect(birthMonthText(2012, 3)).equals('2012-03')
    expect(parseBirthMonth('2012-03')).deep.equals({ year: 2012, month: 3 })
    expect(parseBirthMonth('2012-13')).equals(undefined)
    expect(parseBirthMonth('2012-3')).equals(undefined)
    expect(parseBirthMonth(null)).equals(undefined)
    expect(parseBirthMonth(undefined)).equals(undefined)
  })
})
