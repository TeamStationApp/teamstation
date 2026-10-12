import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultEventTab, eventEnded, eventEndTime } from './eventTabPolicy'

describe('event default and scheduled end policy', () => {
  const startAt = '2027-04-10T18:00:00Z'
  const endAt = '2027-04-10T20:00:00Z'
  const event = { startAt, endAt, status: 'scheduled' }
  it('keeps Info before and during a game until an actual scoring event', () => {
    for (const now of [
      Date.parse(startAt) - 1,
      Date.parse(startAt),
      Date.parse(endAt) - 1
    ])
      expect(defaultEventTab(event, now)).equals('info')
    expect(
      defaultEventTab({ ...event, hasScoringEvents: true }, Date.parse(startAt))
    ).equals('boxScore')
    expect(
      defaultEventTab(
        { ...event, hasScoringEvents: false },
        Date.parse(startAt)
      )
    ).equals('info')
  })
  it('uses the exact end boundary, legacy two-hour duration, final status and unknown times', () => {
    expect(eventEndTime(event)).equals(Date.parse(endAt))
    expect(eventEnded(event, Date.parse(endAt))).equals(true)
    expect(defaultEventTab(event, Date.parse(endAt))).equals('boxScore')
    expect(eventEndTime({ ...event, endAt: 'invalid' })).equals(
      Date.parse(endAt)
    )
    expect(eventEndTime({ status: 'scheduled', startAt: 'invalid' })).equals(
      null
    )
    expect(eventEndTime({ status: 'scheduled' })).equals(null)
    expect(defaultEventTab({ status: 'scheduled' })).equals('info')
    expect(defaultEventTab({ status: 'final' })).equals('boxScore')
  })
  it('keeps non-game Info before and after their end or a supplied scoring flag', () => {
    const dinner = {
      ...event,
      eventKind: 'event' as const,
      hasScoringEvents: true
    }
    expect(eventEndTime(dinner)).equals(null)
    expect(eventEnded(dinner, Date.parse(endAt) + 1)).equals(false)
    expect(defaultEventTab(dinner, Date.parse(endAt) + 1)).equals('info')
  })
})
