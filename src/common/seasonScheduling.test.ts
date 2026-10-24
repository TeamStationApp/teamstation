import { expect } from 'chai'
import { describe, it } from 'mocha'

import { viewerTimezone } from './eventTime'
import type { WindowPeriod } from './fieldAvailability'
import {
  addWindowPeriod,
  asSeasonScheduleSettings,
  asTimezoneOption,
  asWindowPeriods,
  copyWindowPeriods,
  defaultScheduleSettings,
  seasonZone
} from './seasonScheduling'

const EVENINGS = [{ weekday: 2, start: '17:30', end: '21:00' }]
const LATER = [{ weekday: 2, start: '18:00', end: '21:00' }]

/** A spring season's periods: Mar 1 – May 31, then from Jun 1. */
const SPRING = {
  startsOn: '2027-03-01',
  windows: [
    { from: '2027-03-01', until: '2027-05-31', hours: EVENINGS },
    { from: '2027-06-01', hours: LATER }
  ]
}

const season = (
  startsOn: string,
  endsOn: string
): { startsOn: string; endsOn: string } => ({ startsOn, endsOn })

/** The copy, which must also be periods a save accepts as they are. */
function copied(
  source: { startsOn: string; windows: WindowPeriod[] },
  target: { startsOn: string; endsOn: string }
): WindowPeriod[] {
  const windows = copyWindowPeriods(source, target)
  expect(asWindowPeriods(windows)).deep.equals(windows)
  return windows
}

