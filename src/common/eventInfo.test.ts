import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asEventAttendee,
  asEventInfo,
  asEventLocation,
  asEventLocationFields,
  asPlayerRsvpCounts,
  asRsvp,
  asTeamEventInput,
  eventDate,
  eventName,
  eventText,
  playerRsvpCounts,
  sortedAttendees,
  withEventMetadata
} from './eventInfo'
import { userIdOfGumbo } from './userId'

const body = {
  teamId: 'tem_demo',
  title: 'Team dinner',
  startAt: '2027-04-10T18:00:00Z',
  idempotencyKey: 'demo-event-key'
}
describe('event information contracts', () => {
  it('counts only direct players, combines Maybe with unknown and validates count payloads', () => {
    const row = {
      userId: userIdOfGumbo(1),
      gumboId: 1,
      name: 'Babe R',
      avatarUrl: null,
      canReply: false,
      isPlayer: true,
      isTeamParticipant: true
    }
    expect(
      playerRsvpCounts([
        { ...row, response: 'yes' },
        { ...row, userId: userIdOfGumbo(2), response: 'maybe' },
        { ...row, userId: userIdOfGumbo(3), response: null },
        { ...row, userId: userIdOfGumbo(4), response: 'no' },
        {
          ...row,
          userId: userIdOfGumbo(5),
          gumboId: 5,
          response: 'yes',
          isPlayer: false
        },
        {
          ...row,
          userId: userIdOfGumbo(6),
          response: 'no',
          isTeamParticipant: false
        }
      ])
    ).deep.equals({ yes: 1, unknown: 2, no: 1 })
    expect(() => asPlayerRsvpCounts({ yes: -1, unknown: 0, no: 0 })).throws()
    expect(() => asPlayerRsvpCounts({ yes: 0.5, unknown: 0, no: 0 })).throws()
    expect(
      withEventMetadata(value => value)({
        playerRsvps: { yes: 1, unknown: 2, no: 1 }
      }).playerRsvps
    ).deep.equals({ yes: 1, unknown: 2, no: 1 })
  })
  it('decodes optional attendance fields without widening old shapes', () => {
    const row = {
      userId: userIdOfGumbo(1),
      name: 'Babe R',
      avatarUrl: null,
      response: null,
      canReply: true
    }
    expect(asEventAttendee(row)).deep.equals(row)
    const profile = {
      ...row,
      isTeamParticipant: false,
      isPlayer: true,
      staffRoles: ['coach', 'admin'],
      bats: 'switch',
      throws: 'right',
      positions: ['CF'],
      guardianOf: ['Mike T']
    }
    expect(asEventAttendee(profile)).deep.equals({
      ...profile,
      staffRoles: ['admin', 'coach']
    })
    expect(asEventAttendee({ ...profile, bats: null, throws: null })).includes({
      bats: null,
      throws: null
    })
    for (const change of [
      { bats: 'other' },
      { throws: 'switch' },
      { staffRoles: ['parent'] },
      { isPlayer: 'yes' },
      { positions: [3] }
    ])
      expect(() => asEventAttendee({ ...profile, ...change })).throws()
  })
  it('normalizes titles/dates and preserves omitted update fields', () => {
    expect(
      asTeamEventInput({
        ...body,
        title: ' Team dinner ',
        endAt: '2027-04-10T20:00:00Z',
        address: ' 1 Demo Way ',
        latitude: 0,
        longitude: 0
      })
    ).includes({
      title: 'Team dinner',
      address: '1 Demo Way',
      latitude: 0,
      longitude: 0,
      timezone: 'UTC',
      status: 'scheduled'
    })
    expect(asEventLocationFields({})).deep.equals({})
    expect(
      asEventLocationFields({
        address: '',
        endAt: null,
        latitude: null,
        longitude: null
      })
    ).deep.equals({
      address: null,
      endAt: null,
      latitude: null,
      longitude: null
    })
    expect(eventText(null, 'Venue', 200)).equals(null)
    expect(eventText('  ', 'Venue', 200)).equals(null)
    expect(eventDate('2027-04-10T18:00:00-07:00', 'Start')).equals(
      '2027-04-11T01:00:00.000Z'
    )
    expect(
      asTeamEventInput({
        ...body,
        status: 'cancelled',
        venue: 'Demo Park',
        timezone: 'America/Los_Angeles'
      })
    ).includes({ status: 'cancelled', venue: 'Demo Park' })
  })
  it('rejects invalid times, required fields, coordinates and choices', () => {
    for (const change of [
      null,
      [],
      { ...body, title: '' },
      { ...body, title: ' ' },
      { ...body, title: 42 },
      { ...body, title: 'x'.repeat(201) },
      { ...body, teamId: '' },
      { ...body, teamId: 3 },
      { ...body, teamId: 'x'.repeat(101) },
      { ...body, startAt: '2027-04-10' },
      { ...body, startAt: '2027-02-31T18:00:00Z' },
      { ...body, startAt: 'x' },
      { ...body, endAt: body.startAt },
      { ...body, endAt: '2027-04-09T18:00:00Z' },
      { ...body, endAt: 'invalid' },
      { ...body, address: 'x'.repeat(501) },
      { ...body, venue: 0 },
      { ...body, latitude: 91, longitude: 0 },
      { ...body, latitude: 0, longitude: 181 },
      { ...body, latitude: NaN, longitude: 0 },
      { ...body, latitude: 3 },
      { ...body, longitude: 0 },
      { ...body, timezone: 3 },
      { ...body, timezone: 'x'.repeat(101) },
      { ...body, timezone: 'invalid' },
      { ...body, status: 'final' },
      { ...body, idempotencyKey: '' },
      { ...body, idempotencyKey: 'x'.repeat(121) }
    ]) {
      expect(() => asTeamEventInput(change)).throws()
    }
    for (const response of ['noReply', null, 'YES', 1])
      expect(() => asRsvp(response)).throws()
    expect(() => eventText(undefined, 'Title', 200, true)).throws()
  })
  it('preserves old answer shapes and decodes event metadata', () => {
    const decode = withEventMetadata((raw: unknown) => ({
      id: (raw as { id: string }).id
    }))
    expect(decode({ id: 'g' })).deep.equals({ id: 'g' })
    expect(
      decode({
        id: 'g',
        eventKind: 'event',
        title: 'Dinner',
        endAt: null,
        address: null,
        latitude: 0,
        longitude: 0,
        hasScoringEvents: false,
        isGameLive: false
      })
    ).deep.equals({
      id: 'g',
      eventKind: 'event',
      title: 'Dinner',
      endAt: null,
      address: null,
      latitude: 0,
      longitude: 0,
      hasScoringEvents: false,
      isGameLive: false
    })
    expect(() => decode({ id: 'g', eventKind: 'practice' })).throws()
    expect(decode({ id: 'g', isGameLive: true })).deep.equals({
      id: 'g',
      isGameLive: true
    })
    expect(decode({ id: 'g', isUmpire: true })).deep.equals({
      id: 'g',
      isUmpire: true
    })
    expect(decode({ id: 'g', isUmpire: false })).deep.equals({
      id: 'g',
      isUmpire: false
    })
    expect(() => decode({ id: 'g', isUmpire: 'true' })).throws()
    expect(() => decode({ id: 'g', isGameLive: 'true' })).throws()
    expect(
      asEventLocation({
        latitude: null,
        longitude: null,
        tileUrl: 'https://example.test/{z}/{x}/{y}'
      })
    ).property('latitude', null)
    expect(
      asEventInfo({
        id: 'e',
        eventKind: 'event',
        title: 'Dinner',
        teamId: 't',
        teamName: 'Owls',
        startAt: null,
        endAt: null,
        timezone: 'UTC',
        venue: null,
        address: null,
        latitude: null,
        longitude: null,
        status: 'scheduled',
        canManage: true,
        replyUserIds: [userIdOfGumbo(1)],
        attendees: [
          {
            userId: userIdOfGumbo(1),
            name: 'Babe Ruth',
            avatarUrl: null,
            response: null,
            canReply: true
          }
        ]
      }).attendees[0].response
    ).equals(null)
  })
  it('calls a practice Practice and requires a title of any other event', () => {
    expect(
      asTeamEventInput({ ...body, eventType: 'practice', title: undefined })
    ).includes({ eventType: 'practice', title: 'Practice' })
    expect(
      asTeamEventInput({ ...body, eventType: 'practice', title: ' ' })
    ).includes({ title: 'Practice' })
    expect(
      asTeamEventInput({ ...body, eventType: 'practice', title: 'Drills' })
    ).includes({ title: 'Drills' })
    for (const eventType of ['other', undefined])
      expect(() => asTeamEventInput({ ...body, eventType, title: '' })).throws(
        'Title is required'
      )
    expect(() => asTeamEventInput({ ...body, eventType: 'game' })).throws(
      TypeError
    )
    expect(eventName({})).equals(undefined)
    expect(eventName({ eventType: 'game', title: 'x' })).equals(undefined)
    expect(eventName({ eventKind: 'game' })).equals(undefined)
    expect(
      eventName({ eventKind: 'event', eventType: 'practice', title: 'Drills' })
    ).equals('Practice')
    expect(eventName({ eventType: 'practice' })).equals('Practice')
    expect(
      eventName({
        eventKind: 'event',
        eventType: 'other',
        title: ' Team dinner '
      })
    ).equals('Team dinner')
    expect(eventName({ eventKind: 'event', title: null })).equals('Event')
  })
  it('orders replies yes, maybe, no, then absence without changing its source', () => {
    const rows = [null, 'no', 'maybe', 'yes', 'yes'].map((response, i) => ({
      userId: userIdOfGumbo(i + 1),
      name: [
        'Nolan Ryan',
        'Lou Gehrig',
        'Mike Trout',
        'Babe Ruth',
        'Babe Ruth'
      ][i],
      avatarUrl: null,
      canReply: false,
      response: response as 'yes' | 'maybe' | 'no' | null
    }))
    expect(sortedAttendees(rows).map(row => row.userId)).deep.equals(
      [4, 5, 3, 2, 1].map(userIdOfGumbo)
    )
    expect(rows[0].response).equals(null)
  })
})

