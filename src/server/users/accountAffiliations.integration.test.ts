import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  type AccountAffiliationGroup,
  type AccountAffiliations,
  asAccountAffiliations
} from '../../common/api'
import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { createSession } from '../auth/sessions'
import { accountAffiliationsOf } from './accountAffiliations'
import type { Reader } from './readerNames'

/**
 * `GET /me/affiliations`: the account screen's list of the leagues, seasons
 * and teams somebody belongs to directly, with how, and the players they
 * guard.
 */
describe('the account’s affiliations', function () {
  this.timeout(60000)
  let f: GroupFixture

  /** Administers League A, and holds nothing of his own under it. */
  const LEAGUE_ADMIN = 104
  /** Coach and assistant of Demo Regular. */
  const SEASON_STAFF = 301
  /** Head coach of Demo Hawks by a role on the team. */
  const HEAD_COACH = 302
  /** Owns Demo Eagles. */
  const OWNER = 303
  /** Plays on Demo Hawks, and only that. */
  const PLAYER = 304
  /** A member of Demo Regular. */
  const SEASON_MEMBER = 305
  /** Follows Demo Eagles, and nothing else. */
  const FOLLOWER = 306
  /** Follows Demo Hawks and is a member of it. */
  const FOLLOWING_MEMBER = 307
  /** Guards PLAYER. */
  const GUARDIAN = 308
  /** Plays on a merged team and an external one, and on nothing else. */
  const GONE = 309
  /** Signs in as MERGED's open row: a member of Demo Playoffs on the old row. */
  const MERGED = 310
  const MERGED_OLD = 311

  let merged = ''
  let external = ''

  before(async () => {
    f = await groupFixture()
    const db = f.h.db
    for (const [id, name, into] of [
      [SEASON_STAFF, 'Sparky Anderson'],
      [HEAD_COACH, 'Tommy Lasorda'],
      [OWNER, 'Walter Alston'],
      [PLAYER, 'Mookie Betts'],
      [SEASON_MEMBER, 'Sam Fuld'],
      [FOLLOWER, 'Frank Francisco'],
      [FOLLOWING_MEMBER, 'Fred Lynn'],
      [GUARDIAN, 'Freddie Freeman'],
      [GONE, 'Gus Gone'],
      [MERGED, 'Mel Ott'],
      [MERGED_OLD, 'Mel Ott', MERGED]
    ] as Array<[number, string, number?]>) {
      const [first, last] = name.split(' ')
      await insertFixtureUsers(db, {
        id,
        legacyId: `usr_affiliations_${id}`,
        display_name: name,
        first_name: first,
        last_name: last,
        login_enabled: into == null,
        merged_into: into == null ? null : userIdOfGumbo(into)
      })
      if (into == null)
        f.h.tokens.set(
          id,
          (await createSession(db, userIdOfGumbo(id), 'affiliations')).token
        )
    }
    const role = async (
      userId: number,
      scopeType: 'league' | 'season' | 'team',
      scopeId: string,
      given: Role,
      headCoach = false
    ): Promise<void> => {
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(userId),
          scope_type: scopeType,
          scope_id: scopeId,
          role: given,
          is_head_coach: headCoach
        })
        .execute()
    }
    const member = async (
      userId: number,
      teamId: string,
      options: { player?: boolean; role?: 'member' | 'manager' | 'owner' } = {}
    ): Promise<void> => {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(userId),
          team_id: teamId,
          role: options.role ?? 'member',
          is_player: options.player === true
        })
        .execute()
    }
    const follow = async (
      userId: number,
      kind: 'league' | 'season' | 'team',
      id: string
    ): Promise<void> => {
      await db
        .insertInto('follows')
        .values({
          user_id: userIdOfGumbo(userId),
          group_type: kind,
          group_id: id
        })
        .execute()
    }

    await role(LEAGUE_ADMIN, 'league', f.leagueA, 'admin')
    await role(SEASON_STAFF, 'season', f.seasonA, 'coach')
    await role(SEASON_STAFF, 'season', f.seasonA, 'assistant')
    await role(HEAD_COACH, 'team', f.teamA, 'coach', true)
    await member(OWNER, f.teamB, { role: 'owner' })
    await member(PLAYER, f.teamA, { player: true })
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userIdOfGumbo(SEASON_MEMBER),
        season_id: f.seasonA
      })
      .execute()
    await follow(FOLLOWER, 'team', f.teamB)
    await member(FOLLOWING_MEMBER, f.teamA)
    await follow(FOLLOWING_MEMBER, 'team', f.teamA)
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(GUARDIAN),
        related_user_id: userIdOfGumbo(PLAYER),
        kind: 'guardian',
        created_at: new Date()
      })
      .execute()

    merged = makeId('team')
    external = makeId('team')
    await db
      .insertInto('teams')
      .values([
        { id: merged, name: 'Demo Gone', merged_into: f.teamA },
        { id: external, name: 'Demo Visitors Abroad', kind: 'external' }
      ])
      .execute()
    await member(GONE, merged, { player: true })
    await member(GONE, external, { player: true })

    // The old row is a member of Demo Playoffs and follows League B.
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userIdOfGumbo(MERGED_OLD),
        season_id: f.playoffs
      })
      .execute()
    await follow(MERGED_OLD, 'league', f.leagueB)
  })
  after(async () => {
    await f?.h.close()
  })

  const read = async (user: number): Promise<AccountAffiliations> => {
    const response = await f.h.request(
      'GET',
      '/me/affiliations',
      undefined,
      user
    )
    expect(response.status).equals(200)
    return asAccountAffiliations(await response.json())
  }
  /** Each group as `[kind, name, ties]`, in the answer's order. */
  const rows = (
    answer: AccountAffiliations
  ): Array<[string, string, Omit<AccountAffiliationGroup, 'group' | 'id'>]> =>
    answer.groups.map(({ group, id: _, ...ties }) => [
      ties.kind,
      group.name,
      ties
    ])
  const ties = (
    kind: AccountAffiliationGroup['kind'],
    held: Partial<AccountAffiliationGroup> = {}
  ): Omit<AccountAffiliationGroup, 'group' | 'id'> => ({
    kind,
    roles: [],
    headCoach: false,
    player: false,
    member: false,
    following: false,
    ...held
  })

  it('lists a league administrator’s league and nothing it carries down', async () => {
    expect(rows(await read(LEAGUE_ADMIN))).deep.equals([
      ['league', 'Demo League A', ties('league', { roles: ['admin'] })]
    ])
  })

  it('lists the creator of a league, its seasons and a team, leagues first', async () => {
    const answer = await read(101)
    expect(answer.groups.map(row => [row.kind, row.group.name])).deep.equals([
      ['league', 'Demo League A'],
      ['season', 'Demo Playoffs'],
      ['season', 'Demo Regular'],
      ['team', 'Demo Hawks'],
      ['team', 'Demo Hawks']
    ])
    expect(answer.groups.every(row => row.roles.includes('admin'))).equals(true)
    expect(answer.groups[0].group).includes({ kind: 'league', external: false })
  })

  it('carries each staff flag and the head coach', async () => {
    expect(rows(await read(SEASON_STAFF))).deep.equals([
      [
        'season',
        'Demo Regular',
        ties('season', { roles: ['coach', 'assistant'] })
      ]
    ])
    expect(rows(await read(HEAD_COACH))).deep.equals([
      [
        'team',
        'Demo Hawks',
        ties('team', { roles: ['coach'], headCoach: true })
      ]
    ])
  })

  it('makes a team’s owner its admin, and a player, a member and a follower so', async () => {
    expect(rows(await read(OWNER))).deep.equals([
      ['team', 'Demo Eagles', ties('team', { roles: ['admin'] })]
    ])
    expect(rows(await read(PLAYER))).deep.equals([
      ['team', 'Demo Hawks', ties('team', { player: true })]
    ])
    expect(rows(await read(SEASON_MEMBER))).deep.equals([
      ['season', 'Demo Regular', ties('season', { member: true })]
    ])
    expect(rows(await read(FOLLOWER))).deep.equals([
      ['team', 'Demo Eagles', ties('team', { following: true })]
    ])
    expect(rows(await read(FOLLOWING_MEMBER))).deep.equals([
      ['team', 'Demo Hawks', ties('team', { member: true, following: true })]
    ])
  })

  it('lists the players somebody guards, with their teams', async () => {
    const answer = await read(GUARDIAN)
    expect(answer.groups).deep.equals([])
    expect(answer.players).deep.equals([
      {
        userId: userIdOfGumbo(PLAYER),
        name: answer.players[0]?.name,
        avatarUrl: null,
        teamNames: ['Demo Hawks']
      }
    ])
    expect(answer.players[0].name).match(/^Mookie B/)
  })

  it('names the guarded players publicly to a machine, which has no reader', async () => {
    const guardian = userIdOfGumbo(GUARDIAN)
    const named = async (reader?: Reader): Promise<string[]> =>
      (
        await accountAffiliationsOf(f.h.db, guardian, f.h.space, reader)
      ).players.map(player => player.name)
    // The guardian reads their child in full; an API token reads the
    // public short name.
    expect(await named({ userId: guardian, isAdmin: false })).deep.equals([
      'Mookie Betts'
    ])
    expect(await named(undefined)).deep.equals(['Mookie B'])
  })

  it('leaves out merged and external teams', async () => {
    expect(await read(GONE)).deep.equals({ groups: [], players: [] })
  })

  it('counts a merged account’s ties, but not a follow left on its old row', async () => {
    expect(rows(await read(MERGED))).deep.equals([
      ['season', 'Demo Playoffs', ties('season', { member: true })]
    ])
  })

  it('answers only somebody signed in', async () => {
    const response = await f.h.request(
      'GET',
      '/me/affiliations',
      undefined,
      null
    )
    expect(response.status).equals(401)
  })
})
