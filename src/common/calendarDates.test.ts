import { expect } from 'chai'
import { describe, it } from 'mocha'

import { addDays, daysBetween, monthDay } from './calendarDates'

describe('calendar dates', () => {
  it('steps days across months, years, leap days and daylight-saving changes', () => {
    expect(addDays('2027-03-01', 1)).equals('2027-03-02')
    expect(addDays('2027-03-01', -1)).equals('2027-02-28')
    expect(addDays('2028-02-28', 1)).equals('2028-02-29')
    expect(addDays('2027-12-31', 1)).equals('2028-01-01')
    expect(addDays('2027-03-13', 1)).equals('2027-03-14')
    expect(addDays('2027-11-06', 2)).equals('2027-11-08')
    expect(addDays('2027-05-10', 0)).equals('2027-05-10')
  })

  it('counts the days between two dates, either way', () => {
    expect(daysBetween('2027-03-01', '2027-03-08')).equals(7)
    expect(daysBetween('2027-03-08', '2027-03-01')).equals(-7)
    expect(daysBetween('2027-03-01', '2027-03-01')).equals(0)
    expect(daysBetween('2027-03-13', '2027-03-15')).equals(2)
    expect(daysBetween('2027-12-31', '2028-03-01')).equals(61)
  })

  it('reads a date as its month and day, with the year when asked', () => {
    expect(monthDay('2027-03-01')).equals('Mar 1')
    expect(monthDay('2027-12-20')).equals('Dec 20')
    expect(monthDay('2028-01-02', true)).equals('Jan 2, 2028')
  })
})
