import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  audienceOf,
  eligibleSurvivors,
  isEligible,
  isUnder13,
  type ScopeKind,
  scopeTypeOf
} from './audiences'
import { type ChatFixture, openChatFixture } from './chatTestFixture'
import { seasonTitle, titlesOf } from './titles'

/**
 * U5, the seven audiences and their titles, on the chat fixture: QPLL (L),
 * Spring 2027 (S, K), Hawks (Ha, Hc, Hk, Hs; players P 15, R 12, T 12, Q
 * without an account; parents A, B, C, N; guardians G1, G2 of P; fan F) and
 * Eagles (Ea, Ec, Ek, Es; player E 16, who follows Hawks; parents D, D2).
 * Today is 10 April 2027.
 */

describe('chat audiences (U5)', function () {
  this.timeout(120000)
  let fixture: ChatFixture

  before(async function () {
    const opened = await openChatFixture('audiences', { reconcile: false })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    const db = fixture.db
    const { seasonId, leagueId, teams } = fixture.seed
    // A videographer-only team role, a season member and a league member.
    const v = await fixture.person('V')
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: v,
        scope_type: 'team',
        scope_id: teams.hawks,
        role: 'videographer'
      })
      .execute()
    const sm = await fixture.person('SM')
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: sm,
        season_id: seasonId
      })
      .execute()
    const lm = await fixture.person('LM')
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: lm,
        league_id: leagueId
      })
      .execute()
    // A closed row of parent A, still on Owls, answers as A.
    const old = await fixture.person('Aold')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: old,
        team_id: teams.owls,
        role: 'member'
      })
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: fixture.id('A') })
      .where('id', '=', old)
      .execute()
  })

  after(async function () {
    await fixture?.close()
  })

  it('excludes explicitly disabled accounts without removing their existing membership', async () => {
    const id = fixture.id('Hk')
    await fixture.db
      .updateTable('users')
      .set({ disabled_at: fixture.now })
      .where('id', '=', id)
      .execute()
    try {
      expect(await isEligible(fixture.db, id, fixture.now)).equals(false)
      expect([
        ...(await eligibleSurvivors(fixture.db, [id], fixture.now))
      ]).deep.equals([])
      expect(
        await audience('teamStaff', fixture.seed.teams.hawks)
      ).not.includes('Hk')
    } finally {
      await fixture.db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', id)
        .execute()
    }
    expect(await isEligible(fixture.db, id, fixture.now)).equals(true)
  })

  it('includes the master assistant role in direct team staff', async () => {
    const id = fixture.id('Hk')
    const roleId = makeId('scopeRole')
    await fixture.db
      .insertInto('scope_roles')
      .values({
        id: roleId,
        user_id: id,
        scope_type: 'team',
        scope_id: fixture.seed.teams.owls,
        role: 'assistant'
      })
      .execute()
    try {
      expect(await audience('teamStaff', fixture.seed.teams.owls)).includes(
        'Hk'
      )
    } finally {
      await fixture.db
        .deleteFrom('scope_roles')
        .where('id', '=', roleId)
        .execute()
    }
  })

  async function audience(kind: ScopeKind, scopeId: string): Promise<string[]> {
    const ids = await audienceOf(fixture.db, kind, scopeId, fixture.now)
    return [...ids].map(id => fixture.keyOf(id)).sort()
  }

  const sorted = (keys: string[]): string[] => [...keys].sort()
  const hawksStaff = ['Ha', 'Hc', 'Hk', 'Hs']
  const eaglesStaff = ['Ea', 'Ec', 'Ek', 'Es']

  it('teamStaff: direct staff and the owner, never a videographer-only role', async function () {
    expect(await audience('teamStaff', fixture.seed.teams.hawks)).deep.equals(
      sorted(hawksStaff)
    )
  })

  it('teamMembers: staff, players with accounts 13 and over, plain members and guardians', async function () {
    expect(await audience('teamMembers', fixture.seed.teams.hawks)).deep.equals(
      sorted([...hawksStaff, 'P', 'A', 'B', 'C', 'N', 'G1', 'G2'])
    )
  })

  it('teamFans: followers who are no team’s player, and staff', async function () {
    expect(await audience('teamFans', fixture.seed.teams.hawks)).deep.equals(
      sorted([...hawksStaff, 'F'])
    )
    expect(await audience('teamFans', fixture.seed.teams.eagles)).deep.equals(
      sorted(eaglesStaff)
    )
  })

  it('a guardian is in Members by the link alone, without a membership', async function () {
    const g3 = await fixture.person('G3')
    await fixture.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: g3,
        related_user_id: fixture.id('Q'),
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    const keys = await audience('teamMembers', fixture.seed.teams.hawks)
    expect(keys).includes('G3')
    await fixture.db
      .deleteFrom('user_links')
      .where('user_id', '=', g3)
      .execute()
  })

  it('a guardian linked to a row since closed into the player is in Members', async function () {
    const g4 = await fixture.person('G4')
    // P's placeholder from a roster import, linked before it was merged into
    // P: the link stays on the row it was made for.
    const placeholder = await fixture.person('Pold')
    await fixture.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: g4,
        related_user_id: placeholder,
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    await fixture.db
      .updateTable('users')
      .set({ merged_into: fixture.id('P') })
      .where('id', '=', placeholder)
      .execute()
    const keys = await audience('teamMembers', fixture.seed.teams.hawks)
    expect(keys).includes('G4')
    await fixture.db
      .deleteFrom('user_links')
      .where('user_id', '=', g4)
      .execute()
  })

  it('a merged row answers as its survivor', async function () {
    expect(await audience('teamMembers', fixture.seed.teams.owls)).deep.equals([
      'A'
    ])
  })

  it('seasonStaff: season roles and league roles', async function () {
    expect(await audience('seasonStaff', fixture.seed.seasonId)).deep.equals([
      'K',
      'L',
      'S'
    ])
  })

  it('seasonAllStaff: season staff and every full team’s staff', async function () {
    expect(await audience('seasonAllStaff', fixture.seed.seasonId)).deep.equals(
      sorted(['K', 'L', 'S', ...hawksStaff, ...eaglesStaff])
    )
  })

  it('seasonAnnouncements: All Staff, Members, season and league members, never a fan', async function () {
    const keys = await audience('seasonAnnouncements', fixture.seed.seasonId)
    expect(keys).deep.equals(
      sorted([
        'K',
        'L',
        'S',
        ...hawksStaff,
        ...eaglesStaff,
        'P',
        'A',
        'B',
        'C',
        'N',
        'G1',
        'G2',
        'E',
        'D',
        'D2',
        'SM',
        'LM'
      ])
    )
    expect(keys).not.includes('F')
  })

  it('leagueOrg: direct league roles only', async function () {
    expect(await audience('leagueOrg', fixture.seed.leagueId)).deep.equals([
      'L'
    ])
  })

  it('a league admin is in Org and Season Staff but not Hawks Staff', async function () {
    expect(await audience('teamStaff', fixture.seed.teams.hawks)).not.includes(
      'L'
    )
  })

  it('a player without an account, and players under 13, are in nothing', async function () {
    for (const kind of [
      'teamStaff',
      'teamMembers',
      'teamFans'
    ] as ScopeKind[]) {
      const keys = await audience(kind, fixture.seed.teams.hawks)
      for (const key of ['Q', 'R', 'T']) expect(keys).not.includes(key)
    }
    const keys = await audience('seasonAnnouncements', fixture.seed.seasonId)
    for (const key of ['Q', 'R', 'T', 'V']) expect(keys).not.includes(key)
  })

  it('a merged or external team has no audience', async function () {
    const db = fixture.db
    const external = makeId('team')
    await db
      .insertInto('teams')
      .values({ id: external, name: 'Visitors', kind: 'external' })
      .execute()
    expect(await audience('teamStaff', external)).deep.equals([])
    expect(await audience('teamFans', external)).deep.equals([])
  })

  it('reads ages from birth months', function () {
    const now = new Date('2027-04-10T00:00:00Z')
    expect(isUnder13(null, null, now)).equals(false)
    expect(isUnder13(2014, 4, now)).equals(true)
    expect(isUnder13(2014, 3, now)).equals(false)
    expect(scopeTypeOf('seasonAllStaff')).equals('season')
    expect(scopeTypeOf('leagueOrg')).equals('league')
    expect(scopeTypeOf('teamFans')).equals('team')
  })

  it('titles scope chats from their scope names, with and without a league', async function () {
    const db = fixture.db
    const loose = makeId('season')
    await db
      .insertInto('seasons')
      .values({ id: loose, name: 'Fall Ball', year: 2027 })
      .execute()
    const titles = await titlesOf(db, [
      {
        id: 'a',
        kind: 'teamStaff',
        scopeType: 'team',
        scopeId: fixture.seed.teams.hawks
      },
      {
        id: 'b',
        kind: 'teamMembers',
        scopeType: 'team',
        scopeId: fixture.seed.teams.hawks
      },
      {
        id: 'c',
        kind: 'teamFans',
        scopeType: 'team',
        scopeId: fixture.seed.teams.hawks
      },
      {
        id: 'd',
        kind: 'seasonStaff',
        scopeType: 'season',
        scopeId: fixture.seed.seasonId
      },
      {
        id: 'e',
        kind: 'seasonAllStaff',
        scopeType: 'season',
        scopeId: fixture.seed.seasonId
      },
      {
        id: 'f',
        kind: 'seasonAnnouncements',
        scopeType: 'season',
        scopeId: fixture.seed.seasonId
      },
      {
        id: 'g',
        kind: 'leagueOrg',
        scopeType: 'league',
        scopeId: fixture.seed.leagueId
      },
      { id: 'h', kind: 'seasonStaff', scopeType: 'season', scopeId: loose },
      { id: 'i', kind: 'dm', scopeType: null, scopeId: null },
      { id: 'j', kind: 'teamStaff', scopeType: 'team', scopeId: 'tem_gone' }
    ])
    expect(Object.fromEntries(titles)).deep.equals({
      a: 'Hawks Staff',
      b: 'Hawks Members',
      c: 'Hawks Fans',
      d: 'QPLL Spring 2027 Staff',
      e: 'QPLL Spring 2027 All Staff',
      f: 'QPLL Spring 2027 Announcements',
      g: 'QPLL Org',
      h: 'Fall Ball Staff',
      i: null,
      j: 'Chat Staff'
    })
    expect(seasonTitle('Spring', null)).equals('Spring')
  })
})
