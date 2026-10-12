import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { makeId } from '../../common/ids'
import { migration055EventInfo } from '../../migrate/migrations/055eventInfo'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { openApiDocument } from '../openapi'

describe('real event info and guardian attendance', function () {
  this.timeout(60000)
  let f: GroupFixture
  const gameId = 'gam_info_demo'
  const startAt = '2027-04-10T18:00:00.000Z'
  const endAt = '2027-04-10T20:00:00.000Z'
  const body = (): {
    teamId: string
    title: string
    startAt: string
    endAt: string
    address: string
    latitude: number
    longitude: number
    idempotencyKey: string
  } => ({
    teamId: f.teamA,
    title: 'Team dinner',
    startAt,
    endAt,
    address: '1 Demo Way, Demo City',
    latitude: 0,
    longitude: 0,
    idempotencyKey: 'dinner-demo-key'
  })
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: f.teamA })
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(startAt)
      })
      .execute()
    for (const userId of [103, 104]) {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: f.teamA,
          is_player: true
        })
        .execute()
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: 101,
          related_user_id: userId,
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    }
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const create = async (): Promise<string> => {
    const response = await f.h.request('POST', '/events', body())
    expect(response.status).equals(201)
    return (await response.json()).id as string
  }
  const info = async (id: string, actor = 101): Promise<EventInfo> => {
    const response = await f.h.request(
      'GET',
      `/events/${id}/info`,
      undefined,
      actor
    )
    expect(response.status).equals(200)
    return asEventInfo(await response.json())
  }
  it('creates a titled event once, lists it on schedules and never creates an opponent/game/stat row', async () => {
    const id = await create()
    expect(
      (await (await f.h.request('POST', '/events', body())).json()).id
    ).equals(id)
    expect(
      (
        await f.h.request('POST', '/events', {
          ...body(),
          title: 'Another title'
        })
      ).status
    ).equals(409)
    expect(
      (await f.h.db.selectFrom('games').select('id').execute()).map(
        row => row.id
      )
    ).deep.equals([gameId])
    expect(
      await f.h.db.selectFrom('game_player_stats').select('id').execute()
    ).length(0)
    const read = await info(id)
    expect(read).includes({
      title: 'Team dinner',
      eventKind: 'event',
      address: body().address,
      canManage: true
    })
    const detail = await (await f.h.request('GET', `/games/${id}`)).json()
    expect(detail).includes({
      title: 'Team dinner',
      awayTeamId: '',
      canScore: false,
      canDj: false
    })
    const list = await (
      await f.h.request('GET', '/events?when=all&order=asc')
    ).json()
    expect(list.map((row: { id: string }) => row.id)).includes(id)
    const team = await (
      await f.h.request('GET', `/teams/${f.teamA}/games`)
    ).json()
    expect(team.map((row: { id: string }) => row.id)).includes(id)
    const season = await (
      await f.h.request('GET', `/events?season=${f.seasonA}&when=all`)
    ).json()
    expect(season.map((row: { id: string }) => row.id)).includes(id)
    for (const query of [
      'scope=run',
      'scope=film',
      'when=finished',
      'externalId=absent'
    ]) {
      const rows = await (await f.h.request('GET', `/events?${query}`)).json()
      expect(rows).is.an('array')
      expect(rows.map((row: { id: string }) => row.id)).not.includes(id)
    }
    const limited = await (
      await f.h.request('GET', '/events?when=all&limit=1&order=asc')
    ).json()
    expect(limited).length(1)
    expect((await f.h.request('GET', '/events?scoreboard=open')).status).equals(
      503
    )
  })
  it('persists separate self and child replies and denies impersonation even by administrators', async () => {
    const id = await create()
    const initial = await info(id)
    expect(initial.replyUserIds).deep.equals([101, 103, 104])
    expect(
      initial.attendees
        .filter(row => row.canReply)
        .every(row => row.response === null)
    ).equals(true)
    for (const [userId, response] of [
      [101, 'yes'],
      [103, 'no'],
      [104, 'maybe']
    ] as const) {
      const saved = await f.h.request('PUT', `/events/${id}/rsvps/${userId}`, {
        response
      })
      expect(saved.status).equals(200)
      expect(await saved.json()).deep.equals({ userId, response })
    }
    expect(
      (await info(id)).attendees
        .filter(row => row.canReply)
        .map(row => row.response)
    ).deep.equals(['yes', 'maybe', 'no'])
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/102`, { response: 'yes' }))
        .status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'PUT',
          `/events/${id}/rsvps/101`,
          { response: 'yes' },
          105
        )
      ).status
    ).equals(403)
    for (const response of ['none', null, 3])
      expect(
        (await f.h.request('PUT', `/events/${id}/rsvps/101`, { response }))
          .status
      ).equals(400)
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/0`, { response: 'yes' }))
        .status
    ).equals(400)
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/1.1`, { response: 'yes' }))
        .status
    ).equals(400)
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/101`, null)).status
    ).equals(400)
    const responses = await Promise.all(
      ['yes', 'maybe', 'no'].map(
        async response =>
          await f.h.request('PUT', `/events/${id}/rsvps/101`, { response })
      )
    )
    expect(responses.every(response => response.status === 200)).equals(true)
    expect(
      await f.h.db
        .selectFrom('team_event_rsvps')
        .selectAll()
        .where('event_id', '=', id)
        .where('user_id', '=', 101)
        .execute()
    ).length(1)
    await f.h.db
      .deleteFrom('user_links')
      .where('related_user_id', '=', 103)
      .execute()
    expect((await info(id)).replyUserIds).not.includes(103)
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/103`, { response: 'yes' }))
        .status
    ).equals(403)
    await f.h.db
      .updateTable('user_links')
      .set({ kind: 'family' })
      .where('related_user_id', '=', 104)
      .execute()
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/104`, { response: 'yes' }))
        .status
    ).equals(403)
  })
  it('applies the same RSVP controls to a game and hides inactive or merged roster identities', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: 103,
        team_id: f.teamB,
        is_player: true
      })
      .execute()
    const initial = await info(gameId)
    expect(initial.attendees.filter(row => row.userId === 103)).length(1)
    expect(
      (
        await f.h.request('PUT', `/events/${gameId}/rsvps/103`, {
          response: 'yes'
        })
      ).status
    ).equals(200)
    expect(
      (await info(gameId)).attendees.find(row => row.userId === 103)?.response
    ).equals('yes')
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', 103)
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ merged_into: 101 })
      .where('id', '=', 104)
      .execute()
    expect((await info(gameId)).attendees.map(row => row.userId))
      .not.includes(103)
      .and.not.includes(104)
    expect(
      (
        await f.h.request('PUT', `/events/${gameId}/rsvps/103`, {
          response: 'yes'
        })
      ).status
    ).equals(403)
    expect(
      (await f.h.request('GET', `/events/${gameId}/info`, undefined, 103))
        .status
    ).equals(401)
  })
  it('protects private event existence, limits management and validates edits', async () => {
    const id = await create()
    expect(
      (await f.h.request('GET', `/events/${id}/info`, undefined, 106)).status
    ).equals(404)
    expect(
      (await f.h.request('GET', `/games/${id}`, undefined, 106)).status
    ).equals(404)
    expect(
      (await f.h.request('GET', `/events/${id}/location`, undefined, 106))
        .status
    ).equals(404)
    expect((await f.h.request('GET', '/events/missing/info')).status).equals(
      404
    )
    expect(
      (await f.h.request('POST', '/events', { ...body(), teamId: 'missing' }))
        .status
    ).equals(404)
    expect((await f.h.request('POST', '/events', body(), 103)).status).equals(
      403
    )
    expect((await f.h.request('POST', '/events', body(), 106)).status).equals(
      404
    )
    expect((await f.h.request('POST', '/events', {})).status).equals(400)
    expect(
      (
        await f.h.request(
          'PUT',
          `/events/${id}/info`,
          { title: 'Changed' },
          104
        )
      ).status
    ).equals(403)
    for (const change of [
      null,
      { title: '' },
      { status: 'final' },
      { startAt: 'bad' },
      { endAt: startAt },
      { latitude: 0 },
      { timezone: 'bad' }
    ]) {
      expect(
        (await f.h.request('PUT', `/events/${id}/info`, change)).status
      ).equals(400)
    }
    const edited = await f.h.request('PUT', `/events/${id}/info`, {
      title: 'Team picnic',
      status: 'cancelled',
      venue: 'Demo Park',
      timezone: 'America/Los_Angeles',
      address: '2 Demo Way',
      startAt: '2027-04-10T17:00:00Z'
    })
    expect(edited.status).equals(200)
    expect(await edited.json()).includes({
      title: 'Team picnic',
      status: 'cancelled',
      latitude: null,
      longitude: null
    })
    const unchanged = await f.h.request('PUT', `/events/${id}/info`, {})
    expect(unchanged.status).equals(200)
    expect(
      (
        await f.h.request('PUT', `/events/${id}/info`, {
          startAt: '2027-04-11T18:00:00Z'
        })
      ).status
    ).equals(400)
    const location = await f.h.request('PUT', `/events/${id}/info`, {
      latitude: 0,
      longitude: 0
    })
    expect(location.status).equals(200)
    expect(
      (await (await f.h.request('GET', `/events/${id}/location`)).json())
        .latitude
    ).equals(0)
  })
  it('edits game location/end without bypassing the game approval boundary', async () => {
    const response = await f.h.request('PUT', `/events/${gameId}/info`, {
      endAt,
      address: '1 Demo Way',
      latitude: 0,
      longitude: 0
    })
    expect(response.status).equals(200)
    expect(await response.json()).includes({
      endAt,
      address: '1 Demo Way',
      latitude: 0
    })
    expect(
      await (await f.h.request('GET', `/events/${gameId}/location`)).json()
    ).includes({ latitude: 0, longitude: 0 })
    expect(
      (await f.h.request('PUT', `/events/${gameId}/info`, { startAt })).status
    ).equals(400)
    expect(
      (await f.h.request('PUT', `/events/${gameId}/info`, { endAt }, 104))
        .status
    ).equals(403)
    expect(
      (
        await f.h.request('PUT', `/events/${gameId}/info`, {
          address: null,
          endAt: null
        })
      ).status
    ).equals(200)
    expect(
      await (await f.h.request('GET', `/events/${gameId}/location`)).json()
    ).includes({ latitude: null, longitude: null })
    await f.h.db
      .updateTable('games')
      .set({ home_score: 0, away_score: 0, scoringOwner: 'teamstation' })
      .where('id', '=', gameId)
      .execute()
    expect(
      (await (await f.h.request('GET', `/games/${gameId}`)).json())
        .hasScoringEvents
    ).equals(false)
    await f.h.db
      .updateTable('games')
      .set({ currentPlay: { teamStation: { actions: [{ type: 'pitch' }] } } })
      .where('id', '=', gameId)
      .execute()
    expect(
      (await (await f.h.request('GET', `/games/${gameId}`)).json())
        .hasScoringEvents
    ).equals(true)
  })
  it('declares its routes and exercises the API client against real responses', async () => {
    const client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)
    })
    const id = (
      await client.createTeamEvent({
        ...body(),
        status: 'scheduled',
        timezone: 'UTC',
        venue: null
      })
    ).id
    expect((await client.eventInfo(id)).title).equals('Team dinner')
    expect((await client.saveRsvp(id, 104, 'maybe')).response).equals('maybe')
    expect(
      (await client.updateEventInfo(id, { title: 'Team lunch' })).title
    ).equals('Team lunch')
    expect((await client.eventLocation(id)).latitude).equals(0)
    const paths = openApiDocument('https://example.test').paths
    for (const path of [
      '/events/{id}/info',
      '/events/{id}/location',
      '/events/{id}/rsvps/{userId}'
    ])
      expect(paths).property(path)
    expect(paths['/events']).property('post')
  })
  it('enforces database coordinates/end/reply constraints and supports migration rollback', async () => {
    const id = await create()
    for (const query of [
      sql`update team_events set end_at = start_at where id=${id}`,
      sql`update team_events set latitude=100 where id=${id}`,
      sql`insert into team_event_rsvps(event_id,user_id,response) values(${id},101,'invalid')`
    ]) {
      try {
        await query.execute(f.h.db)
        expect.fail('constraint should reject')
      } catch (error) {
        expect(String(error)).includes('constraint')
      }
    }
    await sql.raw(migration055EventInfo.down).execute(f.h.db)
    await sql.raw(migration055EventInfo.up).execute(f.h.db)
    expect(await f.h.db.selectFrom('team_events').selectAll().execute()).length(
      0
    )
  })
})
