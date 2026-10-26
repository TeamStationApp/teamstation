import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type {
  ScheduleSettings,
  ScheduleSetup,
  SeasonScheduleSettings
} from '../../common/seasonScheduling'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { chosenSeasonIds, scheduleSetup } from '../scheduler/setup'
import { CLAIM_WAIT_MS } from '../venues/ownership'

const SETTINGS: ScheduleSettings = {
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 4,
  exhibitionGames: 1,
  doubleheaders: 'never',
  startsOn: '2027-03-01',
  endsOn: '2027-05-31',
  blackouts: ['2027-04-04'],
  windows: [
    {
      from: '2027-04-01',
      hours: [{ weekday: 6, start: '09:00', end: '17:00' }]
    },
    {
      from: '2027-03-01',
      hours: [{ weekday: 2, start: '17:30', end: '21:00' }]
    }
  ]
}

describe('scheduling setup routes', function () {
  this.timeout(120000)
  let f: GroupFixture
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text()
    expect(response.status, text).equals(status)
    return JSON.parse(text) as T
  }
  const flag = async (
    seasonId: string,
    teamId: string,
    exhibition: unknown,
    user = 101
  ): Promise<Response> =>
    await f.h.request(
      'PUT',
      `/seasons/${seasonId}/memberships/${teamId}`,
      { exhibition },
      user
    )
  /** A team taking part actively, not owned by the season. */
  const activeTeam = async (id: string, seasonId: string): Promise<void> => {
    await f.h.db
      .insertInto('teams')
      .values({ id, name: `Demo ${id}` })
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: seasonId, team_id: id, joined_at: new Date() })
      .execute()
  }
  /** A venue with one field, claimed by a league. */
  const venue = async (
    id: string,
    leagueId: string | null,
    status: 'pending' | 'approved' = 'approved'
  ): Promise<string> => {
    await f.h.db
      .insertInto('venues')
      .values({
        id,
        google_place_id: `place-${id}`,
        name: `Demo Park ${id}`,
        latitude: 40,
        longitude: -75,
        timezone: 'America/New_York'
      })
      .execute()
    await f.h.db
      .insertInto('venue_fields')
      .values({
        id: `fld_${id}`,
        venue_id: id,
        name: 'Field 1',
        sizes: ['50/70', '60/90'],
        starts_on: '2027-03-15',
        ends_on: '2027-10-31'
      })
      .execute()
    if (leagueId != null)
      await f.h.db
        .insertInto('venue_claims')
        .values({
          id: `vcl_${id}`,
          venue_id: id,
          league_id: leagueId,
          kind: 'claim',
          requested_by: userIdOfGumbo(101),
          status,
          requested_at: f.clock.now(),
          approves_at: new Date(f.clock.now().getTime() + CLAIM_WAIT_MS),
          decided_at: status === 'pending' ? null : f.clock.now()
        })
        .execute()
    return `fld_${id}`
  }
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  it('flags exhibition teams for a season admin, parent-managed or active, and lists them as exhibition teams', async () => {
    await activeTeam('tem_active', f.seasonA)
    expect((await flag(f.seasonA, f.teamA, true, 102)).status).equals(403)
    expect((await flag(f.seasonA, f.teamA, 'yes')).status).equals(400)
    expect((await flag(f.seasonA, f.teamB, true)).status).equals(404)
    expect(await json(await flag(f.seasonA, f.teamA, true))).deep.equals({
      seasonId: f.seasonA,
      teamId: f.teamA,
      exhibition: true
    })
    await json(await flag(f.seasonA, 'tem_active', true))
    await json(await flag(f.seasonA, 'tem_active', false))
    const teams = await json<
      Array<{ id: string; exhibition: boolean; seasonCategory: string }>
    >(await f.h.request('GET', `/seasons/${f.seasonA}/teams`, undefined, 101))
    expect(
      teams.map(team => [team.id, team.exhibition, team.seasonCategory])
    ).deep.equals([
      [f.teamA, true, 'exhibition'],
      ['tem_active', false, 'unscheduled']
    ])
  })

  it('reads defaults, then round-trips a season’s settings, for its league’s admin', async () => {
    const path = `/seasons/${f.seasonA}/schedule-settings`
    expect(
      await json<SeasonScheduleSettings>(
        await f.h.request('GET', path, undefined, 101)
      )
    ).deep.equals({
      seasonId: f.seasonA,
      saved: false,
      settings: {
        fieldSize: '60/90',
        gameMinutes: 120,
        bufferMinutes: 15,
        regularGames: 0,
        exhibitionGames: 0,
        doubleheaders: 'ifNecessary',
        startsOn: '2027-03-01',
        endsOn: '2027-05-31',
        blackouts: [],
        windows: []
      }
    })
    expect((await f.h.request('GET', path, undefined, 102)).status).equals(403)
    expect((await f.h.request('PUT', path, SETTINGS, 102)).status).equals(403)
    for (const bad of [
      { ...SETTINGS, gameMinutes: 92 },
      { ...SETTINGS, bufferMinutes: 300 },
      { ...SETTINGS, regularGames: -1 },
      { ...SETTINGS, fieldSize: '70/100' },
      { ...SETTINGS, doubleheaders: 'sometimes' },
      { ...SETTINGS, endsOn: '2027-02-01' },
      { ...SETTINGS, windows: [SETTINGS.windows[0], SETTINGS.windows[0]] },
      // An end date before its start, and one that overlaps the next period.
      {
        ...SETTINGS,
        windows: [{ ...SETTINGS.windows[1], until: '2027-02-28' }]
      },
      {
        ...SETTINGS,
        windows: [
          SETTINGS.windows[0],
          { ...SETTINGS.windows[1], until: '2027-04-01' }
        ]
      },
      'settings'
    ])
      expect(
        (await f.h.request('PUT', path, bad, 101)).status,
        JSON.stringify(bad)
      ).equals(400)
    const saved = await json<SeasonScheduleSettings>(
      await f.h.request('PUT', path, SETTINGS, 101)
    )
    expect(saved).deep.equals({
      seasonId: f.seasonA,
      saved: true,
      settings: {
        ...SETTINGS,
        windows: [SETTINGS.windows[1], SETTINGS.windows[0]]
      }
    })
    // A period's end date is kept, and read back.
    const ended = [
      { ...SETTINGS.windows[1], until: '2027-03-20' },
      SETTINGS.windows[0]
    ]
    expect(
      await json(
        await f.h.request('PUT', path, { ...SETTINGS, windows: ended }, 101)
      )
    ).deep.nested.include({ 'settings.windows': ended })
    expect(
      await json(await f.h.request('GET', path, undefined, 101))
    ).deep.nested.include({ 'settings.windows': ended })
    expect(
      await json(
        await f.h.request('PUT', path, { ...SETTINGS, windows: [] }, 101)
      )
    ).deep.nested.include({ 'settings.windows': [] })
    expect(
      await json(await f.h.request('GET', path, undefined, 101))
    ).deep.equals({ ...saved, settings: { ...SETTINGS, windows: [] } })
    // A season outside any league can't be scheduled.
    expect(
      (
        await f.h.request(
          'GET',
          `/seasons/${f.standaloneSeason}/schedule-settings`,
          undefined,
          103
        )
      ).status
    ).equals(409)
    expect(
      (
        await f.h.request(
          'GET',
          '/seasons/sea_missing/schedule-settings',
          undefined,
          105
        )
      ).status
    ).equals(404)
  })

  it('writes no zone to a season with its settings, and supersedes none of its pending requests', async () => {
    const path = `/seasons/${f.seasonA}/schedule-settings`
    const stored = async (): Promise<string> =>
      (
        await f.h.db
          .selectFrom('seasons')
          .select('timezone')
          .where('id', '=', f.seasonA)
          .executeTakeFirstOrThrow()
      ).timezone
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        teamId: f.teamB,
        seasonId: f.seasonA,
        sender: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'season-settings-no-zone'
      },
      101
    )
    expect(sent.status, await sent.clone().text()).equals(201)
    const { id } = (await sent.json()) as { id: string }
    expect(await stored()).equals('UTC')
    // A zone sent with the settings is not part of them, and is ignored.
    const saved = await json<SeasonScheduleSettings>(
      await f.h.request(
        'PUT',
        path,
        { ...SETTINGS, timezone: 'America/Los_Angeles' },
        101
      )
    )
    expect(saved).not.have.property('timezone')
    await json(await f.h.request('PUT', path, SETTINGS, 101))
    expect(await stored()).equals('UTC')
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('pending')
  })

  it('reads the chosen seasons still of the league, in the order the setup lists them', async () => {
    expect(await chosenSeasonIds(f.h.db, f.leagueA)).deep.equals([])
    // Another league's season is not one of this league's run.
    await f.h.db
      .insertInto('league_schedule_setups')
      .values({
        league_id: f.leagueA,
        season_ids: [f.playoffs, f.seasonB, f.seasonA]
      })
      .execute()
    const ids = await chosenSeasonIds(f.h.db, f.leagueA)
    expect(ids).deep.equals([f.playoffs, f.seasonA])
    expect(ids).deep.equals((await scheduleSetup(f.h.db, f.leagueA)).seasonIds)
  })

  it('chooses the league’s seasons and claimed venues’ fields, for a league admin only', async () => {
    const own = await venue('ven_own', f.leagueA)
    const other = await venue('ven_other', f.leagueB)
    const unclaimed = await venue('ven_none', null)
    const waiting = await venue('ven_waiting', f.leagueB, 'pending')
    await activeTeam('tem_active', f.seasonA)
    await json(await flag(f.seasonA, f.teamA, true))
    const path = `/leagues/${f.leagueA}/schedule-setup`
    expect((await f.h.request('GET', path, undefined, 102)).status).equals(403)
    expect(
      (await f.h.request('PUT', path, { seasonIds: [], fieldIds: [] }, 102))
        .status
    ).equals(403)
    const first = await json<ScheduleSetup>(
      await f.h.request('GET', path, undefined, 101)
    )
    expect(first).include({ leagueId: f.leagueA })
    expect(first.seasonIds).deep.equals([])
    expect(first.fields.map(field => field.id)).deep.equals([own])
    expect(first.fields[0]).deep.include({
      venueName: 'Demo Park ven_own',
      sizes: ['50/70', '60/90'],
      startsOn: '2027-03-15',
      endsOn: '2027-10-31',
      deleted: false
    })
    expect(first.seasons.map(season => season.id).sort()).deep.equals(
      [f.seasonA, f.playoffs].sort()
    )
    expect(first.seasons.find(season => season.id === f.seasonA)).deep.include({
      participants: 1,
      exhibitionTeams: 1,
      teams: [
        { id: f.teamA, name: 'Demo Hawks', exhibition: true },
        { id: 'tem_active', name: 'Demo tem_active', exhibition: false }
      ],
      saved: false
    })
    for (const bad of [
      { seasonIds: [f.seasonB], fieldIds: [] },
      { seasonIds: [], fieldIds: [unclaimed] },
      { seasonIds: [], fieldIds: [waiting] },
      { seasonIds: [], fieldIds: ['fld_missing'] },
      { seasonIds: 'all', fieldIds: [] },
      { seasonIds: [''], fieldIds: [] },
      []
    ])
      expect(
        (await f.h.request('PUT', path, bad, 101)).status,
        JSON.stringify(bad)
      ).equals(400)
    const chosen = await json<ScheduleSetup>(
      await f.h.request(
        'PUT',
        path,
        { seasonIds: [f.seasonA, f.seasonA], fieldIds: [own, other] },
        101
      )
    )
    expect(chosen.seasonIds).deep.equals([f.seasonA])
    expect(chosen.fieldIds).deep.equals([own, other])
    // A chosen field of another league's venue is listed with the league's.
    expect(chosen.fields.map(field => field.id)).deep.equals([other, own])
    // A pending claim counts once its seven days pass.
    f.advance(CLAIM_WAIT_MS)
    await json(
      await f.h.request(
        'PUT',
        path,
        { seasonIds: [f.seasonA], fieldIds: [waiting] },
        101
      )
    )
    // A chosen field deleted later is still listed, marked deleted.
    await f.h.db
      .updateTable('venue_fields')
      .set({ deleted_at: new Date() })
      .where('id', '=', waiting)
      .execute()
    const later = await json<ScheduleSetup>(
      await f.h.request('GET', path, undefined, 105)
    )
    expect(later.fieldIds).deep.equals([waiting])
    expect(later.fields.find(field => field.id === waiting)?.deleted).equals(
      true
    )
    expect(
      (
        await f.h.request(
          'GET',
          '/leagues/lea_missing/schedule-setup',
          undefined,
          105
        )
      ).status
    ).equals(404)
  })
})
