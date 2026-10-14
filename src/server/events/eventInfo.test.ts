import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { makeId } from '../../common/ids'
import { migration057EventInfo } from '../../migrate/migrations/057eventInfo'
import { seedEventInfo2People } from '../../test/eventInfo2Fixture'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { mergeTeams } from '../admin/mergeTeams'
import { closeInto } from '../admin/people'
import { recordExternalId } from '../db/externalIds'
import { openApiDocument } from '../openapi'
import { eventInfoRoutes } from '../routes/eventInfo'

describe('real event info and guardian attendance', function () {
  this.timeout(60000)
  let f: GroupFixture
  let locationQueries: string[]
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
    locationQueries = []
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use(
        '/api/v1/fixture',
        eventInfoRoutes(db, media, {
          googleMapsApiKey: 'example-browser-display-key',
          geocoder: {
            lookup: async address => {
              locationQueries.push(address)
              return { latitude: 12, longitude: 34 }
            }
          }
        })
      )
    })
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
  it('calls an untitled practice Practice, and keeps every other event titled', async () => {
    const { title, ...untitled } = body()
    const created = await f.h.request('POST', '/events', {
      ...untitled,
      eventType: 'practice',
      idempotencyKey: 'untitled-practice'
    })
    expect(created.status, await created.clone().text()).equals(201)
    const { id } = (await created.json()) as { id: string }
    const stored = async (): Promise<{ title: string; event_type: string }> =>
      await f.h.db
        .selectFrom('team_events')
        .select(['title', 'event_type'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    expect(await stored()).deep.equals({
      title: 'Practice',
      event_type: 'practice'
    })
    // Clearing a practice's title calls it Practice again.
    expect(
      (await f.h.request('PUT', `/events/${id}/info`, { title: 'Drills' }))
        .status
    ).equals(200)
    expect((await stored()).title).equals('Drills')
    expect(
      (await f.h.request('PUT', `/events/${id}/info`, { title: '' })).status
    ).equals(200)
    expect((await stored()).title).equals('Practice')
    // An Other event needs a title, made or changed into one.
    expect(
      (
        await f.h.request('PUT', `/events/${id}/info`, {
          title: '',
          eventType: 'other'
        })
      ).status
    ).equals(400)
    // Called Practice only by default, it has no title to become Other with.
    expect(
      (await f.h.request('PUT', `/events/${id}/info`, { eventType: 'other' }))
        .status
    ).equals(400)
    expect(
      (
        await f.h.request('PUT', `/events/${id}/info`, {
          eventType: 'other',
          title: 'Team dinner'
        })
      ).status
    ).equals(200)
    expect(await stored()).deep.equals({
      title: 'Team dinner',
      event_type: 'other'
    })
    expect(
      (
        await f.h.request('POST', '/events', {
          ...untitled,
          eventType: 'other',
          idempotencyKey: 'untitled-other'
        })
      ).status
    ).equals(400)
    expect(title).equals('Team dinner')
  })
  it('maps legacy venues with locality and keeps explicit address coordinates authoritative', async () => {
    const path = `/fixture/events/${gameId}/location`
    expect(await (await f.h.request('GET', path)).json()).includes({
      latitude: null,
      longitude: null,
      googleMapsApiKey: 'example-browser-display-key'
    })
    await f.h.db
      .updateTable('games')
      .set({ venue: 'Demo Park', latitude: 0, longitude: 0 })
      .where('id', '=', gameId)
      .execute()
    expect(await (await f.h.request('GET', path)).json()).includes({
      latitude: 12,
      longitude: 34
    })
    expect(locationQueries).deep.equals([
      'Demo Park, Demo City, Demo Region, US'
    ])
    await f.h.db
      .updateTable('games')
      .set({
        address: '1 Demo Way, Demo City',
        latitude: null,
        longitude: null
      })
      .where('id', '=', gameId)
      .execute()
    await f.h.request('GET', path)
    expect(locationQueries[1]).equals('1 Demo Way, Demo City')
    await f.h.db
      .updateTable('games')
      .set({ latitude: 0, longitude: 0 })
      .where('id', '=', gameId)
      .execute()
    expect(await (await f.h.request('GET', path)).json()).includes({
      latitude: 0,
      longitude: 0
    })
    expect(locationQueries).length(2)
    await f.h.db
      .updateTable('games')
      .set({ address: 'Campus Way', latitude: null, longitude: null })
      .where('id', '=', gameId)
      .execute()
    await f.h.request('GET', path)
    expect(locationQueries[2]).equals('Campus Way')
    await f.h.db
      .updateTable('games')
      .set({ address: '2 Visitor Way, Remote City, Remote Region, US' })
      .where('id', '=', gameId)
      .execute()
    await f.h.request('GET', path)
    expect(locationQueries[3]).equals(
      '2 Visitor Way, Remote City, Remote Region, US'
    )
    await f.h.db
      .updateTable('teams')
      .set({ locality: null })
      .where('id', '=', f.teamA)
      .execute()
    await f.h.db
      .updateTable('games')
      .set({
        address: '1 Demo Way, Demo City',
        latitude: null,
        longitude: null
      })
      .where('id', '=', gameId)
      .execute()
    await f.h.request('GET', path)
    expect(locationQueries[4]).equals('1 Demo Way, Demo City')
  })
  it('shows only direct selected-team people with abbreviated profile/guardian details', async () => {
    await seedEventInfo2People(f, gameId)
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'fixtures/player.png' })
      .where('id', '=', 108)
      .execute()
    const read = await info(gameId)
    expect(read.attendees.find(row => row.userId === 108)?.avatarUrl).is.a(
      'string'
    )
    expect(read.teamId).equals(f.teamA)
    expect(read.attendees.map(row => row.userId))
      .not.includes(102)
      .and.not.includes(109)
      .and.not.includes(110)
    expect(read.attendees.find(row => row.userId === 108)).includes({
      name: 'Mookie B',
      isPlayer: true,
      isTeamParticipant: true,
      bats: 'switch',
      throws: 'right'
    })
    expect(
      read.attendees.find(row => row.userId === 108)?.staffRoles
    ).deep.equals(['coach'])
    expect(
      read.attendees.find(row => row.userId === 108)?.positions
    ).deep.equals(['SS', 'CF'])
    expect(
      read.attendees.find(row => row.userId === 105)?.guardianOf
    ).deep.equals(['Mike T'])
    expect(read.attendees.find(row => row.userId === 101)?.name).equals(
      'Babe R'
    )
    expect(read.attendees.find(row => row.userId === 115)).includes({
      name: 'Alex R',
      canReply: true,
      isTeamParticipant: false
    })
    expect(
      (await info(gameId, 109)).attendees.find(row => row.userId === 109)
    ).includes({ canReply: true, isTeamParticipant: false, response: 'yes' })
    const away = await info(gameId, 102)
    expect(away.teamId).equals(f.teamB)
    expect(
      away.attendees
        .filter(row => row.isTeamParticipant === true)
        .map(row => row.userId)
    ).deep.equals([102])
    const client = new TeamStationClient({
      baseUrl: `${f.h.origin}/api/v1`,
      token: f.h.tokens.get(105)!
    })
    const selected = await client.eventInfo(gameId, f.teamB)
    expect(selected.teamId).equals(f.teamB)
    expect(
      selected.attendees
        .filter(row => row.isTeamParticipant === true)
        .map(row => row.userId)
    ).deep.equals([102])
    for (const query of [
      `?teamId=${f.standaloneTeam}`,
      '?teamId=missing',
      '?teamId=',
      `?teamId=${f.teamA}&teamId=${f.teamB}`
    ])
      expect(
        (await f.h.request('GET', `/events/${gameId}/info${query}`)).status
      ).oneOf([400, 404])
    expect(
      (
        await f.h.request(
          'GET',
          `/events/${gameId}/info?teamId=${f.teamB}`,
          undefined,
          109
        )
      ).status
    ).equals(404)
  })
  it('adds batched player counts only to private team schedules and follows roster/reply changes', async () => {
    await seedEventInfo2People(f, gameId)
    const schedule = async (): Promise<
      Array<{
        id: string
        playerRsvps?: { yes: number; unknown: number; no: number }
      }>
    > => await (await f.h.request('GET', `/teams/${f.teamA}/games`)).json()
    expect(
      (await schedule()).find(row => row.id === gameId)?.playerRsvps
    ).deep.equals({ yes: 1, unknown: 4, no: 0 })
    await f.h.request(
      'PUT',
      `/events/${gameId}/rsvps/103`,
      { response: 'no' },
      101
    )
    expect(
      (await schedule()).find(row => row.id === gameId)?.playerRsvps
    ).deep.equals({ yes: 1, unknown: 3, no: 1 })
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', 108)
      .execute()
    expect(
      (await schedule()).find(row => row.id === gameId)?.playerRsvps
    ).deep.equals({ yes: 0, unknown: 3, no: 1 })
    const dinner = await create()
    expect(
      (await schedule()).find(row => row.id === dinner)?.playerRsvps
    ).deep.equals({ yes: 0, unknown: 4, no: 0 })
    await f.h.request(
      'PUT',
      `/events/${dinner}/rsvps/104`,
      { response: 'yes' },
      101
    )
    expect(
      (await schedule()).find(row => row.id === dinner)?.playerRsvps
    ).deep.equals({ yes: 1, unknown: 3, no: 0 })
    await closeInto(f.h.db, 113, 114)
    expect(
      (await schedule()).find(row => row.id === gameId)?.playerRsvps
    ).deep.equals({ yes: 0, unknown: 2, no: 1 })
    expect(
      (await schedule()).find(row => row.id === dinner)?.playerRsvps
    ).deep.equals({ yes: 1, unknown: 2, no: 0 })
    const general = (await (
      await f.h.request('GET', '/events')
    ).json()) as Array<{ playerRsvps?: unknown }>
    expect(general.every(row => row.playerRsvps === undefined)).equals(true)
    const publicRows = (await (
      await f.h.request('GET', `/teams/${f.teamA}/games`, undefined, 102)
    ).json()) as Array<{ playerRsvps?: unknown }>
    expect(publicRows.every(row => row.playerRsvps === undefined)).equals(true)
  })
  it('marks direct coach/member and guardian affiliations without counting inherited visibility', async () => {
    await seedEventInfo2People(f, gameId)
    for (const [user, expected] of [
      [101, [f.teamA]],
      [102, [f.teamB]],
      [105, [f.teamA]],
      [109, []]
    ] as const) {
      const read = await info(gameId, user)
      expect(
        (read.attendanceTeams ?? [])
          .filter(t => t.isParticipant === true)
          .map(t => t.id)
      ).deep.equals(expected)
    }
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: 105,
        team_id: f.teamB,
        is_player: false
      })
      .execute()
    const both = await info(gameId, 105)
    expect(
      (both.attendanceTeams ?? [])
        .filter(t => t.isParticipant === true)
        .map(t => t.id)
    ).members([f.teamA, f.teamB])
    const client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(105)!
    })
    expect(
      (await client.eventInfo(gameId)).attendanceTeams!.every(
        t => t.isParticipant === true
      )
    ).equals(true)
  })
  it('defaults to the team a viewer has most to do with: a point each for guardian, staff and member', async () => {
    await seedEventInfo2People(f, gameId)
    const member = async (
      userId: number,
      teamId: string,
      isPlayer = false
    ): Promise<void> => {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          is_player: isPlayer
        })
        .execute()
    }
    const guardian = async (child: number): Promise<void> => {
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: 107,
          related_user_id: child,
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    }
    // A member of the home team; then of the away team too, a tie that keeps
    // the game's own order.
    expect((await info(gameId, 107)).teamId).equals(f.teamA)
    await member(107, f.teamB)
    expect((await info(gameId, 107)).teamId).equals(f.teamA)
    // Coaching away as well: two points to one.
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: 107,
        scope_type: 'team',
        scope_id: f.teamB,
        role: 'coach'
      })
      .execute()
    expect((await info(gameId, 107)).teamId).equals(f.teamB)
    // Guardian of a home player: two each, and home again.
    await guardian(108)
    expect((await info(gameId, 107)).teamId).equals(f.teamA)
    // That child playing away too gives away all three points.
    await member(108, f.teamB, true)
    const read = await info(gameId, 107)
    expect(read.teamId).equals(f.teamB)
    expect(
      (read.attendanceTeams ?? [])
        .filter(team => team.isParticipant === true)
        .map(team => team.id)
    ).members([f.teamA, f.teamB])
    // Asking for a team still answers that team.
    expect(
      asEventInfo(
        await (
          await f.h.request(
            'GET',
            `/events/${gameId}/info?teamId=${f.teamA}`,
            undefined,
            107
          )
        ).json()
      ).teamId
    ).equals(f.teamA)
  })
  it('drops removed team people and disabled players’ guardians without widening from old replies', async () => {
    await seedEventInfo2People(f, gameId)
    await f.h.db.deleteFrom('scope_roles').where('user_id', '=', 106).execute()
    await f.h.db.deleteFrom('memberships').where('user_id', '=', 107).execute()
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', 103)
      .execute()
    const read = await info(gameId)
    expect(read.attendees.map(row => row.userId))
      .not.includes(105)
      .and.not.includes(106)
      .and.not.includes(107)
    expect(read.replyUserIds).not.includes(103)
    expect(
      read.attendees.find(row => row.userId === 101)?.staffRoles
    ).deep.equals(['admin'])
  })
  it('never defaults a season viewer to an inaccessible participating roster', async () => {
    await seedEventInfo2People(f, gameId)
    const hosted = 'gam_private_guests'
    await f.h.db
      .insertInto('games')
      .values({
        id: hosted,
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam,
        season_id: f.seasonA,
        start_at: new Date(startAt)
      })
      .execute()
    const privateControls = await info(hosted, 109)
    expect(privateControls.attendanceTeams).deep.equals([])
    expect(privateControls.attendees.map(row => row.userId)).deep.equals([109])
    expect(privateControls.attendees[0]).includes({
      canReply: true,
      isTeamParticipant: false
    })
    expect(
      (
        await f.h.request(
          'GET',
          `/events/${hosted}/info?teamId=${f.teamB}`,
          undefined,
          109
        )
      ).status
    ).equals(404)
    await f.h.db
      .updateTable('games')
      .set({ away_team_id: f.teamA })
      .where('id', '=', hosted)
      .execute()
    expect((await info(hosted, 109)).teamId).equals(f.teamA)
  })
  it('defaults to the viewer’s direct team while keeping a guardian control for a non-player elsewhere', async () => {
    await seedEventInfo2People(f, gameId)
    await f.h.db
      .updateTable('memberships')
      .set({ is_player: false })
      .where('team_id', '=', f.teamA)
      .where('user_id', '=', 103)
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamB,
        user_id: 109,
        is_player: false
      })
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: 109,
        related_user_id: 103,
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    const read = await info(gameId, 109)
    expect(read.teamId).equals(f.teamB)
    expect(read.attendees.find(row => row.userId === 103)).includes({
      canReply: true,
      isTeamParticipant: false
    })
    const home = asEventInfo(
      await (
        await f.h.request(
          'GET',
          `/events/${gameId}/info?teamId=${f.teamA}`,
          undefined,
          109
        )
      ).json()
    )
    expect(home.attendees.find(row => row.userId === 109)).includes({
      canReply: true,
      isTeamParticipant: false
    })
  })
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
    const visitor = await (
      await f.h.request('GET', `/teams/${f.teamA}/games`, undefined, 106)
    ).json()
    expect(visitor.map((row: { id: string }) => row.id))
      .includes(gameId)
      .and.not.includes(id)
    expect(JSON.stringify(visitor)).not.includes('Team dinner')
    expect(JSON.stringify(visitor)).not.includes(body().address)
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
  it('keeps out-of-team child controls private to their guardians', async () => {
    const id = await create()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: 101,
        related_user_id: 106,
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    expect((await info(id)).replyUserIds).includes(106)
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/106`, { response: 'yes' }))
        .status
    ).equals(200)
    expect(
      (await info(id)).attendees.find(row => row.userId === 106)?.response
    ).equals('yes')
    expect(
      (await info(id)).attendees.find(row => row.userId === 106)
        ?.isTeamParticipant
    ).equals(false)
    expect((await info(id, 103)).attendees.map(row => row.userId)).not.includes(
      106
    )
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: 104,
        related_user_id: 106,
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    await f.h.db
      .deleteFrom('user_links')
      .where('user_id', '=', 101)
      .where('related_user_id', '=', 106)
      .execute()
    expect(
      (await info(id, 104)).attendees.find(row => row.userId === 106)?.response
    ).equals('yes')
    await f.h.db
      .deleteFrom('user_links')
      .where('related_user_id', '=', 106)
      .execute()
    expect((await info(id, 103)).attendees.map(row => row.userId)).not.includes(
      106
    )
    expect(
      (await f.h.request('PUT', `/events/${id}/rsvps/106`, { response: 'no' }))
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
  it('projects canonical guardians before they reply when children and parents have merged aliases', async () => {
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: 106,
        related_user_id: 103,
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    for (const role of await f.h.db
      .selectFrom('scope_roles')
      .selectAll()
      .where('user_id', '=', 103)
      .execute())
      await f.h.db
        .insertInto('scope_roles')
        .values({ ...role, id: makeId('scopeRole'), user_id: 105 })
        .execute()
    await closeInto(f.h.db, 103, 104)
    await closeInto(f.h.db, 106, 105)
    const other = await info(gameId)
    expect(other.attendees.find(row => row.userId === 105)).includes({
      response: null,
      canReply: false
    })
    expect(other.attendees.filter(row => row.userId === 104)).length(1)
    expect(other.attendees.map(row => row.userId))
      .not.includes(103)
      .and.not.includes(106)
    expect((await info(gameId, 105)).replyUserIds).deep.equals([105, 104])
  })
  it('keeps the latest saved child and guardian responses across account aliases in both RSVP tables', async () => {
    const titled = await create()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: 106,
        related_user_id: 103,
        kind: 'guardian',
        can_manage: false
      })
      .execute()
    for (const id of [gameId, titled]) {
      expect(
        (
          await f.h.request('PUT', `/events/${id}/rsvps/103`, {
            response: 'yes'
          })
        ).status
      ).equals(200)
      expect(
        (
          await f.h.request('PUT', `/events/${id}/rsvps/104`, {
            response: 'maybe'
          })
        ).status
      ).equals(200)
      expect(
        (
          await f.h.request(
            'PUT',
            `/events/${id}/rsvps/106`,
            { response: 'maybe' },
            106
          )
        ).status
      ).equals(200)
      expect(
        (
          await f.h.request(
            'PUT',
            `/events/${id}/rsvps/105`,
            { response: 'yes' },
            105
          )
        ).status
      ).equals(200)
      const table = id === gameId ? 'game_rsvps' : 'team_event_rsvps'
      await f.h.db
        .updateTable(table)
        .set({ updated_at: new Date('2025-01-01T00:00:00Z') })
        .where('event_id', '=', id)
        .execute()
      await f.h.db
        .updateTable(table)
        .set({ updated_at: new Date('2025-01-02T00:00:00Z') })
        .where('event_id', '=', id)
        .where('user_id', 'in', [104, 106])
        .execute()
    }
    for (const role of await f.h.db
      .selectFrom('scope_roles')
      .selectAll()
      .where('user_id', '=', 103)
      .execute())
      await f.h.db
        .insertInto('scope_roles')
        .values({ ...role, id: makeId('scopeRole'), user_id: 105 })
        .execute()
    await closeInto(f.h.db, 103, 104)
    await closeInto(f.h.db, 106, 105)
    for (const id of [gameId, titled]) {
      const rows = (await info(id)).attendees
      expect(rows.filter(row => row.userId === 104)).length(1)
      expect(rows.find(row => row.userId === 104)?.response).equals('maybe')
      expect(rows.find(row => row.userId === 105)?.response).equals('maybe')
      expect(rows.map(row => row.userId))
        .not.includes(103)
        .and.not.includes(106)
      expect(
        (
          await f.h.request('PUT', `/events/${id}/rsvps/104`, {
            response: 'no'
          })
        ).status
      ).equals(200)
      expect(
        (await info(id)).attendees.find(row => row.userId === 104)?.response
      ).equals('no')
    }
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
  it('returns game time and location to a read-only visitor without exposing attendance or accepting RSVPs', async () => {
    await f.h.request('PUT', `/events/${gameId}/info`, {
      address: '1 Demo Way',
      latitude: 0,
      longitude: 0
    })
    const read = await info(gameId, 106)
    expect(read).includes({
      address: '1 Demo Way',
      canViewAttendance: false,
      canManage: false
    })
    expect(read.attendees).deep.equals([])
    expect(read.replyUserIds).deep.equals([])
    expect(
      (
        await f.h.request(
          'PUT',
          `/events/${gameId}/rsvps/106`,
          { response: 'yes' },
          106
        )
      ).status
    ).equals(404)
  })
  it('preserves duration through the real batch rescheduling route', async () => {
    await f.h.db
      .updateTable('games')
      .set({ end_at: new Date(endAt) })
      .where('id', '=', gameId)
      .execute()
    await f.h.db.transaction().execute(
      async trx =>
        await recordExternalId(trx, 'game', gameId, {
          system: 'demo',
          kind: '',
          id: 'event-duration'
        })
    )
    for (const start of ['2027-04-11T18:00:00Z', '2027-04-09T18:00:00Z']) {
      const changed = await f.h.request(
        'POST',
        `/teams/${f.teamA}/games`,
        {
          games: [
            {
              startAt: start,
              externalId: { system: 'demo', id: 'event-duration' }
            }
          ]
        },
        105
      )
      expect(changed.status).equals(200)
      expect((await changed.json()).results[0].result).equals('updated')
      const held = await f.h.db
        .selectFrom('games')
        .select(['start_at', 'end_at'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      expect(held.start_at.toISOString()).equals(new Date(start).toISOString())
      expect(held.end_at!.getTime() - held.start_at.getTime()).equals(
        2 * 3600_000
      )
    }
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
    await sql.raw(migration057EventInfo.down).execute(f.h.db)
    await sql.raw(migration057EventInfo.up).execute(f.h.db)
    expect(await f.h.db.selectFrom('team_events').selectAll().execute()).length(
      0
    )
  })
  it('keeps title events, game locations and latest RSVPs when duplicate teams and fixtures merge', async () => {
    const id = await create()
    const made = await f.h.request('POST', '/teams', {
      name: 'Demo Hawks Copy',
      parent: { kind: 'season', id: f.seasonA },
      locality: {
        city: 'Demo City',
        region: 'Demo Region',
        country: 'US',
        placeId: null,
        timezone: 'UTC'
      },
      idempotencyKey: 'event-merge-team'
    })
    expect(made.status).equals(201)
    const target: string = (await made.json()).id
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_info_duplicate',
        home_team_id: target,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(startAt),
        end_at: new Date(endAt),
        address: '1 Demo Way',
        latitude: 0,
        longitude: 0
      })
      .execute()
    await f.h.db
      .insertInto('game_rsvps')
      .values([
        {
          event_id: gameId,
          user_id: 101,
          response: 'no',
          updated_by: 101,
          updated_at: new Date('2027-01-01T00:00:00Z')
        },
        {
          event_id: 'gam_info_duplicate',
          user_id: 101,
          response: 'yes',
          updated_by: 101,
          updated_at: new Date('2027-01-02T00:00:00Z')
        }
      ])
      .execute()
    await mergeTeams(f.h.db, {
      fromTeamId: f.teamA,
      intoTeamId: target,
      apply: true
    })
    expect((await info(id, 103)).teamId).equals(target)
    expect(
      (
        await (
          await f.h.request(
            'GET',
            `/events/${id}/info?teamId=${f.teamA}`,
            undefined,
            103
          )
        ).json()
      ).teamId
    ).equals(target)
    expect((await info(id, 103)).title).equals('Team dinner')
    const survivor = await f.h.db
      .selectFrom('games')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(survivor.address).equals('1 Demo Way')
    const replies = await f.h.db.selectFrom('game_rsvps').selectAll().execute()
    expect(replies).length(1)
    expect(replies[0]).includes({
      user_id: 101,
      response: 'yes',
      event_id: survivor.id
    })
  })
})
