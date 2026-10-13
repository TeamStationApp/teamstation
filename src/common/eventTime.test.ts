import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  effectiveEventEnd,
  eventLocalFields,
  eventLocalRange,
  eventWallTime,
  nearestFiveMinutes,
  viewerTimezone
} from './eventTime'
import { gameTime } from './gameTime'

describe('viewer-local event times', () => {
  it('uses three elapsed hours across midnight, month/year and daylight-saving boundaries', () => {
    for (const start of [
      '2027-01-31T23:30:00Z',
      '2027-12-31T23:30:00Z',
      '2027-03-14T09:30:00Z',
      '2027-11-07T08:30:00Z'
    ])
      expect(Date.parse(effectiveEventEnd(start)) - Date.parse(start)).equals(
        10800000
      )
    expect(
      eventLocalFields(effectiveEventEnd('2027-12-31T23:30:00Z'), 'UTC')
    ).deep.equals({ date: '2028-01-01', time: '02:30' })
    expect(
      eventWallTime(
        effectiveEventEnd('2027-03-14T09:30:00Z'),
        'America/Los_Angeles'
      )
    ).equals('05:30')
    expect(
      effectiveEventEnd('2027-01-01T00:00:00Z', '2027-01-01T02:00:00Z')
    ).equals('2027-01-01T02:00:00Z')
    expect(() => gameTime('2027-03-14', '02:30', 'America/Los_Angeles')).throws(
      'does not exist'
    )
  })
  it('renders in the viewer’s zone and only rounds deliberate selections', () => {
    const start = '2027-04-11T06:30:42Z'
    expect(eventLocalFields(start, 'America/Los_Angeles')).deep.equals({
      date: '2027-04-10',
      time: '23:30'
    })
    expect(eventLocalRange(start, null, 'America/Los_Angeles')).equals(
      'Saturday, April 10, 11:30 PM – Sunday, April 11, 2:30 AM'
    )
    expect(eventLocalRange(start, null, 'Asia/Tokyo')).equals(
      'Sunday, April 11, 3:30 PM – 6:30 PM'
    )
    expect(viewerTimezone()).is.a('string')
    expect(eventLocalRange(start)).is.a('string')
    expect(nearestFiveMinutes('23:58')).equals('00:00')
    expect(nearestFiveMinutes('12:02')).equals('12:00')
    expect(nearestFiveMinutes('12:03')).equals('12:05')
    expect(() => eventLocalFields(start, 'invalid')).throws()
  })
})
