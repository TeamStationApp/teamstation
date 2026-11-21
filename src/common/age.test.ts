import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ageBandOf,
  ageOn,
  asBirthMonthBody,
  birthMonthText,
  parseBirthMonth
} from './age'

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

describe('ageBandOf', function () {
  const now = new Date('2026-11-20T12:00:00Z')
  const born = (
    year: number,
    month: number,
    isAdult = false
  ): { birthYear: number; birthMonth: number; isAdult: boolean } => ({
    birthYear: year,
    birthMonth: month,
    isAdult
  })

  it('is 13 and 18 from the first of the month after the birth month', function () {
    // Born October 2013 turned 13 on 1 November 2026.
    expect(ageBandOf(born(2013, 10), now)).equals('minor')
    expect(ageBandOf(born(2008, 10), now)).equals('adult')
  })

  it('is one month short until then', function () {
    // Born November 2013 turns 13 on 1 December 2026.
    expect(ageBandOf(born(2013, 11), now)).equals('under13')
    expect(ageBandOf(born(2008, 11), now)).equals('minor')
  })

  it('lets a birth month win over isAdult', function () {
    expect(ageBandOf(born(2014, 1, true), now)).equals('under13')
    expect(ageBandOf(born(2011, 1, true), now)).equals('minor')
  })

  it('reads isAdult only without a birth month', function () {
    const none = { birthYear: null, birthMonth: null }
    expect(ageBandOf({ ...none, isAdult: true }, now)).equals('adult')
    expect(ageBandOf({ ...none, isAdult: false }, now)).equals('unknown')
    expect(
      ageBandOf({ birthYear: 2000, birthMonth: null, isAdult: false }, now)
    ).equals('unknown')
  })
})
