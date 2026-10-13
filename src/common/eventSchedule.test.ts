import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  changeEventSchedule,
  eventScheduleValue,
  newEventSchedule
} from './eventSchedule'

describe('local event schedule drafts', () => {
  it('rounds off-grid start and end clocks within their loaded repeated-hour occurrence', () => {
    const end = changeEventSchedule(
      newEventSchedule(
        '2027-11-07T08:45:00Z',
        '2027-11-07T09:32:42.123Z',
        'America/Los_Angeles'
      ),
      { endTime: '01:30' }
    )
    expect(end.endDate).equals('2027-11-07')
    expect(eventScheduleValue(end).endAt).equals('2027-11-07T09:30:00.000Z')
    const start = changeEventSchedule(
      newEventSchedule(
        '2027-11-07T09:32:42.123Z',
        '2027-11-07T12:32:42.123Z',
        'America/Los_Angeles'
      ),
      { time: '01:30' }
    )
    expect(eventScheduleValue(start)).includes({
      startAt: '2027-11-07T09:30:00.000Z',
      endAt: '2027-11-07T12:32:42.123Z'
    })
    expect(
      eventScheduleValue(changeEventSchedule(start, { time: '01:45' })).startAt
    ).equals('2027-11-07T09:45:00.000Z')
  })
  it('resolves changed dates, zones and transition clocks when the loaded offset no longer applies', () => {
    const original = newEventSchedule(
      '2027-03-14T09:30:00Z',
      null,
      'America/Los_Angeles'
    )
    expect(
      eventScheduleValue(changeEventSchedule(original, { time: '03:30' }))
        .startAt
    ).equals('2027-03-14T10:30:00.000Z')
    expect(() =>
      eventScheduleValue(changeEventSchedule(original, { time: '02:30' }))
    ).throws('does not exist')
    const fold = newEventSchedule(
      '2027-11-07T09:32:00Z',
      null,
      'America/Los_Angeles'
    )
    expect(
      eventScheduleValue(
        changeEventSchedule(fold, { date: '2027-11-08', time: '01:30' })
      ).startAt
    ).equals('2027-11-08T09:30:00.000Z')
    expect(
      eventScheduleValue(
        changeEventSchedule(fold, { timezone: 'UTC', time: '01:30' })
      ).startAt
    ).equals('2027-11-07T01:30:00.000Z')
  })
  it('keeps a valid loaded end on the same day when its repeated clock precedes the start clock', () => {
    const original = newEventSchedule(
      '2027-11-07T08:45:00Z',
      '2027-11-07T09:30:00Z',
      'America/Los_Angeles'
    )
    const picked = changeEventSchedule(original, { endTime: original.endTime })
    expect(picked.endDate).equals('2027-11-07')
    expect(eventScheduleValue(picked).endAt).equals('2027-11-07T09:30:00.000Z')
    const removedDate = changeEventSchedule(
      changeEventSchedule(original, { hasEndDate: true }),
      { hasEndDate: false }
    )
    expect(Date.parse(eventScheduleValue(removedDate).endAt!)).equals(
      Date.parse(original.originalEnd!)
    )
  })
  it('retains the inferred end offset when reconfirming a repeated DST clock', () => {
    let draft = newEventSchedule(
      '2027-11-07T06:30:00Z',
      null,
      'America/Los_Angeles'
    )
    draft = changeEventSchedule(draft, { hasEndTime: true })
    expect(draft.endTime).equals('01:30')
    expect(eventScheduleValue(draft).endAt).equals('2027-11-07T09:30:00.000Z')
    draft = changeEventSchedule(draft, { endTime: draft.endTime })
    expect(eventScheduleValue(draft).endAt).equals('2027-11-07T09:30:00.000Z')
    const moved = changeEventSchedule(
      newEventSchedule('2027-11-07T05:30:00Z', null, 'America/Los_Angeles'),
      { time: '23:30' }
    )
    const selected = changeEventSchedule(
      changeEventSchedule(moved, { hasEndTime: true }),
      { endTime: moved.endTime }
    )
    expect(eventScheduleValue(selected).endAt).equals(
      '2027-11-07T09:30:00.000Z'
    )
    const cleared = changeEventSchedule(
      newEventSchedule(
        '2027-11-07T06:30:00Z',
        '2027-11-07T08:30:00Z',
        'America/Los_Angeles'
      ),
      { hasEndTime: false }
    )
    expect(
      eventScheduleValue(
        changeEventSchedule(cleared, {
          hasEndTime: true,
          endTime: cleared.endTime
        })
      ).endAt
    ).equals('2027-11-07T09:30:00.000Z')
  })
  it('preserves an explicit end on start-only edits and rejects invalid ordering', () => {
    const original = newEventSchedule(
      '2027-04-10T18:00:00Z',
      '2027-04-10T19:00:00Z',
      'UTC'
    )
    for (const change of [{ time: '20:00' }, { date: '2027-04-11' }]) {
      const draft = changeEventSchedule(original, change)
      expect(draft).includes({ endDate: '2027-04-10', endTime: '19:00' })
      expect(() => eventScheduleValue(draft)).throws('after start')
    }
    const recovered = changeEventSchedule(
      changeEventSchedule(original, { time: '20:00' }),
      { endTime: '21:00' }
    )
    expect(eventScheduleValue(recovered).endAt).equals(
      '2027-04-10T21:00:00.000Z'
    )
  })
  it('preserves precise loaded instants when choosing an equivalent saved timezone alias', () => {
    const original = newEventSchedule(
      '2027-11-07T09:30:42.123Z',
      '2027-11-07T12:30:42.123Z',
      'America/Los_Angeles',
      'US/Pacific'
    )
    const changed = changeEventSchedule(original, { timezone: 'US/Pacific' })
    expect(eventScheduleValue(changed)).includes({
      startAt: original.originalStart,
      endAt: original.originalEnd,
      timezone: 'US/Pacific'
    })
  })
  it('drops hidden seconds on a deliberate clock selection without switching a repeated DST hour', () => {
    const original = newEventSchedule(
      '2027-11-07T09:30:42.123Z',
      '2027-11-07T12:30:42.123Z',
      'America/Los_Angeles'
    )
    expect(eventScheduleValue(original).startAt).equals(
      '2027-11-07T09:30:42.123Z'
    )
    const selected = changeEventSchedule(original, {
      time: original.time,
      endTime: original.endTime
    })
    expect(eventScheduleValue(selected)).includes({
      startAt: '2027-11-07T09:30:00.000Z',
      endAt: '2027-11-07T12:30:00.000Z'
    })
  })
  it('preserves exact loaded instants and expresses them in the viewer zone', () => {
    const start = '2027-04-11T06:32:42.123Z'
    const end = '2027-04-11T09:32:42.123Z'
    const draft = newEventSchedule(start, end, 'America/Los_Angeles')
    expect(draft).includes({
      date: '2027-04-10',
      time: '23:32',
      endDate: '2027-04-11',
      endTime: '02:32',
      hasEndDate: true
    })
    expect(eventScheduleValue(draft)).deep.equals({
      startAt: start,
      endAt: end,
      timezone: 'America/Los_Angeles'
    })
    expect(newEventSchedule()).property('time', '18:00')
  })
  it('follows start for an uncustomized three-hour end and rolls over at midnight', () => {
    let draft = newEventSchedule('2027-12-31T22:30:00Z', null, 'UTC')
    expect(draft).includes({ endDate: '2028-01-01', endTime: '01:30' })
    expect(eventScheduleValue(draft).endAt).equals(null)
    draft = changeEventSchedule(draft, { hasEndTime: true })
    expect(eventScheduleValue(draft).endAt).equals('2028-01-01T01:30:00.000Z')
    draft = changeEventSchedule(draft, { time: '23:00' })
    expect(draft.endTime).equals('02:00')
    draft = changeEventSchedule(draft, { hasEndDate: true })
    expect(eventScheduleValue(draft).endAt).equals('2028-01-01T02:00:00.000Z')
    draft = changeEventSchedule(draft, { hasEndTime: false })
    expect(draft).includes({ hasEndDate: false, customEnd: false })
    expect(eventScheduleValue(draft).endAt).equals(null)
  })
  it('retains customized end values, supports clock rollover and validates explicit ordering', () => {
    let draft = changeEventSchedule(
      newEventSchedule('2027-04-10T18:00:00Z', null, 'UTC'),
      { hasEndTime: true, endTime: '01:00' }
    )
    expect(draft.endDate).equals('2027-04-11')
    expect(eventScheduleValue(draft).endAt).equals('2027-04-11T01:00:00.000Z')
    draft = changeEventSchedule(draft, {
      hasEndDate: true,
      endDate: '2027-04-10'
    })
    expect(() => eventScheduleValue(draft)).throws('after start')
    draft = changeEventSchedule(draft, { hasEndDate: false })
    expect(draft.endDate).equals('2027-04-11')
    draft = changeEventSchedule(draft, { hasEndDate: true, date: '2027-04-12' })
    expect(() => eventScheduleValue(draft)).throws('after start')
    draft = changeEventSchedule(draft, { hasEndTime: false })
    expect(draft.endDate).equals('2027-04-12')
  })
  it('keeps DST gaps and invalid zones recoverable and uses three elapsed hours at DST', () => {
    let draft = newEventSchedule(
      '2027-03-14T09:30:00Z',
      null,
      'America/Los_Angeles'
    )
    expect(draft.endTime).equals('05:30')
    draft = changeEventSchedule(draft, { time: '02:30' })
    expect(() => eventScheduleValue(draft)).throws('does not exist')
    draft = changeEventSchedule(draft, { time: '03:30' })
    expect(eventScheduleValue(draft).startAt).equals('2027-03-14T10:30:00.000Z')
    draft = changeEventSchedule(draft, { timezone: 'America/' })
    expect(() => eventScheduleValue(draft)).throws()
    draft = changeEventSchedule(draft, { timezone: 'UTC' })
    expect(eventScheduleValue(draft).startAt).equals('2027-03-14T03:30:00.000Z')
  })
})
