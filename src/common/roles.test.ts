import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asRoleFlags,
  asRoles,
  coachesTeam,
  IMPLIED_ROLES,
  impliedRoles,
  keepsSongs,
  managesRoster,
  ROLE_FLAGS,
  ROLES
} from './roles'

describe('role flags', function () {
  it('accepts the five flags, each once, in their own order', function () {
    expect(asRoleFlags(['videographer', 'coach'])).deep.equals([
      'coach',
      'videographer'
    ])
    expect(asRoleFlags([...ROLE_FLAGS].reverse())).deep.equals([...ROLE_FLAGS])
    expect(asRoleFlags(['scorekeeper', 'assistant'])).deep.equals([
      'assistant',
      'scorekeeper'
    ])
    expect(asRoleFlags(['songkeeper', 'songkeeper'])).deep.equals([
      'songkeeper'
    ])
    expect(asRoleFlags([])).deep.equals([])
  })

  it('refuses admin, an unknown name and anything that is not a list', function () {
    expect(() => asRoleFlags(['admin'])).throws(TypeError)
    expect(() => asRoleFlags(['umpire'])).throws(TypeError)
    expect(() => asRoleFlags('coach')).throws(TypeError)
  })

  it('lists roles administrator first', function () {
    expect(ROLES[0]).equals('admin')
    expect(asRoles(['scorekeeper', 'admin', 'admin'])).deep.equals([
      'admin',
      'scorekeeper'
    ])
    expect(() => asRoles(['member'])).throws(TypeError)
  })
})

describe('coaching a team, from GET /me/roles', function () {
  const roles = {
    teams: {
      tem_coach: ['coach' as const],
      tem_assistant: ['assistant' as const],
      tem_admin: ['admin' as const, 'coach' as const],
      tem_scorer: ['scorekeeper' as const]
    }
  }

  it('is a coach or assistant of it or its admin', function () {
    expect(coachesTeam(roles, 'tem_coach')).equals(true)
    expect(coachesTeam(roles, 'tem_assistant')).equals(true)
    expect(coachesTeam(roles, 'tem_admin')).equals(true)
    expect(coachesTeam({ teams: { tem_1: ['admin'] } }, 'tem_1')).equals(true)
  })

  it('is nobody else, and nothing before the roles are known', function () {
    expect(coachesTeam(roles, 'tem_scorer')).equals(false)
    expect(coachesTeam(roles, 'tem_other')).equals(false)
    expect(coachesTeam(roles, undefined)).equals(false)
    expect(coachesTeam(undefined, 'tem_coach')).equals(false)
  })
})

describe('managing a team’s roster, from GET /me/roles', function () {
  const roles = {
    teams: {
      tem_coach: ['coach' as const],
      tem_assistant: ['assistant' as const],
      tem_scorer: ['scorekeeper' as const],
      tem_admin: ['admin' as const],
      tem_songs: ['songkeeper' as const, 'videographer' as const]
    }
  }

  it('is a coach, assistant or scorekeeper of it or its admin', function () {
    for (const team of [
      'tem_coach',
      'tem_assistant',
      'tem_scorer',
      'tem_admin'
    ])
      expect(managesRoster(roles, team), team).equals(true)
  })

  it('is nobody else, and nothing before the roles are known', function () {
    expect(managesRoster(roles, 'tem_songs')).equals(false)
    expect(managesRoster(roles, 'tem_other')).equals(false)
    expect(managesRoster(roles, undefined)).equals(false)
    expect(managesRoster(undefined, 'tem_coach')).equals(false)
  })
})

describe('keeping a team’s walk-up songs, from GET /me/roles', function () {
  const roles = {
    teams: {
      tem_songs: ['songkeeper' as const],
      tem_admin: ['admin' as const],
      tem_scorer: ['scorekeeper' as const],
      tem_coach: ['coach' as const, 'assistant' as const]
    }
  }

  it('is a songkeeper or scorekeeper of it or its admin', function () {
    expect(keepsSongs(roles, 'tem_songs')).equals(true)
    expect(keepsSongs(roles, 'tem_scorer')).equals(true)
    expect(keepsSongs(roles, 'tem_admin')).equals(true)
  })

  it('is nobody else, and nothing before the roles are known', function () {
    expect(keepsSongs(roles, 'tem_coach')).equals(false)
    expect(keepsSongs(roles, 'tem_other')).equals(false)
    expect(keepsSongs(roles, undefined)).equals(false)
    expect(keepsSongs(undefined, 'tem_songs')).equals(false)
  })
})

/**
 * What a role brings with it at its own level, the one table `roleScopes`
 * widens by and a person's profile reads its "With Admin" rows from.
 */
describe('the roles a role brings with it', function () {
  it('gives an administrator every flag and a scorekeeper Songkeeper, nothing else', function () {
    expect(IMPLIED_ROLES.admin).deep.equals(ROLE_FLAGS)
    expect(IMPLIED_ROLES.scorekeeper).deep.equals(['songkeeper'])
    for (const flag of [
      'coach',
      'assistant',
      'songkeeper',
      'videographer'
    ] as const)
      expect(IMPLIED_ROLES[flag], flag).deep.equals([])
  })

  it('names the first role in order that brings each, whether or not it was given too', function () {
    expect([...impliedRoles([])]).deep.equals([])
    expect([...impliedRoles(['coach', 'songkeeper'])]).deep.equals([])
    expect([...impliedRoles(['scorekeeper', 'songkeeper'])]).deep.equals([
      ['songkeeper', 'scorekeeper']
    ])
    expect([...impliedRoles(['admin', 'scorekeeper'])]).deep.equals(
      ROLE_FLAGS.map(flag => [flag, 'admin'])
    )
  })
})
