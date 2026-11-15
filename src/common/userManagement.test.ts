import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  asPersonAdministration,
  localDate,
  localMinute
} from './userManagement'

describe('user management: local times', function () {
  const zone = process.env.TZ
  before(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  after(() => {
    if (zone == null) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('writes a time as the viewer’s own date and 24-hour minute', function () {
    expect(localMinute('2026-07-04T23:05:59.999Z')).equals('2026-07-04 16:05')
    // Past midnight in UTC is still the evening before here.
    expect(localMinute('2026-03-02T07:59:00.000Z')).equals('2026-03-01 23:59')
  })

  it('follows the clock across a daylight-saving change', function () {
    // 1:30 happens twice on 1 November 2026: first in PDT, then in PST.
    expect(localMinute('2026-11-01T08:30:00.000Z')).equals('2026-11-01 01:30')
    expect(localMinute('2026-11-01T09:30:00.000Z')).equals('2026-11-01 01:30')
    expect(localMinute('2026-11-01T10:30:00.000Z')).equals('2026-11-01 02:30')
  })

  it('dates a time by the viewer’s calendar, not by UTC’s', function () {
    // After 4 pm on 14 November here, it is already the 15th in UTC.
    expect(localDate('2026-11-15T01:30:00.000Z')).equals('2026-11-14')
    expect(localDate(null)).equals('')
  })

  it('writes nothing for no time, or one it cannot read', function () {
    expect(localMinute(null)).equals('')
    expect(localMinute(undefined)).equals('')
    expect(localMinute('not a time')).equals('')
  })

  it('refuses a role it does not know', function () {
    const person = {
      userId: 'usr_1',
      displayName: 'Babe Ruth',
      avatarUrl: null,
      emails: [],
      lastActiveAt: null,
      affiliations: [
        { kind: 'team', id: 'tem_1', name: 'Demo', roles: ['captain'] }
      ]
    }
    expect(() => asPersonAdministration(person)).to.throw()
    expect(
      asPersonAdministration({
        ...person,
        affiliations: [{ ...person.affiliations[0], roles: ['admin'] }]
      }).affiliations[0].roles
    ).deep.equals(['admin'])
  })
})
