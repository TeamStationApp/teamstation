import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ageBandOf,
  ageOn,
  appleAges,
  asAgeBody,
  asMyAgeBody,
  birthMonthText,
  couldBeAged,
  outsideAppleRange,
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

describe('asAgeBody', function () {
  const now = new Date('2026-11-20T12:00:00Z')
  it('takes a year and a month, 18 or older, or both null, or null', function () {
    expect(asAgeBody({ year: 2012, month: 7 }, now)).deep.equals({
      kind: 'month',
      year: 2012,
      month: 7
    })
    expect(asAgeBody({ adult: true }, now)).deep.equals({ kind: 'adult' })
    expect(asAgeBody({ year: null, month: null }, now)).equals(null)
    expect(asAgeBody(null, now)).equals(null)
    // This month is not in the future.
    expect(asAgeBody({ year: 2026, month: 11 }, now)).deep.equals({
      kind: 'month',
      year: 2026,
      month: 11
    })
  })

  it('refuses a day, a bad month or year, a future month, apple, and anything not an object', function () {
    for (const body of [
      { year: 2012, month: 7, day: 3 },
      { year: 2012, month: 0 },
      { year: 2012, month: 13 },
      { year: 2012, month: null },
      { year: 1899, month: 1 },
      { year: 999, month: 1 },
      { year: 2027, month: 1 },
      { year: 2026, month: 12 },
      { month: 1 },
      { adult: false },
      { adult: true, year: 2000, month: 1 },
      { apple: { lowerBound: 18 } },
      [2012, 7],
      '2012-07',
      7
    ]) {
      expect(() => asAgeBody(body, now), JSON.stringify(body)).to.throw(
        TypeError
      )
    }
  })
})

describe('asMyAgeBody', function () {
  const now = new Date('2026-11-20T12:00:00Z')
  it('takes a month or 18 or older, each with an Apple range, or Apple alone at 18 or more', function () {
    expect(asMyAgeBody({ year: 2010, month: 1 }, now)).deep.equals({
      kind: 'month',
      year: 2010,
      month: 1
    })
    expect(
      asMyAgeBody(
        { year: 2010, month: 1, apple: { lowerBound: 13, upperBound: 15 } },
        now
      )
    ).deep.equals({
      kind: 'month',
      year: 2010,
      month: 1,
      apple: { lowerBound: 13, upperBound: 15 }
    })
    expect(asMyAgeBody({ adult: true }, now)).deep.equals({ kind: 'adult' })
    expect(
      asMyAgeBody({ adult: true, apple: { lowerBound: 18 } }, now)
    ).deep.equals({ kind: 'adult', apple: { lowerBound: 18 } })
    expect(asMyAgeBody({ apple: { lowerBound: 18 } }, now)).deep.equals({
      kind: 'apple',
      apple: { lowerBound: 18 }
    })
  })

  it('refuses everything else', function () {
    for (const body of [
      {},
      { adult: false },
      { adult: true, year: 2000, month: 1 },
      { year: 2027, month: 1 },
      { year: 2000 },
      { apple: { lowerBound: 13 } },
      { apple: { lowerBound: 15, upperBound: 13 } },
      { apple: { lowerBound: 18, more: 1 } },
      { apple: 'adult' },
      { year: 2000, month: 1, day: 2 },
      null,
      []
    ]) {
      expect(() => asMyAgeBody(body, now), JSON.stringify(body)).to.throw(
        TypeError
      )
    }
  })
})

describe('the Apple range', function () {
  const now = new Date('2026-11-20T12:00:00Z')
  it('runs from its lower bound to its upper, or to 17 under 18 with none', function () {
    expect(appleAges({ lowerBound: 13, upperBound: 15 })).deep.equals({
      low: 13,
      high: 15
    })
    expect(appleAges({ lowerBound: 13 })).deep.equals({ low: 13, high: 17 })
    expect(appleAges({ lowerBound: 18 }).high).equals(Number.POSITIVE_INFINITY)
  })

  it('says when an answer falls outside it', function () {
    const teen = { lowerBound: 13, upperBound: 15 }
    // 14 and 16 on 20 November 2026.
    const fourteen = { year: 2012, month: 1 }
    const sixteen = { year: 2010, month: 1 }
    expect(
      outsideAppleRange({ kind: 'month', ...fourteen, apple: teen }, now)
    ).equals(false)
    expect(
      outsideAppleRange({ kind: 'month', ...sixteen, apple: teen }, now)
    ).equals(true)
    expect(outsideAppleRange({ kind: 'month', ...sixteen }, now)).equals(false)
    expect(outsideAppleRange({ kind: 'adult', apple: teen }, now)).equals(true)
    expect(
      outsideAppleRange({ kind: 'adult', apple: { lowerBound: 18 } }, now)
    ).equals(false)
    expect(
      outsideAppleRange(
        { kind: 'month', year: 2008, month: 1, apple: { lowerBound: 13 } },
        now
      )
    ).equals(true)
  })

  it('takes a birth month that is this month at either age it could be', function () {
    // Born November 2013: on 20 November 2026 they are 12 or 13.
    const thisMonth = { year: 2013, month: 11 }
    expect(
      outsideAppleRange(
        {
          kind: 'month',
          ...thisMonth,
          apple: { lowerBound: 13, upperBound: 15 }
        },
        now
      )
    ).equals(false)
    expect(
      outsideAppleRange(
        {
          kind: 'month',
          ...thisMonth,
          apple: { lowerBound: 14, upperBound: 15 }
        },
        now
      )
    ).equals(true)
    // Born November 2010: 15 or 16, inside 13 to 15 by the 15.
    expect(
      outsideAppleRange(
        {
          kind: 'month',
          year: 2010,
          month: 11,
          apple: { lowerBound: 13, upperBound: 15 }
        },
        now
      )
    ).equals(false)
    expect(couldBeAged(2013, 10, now, 13, 13)).equals(true)
    expect(couldBeAged(2013, 12, now, 13, 13)).equals(false)
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
