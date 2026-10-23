import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import { userIdOfGumbo } from '../../common/userId'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { gameVersion, materialGame } from '../schedule/gameApprovals'
import { gameFieldWarnings, refreshFieldWarnings } from './fieldWarnings'
import { collides, occupancy } from './occupancy'

const VENUE = 'ven_games'
const FIELD = 'fld_games'
const SINGLE = 'fld_single'
const ALL_DAY = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  start: '00:00',
  end: '24:00'
}))
// 2029-07-07 is a Saturday, in daylight time in New York (UTC-4).
const AT = (hour: number): string =>
  `2029-07-07T${String(hour + 4).padStart(2, '0')}:00:00.000Z`

describe('games on registry fields', function () {
  this.timeout(120000)
  let f: GroupFixture
  let teamC: string
  const request = async <T = any>(
    method: string,
    path: string,
    body?: unknown,
    user = 101,
    status?: number
  ): Promise<T> => {
    const response = await f.h.request(method, path, body, user)
    const text = await response.text()
    if (status != null) expect(response.status, text).equals(status)
    else expect(response.ok, `${method} ${path}: ${text}`).equals(true)
    return (text === '' ? undefined : JSON.parse(text)) as T
  }
  const intent = (overrides: Partial<GameIntent> = {}): GameIntent => ({
    homeTeamId: f.teamA,
    awayTeamId: teamC,
    seasonId: f.seasonA,
    startAt: AT(10),
    endAt: AT(12),
    venue: 'Typed Venue',
    outsideTournament: null,
    status: 'scheduled',
    ...overrides
  })
  let key = 0
  const propose = async (
    game: Partial<GameIntent>,
    extra: Record<string, unknown> = {},
    user = 101,
    status?: number
  ): Promise<any> =>
    await request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: intent(game),
        idempotencyKey: `fields-${++key}`,
        ...extra
      },
      user,
      status
    )
  const gameRow = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const scheduling = async (id: string): Promise<any> =>
    await request('GET', `/games/${id}/scheduling`)
  const change = async (
    id: string,
    game: Partial<GameIntent>,
    status?: number
  ): Promise<any> => {
    const current = await scheduling(id)
    return await request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId: id,
        expected: current.version,
        game: { ...current.game, ...game },
        idempotencyKey: `fields-${++key}`
      },
      101,
      status
    )
  }
  const warningKinds = async (id: string): Promise<string[]> =>
    (await gameFieldWarnings(f.h.db, id, f.clock)).map(w => w.kind).sort()

  beforeEach(async () => {
    f = await groupFixture()
    const created = await request('POST', '/teams', {
      name: 'Demo Comets',
      idempotencyKey: 'fields-team-c',
      locality: demoLocality,
      parent: { kind: 'season', id: f.seasonA }
    })
    teamC = created.id
    for (const id of [f.teamA, teamC])
      await f.h.db
        .insertInto('season_teams')
        .values({ season_id: f.seasonA, team_id: id, active: true })
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
    await f.h.db
      .insertInto('venues')
      .values({
        id: VENUE,
        google_place_id: 'place-games',
        name: 'Example Park',
        address: '1 Example Way, Demo City',
        latitude: 40.02,
        longitude: -75.22,
        timezone: 'America/New_York',
        size_switch_minutes: 30,
        default_hours: JSON.stringify(ALL_DAY)
      })
      .execute()
    await f.h.db
      .insertInto('venue_fields')
      .values([
        {
          id: FIELD,
          venue_id: VENUE,
          name: 'Field 1',
          sizes: ['46/60', '50/70'],
          pin_latitude: 40.021,
          pin_longitude: -75.221
        },
        { id: SINGLE, venue_id: VENUE, name: 'Field 2', sizes: ['60/90'] }
      ])
      .execute()
    // Example Park belongs to leagueA, so 101 may edit its fields.
    await f.h.db
      .insertInto('venue_claims')
      .values({
        id: 'vcl_games',
        venue_id: VENUE,
        league_id: f.leagueA,
        kind: 'claim',
        requested_by: (
          await f.h.db
            .selectFrom('users')
            .select('id')
            .where('is_admin', '=', true)
            .executeTakeFirstOrThrow()
        ).id,
        status: 'approved',
        requested_at: new Date(),
        approves_at: new Date(Date.now() + 1000),
        decided_at: new Date()
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  it('links a game to a field, taking its venue, address and pin, and checks a field it sets', async () => {
    const sent = await propose({ fieldId: FIELD, fieldSize: '50/70' })
    expect(sent.status).equals('accepted')
    const row = await gameRow(sent.gameId)
    expect(row).include({
      field_id: FIELD,
      field_size: '50/70',
      venue: 'Example Park',
      address: '1 Example Way, Demo City',
      latitude: 40.021,
      longitude: -75.221
    })
    // A field with one size takes it when none is chosen.
    const single = await propose({
      fieldId: SINGLE,
      startAt: AT(14),
      endAt: AT(16)
    })
    expect((await gameRow(single.gameId)).field_size).equals('60/90')
    for (const [game, message] of [
      [{ fieldId: FIELD }, 'Choose the size'],
      [{ fieldId: FIELD, fieldSize: '60/90' }, 'cannot be set up as 60/90'],
      [{ fieldId: 'fld_missing', fieldSize: '50/70' }, 'still in the registry'],
      [{ fieldId: null, fieldSize: '50/70' }, 'needs a field'],
      [{ fieldId: FIELD, fieldSize: '70/100' }, 'Choose a field size'],
      [{ fieldId: 7 as unknown as string }, 'Choose a field']
    ] as const) {
      const refused = await propose(game, {}, 101, 400)
      expect(refused.message, JSON.stringify(game)).includes(message)
    }
  })

  it('keeps a field-less game’s version, and versions and returns a field', async () => {
    const plain = await propose({})
    const row = await gameRow(plain.gameId)
    const material = materialGame(row)
    expect(Object.keys(material)).not.includes('fieldId')
    expect((await scheduling(plain.gameId)).field).equals(null)
    const linked = await change(plain.gameId, {
      fieldId: FIELD,
      fieldSize: '46/60'
    })
    expect(linked.status).equals('accepted')
    const read = await scheduling(plain.gameId)
    expect(read.game).include({ fieldId: FIELD, fieldSize: '46/60' })
    expect(read.field).deep.equals({
      venueId: VENUE,
      venueName: 'Example Park',
      fieldId: FIELD,
      fieldName: 'Field 1',
      size: '46/60',
      address: '1 Example Way, Demo City'
    })
    expect(read.version).not.equals(gameVersion(material))
  })

  it('keeps the field when an edit leaves it out, clears it on null, and edits a game whose field was deleted', async () => {
    const sent = await propose({ fieldId: FIELD, fieldSize: '50/70' })
    const id = sent.gameId as string
    const current = await scheduling(id)
    const { fieldId, fieldSize, ...withoutField } = current.game
    expect([fieldId, fieldSize]).deep.equals([FIELD, '50/70'])
    await request('POST', '/game-requests', {
      sender: { kind: 'team', id: f.teamA },
      gameId: id,
      expected: current.version,
      game: { ...withoutField, notes: 'Bring water' },
      idempotencyKey: `fields-${++key}`
    })
    expect(await gameRow(id)).include({ field_id: FIELD, notes: 'Bring water' })
    // Left out, the field is kept, and so is the place it gives the game:
    // another venue or address sent with it does not move the game.
    const kept = await scheduling(id)
    const { fieldId: _keptField, fieldSize: _keptSize, ...keptGame } = kept.game
    await request('POST', '/game-requests', {
      sender: { kind: 'team', id: f.teamA },
      gameId: id,
      expected: kept.version,
      game: {
        ...keptGame,
        venue: 'Somewhere Else',
        address: '9 Elsewhere Road',
        latitude: 41,
        longitude: -74
      },
      idempotencyKey: `fields-${++key}`
    })
    expect(await gameRow(id)).include({
      field_id: FIELD,
      venue: 'Example Park',
      address: '1 Example Way, Demo City',
      latitude: 40.021,
      longitude: -75.221
    })
    await request('DELETE', `/venues/${VENUE}/fields/${FIELD}`)
    expect(await warningKinds(id)).deep.equals(['fieldDeleted'])
    // Still editable on its deleted field.
    await change(id, { startAt: AT(11), endAt: AT(13) })
    expect((await gameRow(id)).start_at.toISOString()).equals(AT(11))
    await change(id, { fieldId: null, fieldSize: null })
    expect(await gameRow(id)).include({ field_id: null, field_size: null })
    expect(await warningKinds(id)).deep.equals([])
  })

  it('warns of overlaps, of the size switch time and of hours, only on upcoming games, and tells both teams once', async () => {
    const first = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    // Back to back at noon in another size: the 30-minute switch collides.
    const second = (
      await propose({
        fieldId: FIELD,
        fieldSize: '46/60',
        startAt: AT(12),
        endAt: AT(14)
      })
    ).gameId as string
    expect(await warningKinds(first)).deep.equals(['conflict'])
    const [warning] = await gameFieldWarnings(f.h.db, second, f.clock)
    expect(warning.message).includes('too close to this one to change')
    const notices = await f.h.db
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'fieldWarning')
      .execute()
    expect(notices).length(2)
    expect((notices[0].metadata as any).gameId).not.equals(undefined)
    // Refreshing again tells nobody anything new.
    await refreshFieldWarnings(f.h.db, [FIELD], f.clock)
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'fieldWarning')
        .execute()
    ).length(2)
    // The same size touches without colliding.
    await change(second, { fieldSize: '50/70' })
    expect(await warningKinds(first)).deep.equals([])
    expect(await warningKinds(second)).deep.equals([])
    // Hours that no longer cover the game.
    await request('PUT', `/venues/${VENUE}/fields/${FIELD}`, {
      hours: [{ weekday: 6, start: '08:00', end: '11:00' }]
    })
    expect(await warningKinds(first)).deep.equals(['outsideAvailability'])
    const outside = await f.h.db
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'fieldWarning')
      .execute()
    expect(outside.map(n => (n.metadata as any).kind)).includes(
      'outsideAvailability'
    )
    // A completed game, or a cancelled one, has none.
    await f.h.db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', first)
      .execute()
    expect(await warningKinds(first)).deep.equals([])
    expect(await gameFieldWarnings(f.h.db, 'gam_missing', f.clock)).deep.equals(
      []
    )
  })

  it('warns when the field can no longer be set up in the game’s size, and tells both teams', async () => {
    const id = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    expect(await warningKinds(id)).deep.equals([])
    await request('PUT', `/venues/${VENUE}/fields/${FIELD}`, {
      sizes: ['46/60']
    })
    expect(await warningKinds(id)).deep.equals(['sizeRemoved'])
    const [warning] = await gameFieldWarnings(f.h.db, id, f.clock)
    expect(warning.message).equals(
      'Field 1 at Example Park can no longer be set up as 50/70. Choose another field or size for this game.'
    )
    const notices = await f.h.db
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'fieldWarning')
      .execute()
    expect(notices.map(n => (n.metadata as any).kind)).deep.equals([
      'sizeRemoved'
    ])
    // Set up in that size again, the warning clears.
    await request('PUT', `/venues/${VENUE}/fields/${FIELD}`, {
      sizes: ['46/60', '50/70']
    })
    expect(await warningKinds(id)).deep.equals([])
  })

  it('forgets a told warning once its game is played, looking only at upcoming games otherwise', async () => {
    const id = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    await request('PUT', `/venues/${VENUE}/fields/${FIELD}`, {
      sizes: ['46/60']
    })
    const told = async (): Promise<string[]> =>
      (
        await f.h.db
          .selectFrom('game_field_warnings')
          .select('kind')
          .where('game_id', '=', id)
          .execute()
      ).map(row => row.kind)
    expect(await told()).deep.equals(['sizeRemoved'])
    await f.h.db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', id)
      .execute()
    await refreshFieldWarnings(f.h.db, [FIELD], f.clock)
    expect(await told()).deep.equals([])
  })

  it('moves an upcoming game with its venue’s new name and its field’s new pin', async () => {
    const id = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    expect(await gameRow(id)).include({
      venue: 'Example Park',
      latitude: 40.021,
      longitude: -75.221
    })
    await request('PUT', `/venues/${VENUE}`, { name: 'Example Fields' })
    expect((await gameRow(id)).venue).equals('Example Fields')
    await request('PUT', `/venues/${VENUE}/fields/${FIELD}`, {
      pin: { latitude: 40.023, longitude: -75.224 }
    })
    expect(await gameRow(id)).include({ latitude: 40.023, longitude: -75.224 })
    // A game already played keeps where it was played.
    await f.h.db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', id)
      .execute()
    await request('PUT', `/venues/${VENUE}`, { name: 'Example Grounds' })
    expect((await gameRow(id)).venue).equals('Example Fields')
  })

  it('leaves out bookings that ended before the instant asked from', async () => {
    const id = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    await f.h.db
      .updateTable('games')
      .set({ end_at: null })
      .where('id', '=', id)
      .execute()
    const keys = async (from: string): Promise<string[]> =>
      (
        await occupancy(
          f.h.db,
          { fieldIds: [FIELD], from: new Date(from) },
          f.clock
        )
      ).map(booking => booking.key)
    // It starts at 10 and, with no end, runs the default three hours.
    expect(await keys(AT(9))).deep.equals([id])
    expect(await keys(AT(12))).deep.equals([id])
    expect(await keys(AT(14))).deep.equals([])
  })

  it('counts a pending proposal on the field, and forgets warnings that clear so they are told again', async () => {
    const first = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    // A game with leagueB's team waits for its consent and holds the field.
    const pending = await propose({
      fieldId: FIELD,
      fieldSize: '50/70',
      awayTeamId: f.teamB
    })
    expect(pending.status).equals('pending')
    const held = await occupancy(f.h.db, { fieldIds: [FIELD] }, f.clock)
    expect(
      held.map(b => b.pending).sort((a, b) => Number(a) - Number(b))
    ).deep.equals([false, true])
    expect(await warningKinds(first)).deep.equals(['conflict'])
    await request('POST', `/game-requests/${pending.id}/decline`, {}, 102)
    expect(await warningKinds(first)).deep.equals([])
    expect(
      await f.h.db.selectFrom('game_field_warnings').select('game_id').execute()
    ).deep.equals([])
    const again = await propose({
      fieldId: FIELD,
      fieldSize: '50/70',
      awayTeamId: f.teamB
    })
    await request('POST', `/game-requests/${again.id}/withdraw`, {})
    expect(await warningKinds(first)).deep.equals([])
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'fieldWarning')
        .execute()
    ).length(2)
    // A team's withdrawal ends its game's warnings, and its rival's.
    const rival = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    expect(await warningKinds(first)).deep.equals(['conflict'])
    await request(`POST`, `/games/${rival}/withdrawals`, { teamId: f.teamA })
    expect(await warningKinds(first)).deep.equals([])
    expect(
      collides(
        { start: 0, end: 10, size: null },
        { start: 10, end: 20, size: '50/70' },
        5
      )
    ).equals(false)
  })

  it('refuses an address on a field-linked game’s info, and looks again when its end moves', async () => {
    const first = (await propose({ fieldId: FIELD, fieldSize: '50/70' }))
      .gameId as string
    const second = (
      await propose({
        fieldId: FIELD,
        fieldSize: '50/70',
        startAt: AT(13),
        endAt: AT(15)
      })
    ).gameId as string
    const refused = await request(
      'PUT',
      `/events/${first}/info`,
      { address: 'Elsewhere' },
      101,
      400
    )
    expect(refused.message).includes('Clear the field')
    await request('PUT', `/events/${first}/info`, { endAt: AT(14) })
    expect(await warningKinds(second)).deep.equals(['conflict'])
    const info = await request('GET', `/events/${second}/info`)
    expect(info.fieldWarnings).deep.equals([
      {
        kind: 'conflict',
        message:
          'Another game is booked on Field 1 at Example Park at the same time.'
      }
    ])
    // A game with no field still takes an address.
    const plain = (await propose({ startAt: AT(18), endAt: AT(20) }))
      .gameId as string
    await request('PUT', `/events/${plain}/info`, { address: '9 Demo Road' })
    expect((await gameRow(plain)).address).equals('9 Demo Road')
    expect(
      (await request('GET', `/events/${plain}/info`)).fieldWarnings
    ).deep.equals([])
  })

  it('keeps a batch-scheduled game on its field’s venue, and looks again when the batch moves it', async () => {
    const row = {
      opponent: { teamId: teamC },
      side: 'home',
      seasonId: f.seasonA,
      startAt: AT(10),
      externalId: { system: 'otherLeague', id: 'field-batch-1' }
    }
    const made = await request('POST', `/teams/${f.teamA}/games`, {
      games: [row]
    })
    const id = made.results[0].gameId as string
    await f.h.db
      .updateTable('games')
      .set({ field_id: FIELD, field_size: '50/70', venue: 'Example Park' })
      .where('id', '=', id)
      .execute()
    const other = (
      await propose({
        fieldId: FIELD,
        fieldSize: '50/70',
        startAt: AT(14),
        endAt: AT(16)
      })
    ).gameId as string
    const venue = await request('POST', `/teams/${f.teamA}/games`, {
      games: [{ ...row, venue: 'Somewhere Else' }]
    })
    expect(venue.results[0].result).equals('error')
    expect(venue.results[0].error.message).includes('Clear the field')
    const moved = await request('POST', `/teams/${f.teamA}/games`, {
      games: [{ ...row, startAt: AT(13) }]
    })
    expect(moved.results[0].result).equals('updated')
    expect(await warningKinds(other)).deep.equals(['conflict'])
    // Had the Auto-Scheduler published it, a batch cancellation tells the
    // league's admins, and a rescheduled game can't be brought back.
    await f.h.db
      .insertInto('schedule_previews')
      .values({
        id: 'spv_batch',
        league_id: f.leagueA,
        created_by: userIdOfGumbo(101),
        mode: 'full',
        input: '{}'
      })
      .execute()
    await f.h.db
      .updateTable('games')
      .set({ schedule_preview_id: 'spv_batch' })
      .where('id', '=', id)
      .execute()
    const cancelled = await request('POST', `/teams/${f.teamA}/games`, {
      games: [{ ...row, startAt: AT(13), status: 'cancelled' }]
    })
    expect(cancelled.results[0].status).equals('cancelled')
    const notices = await f.h.db
      .selectFrom('notification_events')
      .select(['metadata', 'recorded_recipients'])
      .where('source_type', '=', 'scheduleNeedsAttention')
      .execute()
    expect(notices.length).equals(1)
    expect(notices[0].metadata).include({
      leagueId: f.leagueA,
      previewId: 'spv_batch'
    })
    expect(notices[0].recorded_recipients).include(userIdOfGumbo(101))
    await f.h.db
      .updateTable('games')
      .set({ cancellation_reason: 'rescheduled' })
      .where('id', '=', id)
      .execute()
    const restored = await request('POST', `/teams/${f.teamA}/games`, {
      games: [{ ...row, startAt: AT(13), status: 'scheduled' }]
    })
    expect(restored.results[0].result).equals('error')
    expect(restored.results[0].error.message).equals(
      'A withdrawn game cannot be restored'
    )
  })
})
