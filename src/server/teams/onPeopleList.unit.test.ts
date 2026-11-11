import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GroupRef } from '../../common/groupCreation'
import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import * as grants from '../invites/grants'
import * as adds from '../openAdds'
import { onPeopleList } from './teamRoster'

const team: GroupRef = { kind: 'team', id: 'team' }
const season: GroupRef = { kind: 'season', id: 'season' }
const league: GroupRef = { kind: 'league', id: 'league' }
const viewer = { userId: 'reader', isAdmin: false }
describe('single-person roster eligibility', () => {
  let memberAt: (ref: GroupRef) => { member: boolean; roles: string[] }
  let playing: (ids: string[]) => string[]
  let children: string[]
  let heldTeams: string[]
  beforeEach(() => {
    memberAt = () => ({ member: false, roles: [] })
    playing = () => []
    children = []
    heldTeams = []
    mock.method(adds, 'openAddTeams', async () => heldTeams)
    mock.method(access, 'levelsAboveTeam', async (_db: unknown, id: string) =>
      id === 'team'
        ? { seasonIds: ['season'], leagueIds: ['league'] }
        : { seasonIds: [], leagueIds: [] }
    )
    mock.method(access, 'guardedPlayers', async () => children)
    mock.method(
      access,
      'teamsPlayedOnNow',
      async (_db: unknown, ids: string[]) => playing(ids)
    )
    mock.method(grants, 'heldAt', async (_db: unknown, ref: GroupRef) =>
      memberAt(ref)
    )
  })
  afterEach(() => {
    mock.restoreAll()
  })

  it('distinguishes missing levels and people from disabled team members', async () => {
    await withQueryReplies([['from "users"', []]], async db => {
      expect(await onPeopleList(db, team, 'missing')).equals(false)
    })
    for (const ref of [team, season, league]) {
      await withQueryReplies(
        [
          ['from "users"', [{ disabled_at: null }]],
          ['from', []]
        ],
        async db => {
          expect(await onPeopleList(db, ref, 'subject')).equals(false)
        }
      )
    }
    const active = { disabled_at: new Date() }
    memberAt = ref => ({
      member: ref.kind === 'team',
      roles: []
    })
    await withQueryReplies(
      [
        ['from "users"', [active]],
        ['from "teams"', [team]]
      ],
      async db => {
        expect(await onPeopleList(db, team, 'subject')).equals(true)
      }
    )
    await withQueryReplies(
      [
        ['from "users"', [active]],
        ['from "leagues"', [league]]
      ],
      async db => {
        expect(await onPeopleList(db, league, 'subject')).equals(false)
      }
    )
  })
  it('recognizes inherited league roles and players in a season’s teams', async () => {
    memberAt = ref => ({
      member: false,
      roles: ref.kind === 'league' ? ['coach'] : []
    })
    await withQueryReplies(
      [
        ['from "users"', [{ disabled_at: null }]],
        ['from "seasons"', [{ league_id: 'league' }]]
      ],
      async db => {
        expect(await onPeopleList(db, season, 'subject')).equals(true)
      }
    )
    playing = () => ['unrelated', 'team']
    await withQueryReplies(
      [
        ['from "users"', [{ disabled_at: null }]],
        ['from "seasons"', [{ league_id: null }]]
      ],
      async db => {
        expect(await onPeopleList(db, season, 'player')).equals(true)
      }
    )
  })
  it('checks follows only for the person requested, including a team’s merged aliases', async () => {
    for (const ref of [team, league]) {
      await withQueryReplies(
        [
          ['from "users"', [{ disabled_at: null }]],
          ['from', [ref]],
          [
            'follows',
            [{ user_id: 'subject' }],
            query => expect(query.parameters).includes('subject')
          ]
        ],
        async db => {
          expect(await onPeopleList(db, ref, 'subject')).equals(true)
        }
      )
    }
  })
  it('shows a held child’s guardian only on the team and only when the viewer may read that child', async () => {
    children = ['child']
    playing = ids => (ids.includes('child') ? ['unrelated', 'team'] : [])
    heldTeams = ['team']
    mock.method(access, 'mayViewFullName', async () => true)
    for (const ref of [team, league]) {
      await withQueryReplies(
        [
          ['from "users"', [{ disabled_at: null }]],
          ['from', [ref]],
          ['follows', []]
        ],
        async db => {
          expect(await onPeopleList(db, ref, 'guardian', viewer)).equals(
            ref.kind === 'team'
          )
        }
      )
    }
    heldTeams = []
    await withQueryReplies(
      [
        ['from "users"', [{ disabled_at: null }]],
        ['from "leagues"', [league]],
        ['follows', []]
      ],
      async db => {
        expect(await onPeopleList(db, league, 'guardian')).equals(true)
      }
    )
  })
})
