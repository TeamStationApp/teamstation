import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  formatDateRange,
  seasonPeriodLabel,
  seasonTimeFrames
} from './seasonTimeFrames'

describe('reference season time frames', () => {
  it('calculates current, previous and two next seasons from the actual date', () => {
    const frames = seasonTimeFrames(new Date(2026, 9, 6))
    expect(frames.map(row => row.label)).deep.equals([
      'Fall 2026',
      'Summer 2026',
      'Winter 2026',
      'Spring 2027'
    ])
    expect(frames[2]).deep.equals({
      label: 'Winter 2026',
      startsOn: '2026-12-01',
      endsOn: '2027-02-28'
    })
    expect(seasonTimeFrames(new Date(2027, 0, 1))[0].label).equals(
      'Winter 2026'
    )
    expect(seasonTimeFrames(new Date(2027, 11, 1))[0].endsOn).equals(
      '2028-02-29'
    )
    expect(seasonTimeFrames(new Date(2026, 2, 1))[0].startsOn).equals(
      '2026-03-01'
    )
    expect(() => seasonTimeFrames(new Date(NaN))).throws(TypeError)
  })
  it('labels one-day, cross-year and unknown reference ranges without shifting their calendar dates', () => {
    expect(formatDateRange(null, null)).equals('Time frame not set')
    expect(formatDateRange('2027-12-31', '2027-12-31')).includes('Dec 31, 2027')
    expect(formatDateRange('2027-12-31', '2028-01-01')).includes('Jan 1, 2028')
  })
  it('names a season by its time frame unless its dates were chosen by hand', () => {
    expect(seasonPeriodLabel('2026-03-01', '2026-05-31')).equals('Spring 2026')
    expect(seasonPeriodLabel('2026-06-01', '2026-08-31')).equals('Summer 2026')
    expect(seasonPeriodLabel('2025-09-01', '2025-11-30')).equals('Fall 2025')
    expect(seasonPeriodLabel('2026-12-01', '2027-02-28')).equals('Winter 2026')
    expect(seasonPeriodLabel('2026-03-02', '2026-05-31')).equals(
      formatDateRange('2026-03-02', '2026-05-31')
    )
    expect(seasonPeriodLabel(null, null)).equals('Time frame not set')
  })
})
