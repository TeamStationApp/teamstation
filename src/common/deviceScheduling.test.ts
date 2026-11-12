import { expect } from 'chai'
import { describe, it } from 'mocha'

import { field, input, season } from './autoScheduler/fixtures.test'
import { LocalClock, seasonSlots } from './autoScheduler/slots'
import {
  coversGame,
  effectiveAvailability,
  fieldWindows
} from './fieldAvailability'
import { asFieldChanges, asVenueChanges, asVenueField } from './venues'
import { asWindowPeriods, weeklyWindow } from './windowPeriods'

const morning = [{ weekday: 6, start: '08:00', end: '12:00' }]
const evening = [{ weekday: 6, start: '18:00', end: '22:00' }]
const venue = {
  defaultHours: morning,
  defaultWindows: weeklyWindow(morning),
  defaultBlackouts: [],
  timezone: 'UTC'
}
const inherited = {
  startsOn: null,
  endsOn: null,
  hours: null,
  windows: null,
  blackouts: []
}

describe('dated scheduling availability', () => {
  it('preserves explicit inherited windows through API decoding even when legacy hours remain', () => {
    const base = {
      id: 'fld_demo',
      name: 'Demo Field',
      sizes: ['50/70'],
      pin: null,
      startsOn: null,
      endsOn: null,
      hours: evening,
      blackouts: [],
      photoUrl: null,
      photoLargeUrl: null
    }
    const decoded = asVenueField({ ...base, windows: null })
    expect(decoded.windows).equals(null)
    expect(effectiveAvailability(venue, decoded).windows).deep.equals(
      weeklyWindow(morning)
    )
    expect(asVenueField(base).windows).equals(undefined)
  })
  it('inherits windows, honors explicit closure and combines blackouts', () => {
    expect(
      fieldWindows(effectiveAvailability(venue, inherited), '2027-03-06')
    ).length(1)
    expect(
      fieldWindows(
        effectiveAvailability(venue, { ...inherited, windows: [] }),
        '2027-03-06'
      )
    ).deep.equals([])
    expect(
      fieldWindows(
        effectiveAvailability(
          { ...venue, defaultBlackouts: ['2027-03-06'] },
          inherited
        ),
        '2027-03-06'
      )
    ).deep.equals([])
  })
  it('switches dated hours, respects gaps and keeps earlier weekly hours', () => {
    const availability = effectiveAvailability(venue, {
      ...inherited,
      windows: [
        { ...weeklyWindow(morning)[0], until: '2027-03-06' },
        { from: '2027-03-20', hours: evening }
      ]
    })
    expect(
      coversGame(availability, '2027-03-06T08:00:00Z', '2027-03-06T12:00:00Z')
    ).equals(true)
    expect(fieldWindows(availability, '2027-03-13')).deep.equals([])
    expect(
      coversGame(availability, '2027-03-20T18:00:00Z', '2027-03-20T22:00:00Z')
    ).equals(true)
    expect(
      coversGame(availability, '2027-03-20T08:00:00Z', '2027-03-20T12:00:00Z')
    ).equals(false)
    expect(
      coversGame(availability, '2027-03-20T21:00:00Z', '2027-03-20T22:05:00Z')
    ).equals(false)
  })
  it('cleans dated writes and rejects overlap and conflicting legacy writes', () => {
    expect(
      asVenueChanges({ defaultWindows: weeklyWindow(morning) }).defaultWindows
    ).deep.equals(weeklyWindow(morning))
    expect(asFieldChanges({ windows: null }, false).windows).equals(null)
    expect(asFieldChanges({ windows: [] }, false).windows).deep.equals([])
    expect(() => asFieldChanges({ hours: [], windows: [] }, false)).throws(
      'not both'
    )
    expect(() =>
      asVenueChanges({ defaultHours: [], defaultWindows: [] })
    ).throws('not both')
    expect(() =>
      asWindowPeriods([
        { from: '2027-03-01', until: '2027-04-01', hours: [] },
        { from: '2027-03-20', hours: [] }
      ])
    ).throws('overlap')
  })
  it('offers only explicitly selected matching fields for each season', () => {
    const first = season({ fieldIds: ['fld_one'] })
    const second = season({ fieldIds: ['fld_two'] }, { id: 'sea_two' })
    const run = input({
      seasons: [first, second],
      fields: [field(), field({ id: 'fld_two' })]
    })
    for (const selected of [first, second]) {
      const slots = seasonSlots(run, selected, new LocalClock()).slots
      expect(slots.length).greaterThan(0)
      expect([...new Set(slots.map(slot => slot.fieldId))]).deep.equals(
        selected.settings.fieldIds
      )
    }
    first.settings.fieldIds = []
    expect(seasonSlots(run, first, new LocalClock()).slots).deep.equals([])
    first.settings.fieldIds = ['fld_two']
    run.fields[1].sizes = ['60/90']
    expect(seasonSlots(run, first, new LocalClock()).slots).deep.equals([])
  })
})
