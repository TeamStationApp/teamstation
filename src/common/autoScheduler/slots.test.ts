import { expect } from 'chai'
import { describe, it } from 'mocha'

import { mergeIntervals, wallInstant } from '../fieldAvailability'
import { field, hoursOn, input, present, season, ZONE } from './fixtures.test'
import {
  AFTERNOON,
  alignUp,
  dayNumber,
  EVENING,
  firstOpenDate,
  LocalClock,
  MORNING,
  seasonSlots,
  type Slot
} from './slots'

const at = (date: string, time: string, zone = ZONE): number =>
  wallInstant(date, time, zone)

function slotsOf(changes: Parameters<typeof input>[0] = {}): Slot[] {
  const run = input(changes)
  const [first] = run.seasons
  return seasonSlots(run, first, new LocalClock()).slots
}

const on = (slots: Slot[], date: string): Slot[] =>
  slots.filter(slot => slot.date === date)

const iso = (instant: number): string => new Date(instant).toISOString()

/** Field 1 in New York: weekday evenings 17:00–21:00, Saturdays 08:00–18:00. */
function newYork(
  hours = [
    ...hoursOn([1, 2, 3, 4, 5], '17:00', '21:00'),
    ...hoursOn([6], '08:00', '18:00')
  ]
): ReturnType<typeof field> {
  return field({
    availability: {
      ...field().availability,
      timezone: 'America/New_York',
      hours
    }
  })
}