describe('the event info cleaner’s field', () => {
  const answer = {
    id: 'gam_demo',
    eventKind: 'game',
    title: null,
    teamId: 'tea_owls',
    teamName: 'Owls',
    startAt: '2027-04-10T14:00:00.000Z',
    endAt: '2027-04-10T16:00:00.000Z',
    timezone: 'America/New_York',
    venue: 'Example Park',
    address: '1 Example Way, Demo City',
    latitude: 40.0212,
    longitude: -75.2191,
    status: 'scheduled',
    canManage: false,
    attendees: [],
    replyUserIds: []
  }
  const FIELD = {
    id: 'fld_one',
    name: 'Field 1',
    size: '50/70',
    latitude: 40.0212,
    longitude: -75.2191
  }
  it('keeps a game’s field with its id, name, size and point', () => {
    expect(asEventInfo({ ...answer, field: FIELD }).field).deep.equals(FIELD)
    expect(
      asEventInfo({ ...answer, field: { ...FIELD, size: 'T-ball' } }).field
        ?.size
    ).equals('T-ball')
  })
  it('leaves the field absent when the answer has none', () => {
    const info = asEventInfo(answer)
    expect(info).not.property('field')
    expect(info.venue).equals('Example Park')
  })
  it('refuses an answer whose field is malformed, as it does for warnings', () => {
    for (const field of [
      null,
      'Field 1',
      { ...FIELD, name: undefined },
      { ...FIELD, size: '70/100' },
      { ...FIELD, latitude: '40.0212' },
      { id: 'fld_one', name: 'Field 1', size: '50/70' }
    ])
      expect(
        () => asEventInfo({ ...answer, field }),
        JSON.stringify(field)
      ).throws(TypeError)
    expect(() =>
      asEventInfo({ ...answer, fieldWarnings: [{ kind: 'flooded' }] })
    ).throws(TypeError)
  })
})
