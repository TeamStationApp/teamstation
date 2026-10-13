import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  arrivalMinutes,
  arrivalMinutesInput,
  asEventLocationFields,
  asTeamEventInput,
  withEventMetadata
} from './eventInfo'
import { selectedEventPlace } from './eventPlaces'
import { eventArrivalTime, eventHeroTime } from './eventTime'

describe('optional event notes and relative arrival time', () => {
  it('distinguishes absent, blank, zero and positive arrival minutes and validates boundaries', () => {
    expect(asEventLocationFields({})).deep.equals({})
    expect(
      asEventLocationFields({ notes: '', arrivalTimeDelta: null })
    ).deep.equals({ notes: null, arrivalTimeDelta: null })
    expect(
      asEventLocationFields({
        notes: ' Field 2\nMeet by gate ',
        arrivalTimeDelta: 45
      })
    ).deep.equals({ notes: 'Field 2\nMeet by gate', arrivalTimeDelta: 45 })
    for (const value of [0, 45, 10080])
      expect(arrivalMinutes(value)).equals(value)
    for (const value of [-1, 0.5, Infinity, NaN, '45', 10081, {}, true])
      expect(() => arrivalMinutes(value)).throws()
    expect(arrivalMinutes(null)).equals(null)
    expect(arrivalMinutesInput('')).equals(null)
    expect(arrivalMinutesInput(' 0 ')).equals(0)
    expect(arrivalMinutesInput('45')).equals(45)
    for (const value of ['-5', '0.5', 'abc', 'Infinity', '10081'])
      expect(() => arrivalMinutesInput(value)).throws()
    for (const notes of [false, 12, 'x'.repeat(2001)])
      expect(() => asEventLocationFields({ notes })).throws()
    expect(asEventLocationFields({ notes: 'x'.repeat(2000) }).notes).length(
      2000
    )
    const decode = withEventMetadata(raw => ({
      id: (raw as { id: string }).id
    }))
    expect(decode({ id: 'legacy' })).deep.equals({ id: 'legacy' })
    expect(
      decode({
        id: 'new',
        notes: null,
        arrivalTimeDelta: 0,
        eventType: 'practice'
      })
    ).includes({ notes: null, arrivalTimeDelta: 0, eventType: 'practice' })
    const body = {
      teamId: 'tem_demo',
      title: 'Practice',
      startAt: '2032-02-29T00:15Z',
      idempotencyKey: 'practice-demo'
    }
    expect(
      asTeamEventInput({ ...body, eventType: 'practice' }).eventType
    ).equals('practice')
    expect(asTeamEventInput(body)).not.property('eventType')
    expect(() => asTeamEventInput({ ...body, eventType: 'game' })).throws()
  })
  it('calculates actual viewer-local arrival and prior-day date without treating zero as absent', () => {
    const start = '2032-03-01T00:15:00Z'
    expect(eventArrivalTime(start, 45, 'UTC')).equals(
      'Sunday, February 29 at 11:30 PM'
    )
    expect(eventArrivalTime(start, 0, 'UTC')).equals('12:15 AM')
    expect(eventArrivalTime(start, null)).equals(null)
    expect(eventArrivalTime(start, undefined)).equals(null)
    expect(eventArrivalTime('2032-03-01T01:15:00Z', 45, 'UTC')).equals(
      '12:30 AM'
    )
    expect(eventArrivalTime(start, 45, 'America/Los_Angeles')).equals('3:30 PM')
    expect(eventHeroTime(start, null, 0, 'UTC')).includes('Arrival 12:15 AM')
    expect(eventHeroTime(start, null, null, 'UTC')).not.includes('Arrival')
    expect(eventHeroTime(start, null, 45)).includes('Arrival')
  })
  it('fills both fields for venue choices and only blank names for address choices', () => {
    const place = { id: 'demo', name: 'Demo Park', address: '1 Demo Way' }
    expect(selectedEventPlace('venue', place, 'Custom')).deep.equals({
      venue: 'Demo Park',
      address: '1 Demo Way'
    })
    expect(selectedEventPlace('address', place, 'Custom')).deep.equals({
      venue: 'Custom',
      address: '1 Demo Way'
    })
    expect(selectedEventPlace('address', place, ' ')).property(
      'venue',
      'Demo Park'
    )
    expect(
      selectedEventPlace('address', { ...place, name: null }, '')
    ).property('venue', '')
    expect(
      selectedEventPlace('venue', { ...place, name: null }, 'Manual')
    ).property('venue', 'Manual')
  })
})