describe('seasonSlots', () => {
  it('fills each window with every 5-minute start where the game fits', () => {
    const slots = slotsOf()
    // Monday 17:30–21:00: 90-minute games start 17:30 to 19:30.
    const monday = on(slots, '2027-03-01')
    expect(monday).length(25)
    expect(monday[0].start).equals(at('2027-03-01', '17:30'))
    expect(monday[24].start).equals(at('2027-03-01', '19:30'))
    expect(monday[24].end).equals(at('2027-03-01', '21:00'))
    for (let i = 1; i < monday.length; i++)
      expect(monday[i].start - monday[i - 1].start).equals(5 * 60_000)
    // Saturday 08:00–18:00: starts 08:00 to 16:30.
    const saturday = on(slots, '2027-03-06')
    expect(saturday).length(103)
    expect(saturday.map(slot => slot.weekday)).satisfies((days: number[]) =>
      days.every(day => day === 6)
    )
    // Sundays have no window.
    expect(on(slots, '2027-03-07')).length(0)
    // From June 1 the weekday window is 18:00–21:00.
    const june = on(slots, '2027-06-01')
    expect(june).length(19)
    expect(june[0].start).equals(at('2027-06-01', '18:00'))
    expect(slots.map(slot => slot.index)).deep.equals(slots.map((_, i) => i))
  })

  it('only fits inside both the field’s hours and the season’s window', () => {
    const slots = slotsOf({
      fields: [
        field({
          availability: {
            ...field().availability,
            hours: hoursOn([1], '19:00', '22:00')
          }
        })
      ]
    })
    expect(on(slots, '2027-03-01').map(slot => slot.start)).deep.equals([
      at('2027-03-01', '19:00'),
      at('2027-03-01', '19:05'),
      at('2027-03-01', '19:10'),
      at('2027-03-01', '19:15'),
      at('2027-03-01', '19:20'),
      at('2027-03-01', '19:25'),
      at('2027-03-01', '19:30')
    ])
    expect(on(slots, '2027-03-06')).length(0)
  })

  it('reads a season’s windows in the local time of the field, not in UTC', () => {
    // The season holds only dates; its 17:30–21:00 weekday window is read
    // on a New York field in New York, as the field's 17:00–21:00 hours are.
    const slots = slotsOf({ fields: [newYork()] })
    // May 3, 2027 is a Monday on daylight time, UTC−4.
    const monday = on(slots, '2027-05-03')
    expect(iso(monday[0].start)).equals('2027-05-03T21:30:00.000Z')
    expect(iso(monday[monday.length - 1].end)).equals(
      '2027-05-04T01:00:00.000Z'
    )
    expect(monday).length(25)
    expect(monday.every(slot => slot.timeOfDay === EVENING)).equals(true)
    // Read in UTC, the window would be 13:30–17:00 in New York, before the
    // field opens, so no weekday game would start at 17:30Z or before 21:00Z.
    const weekdays = slots.filter(
      slot => slot.weekday >= 1 && slot.weekday <= 5
    )
    expect(weekdays.length).greaterThan(0)
    expect(
      weekdays.some(slot => iso(slot.start).endsWith('T17:30:00.000Z'))
    ).equals(false)
    expect(
      weekdays.every(
        slot =>
          slot.start >= wallInstant(slot.date, '17:30', 'America/New_York')
      )
    ).equals(true)
  })

  it('blocks a blackout date on the field’s local calendar day, late games too', () => {
    // 60-minute games until 22:00 local, so the last start, 21:00 in New
    // York, is already the next day in UTC.
    const late = hoursOn([1, 2, 3, 4, 5], '17:30', '22:00')
    const slots = slotsOf({
      seasons: [
        season({
          gameMinutes: 60,
          blackouts: ['2027-05-04'],
          windows: [{ from: '2027-03-01', hours: late }]
        })
      ],
      fields: [newYork(hoursOn([1, 2, 3, 4, 5], '17:00', '22:00'))]
    })
    // Tuesday May 4 has nothing, even at 21:00, which is 01:00Z on May 5.
    expect(on(slots, '2027-05-04')).length(0)
    expect(
      slots.filter(
        slot =>
          slot.start >= Date.parse('2027-05-04T04:00:00Z') &&
          slot.start < Date.parse('2027-05-05T04:00:00Z')
      )
    ).length(0)
    // Monday's 21:00 start, 01:00Z on May 4, is Monday's, so it stays.
    expect(on(slots, '2027-05-03').map(slot => iso(slot.start))).includes(
      '2027-05-04T01:00:00.000Z'
    )
    // Wednesday's is there as well, dated Wednesday.
    const wednesday = on(slots, '2027-05-05')
    expect(iso(wednesday[wednesday.length - 1].start)).equals(
      '2027-05-06T01:00:00.000Z'
    )
  })

  it('reads the season’s first and last day as the field’s local days', () => {
    const slots = slotsOf({
      seasons: [season({ startsOn: '2027-03-01', endsOn: '2027-03-05' })],
      fields: [newYork()]
    })
    // Monday March 1's first start, 17:30 in New York on standard time.
    expect(iso(slots[0].start)).equals('2027-03-01T22:30:00.000Z')
    expect(slots[0].date).equals('2027-03-01')
    // Friday March 5's last start, 19:30, is March 6 in UTC, but the
    // season's last day in New York, so it is in.
    const last = slots[slots.length - 1]
    expect(last.date).equals('2027-03-05')
    expect(iso(last.start)).equals('2027-03-06T00:30:00.000Z')
    expect(on(slots, '2027-03-06')).length(0)
    // Under way, a season starts at each field's own today.
    const lateMonday = Date.parse('2027-03-02T03:00:00Z')
    expect(firstOpenDate(season(), lateMonday, 'America/New_York')).equals(
      '2027-03-01'
    )
    expect(firstOpenDate(season(), lateMonday, 'Asia/Tokyo')).equals(
      '2027-03-02'
    )
  })

  it('reads two fields in different zones each in its own', () => {
    const east = newYork()
    const west = {
      ...east,
      id: 'fld_west',
      name: 'West Field',
      availability: { ...east.availability, timezone: 'America/Los_Angeles' }
    }
    const slots = slotsOf({ fields: [east, west] })
    const monday = on(slots, '2027-03-01')
    const first = (fieldId: string): Slot =>
      present(monday.find(slot => slot.fieldId === fieldId))
    // 17:30 in New York, then 17:30 in Los Angeles, three hours later.
    expect(iso(first('fld_one').start)).equals('2027-03-01T22:30:00.000Z')
    expect(iso(first('fld_west').start)).equals('2027-03-02T01:30:00.000Z')
    for (const id of ['fld_one', 'fld_west']) {
      const own = monday.filter(slot => slot.fieldId === id)
      expect(own, id).length(25)
      expect(own.every(slot => slot.timeOfDay === EVENING)).equals(true)
    }
  })

  it('only uses fields that set up as the season’s size', () => {
    expect(slotsOf({ fields: [field({ sizes: ['60/90'] })] })).length(0)
    const tball = slotsOf({
      seasons: [season({ fieldSize: '46/60' })]
    })
    expect(tball.length).greaterThan(0)
    expect(tball.every(slot => slot.size === '46/60')).equals(true)
  })

  it('skips blackouts, dates the field is closed and the past', () => {
    const slots = slotsOf({
      seasons: [season({ blackouts: ['2027-03-01'] })],
      fields: [
        field({
          availability: {
            ...field().availability,
            endsOn: '2027-03-31',
            blackouts: ['2027-03-02']
          }
        })
      ],
      notBefore: at('2027-03-03', '17:42')
    })
    expect(on(slots, '2027-03-01')).length(0)
    expect(on(slots, '2027-03-02')).length(0)
    // Today's first start is the first 5-minute step after now.
    expect(on(slots, '2027-03-03')[0].start).equals(at('2027-03-03', '17:45'))
    expect(on(slots, '2027-04-01')).length(0)
    expect(slots[slots.length - 1].date).equals('2027-03-31')
  })

  it('marks the part of the day, the day and the starts that pack the time', () => {
    const saturday = on(slotsOf(), '2027-03-06')
    const start = (time: string): Slot =>
      present(saturday.find(slot => slot.start === at('2027-03-06', time)))
    expect(start('08:00').timeOfDay).equals(MORNING)
    expect(start('11:55').timeOfDay).equals(MORNING)
    expect(start('12:00').timeOfDay).equals(AFTERNOON)
    expect(start('16:30').timeOfDay).equals(AFTERNOON)
    expect(on(slotsOf(), '2027-03-01')[0].timeOfDay).equals(EVENING)
    expect(start('08:00').day).equals(dayNumber('2027-03-06'))
    expect(
      saturday.filter(slot => slot.onGrid).map(slot => slot.start)
    ).deep.equals(
      ['08:00', '09:40', '11:20', '13:00', '14:40', '16:20'].map(time =>
        at('2027-03-06', time)
      )
    )
  })

  it('counts the field time’s mix of back-to-back games', () => {
    const run = input({
      seasons: [season({ endsOn: '2027-03-06' })]
    })
    const { supply, windows } = seasonSlots(
      run,
      run.seasons[0],
      new LocalClock()
    )
    // Five weekday evenings of two games, and a Saturday of six.
    expect(supply).deep.equals({
      games: 16,
      timeOfDay: [3, 3, 10],
      weekdays: [0, 2, 2, 2, 2, 2, 6]
    })
    expect(windows).length(6)
    expect(windows[0]).deep.equals({
      fieldId: 'fld_one',
      date: '2027-03-01',
      start: at('2027-03-01', '17:30'),
      end: at('2027-03-01', '21:00')
    })
  })

  it('counts the other seasons that need a size the field sets up as', () => {
    const run = input({
      seasons: [
        season(),
        season({ fieldSize: '46/60' }, { id: 'sea_tball' }),
        season({ fieldSize: '60/90' }, { id: 'sea_big' })
      ]
    })
    const [slot] = seasonSlots(run, run.seasons[0], new LocalClock()).slots
    expect(slot.scarcity).equals(1)
  })

  it('orders slots on several fields by start, then by field', () => {
    const slots = slotsOf({
      fields: [field(), field({ id: 'fld_two', name: 'Field 2' })]
    })
    const monday = on(slots, '2027-03-01')
    expect(monday.slice(0, 2).map(slot => slot.fieldId)).deep.equals([
      'fld_one',
      'fld_two'
    ])
    expect(monday[0].start).equals(monday[1].start)
  })
})

