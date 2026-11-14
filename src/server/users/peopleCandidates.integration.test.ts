import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import * as access from '../access'
import { mayEditName, mayEditNames } from '../access'
import { onePerson } from '../admin/people'
import {
  FULL_NAME_ASKED,
  FULL_NAME_BATCH,
  peopleCandidates,
  peopleQueryOf
} from './peopleCandidates'

describe('account selection privacy and grants', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const id = userIdOfGumbo
  const query = (group: string, q: string): string =>
    `/users?forGroupKind=team&forGroupId=${group}&q=${encodeURIComponent(q)}`
  async function search(
    q: string,
    user = 101,
    extra = '',
    details = false
  ): Promise<any[]> {
    const response = await f.h.request(
      'GET',
      query(f.teamA, q) + extra,
      undefined,
      user
    )
    expect(response.status, await response.clone().text()).equals(200)
    const rows = (await response.json()) as any[]
    return details
      ? rows
      : rows.map(({ userId, displayName }) => ({ userId, displayName }))
  }
  async function add(
    body: Record<string, unknown>,
    user = 101
  ): Promise<Response> {
    return await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      { idempotencyKey: 'account-selection-fixture', ...body },
      user
    )
  }
  /** Makes the searcher a plain member of team B, so they see its players. */
  async function seeTeamB(): Promise<void> {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: id(101),
        role: 'member',
        is_player: false
      })
      .execute()
  }
  it('ranks only visible names, caps at five and excludes unavailable and selected accounts', async () => {
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 8 }, (_, n) => ({
        id: 200 + n,
        display_name: `Mookie Betts ${n}`,
        first_name: n === 0 ? 'Some Mookie' : 'Mookie',
        last_name: `Betts ${n}`,
        login_enabled: true
      }))
    )
    await insertFixtureUsers(f.h.db, {
      id: 220,
      display_name: 'Mookie Placeholder',
      login_enabled: false
    })
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', id(201))
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id(202) })
      .where('id', '=', id(203))
      .execute()
    const rows = await search('mOoKiE')
    expect(rows).length(5)
    expect(rows.every(row => row.displayName === 'Mookie B')).equals(true)
    expect(rows.flatMap(row => Object.keys(row))).not.includes('email')
    expect(rows.map(row => row.userId))
      .not.includes(id(201))
      .and.not.includes(id(203))
      .and.not.includes(id(220))
    expect(await search('Betts')).deep.equals([])
    expect(await search('mookie')).deep.equals(rows)
    const next = await search('mookie', 101, `&exclude=${rows[0].userId}`)
    expect(next.map(row => row.userId)).not.includes(rows[0].userId)
    expect(next.at(-1)?.displayName).equals('Some Mookie B')
    expect(await search('')).deep.equals([])
    expect(await search('   ')).deep.equals([])
    expect(await search('no such name')).deep.equals([])
  })
  it('uses per-person name rights independently of destination administration', async () => {
    expect(await search('Ruth')).deep.equals([
      { userId: id(101), displayName: 'Babe Ruth' }
    ])
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: id(101),
        role: 'member',
        is_player: true
      })
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: id(106),
        role: 'member',
        is_player: true
      })
      .execute()
    for (const role of [
      'coach',
      'assistant',
      'scorekeeper',
      'admin',
      'songkeeper',
      'videographer'
    ] as const) {
      const grant = makeId('scopeRole')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: grant,
          user_id: id(101),
          scope_type: 'team',
          scope_id: f.teamB,
          role,
          granted_by: id(102)
        })
        .execute()
      const full = ['coach', 'assistant', 'scorekeeper', 'admin'].includes(role)
      expect(await search('Raines'), role).deep.equals(
        full ? [{ userId: id(106), displayName: 'Tim Raines' }] : []
      )
      expect(await search('Tim')).deep.equals([
        { userId: id(106), displayName: full ? 'Tim Raines' : 'Tim R' }
      ])
      await f.h.db.deleteFrom('scope_roles').where('id', '=', grant).execute()
    }
    for (const kind of ['guardian', 'family'] as const) {
      const link = makeId('userLink')
      await f.h.db
        .insertInto('user_links')
        .values({ id: link, user_id: id(101), related_user_id: id(106), kind })
        .execute()
      expect(await search('Raines')).deep.equals([
        { userId: id(106), displayName: 'Tim Raines' }
      ])
      await f.h.db.deleteFrom('user_links').where('id', '=', link).execute()
    }
    expect(await search('Raines')).deep.equals([])
    expect(await search('Raines', 105)).deep.equals([
      { userId: id(106), displayName: 'Tim Raines' }
    ])
    for (const scope of [
      { kind: 'season', id: f.seasonB },
      { kind: 'league', id: f.leagueB }
    ] as const) {
      const grant = makeId('scopeRole')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: grant,
          user_id: id(101),
          scope_type: scope.kind,
          scope_id: scope.id,
          role: 'coach',
          granted_by: id(102)
        })
        .execute()
      expect(await search('Raines')).deep.equals([
        { userId: id(106), displayName: 'Tim Raines' }
      ])
      await f.h.db.deleteFrom('scope_roles').where('id', '=', grant).execute()
    }
  })
  it('includes team and privacy-formatted guardian affiliations through merged accounts', async () => {
    await insertFixtureUsers(f.h.db, [
      { id: 501, display_name: 'Mookie Betts', login_enabled: true },
      { id: 502, display_name: 'Mookie Betts', login_enabled: true }
    ])
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id(501) })
      .where('id', '=', id(502))
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: id(502),
        related_user_id: id(106),
        kind: 'guardian'
      })
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: id(106),
        role: 'member',
        is_player: true
      })
      .execute()
    // The searcher sees neither Tim nor his team: nothing is listed.
    expect(
      (await search('Mookie', 101, '', true)).map(row => row.affiliations)
    ).deep.equals([''])
    expect(
      (await search('Tim', 101, '', true)).map(row => row.affiliations)
    ).deep.equals([''])
    await seeTeamB()
    const parent = await search('Mookie', 101, '', true)
    expect(parent).length(1)
    expect(parent[0].avatarUrl).equals(null)
    expect(parent[0].affiliations).equals('Guardian of Tim R · Demo Eagles')
    expect(parent[0]).not.have.property('publicName')
    const child = await search('Tim', 101, '', true)
    expect(child[0].affiliations).equals('Guardians: Mookie B · Demo Eagles')
    expect(JSON.stringify(parent)).not.contains('Raines')
  })
  it('returns a signed avatar URL when media is configured', async () => {
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'avatars/fixture' })
      .where('id', '=', id(101))
      .execute()
    const rows = await peopleCandidates(
      f.h.db,
      actor(101),
      peopleQueryOf({ forGroupKind: 'team', forGroupId: f.teamA, q: 'Ruth' }),
      {
        endpoint: 'https://media.example.test',
        region: 'test',
        bucket: 'fixture',
        accessKeyId: 'fixture-key',
        secretAccessKey: 'fixture-secret',
        pathStyle: true
      }
    )
    expect(rows).length(1)
    const photo = new URL(rows[0].avatarUrl!)
    expect(photo.hostname).equals('media.example.test')
    expect(photo.pathname).contains('avatars/fixture')
    expect(photo.searchParams.has('X-Amz-Signature')).equals(true)
  })
  it('applies related-player privacy across merged aliases without an empty-alias default', async () => {
    await insertFixtureUsers(f.h.db, {
      id: 503,
      display_name: 'Tim Raines',
      first_name: 'Tim',
      last_name: 'Raines'
    })
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id(106) })
      .where('id', '=', id(503))
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', id(106))
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: id(503),
        role: 'member',
        is_player: true
      })
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: id(103),
        related_user_id: id(503),
        kind: 'guardian'
      })
      .execute()
    await seeTeamB()
    for (const [format, name] of [
      ['initials', 'T R'],
      ['full', 'Tim Raines']
    ] as const) {
      await f.h.db
        .updateTable('teams')
        .set({ player_name_privacy: format })
        .where('id', '=', f.teamB)
        .execute()
      const rows = await search('Mike', 101, '', true)
      expect(rows[0].affiliations).equals(`Guardian of ${name} · Demo Eagles`)
    }
  })
  it('shares authorization reads across broad searches without matching hidden surnames', async () => {
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 1000 }, (_, n) => ({
        id: 1000 + n,
        display_name: `Alex${n} Smith`,
        first_name: `Alex${n}`,
        last_name: 'Smith',
        login_enabled: true
      }))
    )
    let queries = 0
    const db = f.h.db.withPlugin({
      transformQuery(args) {
        queries++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    // The same reads for a thousand matches as for one: name authority
    // (`mayViewFullNames`) is asked once for the list.
    const counts: number[] = []
    for (const q of ['Alex', 'Smith', 'Alex999']) {
      queries = 0
      const rows = await peopleCandidates(db, actor(101), {
        group: { kind: 'team', id: f.teamA },
        q: q.toLowerCase(),
        exclude: []
      })
      expect(rows).length(q === 'Smith' ? 0 : q === 'Alex' ? 5 : 1)
      // The searcher's scopes and the five lines' affiliations are read once
      // each, however many names matched.
      expect(queries).lessThan(120)
      counts.push(queries)
    }
    expect(counts[0]).equals(counts[2])
  })
  it('asks name authority only about matches within the reader’s reach when one letter matches hundreds', async () => {
    // Found by the short name: Zack… G. Found by the full name alone: Ichiro…
    // Suzuki, whose short name, Ichiro… S, holds no z. Neither is on a level
    // of the searcher's.
    await insertFixtureUsers(f.h.db, [
      ...Array.from({ length: 150 }, (_, n) => ({
        id: 3000 + n,
        display_name: `Zack${n} Greinke`,
        first_name: `Zack${n}`,
        last_name: 'Greinke',
        login_enabled: true
      })),
      ...Array.from({ length: 150 }, (_, n) => ({
        id: 3200 + n,
        display_name: `Ichiro${n} Suzuki`,
        first_name: `Ichiro${n}`,
        last_name: 'Suzuki',
        login_enabled: true
      }))
    ])
    const asked: string[][] = []
    // The module's exports, which the search reads its name authority from.
    const exported: { mayViewFullNames: typeof access.mayViewFullNames } =
      access
    const real = access.mayViewFullNames
    const spy: typeof real = async (db, reader, userIds, about, known) => {
      asked.push([...userIds])
      return await real(db, reader, userIds, about, known)
    }
    exported.mayViewFullNames = spy
    try {
      const rows = await peopleCandidates(f.h.db, actor(101), {
        group: { kind: 'team', id: f.teamA },
        q: 'z',
        exclude: []
      })
      expect(rows).length(5)
      expect(rows.every(row => row.displayName.startsWith('Zack'))).equals(true)
      // Asked once, about nobody of the three hundred.
      expect(asked.length).at.most(1)
      const strangers = new Set(
        Array.from({ length: 150 }, (_, n) => [
          userIdOfGumbo(3000 + n),
          userIdOfGumbo(3200 + n)
        ]).flat()
      )
      expect(asked.flat().filter(each => strangers.has(each))).deep.equals([])
    } finally {
      exported.mayViewFullNames = real
    }
  })
  it('asks name authority about a bounded number of a site admin’s matches when one letter matches hundreds', async () => {
    // A site admin reaches everybody: 300 accounts hold a z in full.
    await insertFixtureUsers(f.h.db, [
      ...Array.from({ length: 150 }, (_, n) => ({
        id: 3000 + n,
        display_name: `Zack${n} Greinke`,
        first_name: `Zack${n}`,
        last_name: 'Greinke',
        login_enabled: true
      })),
      ...Array.from({ length: 150 }, (_, n) => ({
        id: 3200 + n,
        display_name: `Ichiro${n} Suzuki`,
        first_name: `Ichiro${n}`,
        last_name: 'Suzuki',
        login_enabled: true
      }))
    ])
    const asked: string[][] = []
    const exported: { mayViewFullNames: typeof access.mayViewFullNames } =
      access
    const real = access.mayViewFullNames
    let readsNobody = false
    const spy: typeof real = async (db, reader, userIds, about, known) => {
      asked.push([...userIds])
      return readsNobody
        ? new Set<string>()
        : await real(db, reader, userIds, about, known)
    }
    exported.mayViewFullNames = spy
    const admin = async (q: string): ReturnType<typeof peopleCandidates> =>
      await peopleCandidates(f.h.db, actor(105), {
        group: { kind: 'team', id: f.teamA },
        q,
        exclude: []
      })
    try {
      // The first twenty, best first, fill the five.
      const rows = await admin('z')
      expect(rows.map(row => row.displayName)).deep.equals(
        [0, 1, 10, 100, 101].map(n => `Zack${n} Greinke`)
      )
      expect(asked.map(batch => batch.length)).deep.equals([FULL_NAME_BATCH])
      // Read in full by nobody, each batch keeps none: the asking stops at
      // its bound, and the short names that hold no z are not listed.
      asked.length = 0
      readsNobody = true
      expect(await admin('suzuki')).deep.equals([])
      expect(asked.flat()).length(FULL_NAME_ASKED)
      expect(asked.every(batch => batch.length <= FULL_NAME_BATCH)).equals(true)
    } finally {
      exported.mayViewFullNames = real
    }
  })

  it('finds a member read in full by his surname however many accounts site-wide sort ahead of him', async () => {
    // Sixty Dennis… Martinez accounts on no level of the searcher's, read
    // short and so matched by no surname, all sort ahead of Edgar Martinez,
    // a member of the team its administrator manages.
    await insertFixtureUsers(f.h.db, [
      ...Array.from({ length: 60 }, (_, n) => ({
        id: 3400 + n,
        display_name: `Dennis${n} Martinez`,
        first_name: `Dennis${n}`,
        last_name: 'Martinez',
        login_enabled: true
      })),
      {
        id: 3480,
        display_name: 'Edgar Martinez',
        first_name: 'Edgar',
        last_name: 'Martinez',
        login_enabled: true
      }
    ])
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamA,
        user_id: id(3480),
        role: 'member',
        is_player: false
      })
      .execute()
    expect(await search('martinez')).deep.equals([
      { userId: id(3480), displayName: 'Edgar Martinez' }
    ])
    // A short substring of the surname finds him too, past every Dennis.
    expect(await search('tine')).deep.equals([
      { userId: id(3480), displayName: 'Edgar Martinez' }
    ])
  })
  it('keeps batch and individual name authority equal across merged guardian identities', async () => {
    await insertFixtureUsers(f.h.db, [
      { id: 210, display_name: 'Demo Parent', login_enabled: false },
      { id: 211, display_name: 'Demo Child', login_enabled: false }
    ])
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id(101) })
      .where('id', '=', id(210))
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id(106) })
      .where('id', '=', id(211))
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: id(210),
        related_user_id: id(211),
        kind: 'guardian'
      })
      .execute()
    const ids = [id(101), id(106), id(104)]
    const known = await onePerson(f.h.db, id(106))
    const batch = await mayEditNames(
      f.h.db,
      id(101),
      ids,
      actor(101),
      new Map([[id(106), known]])
    )
    expect([...batch].sort()).deep.equals([id(101), id(106)].sort())
    expect(await search('Raines')).deep.equals([
      { userId: id(106), displayName: 'Tim Raines' }
    ])
    expect(
      await mayEditName(f.h.db, id(101), id(106), actor(101), { player: known })
    ).equals(true)
    expect(
      await mayEditName(f.h.db, id(101), id(104), actor(101), { player: known })
    ).equals(false)
  })
  it('names somebody on a list of the league its administrator manages in full, and adds them so', async () => {
    await insertFixtureUsers(f.h.db, [
      {
        id: 230,
        display_name: 'Ken Griffey',
        first_name: 'Ken',
        last_name: 'Griffey',
        login_enabled: true
      },
      {
        id: 231,
        display_name: 'Ken Boyer',
        first_name: 'Ken',
        last_name: 'Boyer',
        login_enabled: true
      }
    ])
    await f.h.db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: id(230),
        league_id: f.leagueA,
        joined_at: new Date()
      })
      .execute()
    // A member of League A, whose administrator 101 is, reads in full and
    // matches by surname; somebody on no level of theirs stays short.
    expect(await search('Griffey')).deep.equals([
      { userId: id(230), displayName: 'Ken Griffey' }
    ])
    expect(await search('Boyer')).deep.equals([])
    expect(await search('Ken B')).deep.equals([
      { userId: id(231), displayName: 'Ken B' }
    ])
    const response = await add({ userId: id(230) })
    expect(response.status, await response.clone().text()).equals(201)
    expect(await response.json()).deep.equals({
      added: true,
      person: { userId: id(230), displayName: 'Ken Griffey' }
    })
    // Seeing grants no change: the name is not 101's to edit.
    expect(await mayEditName(f.h.db, id(101), id(230), actor(101))).equals(
      false
    )
  })
  it('requires administrator rights for search and submission, including empty queries', async () => {
    for (const role of [
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer'
    ] as const) {
      const grant = makeId('scopeRole')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: grant,
          user_id: id(104),
          scope_type: 'team',
          scope_id: f.teamA,
          role,
          granted_by: id(101)
        })
        .execute()
      for (const q of ['Tim', ''])
        expect(
          (await f.h.request('GET', query(f.teamA, q), undefined, 104)).status
        ).equals(403)
      expect((await add({ userId: id(106) }, 104)).status).equals(404)
      await f.h.db.deleteFrom('scope_roles').where('id', '=', grant).execute()
    }
    expect(
      (await f.h.request('GET', query(f.teamA, 'Tim'), undefined, null)).status
    ).equals(401)
    for (const group of [
      { kind: 'team', id: f.teamA },
      { kind: 'season', id: f.seasonA },
      { kind: 'league', id: f.leagueA }
    ]) {
      expect(
        (
          await f.h.request(
            'GET',
            `/users?forGroupKind=${group.kind}&forGroupId=${group.id}&q=Tim`,
            undefined,
            101
          )
        ).status
      ).equals(200)
    }
    expect(
      (await f.h.request('GET', query('missing', 'Tim'), undefined, 101)).status
    ).equals(404)
  })
  it('adds selected accounts with the same roles and mail, without disclosing private identity', async () => {
    const response = await add({ userId: id(106), flags: ['coach'] })
    expect(response.status, await response.clone().text()).equals(201)
    const body = await response.json()
    expect(body).deep.equals({
      added: true,
      person: { userId: id(106), displayName: 'Tim R' }
    })
    expect(f.h.invitations.has('fixture106@example.com')).equals(true)
    expect(
      await (
        await add({ email: 'fixture106@example.com', flags: ['coach'] })
      ).json()
    ).property('added', false)
    expect(
      await (await add({ userId: id(106), flags: ['coach'] })).json()
    ).property('added', false)
    expect(
      await (await add({ email: 'new-person@example.test' })).json()
    ).property('invited')
  })
  it('rejects malformed requests and accounts that stopped being eligible', async () => {
    for (const body of [
      {},
      { email: 'fixture106@example.com', userId: id(106) },
      { userId: 'invalid' },
      { userId: id(106), idempotencyKey: 'short' }
    ])
      expect((await add(body)).status).equals(400)
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', id(106))
      .execute()
    expect((await add({ userId: id(106) })).status).equals(404)
    for (const extra of [
      '&forTeam=x',
      '&guardedBy=me',
      '&view=other',
      '&exclude=bad',
      '&q=again'
    ])
      expect(
        (
          await f.h.request(
            'GET',
            query(f.teamA, 'Tim') + extra,
            undefined,
            101
          )
        ).status
      ).equals(400)
    for (const q of [
      { forGroupKind: 'no', forGroupId: 'x' },
      { forGroupKind: 'team' },
      { forGroupKind: 'team', forGroupId: 'x', q: 42 },
      { forGroupKind: 'team', forGroupId: 'x', q: 'a'.repeat(101) },
      {
        forGroupKind: 'team',
        forGroupId: 'x',
        exclude: Array(101).fill(id(101))
      }
    ])
      expect(() => peopleQueryOf(q)).throws()
  })
})
