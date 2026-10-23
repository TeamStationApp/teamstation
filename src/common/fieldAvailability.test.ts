import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addDays,
  type Availability,
  coversGame,
  effectiveAvailability,
  fieldWindows,
  intersect,
  periodOn,
  seasonWindows,
  wallInstant,
  weekdayOf
} from './fieldAvailability'

const ZONE = 'America/New_York'
const iso = (ms: number): string => new Date(ms).toISOString()

const venue = {
  defaultHours: [
    { weekday: 2, start: '17:00', end: '21:00' },
    { weekday: 6, start: '08:00', end: '18:00' }
  ],
  defaultBlackouts: ['2027-07-04'],
  timezone: ZONE
}
const field = {
  startsOn: '2027-03-01',
  endsOn: '2027-09-30',
  hours: null,
  blackouts: ['2027-04-17']
}

describe('field availability', () => {
  it('inherits the venue hours unless the field has its own, and adds blackouts', () => {
    const inherited = effectiveAvailability(venue, field)
    expect(inherited.hours).deep.equals(venue.defaultHours)
    expect(inherited.blackouts).deep.equals(['2027-04-17', '2027-07-04'])
    expect(inherited.timezone).equals(ZONE)
    const own = effectiveAvailability(venue, {
      ...field,
      hours: [{ weekday: 6, start: '08:00', end: '22:00' }],
      blackouts: ['2027-07-04']
    })
    expect(own.hours).deep.equals([
      { weekday: 6, start: '08:00', end: '22:00' }
    ])
    expect(own.blackouts).deep.equals(['2027-07-04'])
  })

  it('opens on a weekday with hours, inside its dates, off its blackouts', () => {
    const a = effectiveAvailability(venue, field)
    // 2027-04-10 is a Saturday, in daylight time (UTC-4).
    expect(weekdayOf('2027-04-10')).equals(6)
    expect(
      fieldWindows(a, '2027-04-10').map(w => [iso(w.start), iso(w.end)])
    ).deep.equals([['2027-04-10T12:00:00.000Z', '2027-04-10T22:00:00.000Z']])
    expect(fieldWindows(a, '2027-04-11'), 'a Sunday has no hours').deep.equals(
      []
    )
    expect(fieldWindows(a, '2027-04-17'), 'a field blackout').deep.equals([])
    expect(fieldWindows(a, '2027-07-04'), 'a venue blackout').deep.equals([])
    expect(fieldWindows(a, '2027-02-27'), 'before its dates').deep.equals([])
    expect(fieldWindows(a, '2027-10-02'), 'after its dates').deep.equals([])
    const always: Availability = { ...a, startsOn: null, endsOn: null }
    expect(fieldWindows(always, '2026-02-28')).length(1)
  })

  it('keeps wall times across the daylight-saving changes', () => {
    // Spring forward: 2027-03-14. Fall back: 2027-11-07.
    expect(iso(wallInstant('2027-03-13', '08:00', ZONE))).equals(
      '2027-03-13T13:00:00.000Z'
    )
    expect(iso(wallInstant('2027-03-14', '08:00', ZONE))).equals(
      '2027-03-14T12:00:00.000Z'
    )
    expect(iso(wallInstant('2027-11-07', '08:00', ZONE))).equals(
      '2027-11-07T13:00:00.000Z'
    )
    // 02:30 does not exist on the spring date; it becomes 03:00.
    expect(iso(wallInstant('2027-03-14', '02:30', ZONE))).equals(
      '2027-03-14T07:00:00.000Z'
    )
    expect(iso(wallInstant('2027-04-10', '24:00', ZONE))).equals(
      '2027-04-11T04:00:00.000Z'
    )
    expect(addDays('2027-12-31', 1)).equals('2028-01-01')
  })

  it('switches season window periods on their from date', () => {
    const periods = [
      {
        from: '2027-06-01',
        hours: [{ weekday: 2, start: '18:00', end: '21:00' }]
      },
      {
        from: '2027-03-01',
        hours: [{ weekday: 2, start: '17:30', end: '21:00' }]
      }
    ]
    expect(periodOn(periods, '2027-02-01')).equals(null)
    expect(periodOn(periods, '2027-05-25')?.from).equals('2027-03-01')
    expect(periodOn(periods, '2027-06-01')?.from).equals('2027-06-01')
    // 2027-05-25 and 2027-06-01 are Tuesdays.
    expect(
      seasonWindows(periods, ZONE, '2027-05-25').map(w => iso(w.start))
    ).deep.equals(['2027-05-25T21:30:00.000Z'])
    expect(
      seasonWindows(periods, ZONE, '2027-06-01').map(w => iso(w.start))
    ).deep.equals(['2027-06-01T22:00:00.000Z'])
    expect(seasonWindows(periods, ZONE, '2027-02-02')).deep.equals([])
  })

  it('ends a period on its end date, leaving the days before the next with no windows', () => {
    const periods = [
      {
        from: '2027-03-01',
        until: '2027-05-20',
        hours: [{ weekday: 2, start: '17:30', end: '21:00' }]
      },
      {
        from: '2027-06-01',
        hours: [{ weekday: 2, start: '18:00', end: '21:00' }]
      }
    ]
    expect(periodOn(periods, '2027-05-20')?.from).equals('2027-03-01')
    expect(periodOn(periods, '2027-05-21')).equals(null)
    expect(periodOn(periods, '2027-05-31')).equals(null)
    expect(periodOn(periods, '2027-06-01')?.from).equals('2027-06-01')
    // 2027-05-18 and 2027-05-25 are Tuesdays.
    expect(seasonWindows(periods, ZONE, '2027-05-18')).length(1)
    expect(seasonWindows(periods, ZONE, '2027-05-25')).deep.equals([])
    // A last period with no end date runs on to the season's end, and past.
    expect(periodOn(periods, '2027-12-31')?.from).equals('2027-06-01')
    // A period that ends on the day it starts covers that day alone.
    const day = [{ from: '2027-05-25', until: '2027-05-25', hours: [] }]
    expect(periodOn(day, '2027-05-25')?.from).equals('2027-05-25')
    expect(periodOn(day, '2027-05-26')).equals(null)
  })

  it('covers a game only when it fits wholly inside an open interval', () => {
    const a = effectiveAvailability(venue, field)
    expect(
      coversGame(a, '2027-04-10T12:00:00.000Z', '2027-04-10T22:00:00.000Z')
    ).equals(true)
    expect(
      coversGame(a, '2027-04-10T11:55:00.000Z', '2027-04-10T13:00:00.000Z')
    ).equals(false)
    expect(
      coversGame(a, '2027-04-10T21:00:00.000Z', '2027-04-10T22:05:00.000Z')
    ).equals(false)
    expect(
      coversGame(a, '2027-04-11T14:00:00.000Z', '2027-04-11T16:00:00.000Z')
    ).equals(false)
  })

  it('covers a game across touching windows, past midnight as well, as the engine places it', () => {
    // 2027-04-10 is a Saturday: open until midnight, and again from it.
    const late: Availability = {
      startsOn: null,
      endsOn: null,
      hours: [
        { weekday: 6, start: '18:00', end: '24:00' },
        { weekday: 0, start: '00:00', end: '03:00' }
      ],
      blackouts: [],
      timezone: 'UTC'
    }
    expect(
      coversGame(late, '2027-04-10T23:00:00.000Z', '2027-04-11T01:00:00.000Z')
    ).equals(true)
    expect(
      coversGame(late, '2027-04-11T02:00:00.000Z', '2027-04-11T04:00:00.000Z')
    ).equals(false)
  })

  it('intersects interval lists', () => {
    expect(
      intersect(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 }
        ],
        [{ start: 5, end: 25 }]
      )
    ).deep.equals([
      { start: 5, end: 10 },
      { start: 20, end: 25 }
    ])
    expect(
      intersect([{ start: 0, end: 5 }], [{ start: 5, end: 9 }])
    ).deep.equals([])
  })
})
