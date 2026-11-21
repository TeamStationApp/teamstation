import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  type Answer,
  type ChatFixture,
  openChatFixture
} from './chatTestFixture'
import { dmProxies, dmReach, withDmReach } from './dms'

describe('how a viewer can message somebody (dmReach, dmProxies)', function () {
  this.timeout(120000)
  let fixture: ChatFixture

  before(async function () {
    const opened = await openChatFixture('dm_reach')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
  })

  after(async function () {
    await fixture?.close()
  })

  const id = (key: string): string => fixture.id(key)
  const reach = async (
    viewer: string,
    keys: string[]
  ): Promise<Record<string, string | null>> => {
    const answers = await dmReach(
      fixture.db,
      id(viewer),
      keys.map(id),
      fixture.now
    )
    return Object.fromEntries(
      keys.map(key => [key, answers.get(id(key)) ?? null])
    )
  }
  const proxies = async (
    viewer: string,
    player: string
  ): Promise<{ kind: string; keys: string[] } | null> => {
    const answer = await dmProxies(
      fixture.db,
      id(viewer),
      id(player),
      fixture.now
    )
    return answer == null
      ? null
      : { kind: answer.kind, keys: answer.ids.map(fixture.keyOf).sort() }
  }
  const call = async (
    who: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer> => await fixture.call(who, method, path, body)
  /** N as R's guardian for the length of `run`. */
  const withGuardian = async (run: () => Promise<void>): Promise<void> => {
    const link = makeId('userLink')
    await fixture.db
      .insertInto('user_links')
      .values({
        id: link,
        user_id: id('N'),
        related_user_id: id('R'),
        kind: 'guardian'
      })
      .execute()
    try {
      await run()
    } finally {
      await fixture.db.deleteFrom('user_links').where('id', '=', link).execute()
    }
  }

  it('answers direct for people the DM rules let the viewer name, and nobody else', async () => {
    expect(await reach('Hc', ['A', 'Ha', 'P', 'G1', 'Hc', 'D'])).deep.equals({
      A: 'direct',
      Ha: 'direct',
      P: 'direct',
      G1: 'direct',
      Hc: null,
      D: null
    })
    expect(await reach('A', ['Hc', 'P', 'Q'])).deep.equals({
      Hc: 'direct',
      P: null,
      Q: null
    })
    // A fan, whose only tie is a follow, reaches nobody.
    expect(await reach('F', ['A', 'Hc', 'Q'])).deep.equals({
      A: null,
      Hc: null,
      Q: null
    })
  })

  it("answers proxies for a player who cannot sign in, through the team's coaches when they have no guardian", async () => {
    expect(await reach('Hc', ['R', 'T', 'Q'])).deep.equals({
      R: 'proxies',
      T: 'proxies',
      Q: 'proxies'
    })
    expect(await proxies('Hc', 'Q')).deep.equals({
      kind: 'coaches',
      keys: ['Ha']
    })
    expect(await proxies('L', 'Q')).deep.equals({
      kind: 'coaches',
      keys: ['Ha', 'Hc']
    })
  })

  it('lists the guardians first, and leaves the viewer out', async () => {
    await withGuardian(async () => {
      expect(await proxies('Hc', 'R')).deep.equals({
        kind: 'guardians',
        keys: ['N']
      })
      // The guardian, asking, is not offered themselves: the coaches remain.
      expect(await proxies('N', 'R')).deep.equals({
        kind: 'coaches',
        keys: ['Ha', 'Hc']
      })
    })
    expect(await proxies('Hc', 'R')).deep.equals({
      kind: 'coaches',
      keys: ['Ha']
    })
  })

  it('skips a guardian who cannot be messaged, and answers null when nobody is left', async () => {
    await withGuardian(async () => {
      await fixture.db
        .updateTable('users')
        .set({ disabled_at: new Date() })
        .where('id', '=', id('N'))
        .execute()
      try {
        expect(await proxies('Hc', 'R')).deep.equals({
          kind: 'coaches',
          keys: ['Ha']
        })
        // With Ha's account switched off too, Hc has nobody left for R.
        await fixture.db
          .updateTable('users')
          .set({ login_enabled: false })
          .where('id', '=', id('Ha'))
          .execute()
        expect(await reach('Hc', ['R'])).deep.equals({ R: null })
        expect(await proxies('Hc', 'R')).equals(null)
      } finally {
        await fixture.db
          .updateTable('users')
          .set({ disabled_at: null, login_enabled: true })
          .where('id', 'in', [id('N'), id('Ha')])
          .execute()
      }
    })
  })

  it('skips a family member under 13, keeping the guardians', async () => {
    const link = makeId('userLink')
    await fixture.db
      .insertInto('user_links')
      .values({
        id: link,
        user_id: id('T'),
        related_user_id: id('R'),
        kind: 'family'
      })
      .execute()
    try {
      expect(await proxies('Hc', 'R')).deep.equals({
        kind: 'coaches',
        keys: ['Ha']
      })
    } finally {
      await fixture.db.deleteFrom('user_links').where('id', '=', link).execute()
    }
  })

  it('answers null for a viewer with no tie to the player, or with no account', async () => {
    expect(await reach('Ec', ['R', 'Q'])).deep.equals({ R: null, Q: null })
    expect(await proxies('Ec', 'R')).equals(null)
    expect(await proxies('Hc', 'A')).equals(null)
    await fixture.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', id('Hc'))
      .execute()
    try {
      expect(await reach('Hc', ['A', 'Q'])).deep.equals({ A: null, Q: null })
      expect(await proxies('Hc', 'Q')).equals(null)
    } finally {
      await fixture.db
        .updateTable('users')
        .set({ login_enabled: true })
        .where('id', '=', id('Hc'))
        .execute()
    }
  })

  it('marks each entry of a list with how the viewer can message them', async () => {
    const marked = await withDmReach(
      fixture.db,
      id('Hc'),
      ['A', 'Q', 'D', 'Hc'].map(key => ({ userId: id(key), key })),
      fixture.now
    )
    expect(marked.map(entry => [entry.key, entry.message])).deep.equals([
      ['A', 'direct'],
      ['Q', 'proxies'],
      ['D', undefined],
      ['Hc', undefined]
    ])
    expect('message' in marked[2]).equals(false)
  })

  it('never offers a playing minor as a guardian when siblings are read side by side', async () => {
    const links = [
      ['N', 'R', 'guardian'],
      ['N', 'T', 'guardian'],
      ['P', 'R', 'family'],
      ['P', 'T', 'family']
    ].map(([from, to, kind]) => ({
      id: makeId('userLink'),
      user_id: id(from),
      related_user_id: id(to),
      kind: kind as 'guardian' | 'family'
    }))
    await fixture.db.insertInto('user_links').values(links).execute()
    try {
      // R and T in one batch share N and P: P plays, and is 15.
      const marked = await withDmReach(
        fixture.db,
        id('Hc'),
        ['R', 'T', 'Q', 'A', 'P'].map(key => ({ userId: id(key), key })),
        fixture.now
      )
      expect(
        Object.fromEntries(marked.map(entry => [entry.key, entry.message]))
      ).deep.equals({
        R: 'proxies',
        T: 'proxies',
        Q: 'proxies',
        A: 'direct',
        P: 'direct'
      })
      for (const sibling of ['R', 'T'])
        expect(await proxies('Hc', sibling)).deep.equals({
          kind: 'guardians',
          keys: ['N']
        })
    } finally {
      await fixture.db
        .deleteFrom('user_links')
        .where(
          'id',
          'in',
          links.map(link => link.id)
        )
        .execute()
    }
  })

  it('reads a long list in a bounded number of queries', async () => {
    const ids: string[] = []
    for (let i = 0; i < 400; i++) ids.push(userIdOfGumbo(900000 + i))
    await insertFixtureUsers(
      fixture.db,
      ids.map((_, i) => ({
        id: 900000 + i,
        display_name: `Member ${i}`,
        first_name: 'Member',
        last_name: String(i),
        login_enabled: true,
        is_admin: false
      }))
    )
    await fixture.db
      .insertInto('league_members')
      .values(
        ids.map(userId => ({
          id: makeId('leagueMember'),
          league_id: fixture.seed.leagueId,
          user_id: userId,
          role: 'member' as const
        }))
      )
      .execute()
    let queries = 0
    let inFlight = 0
    let peak = 0
    const counted = fixture.db.withPlugin({
      transformQuery: args => {
        queries++
        inFlight++
        peak = Math.max(peak, inFlight)
        return args.node
      },
      transformResult: async args => {
        inFlight--
        return await Promise.resolve(args.result)
      }
    })
    const started = Date.now()
    const marked = await withDmReach(
      counted,
      id('L'),
      ids.map(userId => ({ userId })),
      fixture.now
    )
    expect(marked).length(400)
    expect(queries).lessThan(20 + 10 * 400)
    // A few of the pool's connections at once, never most of them.
    expect(peak).at.most(3)
    expect(Date.now() - started).lessThan(5000)
  })

  describe('the routes', function () {
    it('GET /chat/dm-reach answers each reach and 404 for nobody', async () => {
      for (const [key, expected] of [
        ['A', 'direct'],
        ['Q', 'proxies'],
        ['D', null]
      ] as const) {
        const answer = await call(
          'Hc',
          'GET',
          `/chat/dm-reach?userId=${id(key)}`
        )
        expect(answer.status).equals(200)
        expect(answer.body).deep.equals({ reach: expected })
      }
      expect(
        (await call('Hc', 'GET', '/chat/dm-reach?userId=usr_missing')).status
      ).equals(404)
      expect((await call('Hc', 'GET', '/chat/dm-reach')).status).equals(404)
    })

    it('GET /chat/dm-proxies lists the people to message, named for the reader', async () => {
      await withGuardian(async () => {
        const answer = await call(
          'Hc',
          'GET',
          `/chat/dm-proxies?userId=${id('R')}`
        )
        expect(answer.status).equals(200)
        expect(answer.body.player).deep.equals({
          userId: id('R'),
          shortName: 'Riley Rookie'
        })
        expect(answer.body.kind).equals('guardians')
        expect(
          answer.body.people.map((p: { userId: string }) =>
            fixture.keyOf(p.userId)
          )
        ).deep.equals(['N'])
        expect(answer.body.people[0].shortName).equals('Nora Nash')
        expect(answer.body.people[0]).to.have.property('avatarUrl')
      })
      const coaches = await call(
        'L',
        'GET',
        `/chat/dm-proxies?userId=${id('Q')}`
      )
      expect(coaches.status).equals(200)
      expect(coaches.body.kind).equals('coaches')
      expect(
        coaches.body.people.map((p: { shortName: string }) => p.shortName)
      ).deep.equals(['Hank Coach', 'Harper Hawkins'])
      for (const [who, key] of [
        ['Ec', 'R'],
        ['Hc', 'A']
      ])
        expect(
          (await call(who, 'GET', `/chat/dm-proxies?userId=${id(key)}`)).status
        ).equals(404)
    })

    it('makes the DM with a listed person', async () => {
      const listed = await call(
        'Hc',
        'GET',
        `/chat/dm-proxies?userId=${id('Q')}`
      )
      for (const person of listed.body.people as Array<{ userId: string }>) {
        const made = await call('Hc', 'POST', '/chat/dms', {
          userIds: [person.userId]
        })
        expect([200, 201]).includes(made.status)
      }
    })
  })
})
