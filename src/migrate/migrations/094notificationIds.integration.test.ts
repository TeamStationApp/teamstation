import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { Notification } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import type { VenueDetail } from '../../common/venues'
import { notifyGrant } from '../../server/invites/grants'
import { googlePlaces } from '../../server/location/googlePlaces'
import { EXAMPLE_PARK, googlePlacesStub } from '../../test/googlePlacesStub'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { testDatabaseUrl } from '../testDatabase'
import { migration094NotificationIds } from './094notificationIds'

type Json = Record<string, unknown>

/**
 * 094 on notifications stored as they were before it: a request's with its
 * sender's name and its rendered text, a grant's with its title and
 * description, a person's venue decision naming them.
 */
describe('094 notifications rendered from ids', function () {
  this.timeout(120000)
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  let f: GroupFixture
  let pool: Pool
  beforeEach(async () => {
    stub = await googlePlacesStub()
    f = await groupFixture(
      undefined,
      undefined,
      undefined,
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
    )
    const { rows } = await sql<{
      name: string
    }>`select current_database() as name`.execute(f.h.db)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${rows[0].name}`)
    })
  })
  afterEach(async () => {
    await pool?.end()
    await f?.h.close()
    await stub?.close()
  })

  /** 094's SQL and step, in one transaction, as the runner runs them. */
  const migrate = async (): Promise<void> => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(migration094NotificationIds.up)
      await migration094NotificationIds.steps!(client)
      await client.query('commit')
    } finally {
      client.release()
    }
  }
  const metadata = async (id: string): Promise<Json> =>
    (
      await f.h.db
        .selectFrom('notification_events')
        .select('metadata')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).metadata as Json
  const rewrite = async (id: string, value: Json): Promise<void> => {
    await f.h.db
      .updateTable('notification_events')
      .set({ metadata: sql`${JSON.stringify(value)}::jsonb` })
      .where('id', '=', id)
      .execute()
  }
  const read = async (id: string, user: number): Promise<Notification> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return (await response.json()) as Notification
  }
  const renameTeam = async (id: string, name: string): Promise<void> => {
    await f.h.db
      .updateTable('teams')
      .set({ name })
      .where('id', '=', id)
      .execute()
  }
  const renamePerson = async (user: number, name: string): Promise<void> => {
    await f.h.db
      .updateTable('users')
      .set({ display_name: name })
      .where('id', '=', userIdOfGumbo(user))
      .execute()
  }

  it("freezes a request's group names and zones as they stand, and reads its sender as they are now", async () => {
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          venue: 'Demo Park',
          status: 'scheduled'
        },
        idempotencyKey: 'migration-094-game'
      },
      101
    )
    expect(sent.status).equals(201)
    const { id: requestId } = (await sent.json()) as { id: string }
    // As stored before 094: terms from before they carried a zone, and the
    // sender's name and the text written with it in the metadata.
    await f.h.db
      .updateTable('group_requests')
      .set({
        terms: sql`jsonb_set(terms, '{game}', (terms->'game') - 'timezone')`
      })
      .where('id', '=', requestId)
      .execute()
    const event = await f.h.db
      .selectFrom('notification_events')
      .select('id')
      .where('source_type', '=', 'groupRequest')
      .where('source_id', '=', requestId)
      .executeTakeFirstOrThrow()
    await rewrite(event.id, {
      senderName: 'Babe Ruth',
      senderGroupName: 'Demo Hawks',
      requestTitle: 'Demo Eagles invited to game vs. Demo Hawks',
      requestDescription: 'Babe Ruth from Demo Hawks proposed a game.',
      gameClassificationIncluded: true,
      gameEventDetailsIncluded: true,
      gameScheduleDetailsIncluded: true
    })
    // Renamed between sending and 094: the request reads the name at 094.
    await renameTeam(f.teamB, 'Demo Night Eagles')
    await f.h.db
      .updateTable('seasons')
      .set({ timezone: 'America/Chicago' })
      .where('id', '=', f.seasonA)
      .execute()

    await migrate()
    expect(await metadata(event.id)).deep.equals({
      senderGroupName: 'Demo Hawks',
      frozen: {
        groups: {
          [`team:${f.teamA}`]: 'Demo Hawks',
          [`team:${f.teamB}`]: 'Demo Night Eagles',
          [`season:${f.seasonA}`]: 'Demo Regular'
        },
        zones: { [f.seasonA]: 'America/Chicago' }
      }
    })
    const shown = await read(requestId, 102)
    expect(shown.title).equals(
      'Demo Night Eagles invited to game vs. Demo Hawks'
    )
    expect(shown.description).equals(
      'Babe Ruth from Demo Hawks proposed Demo Night Eagles at Demo Hawks in Demo Regular, Apr 1, 2027, 2:00 PM (America/Chicago) at Demo Park, scheduled, Exhibition: Off. This changes neither management parents nor season participation.'
    )

    // A later rename of a group or a zone changes nothing; a person's does.
    await renameTeam(f.teamB, 'Demo Day Eagles')
    await f.h.db
      .updateTable('seasons')
      .set({ name: 'Demo Renamed Regular', timezone: 'America/New_York' })
      .where('id', '=', f.seasonA)
      .execute()
    expect(await read(requestId, 102)).deep.equals(shown)
    await renamePerson(101, 'Ken Griffey')
    expect(await read(requestId, 102)).deep.include({
      title: shown.title,
      description: shown.description.replace('Babe Ruth', 'Ken Griffey')
    })

    // Run again, it keeps what it froze.
    await migrate()
    expect((await metadata(event.id)).frozen)
      .property('groups')
      .property(`team:${f.teamB}`, 'Demo Night Eagles')
  })

  it("takes a grant's words out and reads it with its giver's name", async () => {
    const id = (await notifyGrant(f.h.db, {
      ref: { kind: 'team', id: f.teamA },
      userId: userIdOfGumbo(103),
      added: ['coach'],
      actorId: userIdOfGumbo(101)
    }))!
    const scope = { kind: 'team', id: f.teamA }
    await rewrite(id, {
      title: 'Babe Ruth added you as Coach of Demo Hawks',
      description:
        "You are a member of Demo Hawks now. If you don't want to be, leave it here.",
      scope,
      roles: ['coach']
    })
    await migrate()
    expect(await metadata(id)).deep.equals({ scope, roles: ['coach'] })
    await renamePerson(101, 'Ken Griffey')
    expect((await read(id, 103)).title).equals(
      'Ken Griffey added you as Coach of Demo Hawks'
    )
  })

  it("names the person who decided a venue claim as they are now, and leaves the seven days' words", async () => {
    const venue = (await (
      await f.h.request('POST', '/venues', {
        placeId: EXAMPLE_PARK.id,
        leagueId: f.leagueA
      })
    ).json()) as VenueDetail
    f.advance(1000 * 3600 * 24 * 8)
    await f.h.request('GET', `/venues/${venue.id!}`, undefined, 102)
    await f.h.request(
      'POST',
      `/venues/${venue.id!}/claims`,
      { leagueId: f.leagueB },
      102
    )
    const claimId = (
      (await (
        await f.h.request('GET', `/venues/${venue.id!}`)
      ).json()) as VenueDetail
    ).claims.find(claim => claim.leagueId === f.leagueB)!.id
    await f.h.request(
      'POST',
      `/venues/${venue.id!}/claims/${claimId}/decisions`,
      { decision: 'reject' }
    )
    const [automatic, decided] = await f.h.db
      .selectFrom('notification_events')
      .select(['id', 'actor_id', 'metadata'])
      .where('source_type', '=', 'venueClaimDecided')
      .orderBy('created_at')
      .execute()
    expect(automatic.actor_id).equals(null)
    const decider = (
      await f.h.db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', decided.actor_id!)
        .executeTakeFirstOrThrow()
    ).display_name
    const before094 = {
      title: 'Example Park: request declined',
      description: `${decider} decided Demo League B's request.`,
      venueId: venue.id,
      claimId
    }
    await rewrite(decided.id, before094)
    const seven = await metadata(automatic.id)
    // The league is renamed before 094, and its name at 094 is kept.
    await f.h.db
      .updateTable('leagues')
      .set({ name: 'Demo League Bee' })
      .where('id', '=', f.leagueB)
      .execute()

    await migrate()
    expect(await metadata(automatic.id)).deep.equals(seven)
    expect(await metadata(decided.id)).deep.equals({
      title: before094.title,
      venueId: venue.id,
      claimId,
      claimKind: 'request',
      leagueName: 'Demo League Bee'
    })
    await f.h.db
      .updateTable('users')
      .set({ display_name: 'Ken Griffey' })
      .where('id', '=', decided.actor_id!)
      .execute()
    expect((await read(decided.id, 102)).description).equals(
      "Ken Griffey decided Demo League Bee's request."
    )
  })

  it('cannot be rolled back', async () => {
    const client = await pool.connect()
    let refused = ''
    try {
      await client.query('begin')
      await client.query(migration094NotificationIds.down)
    } catch (error) {
      refused = String(error)
    } finally {
      await client.query('rollback')
      client.release()
    }
    expect(refused).contains('cannot be put back')
  })
})
