import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import { buildContext, openSlots, type SeasonContext } from './context'
import { DayBuckets, type Hold, Occupancy } from './feasibility'
import { fixedGame, input, present, season, ZONE } from './fixtures.test'
import type { Slot } from './slots'
import type { EngineBooking, EngineInput } from './types'

const SATURDAY = '2027-03-06'
const at = (time: string, date = SATURDAY): number =>
  wallInstant(date, time, ZONE)

function setUp(changes: Partial<EngineInput> = {}): {
  occupancy: Occupancy
  season: SeasonContext
  slot: (time: string, date?: string) => Slot
} {
  const context = buildContext(input(changes))
  const [first] = context.seasons
  return {
    occupancy: new Occupancy(context),
    season: first,
    slot: (time, date = SATURDAY) =>
      present(first.slots.find(slot => slot.start === at(time, date)))
  }
}

function booking(
  start: string,
  end: string,
  changes: Partial<EngineBooking> = {}
): EngineBooking {
  return {
    key: `bkg_${start}`,
    fieldId: 'fld_one',
    size: '50/70',
    teamIds: [],
    start: at(start),
    end: at(end),
    ...changes
  }
}

describe('Occupancy', () => {
  it('keeps the field free of bookings, with the season’s buffer after them', () => {
    const { occupancy, season, slot } = setUp({
      bookings: [booking('10:00', '11:30')]
    })
    const fits = (time: string): boolean =>
      occupancy.fits(season, 'tem_hawks', 'tem_owls', slot(time))
    expect(fits('10:30')).equals(false)
    // 10 minutes between: a game may start at 11:40, not 11:35.
    expect(fits('11:35')).equals(false)
    expect(fits('11:40')).equals(true)
    // And end 10 minutes before the booking.
    expect(fits('08:20')).equals(true)
    expect(fits('08:25')).equals(false)
  })

  it('keeps the next game’s season buffer before a game of another run season', () => {
    const {
      occupancy,
      season: demo,
      slot
    } = setUp({
      seasons: [
        season(),
        {
          ...season({ bufferMinutes: 30 }, { id: 'sea_late' }),
          participants: ['tem_a', 'tem_b'],
          exhibitionTeams: []
        }
      ],
      fixed: [
        fixedGame(
          'g1',
          'tem_a',
          'tem_b',
          new Date(at('12:00')).toISOString(),
          90,
          {
            seasonId: 'sea_late'
          }
        )
      ]
    })
    const fits = (time: string): boolean =>
      occupancy.fits(demo, 'tem_hawks', 'tem_owls', slot(time))
    // The later game's season wants 30 minutes before it.
    expect(fits('10:05')).equals(false)
    expect(fits('10:00')).equals(true)
    // After it, this season's own 10 minutes.
    expect(fits('13:40')).equals(true)
    expect(fits('13:35')).equals(false)
  })

  it('adds the field’s size switch time between games of different sizes', () => {
    const { occupancy, season, slot } = setUp({
      bookings: [
        booking('08:00', '09:00', { size: '46/60' }),
        booking('14:00', '15:00', { size: null })
      ]
    })
    const fits = (time: string): boolean =>
      occupancy.fits(season, 'tem_hawks', 'tem_owls', slot(time))
    // 10 minutes of buffer and 30 of switch time.
    expect(fits('09:35')).equals(false)
    expect(fits('09:40')).equals(true)
    // A booking of unknown size needs only the buffer.
    expect(fits('15:10')).equals(true)
    expect(fits('15:05')).equals(false)
  })

  it('keeps each team free of its own commitments, with no buffer', () => {
    const { occupancy, season, slot } = setUp({
      bookings: [
        booking('10:00', '11:30', { fieldId: null, teamIds: ['tem_hawks'] })
      ]
    })
    expect(
      occupancy.fits(season, 'tem_hawks', 'tem_owls', slot('11:00'))
    ).equals(false)
    expect(
      occupancy.fits(season, 'tem_owls', 'tem_hawks', slot('09:00'))
    ).equals(false)
    expect(
      occupancy.fits(season, 'tem_hawks', 'tem_owls', slot('11:30'))
    ).equals(true)
    expect(
      occupancy.fits(season, 'tem_hawks', 'tem_owls', slot('08:30'))
    ).equals(true)
    expect(
      occupancy.fits(season, 'tem_bears', 'tem_owls', slot('10:00'))
    ).equals(true)
  })

  it('holds the field and the teams for placed games until they are taken back', () => {
    const { occupancy, season, slot } = setUp()
    occupancy.place(0, season, 'tem_hawks', 'tem_owls', slot('08:00'))
    expect(
      occupancy.fits(season, 'tem_bears', 'tem_foxes', slot('09:00'))
    ).equals(false)
    expect(
      occupancy.fits(season, 'tem_bears', 'tem_foxes', slot('09:40'))
    ).equals(true)
    expect(occupancy.gamesOn(season, 'tem_hawks', slot('08:00').day)).equals(1)
    occupancy.unplace(0, season, 'tem_hawks', 'tem_owls', slot('08:00'))
    expect(
      occupancy.fits(season, 'tem_bears', 'tem_foxes', slot('09:00'))
    ).equals(true)
    expect(occupancy.gamesOn(season, 'tem_hawks', slot('08:00').day)).equals(0)
  })

  it('allows a second game in a day only where the season permits it', () => {
    for (const [doubleheaders, allowed] of [
      ['never', false],
      ['ifNecessary', true],
      ['allowed', true]
    ] as const) {
      const {
        occupancy,
        season: demo,
        slot
      } = setUp({
        seasons: [season({ doubleheaders })],
        fixed: [
          fixedGame(
            'g1',
            'tem_hawks',
            'tem_owls',
            new Date(at('08:00')).toISOString()
          )
        ]
      })
      expect(
        occupancy.fits(demo, 'tem_hawks', 'tem_bears', slot('14:00')),
        doubleheaders
      ).equals(allowed)
      expect(
        occupancy.fits(
          demo,
          'tem_hawks',
          'tem_bears',
          slot('14:00', '2027-03-13')
        )
      ).equals(true)
    }
  })

  it('records the starting occupancy in the context', () => {
    const context = buildContext(
      input({
        seasons: [season({ doubleheaders: 'never' })],
        bookings: [
          booking('08:00', '18:00', {
            fieldId: 'fld_other',
            teamIds: ['tem_hawks']
          })
        ]
      })
    )
    const [demo] = context.seasons
    const saturday = demo.slots.filter(slot => slot.date === SATURDAY)
    expect(saturday.every(slot => demo.fieldFree[slot.index] === 1)).equals(
      true
    )
    const hawks = present(demo.teamFree.get('tem_hawks'))
    expect(saturday.every(slot => hawks[slot.index] === 0)).equals(true)
    expect(openSlots(demo, 'tem_hawks', 'tem_owls')).equals(
      demo.slots.length - saturday.length
    )
    expect(openSlots(demo, 'tem_hawks', 'tem_nobody')).equals(0)
  })
})

describe('DayBuckets', () => {
  it('files a hold under the days around it and takes it back out', () => {
    const buckets = new DayBuckets()
    const hold: Hold = {
      id: 1,
      start: Date.parse('2027-03-06T23:00:00Z'),
      end: Date.parse('2027-03-07T01:00:00Z'),
      size: null,
      bufferMs: null
    }
    buckets.add(hold)
    buckets.add({ ...hold, id: 2 })
    expect(buckets.near(Date.parse('2027-03-08T12:00:00Z'))).length(2)
    expect(buckets.near(Date.parse('2027-03-05T12:00:00Z'))).length(2)
    expect(buckets.near(Date.parse('2027-03-10T12:00:00Z'))).length(0)
    buckets.remove(hold)
    buckets.remove({ ...hold, id: 3 })
    expect(buckets.near(Date.parse('2027-03-06T12:00:00Z'))).deep.equals([
      { ...hold, id: 2 }
    ])
    const empty = new DayBuckets()
    empty.remove(hold)
    expect(empty.near(hold.start)).length(0)
  })
})
