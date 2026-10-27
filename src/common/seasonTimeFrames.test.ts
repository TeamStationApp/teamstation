import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  formatDateRange,
  presetFrame,
  presetOf,
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
      '2028-02-28'
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
  it('names a season by its time frame whenever dates match a preset, including leap-year winters', () => {
    expect(seasonPeriodLabel('2026-03-01', '2026-05-31')).equals('Spring 2026')
    expect(seasonPeriodLabel('2026-06-01', '2026-08-31')).equals('Summer 2026')
    expect(seasonPeriodLabel('2025-09-01', '2025-11-30')).equals('Fall 2025')
    expect(seasonPeriodLabel('2026-12-01', '2027-02-28')).equals('Winter 2026')
    expect(seasonPeriodLabel('2026-03-02', '2026-05-31')).equals(
      formatDateRange('2026-03-02', '2026-05-31')
    )
    expect(seasonPeriodLabel('2027-12-01', '2028-02-28')).equals('Winter 2027')
    expect(seasonPeriodLabel('2027-12-01', '2028-02-29')).equals(
      formatDateRange('2027-12-01', '2028-02-29')
    )
    expect(seasonPeriodLabel(null, null)).equals('Time frame not set')
  })
  it('gives each season of a year its dates, and reads them back', () => {
    expect(presetFrame(2026, 'Spring')).deep.equals({
      label: 'Spring 2026',
      startsOn: '2026-03-01',
      endsOn: '2026-05-31'
    })
    expect(presetFrame(2026, 'Summer')).deep.include({
      startsOn: '2026-06-01',
      endsOn: '2026-08-31'
    })
    expect(presetFrame(2026, 'Fall')).deep.include({
      startsOn: '2026-09-01',
      endsOn: '2026-11-30'
    })
    expect(presetFrame(2026, 'Winter')).deep.include({
      startsOn: '2026-12-01',
      endsOn: '2027-02-28'
    })
    for (const season of ['Winter', 'Spring', 'Summer', 'Fall'] as const) {
      const { startsOn, endsOn, label } = presetFrame(2031, season)
      expect(presetOf(startsOn, endsOn)).deep.equals({ year: 2031, season })
      expect(seasonPeriodLabel(startsOn, endsOn)).equals(label)
    }
    // A winter ending February 29, or any other range, is no preset.
    expect(presetOf('2027-12-01', '2028-02-29')).equals(null)
    expect(presetOf('2026-03-02', '2026-05-31')).equals(null)
    expect(presetOf(null, null)).equals(null)
  })
})
