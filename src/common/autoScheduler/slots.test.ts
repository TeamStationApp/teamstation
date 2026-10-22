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
  MORNING,
  SeasonClock,
  seasonSlots,
  type Slot
} from './slots'

const at = (date: string, time: string, zone = ZONE): number =>
  wallInstant(date, time, zone)

function slotsOf(changes: Parameters<typeof input>[0] = {}): Slot[] {
  const run = input(changes)
  const [first] = run.seasons
  return seasonSlots(run, first, new SeasonClock(first.timezone)).slots
}

const on = (slots: Slot[], date: string): Slot[] =>
  slots.filter(slot => slot.date === date)

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

  it('reads a field in another zone in its own zone', () => {
    const slots = slotsOf({
      fields: [
        field({
          availability: {
            ...field().availability,
            timezone: 'America/New_York',
            hours: hoursOn([1], '17:30', '21:00')
          }
        })
      ]
    })
    // 17:30–21:00 in New York is 16:30–20:00 in Chicago.
    const monday = on(slots, '2027-03-01')
    expect(monday).length(13)
    expect(monday[12].end).equals(at('2027-03-01', '20:00'))
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
      new SeasonClock(ZONE)
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
    const [slot] = seasonSlots(run, run.seasons[0], new SeasonClock(ZONE)).slots
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

  it('reads an instant as a point in the season’s zone', () => {
    const clock = new SeasonClock(ZONE)
    // 01:00 UTC on Sunday is Saturday evening in Chicago.
    expect(clock.pointOf(Date.parse('2027-03-07T01:00:00Z'))).deep.equals({
      date: '2027-03-06',
      day: dayNumber('2027-03-06'),
      weekday: 6,
      timeOfDay: EVENING
    })
  })

  it('starts a season today when it is already under way', () => {
    expect(firstOpenDate(season(), Date.parse('2027-04-10T17:00:00Z'))).equals(
      '2027-04-10'
    )
    expect(firstOpenDate(season(), 0)).equals('2027-03-01')
  })
})
