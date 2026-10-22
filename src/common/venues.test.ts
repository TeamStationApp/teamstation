import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asBlackouts,
  asFieldChanges,
  asFieldSizeChoice,
  asPin,
  asVenueChanges,
  asVenueDetail,
  asWeeklyHours,
  fieldSizeLabel,
  wallMinutes,
  wallTimeOf
} from './venues'

const fails = (run: () => unknown, message: string): void => {
  expect(run).throws(TypeError, message)
}

describe('venue cleaners', () => {
  it('reads weekly hours on 5-minute steps, one range per weekday, in order', () => {
    expect(
      asWeeklyHours([
        { weekday: 6, start: '08:00', end: '18:00' },
        { weekday: 1, start: '17:00', end: '24:00' }
      ])
    ).deep.equals([
      { weekday: 1, start: '17:00', end: '24:00' },
      { weekday: 6, start: '08:00', end: '18:00' }
    ])
    fails(() => asWeeklyHours('Saturdays'), 'Choose the weekly hours')
    fails(() => asWeeklyHours([null]), 'Choose the weekly hours')
    fails(
      () => asWeeklyHours([{ weekday: 7, start: '08:00', end: '09:00' }]),
      'Choose a day of the week'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1.5, start: '08:00', end: '09:00' }]),
      'Choose a day of the week'
    )
    fails(
      () =>
        asWeeklyHours([
          { weekday: 1, start: '08:00', end: '09:00' },
          { weekday: 1, start: '10:00', end: '11:00' }
        ]),
      'one range of hours'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '08:03', end: '09:00' }]),
      '5-minute step'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '24:00', end: '24:00' }]),
      '5-minute step'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '08:00', end: '24:05' }]),
      '5-minute step'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '8am', end: '09:00' }]),
      'Choose a time'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '09:00', end: '09:00' }]),
      'after the opening time'
    )
    fails(
      () => asWeeklyHours([{ weekday: 1, start: '09:60', end: '10:00' }]),
      '5-minute step'
    )
    expect(wallMinutes('24:00')).equals(1440)
    expect(wallTimeOf(605)).equals('10:05')
  })

  it('reads blackouts as distinct dates, earliest first', () => {
    expect(asBlackouts(['2027-07-04', '2027-05-31', '2027-07-04'])).deep.equals(
      ['2027-05-31', '2027-07-04']
    )
    fails(() => asBlackouts('2027-07-04'), 'Choose the blackout days')
    fails(() => asBlackouts(['2027-02-30']), 'valid calendar date')
    fails(
      () => asBlackouts(Array.from({ length: 367 }, () => '2027-01-01')),
      'at most 366'
    )
  })

  it('reads sizes, pins and venue changes', () => {
    expect(asFieldSizeChoice('50/70')).equals('50/70')
    fails(() => asFieldSizeChoice('70/100'), 'Choose a field size')
    expect(fieldSizeLabel('46/60')).equals('T-ball 46/60')
    expect(fieldSizeLabel('60/90')).equals('60/90')
    expect(asPin({ latitude: 40, longitude: -75 })).deep.equals({
      latitude: 40,
      longitude: -75
    })
    fails(() => asPin({ latitude: 91, longitude: 0 }), 'Drop the pin')
    fails(() => asPin('here'), 'Drop the pin')
    expect(asVenueChanges({})).deep.equals({})
    expect(
      asVenueChanges({
        name: '  Example Park ',
        sizeSwitchMinutes: 30,
        defaultHours: [{ weekday: 6, start: '08:00', end: '18:00' }],
        defaultBlackouts: ['2027-07-04'],
        photo: { contentType: 'image/png', base64: 'AAAA' }
      })
    ).deep.equals({
      name: 'Example Park',
      sizeSwitchMinutes: 30,
      defaultHours: [{ weekday: 6, start: '08:00', end: '18:00' }],
      defaultBlackouts: ['2027-07-04'],
      photo: { contentType: 'image/png', base64: 'AAAA' }
    })
    fails(() => asVenueChanges(null), 'Enter the venue details')
    fails(() => asVenueChanges({ name: ' ' }), 'Enter the venue name')
    fails(() => asVenueChanges({ name: 'x'.repeat(201) }), 'to 200 characters')
    fails(() => asVenueChanges({ sizeSwitchMinutes: 241 }), 'size switch time')
    fails(() => asVenueChanges({ sizeSwitchMinutes: 2.5 }), 'size switch time')
    fails(() => asVenueChanges({ photo: 'cat.png' }), 'Choose a photo')
  })

  it('reads a new field whole, and a change by the keys it names', () => {
    expect(
      asFieldChanges(
        { name: 'Field 1', sizes: ['50/70', '46/60', '50/70'] },
        true
      )
    ).deep.equals({ name: 'Field 1', sizes: ['46/60', '50/70'] })
    fails(() => asFieldChanges({ sizes: ['50/70'] }, true), 'field name')
    fails(() => asFieldChanges({ name: 'Field 1' }, true), 'at least one')
    fails(
      () => asFieldChanges({ name: 'Field 1', sizes: [] }, true),
      'at least one'
    )
    fails(() => asFieldChanges(7, false), 'Enter the field details')
    expect(asFieldChanges({}, false)).deep.equals({})
    expect(
      asFieldChanges(
        {
          pin: null,
          startsOn: null,
          endsOn: null,
          hours: null,
          blackouts: ['2027-04-17'],
          photo: { contentType: 'image/jpeg', base64: 'AAAA' }
        },
        false
      )
    ).deep.equals({
      pin: null,
      dates: null,
      hours: null,
      blackouts: ['2027-04-17'],
      photo: { contentType: 'image/jpeg', base64: 'AAAA' }
    })
    expect(
      asFieldChanges(
        {
          pin: { latitude: 40.01, longitude: -75.2 },
          startsOn: '2026-10-01',
          endsOn: '2027-09-30',
          hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
        },
        false
      )
    ).deep.equals({
      pin: { latitude: 40.01, longitude: -75.2 },
      dates: { startsOn: '2026-10-01', endsOn: '2027-09-30' },
      hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
    })
    fails(
      () =>
        asFieldChanges({ startsOn: '2027-09-30', endsOn: '2026-10-01' }, false),
      'on or after the start date'
    )
    fails(
      () => asFieldChanges({ startsOn: '2027-09-30' }, false),
      'calendar date'
    )
  })

  it('reads a venue detail from the API', () => {
    const detail = asVenueDetail({
      id: null,
      placeId: 'example-park',
      name: 'Example Park',
      address: '1 Example Way',
      timezone: null,
      sizeSwitchMinutes: 0,
      defaultHours: [],
      defaultBlackouts: [],
      photoUrl: null,
      photoLargeUrl: null,
      owners: [],
      claims: [],
      fields: [],
      rights: {
        canEdit: false,
        claimLeagues: [{ id: 'lea_a', name: 'Demo League' }],
        canClaim: true,
        canRequest: false,
        leaveClaimIds: [],
        canRemoveOwners: false,
        decidableClaimIds: []
      },
      map: {
        latitude: 40,
        longitude: -75,
        tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png'
      }
    })
    expect(detail.rights.claimBlocked).equals(null)
    expect(detail.map.googleMapsApiKey).equals(undefined)
  })
})
