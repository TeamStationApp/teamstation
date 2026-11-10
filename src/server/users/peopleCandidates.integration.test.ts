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
import { mayEditName, mayEditNames } from '../access'
import { onePerson } from '../admin/people'
import { peopleCandidates, peopleQueryOf } from './peopleCandidates'

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
    const parent = await search('Mookie', 101, '', true)
    expect(parent).length(1)
    expect(parent[0].avatarUrl).equals(null)
    expect(parent[0].affiliations).equals('Guardian of Tim R · Demo Eagles')
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
    for (const q of ['Alex', 'Smith']) {
      queries = 0
      const rows = await peopleCandidates(db, actor(101), {
        group: { kind: 'team', id: f.teamA },
        q: q.toLowerCase(),
        exclude: []
      })
      expect(rows).length(q === 'Alex' ? 5 : 0)
      expect(queries).lessThan(40)
    }
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