describe('slot helpers', () => {
  it('merges overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 5, end: 8 },
        { start: 15, end: 30 }
      ])
    ).deep.equals([
      { start: 0, end: 8 },
      { start: 10, end: 30 }
    ])
  })

  it('aligns to 5-minute steps and numbers days', () => {
    expect(alignUp(0)).equals(0)
    expect(alignUp(1)).equals(300_000)
    expect(alignUp(300_000)).equals(300_000)
    expect(dayNumber('1970-01-02')).equals(1)
  })

  it('reads an instant as a point in a field’s zone', () => {
    const clock = new LocalClock()
    // 01:00 UTC on Sunday is Saturday evening in Chicago, and Sunday
    // morning in Tokyo.
    expect(clock.pointOf(Date.parse('2027-03-07T01:00:00Z'), ZONE)).deep.equals(
      {
        date: '2027-03-06',
        day: dayNumber('2027-03-06'),
        weekday: 6,
        timeOfDay: EVENING
      }
    )
    expect(
      clock.pointOf(Date.parse('2027-03-07T01:00:00Z'), 'Asia/Tokyo')
    ).deep.include({ date: '2027-03-07', weekday: 0, timeOfDay: MORNING })
  })

  it('starts a season today when it is already under way', () => {
    expect(
      firstOpenDate(season(), Date.parse('2027-04-10T17:00:00Z'), ZONE)
    ).equals('2027-04-10')
    expect(firstOpenDate(season(), 0, ZONE)).equals('2027-03-01')
  })
})
