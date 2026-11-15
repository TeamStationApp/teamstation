import { expect } from 'chai'
import { describe, it } from 'mocha'

import { affiliationRoles } from './userDirectory'

describe('affiliation roles', function () {
  it('lists each role once, administrator first and following last', function () {
    expect(
      affiliationRoles([
        { following: true },
        { role: 'videographer' },
        { membership: 'member', player: true },
        { role: 'coach', headCoach: true },
        { role: 'admin' },
        { role: 'scorekeeper' },
        { member: true }
      ])
    ).deep.equals([
      'admin',
      'head coach',
      'coach',
      'scorekeeper',
      'videographer',
      'player',
      'member',
      'following'
    ])
  })

  it('reads a team’s owner or manager as its administrator', function () {
    expect(affiliationRoles([{ membership: 'owner' }])).deep.equals(['admin'])
    expect(
      affiliationRoles([{ membership: 'manager' }, { role: 'admin' }])
    ).deep.equals(['admin'])
    expect(
      affiliationRoles([{ role: 'assistant' }, { role: 'songkeeper' }])
    ).deep.equals(['assistant', 'songkeeper'])
    expect(affiliationRoles([])).deep.equals([])
  })
})
