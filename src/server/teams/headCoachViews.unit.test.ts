import { mock } from 'node:test'

import { expect } from 'chai'
import type { CompiledQuery } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import * as identity from '../admin/people'
import { readEventInfo } from '../events/eventInfo'
import * as privacy from '../groups/playerNamePrivacy'
import { groupDetail } from '../groups/publicSummary'
import * as rights from '../groups/rights'
import * as grants from '../invites/grants'
import { personProfile } from './personProfile'
import * as designation from './teamHeadCoach'
import { teamRoster } from './teamRoster'
import { teamStaff } from './teamStaff'

const team = {
  id: 'team',
  name: 'Test Team',
  kind: 'full',
  league_id: null,
  merged_into: null,
  logo_path: null
}
const coach = userIdOfGumbo(17)
const other = userIdOfGumbo(18)
const space = {
  endpoint: '',
  bucket: '',
  region: '',
  secretAccessKey: '',
  accessKeyId: '',
  pathStyle: false
}
const actor = { userId: other, scopes: [], isAdmin: false }
const members = [coach, other].map((id, i) => ({
  id,
  userId: id,
  displayName: i === 0 ? 'Chipper Jones' : 'Josh Donaldson',
  firstName: i === 0 ? 'Chipper' : 'Josh',
  lastName: i === 0 ? 'Jones' : 'Donaldson',
  first_name: i === 0 ? 'Chipper' : 'Josh',
  last_name: i === 0 ? 'Jones' : 'Donaldson',
  display_name: i === 0 ? 'Chipper Jones' : 'Josh Donaldson',
  avatarPath: null,
  avatar_path: null,
  role: 'member',
  isPlayer: false,
  positions: [],
  onboarding_step: 'done'
}))
const levels = new Map(
  members.map(member => [member.id, new Map([['coach', 'team']])])
)
function readPeople({ sql }: CompiledQuery): unknown[] {
  if (sql.includes('from "teams"')) return [team]
  if (sql.includes('from "memberships"') && sql.includes('inner join "users"'))
    return members
  if (sql.includes('from "users"')) return members
  if (sql.includes('from "scope_roles"'))
    return members.map(m => ({
      userId: m.id,
      user_id: m.id,
      role: 'coach',
      is_head_coach: m.id === coach
    }))
  if (sql.includes('with recursive chain'))
    return members.map(m => ({ startId: m.id, survivorId: m.id }))
  if (!/^(select|with)/.test(sql.trimStart()))
    throw new Error('Unexpected write: ' + sql)
  return []
}
describe('team-scoped manager projections', () => {
  beforeEach(() => {
    mock.method(designation, 'teamHeadCoach', async () => ({
      userId: coach,
      grantUserId: coach,
      name: 'Chipper J.'
    }))
    mock.method(access, 'levelsAboveTeam', async () => ({
      seasonIds: [],
      leagueIds: []
    }))
    mock.method(access, 'givenRoleLevelsAt', async () => levels)
    mock.method(access, 'givenRoleLevelsOnTeam', async () => levels)
    mock.method(privacy, 'loadPlayerNamePrivacy', async () => ({
      stored: null,
      format: 'firstLastInitial',
      inheritedFrom: null
    }))
    mock.method(privacy, 'publicFormats', async () => new Map())
    mock.method(identity, 'onePerson', async (_db: unknown, id: string) => ({
      userId: id,
      userIds: [id]
    }))
  })
  afterEach(() => {
    mock.restoreAll()
  })
  it('marks just the designated person in the direct staff feed, signed-in roster and public team', async () => {
    await withQueryReplies(readPeople, async db => {
      const staff = await teamStaff(db, space, team.id)
      expect(
        staff.filter(p => p.isHeadCoach === true).map(p => p.userId)
      ).deep.equals([coach])
      const roster = await teamRoster(db, undefined, team.id)
      expect(
        roster.filter(p => p.isHeadCoach === true).map(p => p.userId)
      ).deep.equals([coach])
      const detail = await groupDetail(db, { kind: 'team', id: team.id }, space)
      expect(
        detail.staff.filter(p => p.isHeadCoach === true).map(p => p.name)
      ).deep.equals(['Chipper J.'])
    })
  })
  it('exposes the incumbent in a manager’s profile section and hides it from an unrelated self-profile', async () => {
    mock.method(rights, 'currentActor', async () => actor)
    mock.method(access, 'teamsUnder', async () => new Set([team.id]))
    mock.method(access, 'mayEditName', async () => true)
    mock.method(access, 'guardedPlayers', async () => [])
    mock.method(access, 'teamsPlayedOnNow', async () => [])
    mock.method(
      privacy,
      'publicNames',
      async () => new Map([[other, 'Josh D.']])
    )
    mock.method(grants, 'heldAt', async () => ({
      roles: ['coach'],
      member: true
    }))
    mock.method(grants, 'groupName', async () => team.name)
    mock.method(rights, 'canAdminister', async () => false)
    let manages = true
    mock.method(rights, 'canManagePeople', async () => manages)
    for (const enabled of [true, false]) {
      manages = enabled
      await withQueryReplies(
        q => (q.sql.includes('from "users"') ? [members[1]] : readPeople(q)),
        async db => {
          const profile = await personProfile(
            db,
            undefined,
            actor,
            { kind: 'team', id: team.id },
            other
          )
          expect(profile.sections[0].headCoach).deep.equals(
            manages ? { userId: coach, name: 'Chipper J.' } : undefined
          )
        }
      )
    }
  })
  it('marks only the selected team’s head coach in event attendance', async () => {
    mock.method(rights, 'currentActor', async () => actor)
    mock.method(access, 'visibleScopes', async () => ({
      isAdmin: false,
      teamIds: new Set([team.id]),
      seasonIds: new Set()
    }))
    mock.method(rights, 'canScheduleFor', async () => false)
    await withQueryReplies(
      q => {
        if (q.sql.includes('from "team_events"'))
          return [
            {
              id: 'event',
              team_id: team.id,
              event_type: 'practice',
              start_at: new Date('2030-01-01'),
              end_at: null
            }
          ]
        return readPeople(q)
      },
      async db => {
        const info = await readEventInfo(db, actor, 'event', {
          space,
          mediaRoot: '',
          ffmpegPath: '',
          mediaSecret: '',
          publicUrl: ''
        })
        expect(
          info.attendees.filter(p => p.isHeadCoach === true).map(p => p.userId)
        ).deep.equals([coach])
        expect(
          info.attendees.find(p => p.userId === other)?.staffRoles
        ).deep.equals(['coach'])
      }
    )
  })
})
