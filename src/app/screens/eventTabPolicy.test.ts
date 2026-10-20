import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultEventTab,
  eventEnded,
  eventEndTime,
  gameSectionOrder
} from './eventTabPolicy'

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
  it('uses the exact end boundary, legacy three-hour duration, final status and unknown times', () => {
    expect(eventEndTime(event)).equals(Date.parse(endAt))
    expect(eventEnded(event, Date.parse(endAt))).equals(true)
    expect(defaultEventTab(event, Date.parse(endAt))).equals('boxScore')
    expect(eventEndTime({ ...event, endAt: 'invalid' })).equals(
      Date.parse(startAt) + 3 * 60 * 60 * 1000
    )
    expect(eventEndTime({ status: 'scheduled', startAt: 'invalid' })).equals(
      null
    )
    expect(eventEndTime({ status: 'scheduled' })).equals(null)
    expect(defaultEventTab({ status: 'scheduled' })).equals('info')
    expect(defaultEventTab({ status: 'final' })).equals('boxScore')
    expect(gameSectionOrder({ status: 'final' })).deep.equals([
      'boxScore',
      'plays',
      'watch',
      'info'
    ])
    expect(
      gameSectionOrder({ ...event, status: 'final' }, Date.parse(endAt))
    ).deep.equals(['boxScore', 'plays', 'watch', 'info'])
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
  it('orders the sections from standing plays, a live video and the start time', () => {
    const before = Date.parse(startAt) - 1
    const live = [{ status: 'live' }]
    expect(gameSectionOrder(event, before)).deep.equals([
      'info',
      'boxScore',
      'watch'
    ])
    expect(
      gameSectionOrder({ ...event, hasScoringEvents: true }, before)
    ).deep.equals(['boxScore', 'watch', 'info'])
    expect(
      defaultEventTab(
        { ...event, hasScoringEvents: true, videos: live },
        before
      )
    ).equals('watch')
    expect(gameSectionOrder({ ...event, videos: live }, before)).deep.equals([
      'info',
      'boxScore',
      'watch'
    ])
    expect(
      defaultEventTab({ ...event, videos: live }, Date.parse(startAt))
    ).equals('watch')
    expect(
      gameSectionOrder({ ...event, videos: live }, Date.parse(startAt))
    ).deep.equals(['watch', 'boxScore', 'info'])
  })
})