describe('season scheduling', () => {
  it('shows a season at the UTC default in the viewer’s zone, and keeps any other', () => {
    expect(seasonZone({ timezone: 'UTC' }, 'America/Los_Angeles')).equals(
      'America/Los_Angeles'
    )
    expect(
      seasonZone({ timezone: 'America/New_York' }, 'America/Los_Angeles')
    ).equals('America/New_York')
    expect(seasonZone({ timezone: 'UTC' })).equals(viewerTimezone())
  })

  it('reads the zone a save or a build names, if any', () => {
    expect(asTimezoneOption(undefined)).equals(undefined)
    expect(asTimezoneOption(null)).equals(undefined)
    expect(asTimezoneOption('America/Chicago')).equals('America/Chicago')
    for (const bad of [7, '', 'x'.repeat(65)])
      expect(() => asTimezoneOption(bad)).throws('Choose a timezone')
  })

  it('reads a period’s end date, on or after its start and before the next period', () => {
    expect(
      asWindowPeriods([
        { from: '2027-06-01', until: null, hours: LATER },
        { from: '2027-03-01', until: '2027-05-20', hours: EVENINGS }
      ])
    ).deep.equals([
      { from: '2027-03-01', until: '2027-05-20', hours: EVENINGS },
      { from: '2027-06-01', hours: LATER }
    ])
    // A period may end on the day it starts, and the next may start the day
    // after.
    expect(
      asWindowPeriods([
        { from: '2027-03-01', until: '2027-03-01', hours: [] },
        { from: '2027-03-02', hours: [] }
      ])
    ).length(2)
    expect(() =>
      asWindowPeriods([{ from: '2027-03-01', until: '2027-02-28', hours: [] }])
    ).throws('End each period of game windows on or after the day it starts')
    expect(() =>
      asWindowPeriods([
        { from: '2027-03-01', until: '2027-06-01', hours: [] },
        { from: '2027-06-01', hours: [] }
      ])
    ).throws('Periods of game windows can’t overlap')
    expect(() =>
      asWindowPeriods([{ from: '2027-03-01', until: '2027-02-30', hours: [] }])
    ).throws('Choose a valid calendar date')
  })

  it('keeps a period’s end date in a settings answer, and adds none to a period without one', () => {
    const answer = asSeasonScheduleSettings({
      seasonId: 'sea_a',
      saved: true,
      timezone: 'America/New_York',
      settings: {
        ...defaultScheduleSettings({
          ...SPRING,
          endsOn: '2027-07-31',
          year: 2027
        }),
        windows: SPRING.windows
      }
    })
    expect(answer.settings.windows).deep.equals(SPRING.windows)
    expect(Object.keys(answer.settings.windows[1])).not.includes('until')
  })

  it('splits a dated period when a period is added from a date inside it', () => {
    const added = addWindowPeriod(SPRING.windows, '2027-04-15')
    expect(added).deep.equals([
      { from: '2027-03-01', until: '2027-04-14', hours: EVENINGS },
      { from: '2027-04-15', until: '2027-05-31', hours: EVENINGS },
      { from: '2027-06-01', hours: LATER }
    ])
    // Periods a save accepts, and a copy of the hours, not the same list.
    expect(asWindowPeriods(added)).deep.equals(added)
    expect(added[1].hours).not.equals(added[0].hours)
    // A date on a period's last day splits it into one day each side.
    expect(
      addWindowPeriod(SPRING.windows, '2027-05-31').slice(0, 2)
    ).deep.equals([
      { from: '2027-03-01', until: '2027-05-30', hours: EVENINGS },
      { from: '2027-05-31', until: '2027-05-31', hours: EVENINGS }
    ])
    expect(SPRING.windows[0].until).equals('2027-05-31')
  })

  it('adds a period with no end date after an open period, in a gap, or before the first', () => {
    expect(addWindowPeriod(SPRING.windows, '2027-07-01')).deep.equals([
      ...SPRING.windows,
      { from: '2027-07-01', hours: LATER }
    ])
    const gap = [
      { from: '2027-03-01', until: '2027-03-31', hours: EVENINGS },
      { from: '2027-06-01', hours: LATER }
    ]
    expect(addWindowPeriod(gap, '2027-05-01')).deep.equals([
      gap[0],
      { from: '2027-05-01', hours: EVENINGS },
      gap[1]
    ])
    expect(addWindowPeriod(SPRING.windows, '2027-02-01')[0]).deep.equals({
      from: '2027-02-01',
      hours: []
    })
  })

  it('copies another season’s periods as they are when the seasons start together', () => {
    expect(copied(SPRING, season('2027-03-01', '2027-07-31'))).deep.equals(
      SPRING.windows
    )
  })

  it('moves the periods by the days between the seasons’ starts, keeping their lengths and order', () => {
    // March 1 to August 1 is 153 days.
    expect(copied(SPRING, season('2027-08-01', '2027-12-31'))).deep.equals([
      { from: '2027-08-01', until: '2027-10-31', hours: EVENINGS },
      { from: '2027-11-01', hours: LATER }
    ])
    // A later source copies back into an earlier season the same way.
    expect(
      copied(
        {
          startsOn: '2027-08-01',
          windows: [{ from: '2027-08-15', hours: [] }]
        },
        season('2027-03-01', '2027-07-31')
      )
    ).deep.equals([{ from: '2027-03-15', hours: [] }])
  })

  it('drops periods that start after the season ends, and ends the rest with it', () => {
    expect(copied(SPRING, season('2027-08-01', '2027-10-15'))).deep.equals([
      { from: '2027-08-01', until: '2027-10-15', hours: EVENINGS }
    ])
    // A season that ends on a period's first day keeps that day.
    expect(copied(SPRING, season('2027-03-01', '2027-06-01'))).deep.equals([
      SPRING.windows[0],
      { from: '2027-06-01', hours: LATER }
    ])
  })

  it('copies a season that spans New Year into the next one', () => {
    const winter = {
      startsOn: '2026-11-01',
      windows: [
        { from: '2026-11-01', until: '2026-12-19', hours: EVENINGS },
        { from: '2027-01-04', hours: LATER }
      ]
    }
    // A year and six days later.
    expect(copied(winter, season('2027-11-07', '2028-03-05'))).deep.equals([
      { from: '2027-11-07', until: '2027-12-25', hours: EVENINGS },
      { from: '2028-01-10', hours: LATER }
    ])
  })

  it('copies nothing when every period would start after the season ends', () => {
    expect(
      copyWindowPeriods(
        { startsOn: '2027-03-01', windows: [SPRING.windows[1]] },
        season('2027-03-01', '2027-05-31')
      )
    ).deep.equals([])
    expect(
      copyWindowPeriods(
        { ...SPRING, windows: [] },
        season('2027-03-01', '2027-05-31')
      )
    ).deep.equals([])
  })

  it('copies the weekly hours, not the source’s own list', () => {
    const [period] = copyWindowPeriods(
      SPRING,
      season('2027-03-01', '2027-07-31')
    )
    expect(period.hours).deep.equals(EVENINGS)
    expect(period.hours).not.equals(EVENINGS)
    expect(period.hours[0]).not.equals(EVENINGS[0])
  })
})
