import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { Notification } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { grantAt, notifyGrant } from '../invites/grants'
import { inbox } from './inbox'

describe('the inbox names people as they are now', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const history = async (user: number): Promise<Notification[]> => {
    const response = await f.h.request(
      'GET',
      '/me/notifications?history=1',
      undefined,
      user
    )
    expect(response.status).equals(200)
    return ((await response.json()) as { items: Notification[] }).items
  }
  const detail = async (id: string, user: number): Promise<Notification> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return (await response.json()) as Notification
  }
  const rename = async (user: number, name: string): Promise<void> => {
    await f.h.db
      .updateTable('users')
      .set({ display_name: name })
      .where('id', '=', userIdOfGumbo(user))
      .execute()
  }

  it("titles a grant with its giver's name and its level's name as they are now", async () => {
    const ref = { kind: 'team' as const, id: f.teamA }
    const added = await grantAt(
      f.h.db,
      ref,
      userIdOfGumbo(103),
      ['coach'],
      userIdOfGumbo(101)
    )
    expect(added).deep.equals(['member', 'coach'])
    const id = (await notifyGrant(f.h.db, {
      ref,
      userId: userIdOfGumbo(103),
      added,
      actorId: userIdOfGumbo(101)
    }))!
    const stored = await f.h.db
      .selectFrom('notification_events')
      .select(['actor_id', 'metadata'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(stored).deep.equals({
      actor_id: userIdOfGumbo(101),
      metadata: { scope: { kind: 'team', id: f.teamA }, roles: ['coach'] }
    })
    const grant = (await history(103)).find(item => item.id === id)!
    expect(grant).deep.include({
      type: 'grant',
      title: 'Babe Ruth added you as Coach of Demo Hawks',
      description:
        "You are a member of Demo Hawks now. If you don't want to be, leave it here.",
      leave: { kind: 'team', id: f.teamA, name: 'Demo Hawks' }
    })
    expect(await detail(id, 103)).deep.equals(grant)

    await rename(101, 'Ken Griffey')
    await f.h.db
      .updateTable('teams')
      .set({ name: 'Demo Renamed Hawks' })
      .where('id', '=', f.teamA)
      .execute()
    const renamed = await detail(id, 103)
    expect(renamed).deep.include({
      title: 'Ken Griffey added you as Coach of Demo Renamed Hawks',
      description:
        "You are a member of Demo Renamed Hawks now. If you don't want to be, leave it here.",
      leave: { kind: 'team', id: f.teamA, name: 'Demo Renamed Hawks' }
    })
    expect((await history(103)).find(item => item.id === id)).deep.equals(
      renamed
    )
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select(['actor_id', 'metadata'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).deep.equals(stored)
  })

  it("reads a page's actors' names once, however many notices name them", async () => {
    const recipients = [userIdOfGumbo(103)]
    const at = new Date()
    const rows = [101, 102, 101].map(actor => ({
      id: makeId('audit'),
      source_type: 'grant',
      actor_id: userIdOfGumbo(actor),
      metadata: { scope: { kind: 'team', id: f.teamA }, roles: [] }
    }))
    await f.h.db
      .insertInto('notification_events')
      .values(
        rows.map(row => ({
          ...row,
          source_id: row.id,
          revision: 1,
          recorded_recipients: recipients,
          created_at: at
        }))
      )
      .execute()
    await rename(102, 'Ken Griffey')
    const queries: string[] = []
    const watched = f.h.db.withPlugin({
      transformQuery: args => {
        queries.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const page = await inbox(
      watched,
      { userId: userIdOfGumbo(103), isAdmin: false, scopes: [] },
      { history: true }
    )
    expect(
      rows.map(row => page.items.find(item => item.id === row.id)?.title)
    ).deep.equals([
      'Babe Ruth added you to Demo Hawks',
      'Ken Griffey added you to Demo Hawks',
      'Babe Ruth added you to Demo Hawks'
    ])
    expect(
      queries.filter(query => query.includes('"name":"display_name"'))
    ).has.length(1)
  })

  it("reads a page's senders with its actors, and its grants' groups once a kind", async () => {
    // Two players ask to join Demo Hawks, whose administrator reads them.
    for (const [user, key] of [
      [103, 'join-trout'],
      [104, 'join-ichiro']
    ] as const) {
      const response = await f.h.request(
        'POST',
        '/relationship-requests',
        { kind: 'membership', teamId: f.teamA, idempotencyKey: key },
        user
      )
      expect(response.status, await response.clone().text()).equals(201)
    }
    // And three grants, from two people, over two teams and a league.
    const rows = [
      [102, { kind: 'team', id: f.teamA }],
      [103, { kind: 'team', id: f.teamB }],
      [102, { kind: 'league', id: f.leagueA }]
    ].map(([actor, scope]) => ({
      id: makeId('audit'),
      source_type: 'grant',
      actor_id: userIdOfGumbo(actor as number),
      metadata: { scope, roles: [] }
    }))
    await f.h.db
      .insertInto('notification_events')
      .values(
        rows.map(row => ({
          ...row,
          source_id: row.id,
          revision: 1,
          recorded_recipients: [userIdOfGumbo(101)],
          created_at: new Date()
        }))
      )
      .execute()
    await rename(104, 'Ken Griffey')
    const queries: string[] = []
    const watched = f.h.db.withPlugin({
      transformQuery: args => {
        queries.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const viewer = { userId: userIdOfGumbo(101), isAdmin: false, scopes: [] }
    const pending = await inbox(watched, viewer)
    expect(
      pending.items
        .filter(item => item.type === 'membership')
        .map(item => item.title)
        .sort()
    ).deep.equals([
      'Ken Griffey requests membership in Demo Hawks',
      'Mike Trout requests membership in Demo Hawks'
    ])
    expect(
      queries.filter(query => query.includes('"name":"display_name"'))
    ).has.length(1)
    queries.length = 0
    const page = await inbox(watched, viewer, { history: true })
    expect(
      rows.map(row => page.items.find(item => item.id === row.id)?.title)
    ).deep.equals([
      'Lou Gehrig added you to Demo Hawks',
      'Mike Trout added you to Demo Eagles',
      'Lou Gehrig added you to Demo League A'
    ])
    expect(
      queries.filter(query => query.includes('"name":"display_name"'))
    ).has.length(1)
    const groupReads = (table: string): number =>
      queries.filter(
        query =>
          query.includes(`"name":"${table}"`) &&
          query.includes('"name":"name"') &&
          !query.includes('"name":"display_name"')
      ).length
    expect(groupReads('teams')).equals(1)
    expect(groupReads('leagues')).equals(1)
  })

  it('names nobody where a notice has no actor, and keeps the words a notice stores', async () => {
    const recipients = [userIdOfGumbo(103)]
    const at = new Date()
    const rows = [
      {
        id: makeId('audit'),
        source_type: 'grant',
        actor_id: null,
        metadata: { scope: { kind: 'team', id: f.teamA }, roles: [] }
      },
      {
        id: makeId('audit'),
        source_type: 'venueClaimDecided',
        actor_id: null,
        metadata: {
          title: 'Example Park: claim rejected',
          claimKind: 'claim',
          leagueName: 'Demo League A'
        }
      },
      {
        id: makeId('audit'),
        source_type: 'venueClaimDecided',
        actor_id: userIdOfGumbo(102),
        metadata: {
          title: 'Example Park: claim approved',
          description: "Demo League A's claim was approved after 7 days."
        }
      }
    ]
    await f.h.db
      .insertInto('notification_events')
      .values(
        rows.map(row => ({
          ...row,
          source_id: row.id,
          revision: 1,
          recorded_recipients: recipients,
          created_at: at
        }))
      )
      .execute()
    const items = await history(103)
    expect(
      rows.map(row => {
        const item = items.find(each => each.id === row.id)!
        return [item.title, item.description]
      })
    ).deep.equals([
      [
        'An admin added you to Demo Hawks',
        "You are a member of Demo Hawks now. If you don't want to be, leave it here."
      ],
      [
        'Example Park: claim rejected',
        "An admin decided Demo League A's claim."
      ],
      [
        'Example Park: claim approved',
        "Demo League A's claim was approved after 7 days."
      ]
    ])
  })
})
