import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { grant, revoke } from '../umpires/admin'
import { audienceOf } from './audiences'
import { type ChatFixture, openChatFixture } from './chatTestFixture'

/**
 * #349, a league's umpire chat, on the chat fixture: QPLL (league admin L)
 * with Hawks (parents A, B, C on it; fan F, who only follows it) in Spring
 * 2027, and site administrator Z. Today is 10 April 2027.
 *
 * The chat is the league's `league_umpires` holders who are accepted into
 * it, as eligible survivors, while it manages umpires; nobody creates it.
 */
describe('the league umpire chat (#349)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let league: string

  const role = async (key: string, granter = 'L'): Promise<void> => {
    await fixture.db
      .insertInto('league_umpires')
      .values({
        league_id: league,
        user_id: fixture.id(key),
        granted_by: fixture.id(granter)
      })
      .onConflict(oc => oc.doNothing())
      .execute()
  }
  const unrole = async (key: string): Promise<void> => {
    await fixture.db
      .deleteFrom('league_umpires')
      .where('league_id', '=', league)
      .where('user_id', '=', fixture.id(key))
      .execute()
  }
  const manage = async (on: boolean): Promise<void> => {
    await fixture.db
      .updateTable('leagues')
      .set({ umpire_management: on })
      .where('id', '=', league)
      .execute()
  }
  const chat = async (): Promise<string | undefined> =>
    (
      await fixture.db
        .selectFrom('chat_conversations')
        .select('id')
        .where('kind', '=', 'leagueUmpires')
        .where('scope_id', '=', league)
        .executeTakeFirst()
    )?.id
  const members = async (): Promise<string[]> => {
    const id = await chat()
    if (id == null) return []
    const rows = await fixture.db
      .selectFrom('chat_members')
      .select('user_id')
      .where('conversation_id', '=', id)
      .where('left_at', 'is', null)
      .execute()
    return rows.map(row => fixture.keyOf(row.user_id)).sort()
  }

  before(async function () {
    const opened = await openChatFixture('umpire_chat', { reconcile: false })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    league = fixture.seed.leagueId
    await fixture.drain()
  })
  after(async function () {
    await fixture?.close()
  })

  it('has no chat, and nobody makes one, until the league manages umpires and has one', async function () {
    await role('B')
    await fixture.drain()
    expect(await chat()).equals(undefined)
    await manage(true)
    await fixture.drain()
    expect(await chat()).not.equals(undefined)
    expect(await members()).deep.equals(['B'])
  })

  it('is called after the league, and its members are labelled as umpires', async function () {
    const id = (await chat())!
    const listed = await fixture.call('B', 'GET', '/chat/conversations')
    const found = (
      listed.body as Array<{ id: string; title: string | null }>
    ).find(item => item.id === id)
    expect(found?.title).equals('QPLL Umpires')
    const people = await fixture.call(
      'B',
      'GET',
      `/chat/conversations/${id}/members`
    )
    expect(people.status).equals(200)
    const labels = (
      people.body as Array<{ userId: string; label: string }>
    ).map(member => member.label)
    expect(labels).deep.equals(['Umpire'])
  })

  it('leaves the umpire chat out of the list for a build from before it, which would fail on its kind', async function () {
    const id = (await chat())!
    const list = async (header?: string): Promise<string[]> => {
      const response = await fetch(`${fixture.api}/chat/conversations`, {
        headers: {
          authorization: `Bearer ${fixture.tokenOf('B')}`,
          ...(header == null ? {} : { 'x-teamstation-chat-kinds': header })
        }
      })
      expect(response.status).equals(200)
      return ((await response.json()) as Array<{ id: string }>).map(
        item => item.id
      )
    }
    expect(await list()).not.includes(id)
    expect(await list('somethingElse')).not.includes(id)
    expect(await list('leagueUmpires')).includes(id)
    // Its other chats are there either way.
    expect((await list()).length).equals(
      (await list('leagueUmpires')).length - 1
    )
  })

  it('keeps out a league administrator without the role, who cannot read it', async function () {
    const id = (await chat())!
    expect(await members()).not.includes('L')
    const listed = await fixture.call('L', 'GET', '/chat/conversations')
    expect(
      (listed.body as Array<{ id: string }>).map(item => item.id).includes(id)
    ).equals(false)
    for (const path of [
      `/chat/conversations/${id}/members`,
      `/chat/conversations/${id}/log`
    ])
      expect((await fixture.call('L', 'GET', path)).status).within(400, 404)
  })

  it('takes in an administrator who grants themselves the role, and lets them moderate', async function () {
    await fixture.db.transaction().execute(async trx => {
      await grant(trx, league, fixture.id('L'), fixture.id('L'))
    })
    await fixture.drain()
    expect(await members()).deep.equals(['B', 'L'])
    const id = (await chat())!
    const listed = await fixture.call('L', 'GET', '/chat/conversations')
    const mine = (
      listed.body as Array<{ id: string; canModerate: boolean }>
    ).find(item => item.id === id)
    expect(mine?.canModerate).equals(true)
    // Nobody else in the chat moderates it.
    const theirs = (
      (await fixture.call('B', 'GET', '/chat/conversations')).body as Array<{
        id: string
        canModerate: boolean
      }>
    ).find(item => item.id === id)
    expect(theirs?.canModerate).equals(false)
  })

  it('takes in a site administrator who holds the role, as their schedule shows them every game', async function () {
    await role('Z')
    await fixture.drain()
    expect(await members()).includes('Z')
    // No longer a site administrator, Z has no tie to the league: out at once.
    await fixture.db
      .updateTable('users')
      .set({ is_admin: false })
      .where('id', '=', fixture.id('Z'))
      .execute()
    await fixture.drain()
    expect(await members()).not.includes('Z')
    await fixture.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', fixture.id('Z'))
      .execute()
    await fixture.drain()
    expect(await members()).includes('Z')
    await unrole('Z')
    await fixture.drain()
    expect(await members()).not.includes('Z')
  })

  it('adds and removes members as the role is granted and taken away', async function () {
    await role('A')
    await fixture.drain()
    expect(await members()).deep.equals(['A', 'B', 'L'])
    await fixture.db.transaction().execute(async trx => {
      await revoke(trx, league, fixture.id('A'))
    })
    await fixture.drain()
    expect(await members()).deep.equals(['B', 'L'])
  })

  it('keeps out a role holder who is not accepted into the league, and lets out one who stops being', async function () {
    await role('F')
    await fixture.drain()
    expect(await members()).not.includes('F')
    await unrole('F')
    // C is accepted by a Hawks membership; without it, C is nobody here.
    await role('C')
    await fixture.drain()
    expect(await members()).includes('C')
    const membership = await fixture.db
      .deleteFrom('memberships')
      .where('user_id', '=', fixture.id('C'))
      .returningAll()
      .execute()
    await fixture.drain()
    expect(await members()).not.includes('C')
    await fixture.db.insertInto('memberships').values(membership).execute()
    await unrole('C')
    await fixture.drain()
  })

  it('counts acceptance through a season membership at once', async function () {
    const sm = await fixture.person('SMU')
    await role('SMU')
    await fixture.drain()
    expect(await members()).not.includes('SMU')
    await fixture.db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: sm,
        season_id: fixture.seed.seasonId
      })
      .execute()
    await fixture.drain()
    expect(await members()).includes('SMU')
    await unrole('SMU')
    await fixture.drain()
  })

  it('leaves out an under-13, a disabled and a login-disabled holder, and counts a merged one as their survivor', async function () {
    const kid = await fixture.person('UKID', {
      birth: { year: 2018, month: 1 }
    })
    const gone = await fixture.person('UGONE')
    const locked = await fixture.person('ULOCK')
    const old = await fixture.person('COLD')
    for (const id of [kid, gone, locked, old])
      await fixture.db
        .insertInto('season_members')
        .values({
          id: makeId('seasonMember'),
          user_id: id,
          season_id: fixture.seed.seasonId
        })
        .execute()
    await fixture.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', gone)
      .execute()
    await fixture.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', locked)
      .execute()
    for (const key of ['UKID', 'UGONE', 'ULOCK', 'COLD']) await role(key)
    // C's old account holds the role; C, accepted on Hawks, is its survivor.
    await fixture.db
      .updateTable('users')
      .set({ merged_into: fixture.id('C') })
      .where('id', '=', old)
      .execute()
    // Ineligible holders beside eligible ones: the reconcile goes through.
    await fixture.drain()
    expect(await members()).deep.equals(['B', 'C', 'L'])
    for (const key of ['UKID', 'UGONE', 'ULOCK', 'COLD']) await unrole(key)
    await fixture.drain()
    expect(await members()).deep.equals(['B', 'L'])
  })

  it('empties when the league stops managing umpires, keeping the chat, and fills again', async function () {
    const id = await chat()
    await manage(false)
    await fixture.drain()
    expect(await chat()).equals(id)
    expect(await members()).deep.equals([])
    await manage(true)
    await fixture.drain()
    expect(await members()).deep.equals(['B', 'L'])
  })

  it('works out a league of umpires in a bounded number of queries', async function () {
    const keys = Array.from({ length: 12 }, (_, i) => `UB${i}`)
    for (const key of keys) {
      const id = await fixture.person(key)
      await fixture.db
        .insertInto('season_members')
        .values({
          id: makeId('seasonMember'),
          user_id: id,
          season_id: fixture.seed.seasonId
        })
        .execute()
      await role(key)
    }
    let queries = 0
    const counted = fixture.db.withPlugin({
      transformQuery: args => {
        queries++
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const members = await audienceOf(
      counted,
      'leagueUmpires',
      league,
      fixture.now
    )
    // B and L, and the twelve, each accepted by membership: the
    // administrator question is never asked of them.
    expect(members.size).equals(14)
    expect(queries).lessThan(10 + 8 * members.size)
    for (const key of keys) await unrole(key)
    await fixture.drain()
  })

  it('lets out a member accepted only through a season that moves to another league', async function () {
    const other = makeId('league')
    await fixture.db
      .insertInto('leagues')
      .values({ id: other, name: 'Demo League B' })
      .execute()
    const season = makeId('season')
    await fixture.db
      .insertInto('seasons')
      .values({
        id: season,
        name: 'Fall 2027',
        year: 2027,
        league_id: league,
        starts_on: '2027-09-01',
        ends_on: '2027-11-30'
      })
      .execute()
    const mover = await fixture.person('MOVER')
    await fixture.db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: mover,
        season_id: season
      })
      .execute()
    await role('MOVER')
    await fixture.drain()
    expect(await members()).includes('MOVER')
    await fixture.db
      .updateTable('seasons')
      .set({ league_id: other })
      .where('id', '=', season)
      .execute()
    await fixture.drain()
    expect(await members()).not.includes('MOVER')
    await unrole('MOVER')
    await fixture.drain()
  })
})
