import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { UmpireAvailability } from '../../common/umpires'
import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { umpireFixture } from '../../test/umpireFixture'
import { USER_API_KEY_PREFIX } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { matchedAt } from './availability'

/**
 * Umpire availability on `umpireFixture`: Demo League A manages umpires,
 * 101 administers it and holds its umpire role, and 104 (a player on Demo
 * Hawks, guarded by 101) holds it too. 102 administers Demo League B; 103
 * has nothing to do with either; 105 is a site administrator.
 */
describe('umpire availability', function () {
  this.timeout(120000)
  let f: GroupFixture
  let key = ''
  const umpire = userIdOfGumbo(104)
  const weekdayEvenings: UmpireAvailability = {
    levels: ['ulv_majors'],
    days: [0, 1, 2, 3, 4],
    from: '17:00',
    to: '22:00',
    timezone: 'America/Los_Angeles'
  }
  /** Tuesday 2027-04-13 at 18:30 in Los Angeles. */
  const tuesdayEvening = '2027-04-14T01:30:00.000Z'
  /** Saturday 2027-04-17 at 18:30 in Los Angeles. */
  const saturdayEvening = '2027-04-18T01:30:00.000Z'

  const mine = (league: string): string =>
    `/leagues/${league}/me/umpire-availability`
  const call = async (
    method: string,
    path: string,
    who: number | string,
    body?: unknown
  ): Promise<{ status: number; body: any }> => {
    const response = await f.h.request(method, path, body, who)
    return { status: response.status, body: await response.json() }
  }
  const save = async (
    league: string,
    availability: unknown,
    who: number | string = 104
  ): Promise<{ status: number; body: any }> =>
    await call('PUT', mine(league), who, { availability })
  const list = async (
    league: string,
    query = '',
    who: number = 101
  ): Promise<{ status: number; body: any }> =>
    await call('GET', `/leagues/${league}/umpires${query}`, who)
  const ids = (answer: { body: any }): string[] =>
    answer.body.people.map((person: { id: string }) => person.id).sort()

  before(async function () {
    f = await umpireFixture()
    await f.h.db
      .insertInto('umpire_levels')
      .values([
        {
          id: 'ulv_minors',
          league_id: f.leagueA,
          name: 'minors',
          position: 1
        },
        {
          id: 'ulv_other',
          league_id: f.leagueB,
          name: 'majors',
          position: 0
        }
      ])
      .execute()
    key = USER_API_KEY_PREFIX + makeToken()
    await f.h.db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: umpire,
        name: 'Umpire tools',
        token_hash: hashToken(key),
        secret_sealed: 'sealed',
        permissions: ['umpire:read', 'umpire:write'],
        created_at: new Date()
      })
      .execute()
  })
  after(async function () {
    await f?.h.close()
  })
  beforeEach(async function () {
    await f.h.resetLimits()
  })

  it('saves, reads back and clears a filter for one league', async function () {
    expect(await call('GET', mine(f.leagueA), 104)).deep.equals({
      status: 200,
      body: { availability: null }
    })
    const saved = await save(f.leagueA, {
      ...weekdayEvenings,
      days: [4, 0, 2, 1, 3, 3]
    })
    expect(saved).deep.equals({
      status: 200,
      body: { availability: weekdayEvenings }
    })
    expect((await call('GET', mine(f.leagueA), 104)).body).deep.equals({
      availability: weekdayEvenings
    })
    expect(await save(f.leagueA, null)).deep.equals({
      status: 200,
      body: { availability: null }
    })
    expect((await call('GET', mine(f.leagueA), 104)).body).deep.equals({
      availability: null
    })
    await save(f.leagueA, weekdayEvenings)
    expect(
      await save(f.leagueA, {
        levels: [],
        days: [],
        from: null,
        to: null,
        timezone: 'America/Chicago'
      })
    ).deep.equals({ status: 200, body: { availability: null } })
    expect(
      await f.h.db
        .selectFrom('umpire_availability')
        .selectAll()
        .where('user_id', '=', umpire)
        .execute()
    ).deep.equals([])
  })

  for (const [label, who] of [
    ['a member’s session', 104],
    ['an umpire-family key', 'key']
  ] as const)
    it(`refuses a body with no time zone, or lists that are not lists, from ${label}`, async function () {
      const as = who === 'key' ? key : who
      const { timezone: _zone, ...noZone } = weekdayEvenings
      for (const body of [
        noZone,
        { ...weekdayEvenings, levels: 'ulv_majors' },
        { ...weekdayEvenings, days: 0 },
        'weekday evenings'
      ]) {
        const answer = await save(f.leagueA, body, as)
        expect(answer.status, JSON.stringify(body)).equals(400)
        expect(answer.body.message).equals('Choose a valid filter.')
      }
      expect(
        (await call('PUT', mine(f.leagueA), as, { filter: weekdayEvenings }))
          .status
      ).equals(400)
      expect((await save(f.leagueA, weekdayEvenings, as)).status).equals(200)
      expect((await call('GET', mine(f.leagueA), as)).body).deep.equals({
        availability: weekdayEvenings
      })
    })

  it('refuses a bad time, zone, weekday, range or level', async function () {
    for (const [body, message] of [
      [{ ...weekdayEvenings, from: '5pm' }, 'Choose a valid time.'],
      [
        { ...weekdayEvenings, timezone: 'Mars/Olympus' },
        'Choose a valid timezone.'
      ],
      [{ ...weekdayEvenings, days: [7] }, 'Choose a valid weekday.'],
      [
        { ...weekdayEvenings, from: '22:00', to: '17:00' },
        'End time must be after start time.'
      ],
      [
        { ...weekdayEvenings, to: null },
        'Choose both a start and an end time.'
      ],
      [
        { ...weekdayEvenings, from: null },
        'Choose both a start and an end time.'
      ],
      [{ ...weekdayEvenings, levels: ['ulv_other'] }, 'Choose a valid level.']
    ] as const) {
      const answer = await save(f.leagueA, body)
      expect(answer.status, JSON.stringify(body)).equals(400)
      expect(answer.body.message).equals(message)
    }
  })

  it('answers 404 to a caller who may not open the league’s schedule', async function () {
    expect((await call('GET', mine(f.leagueA), 103)).status).equals(404)
    expect((await save(f.leagueA, weekdayEvenings, 103)).status).equals(404)
    // Demo League B does not manage umpires yet.
    expect((await call('GET', mine(f.leagueB), 102)).status).equals(404)
    expect((await call('GET', mine('lea_missing'), 104)).status).equals(404)
  })

  it('keeps a separate filter for each league', async function () {
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: true })
      .where('id', '=', f.leagueB)
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueB,
        user_id: umpire,
        granted_by: userIdOfGumbo(102)
      })
      .execute()
    const saturdays: UmpireAvailability = {
      levels: ['ulv_other'],
      days: [5],
      from: null,
      to: null,
      timezone: 'America/Chicago'
    }
    expect((await save(f.leagueB, saturdays)).body.availability).deep.equals(
      saturdays
    )
    expect(
      (await call('GET', mine(f.leagueA), 104)).body.availability
    ).deep.equals(weekdayEvenings)
    expect(
      (await call('GET', mine(f.leagueB), 104)).body.availability
    ).deep.equals(saturdays)
    // An admin of a league with no umpire role may save their own.
    expect((await call('GET', mine(f.leagueB), 102)).body).deep.equals({
      availability: null
    })
  })

  it('reads a filter saved by an account merged into the person, and saves under the survivor', async function () {
    const old = userIdOfGumbo(950)
    await f.h.db
      .insertInto('users')
      .values({ id: old, display_name: 'Old account' })
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(106),
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    await f.h.db
      .insertInto('umpire_availability')
      .values({
        user_id: old,
        league_id: f.leagueA,
        days: [5, 6],
        timezone: 'America/Denver'
      })
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(106) })
      .where('id', '=', old)
      .execute()
    const weekends = {
      levels: [],
      days: [5, 6],
      from: null,
      to: null,
      timezone: 'America/Denver'
    }
    expect((await call('GET', mine(f.leagueA), 106)).body).deep.equals({
      availability: weekends
    })
    const listed = (await list(f.leagueA)).body.people.find(
      (person: { id: string }) => person.id === userIdOfGumbo(106)
    )
    expect(listed.umpireAvailability).deep.equals(weekends)
    await save(f.leagueA, { ...weekends, days: [6] }, 106)
    const rows = await f.h.db
      .selectFrom('umpire_availability')
      .select(['user_id', 'days'])
      .where('league_id', '=', f.leagueA)
      .where('user_id', 'in', [old, userIdOfGumbo(106)])
      .execute()
    expect(rows).deep.equals([{ user_id: userIdOfGumbo(106), days: [6] }])
    await save(f.leagueA, null, 106)
  })

  it('drops a deleted level from a read', async function () {
    await save(f.leagueA, {
      ...weekdayEvenings,
      levels: ['ulv_majors', 'ulv_minors']
    })
    await f.h.db
      .deleteFrom('umpire_levels')
      .where('id', '=', 'ulv_minors')
      .execute()
    expect(
      (await call('GET', mine(f.leagueA), 104)).body.availability
    ).deep.equals(weekdayEvenings)
  })

  it('carries each umpire’s filter on the admin’s list', async function () {
    const answer = await list(f.leagueA)
    expect(answer.status).equals(200)
    const byId = new Map(
      answer.body.people.map((person: any) => [
        person.id,
        person.umpireAvailability
      ])
    )
    expect(byId.get(umpire)).deep.equals(weekdayEvenings)
    expect(byId.get(userIdOfGumbo(101))).equals(null)
    // An umpire who is no admin reads no list.
    expect((await list(f.leagueA, '', 104)).status).equals(403)
  })

  it('keeps the umpires free at availableAt, and those with none unless strict', async function () {
    const all = [userIdOfGumbo(101), umpire, userIdOfGumbo(106)].sort()
    expect(
      ids(await list(f.leagueA, `?availableAt=${tuesdayEvening}`))
    ).deep.equals(all)
    expect(
      ids(await list(f.leagueA, `?availableAt=${saturdayEvening}`))
    ).deep.equals([userIdOfGumbo(101), userIdOfGumbo(106)].sort())
    expect(
      ids(await list(f.leagueA, `?availableAt=${tuesdayEvening}&strict=true`))
    ).deep.equals([umpire])
    expect(ids(await list(f.leagueA, '?strict=false'))).deep.equals(all)
  })

  it('names the weekday and time availableAt was matched on, per zone', async function () {
    // Tuesday 18:30 in Los Angeles is already Wednesday in UTC; no game
    // starts then, so only the saved filters' zone is read.
    const answer = await list(f.leagueA, `?availableAt=${tuesdayEvening}`)
    expect(answer.body.matchedAt).deep.equals([
      {
        timezone: 'America/Los_Angeles',
        weekday: 'Tuesday',
        date: '2027-04-13',
        time: '18:30'
      }
    ])
    // A league game starting then adds its own zone.
    const game = await f.h.db
      .selectFrom('games')
      .innerJoin('seasons', 'seasons.id', 'games.season_id')
      .select(['games.id', 'games.start_at', 'games.end_at', 'games.timezone'])
      .where('seasons.league_id', '=', f.leagueA)
      .executeTakeFirstOrThrow()
    const move = async (values: {
      start_at: Date
      end_at: Date | null
      timezone: string
    }): Promise<unknown> =>
      await f.h.db
        .updateTable('games')
        .set(values)
        .where('id', '=', game.id)
        .execute()
    await move({
      start_at: new Date('2027-04-12T03:00:00.000Z'),
      end_at: new Date('2027-04-12T06:00:00.000Z'),
      timezone: 'America/New_York'
    })
    expect(
      (await list(f.leagueA, '?availableAt=2027-04-12T03:00:00.000Z')).body
        .matchedAt
    ).deep.equals([
      {
        timezone: 'America/Los_Angeles',
        weekday: 'Sunday',
        date: '2027-04-11',
        time: '20:00'
      },
      {
        timezone: 'America/New_York',
        weekday: 'Sunday',
        date: '2027-04-11',
        time: '23:00'
      }
    ])
    await move({
      start_at: game.start_at,
      end_at: game.end_at,
      timezone: game.timezone
    })
    // With no game then and no saved filter there is nothing to read.
    expect(
      await matchedAt(f.h.db, f.leagueA, new Date(tuesdayEvening), [null])
    ).deep.equals([])
    // A day and time need no reading, and no query matches on none.
    expect(
      (await list(f.leagueA, '?day=1&time=18:30')).body
    ).not.to.have.property('matchedAt')
    expect((await list(f.leagueA)).body).not.to.have.property('matchedAt')
  })

  it('misses a game whose duration runs past to', async function () {
    // 20:30 in Los Angeles: two hours ends at 22:30, past 22:00.
    const late = '2027-04-14T03:30:00.000Z'
    expect(
      ids(await list(f.leagueA, `?availableAt=${late}&strict=true`))
    ).deep.equals([umpire])
    expect(
      ids(
        await list(
          f.leagueA,
          `?availableAt=${late}&durationMinutes=120&strict=true`
        )
      )
    ).deep.equals([])
    expect(
      ids(
        await list(
          f.leagueA,
          `?availableAt=${late}&durationMinutes=90&strict=true`
        )
      )
    ).deep.equals([umpire])
  })

  it('filters by day and time and by level, and refuses bad values', async function () {
    expect(
      ids(await list(f.leagueA, '?day=0&time=18:00&strict=true'))
    ).deep.equals([umpire])
    expect(
      ids(await list(f.leagueA, '?day=5&time=18:00&strict=true'))
    ).deep.equals([])
    expect(
      ids(await list(f.leagueA, '?day=0&time=23:00&strict=true'))
    ).deep.equals([])
    expect(
      ids(await list(f.leagueA, '?level=ulv_majors&strict=true'))
    ).deep.equals([umpire])
    expect(
      ids(await list(f.leagueA, '?level=ulv_minors&strict=true'))
    ).deep.equals([])
    for (const query of [
      '?day=0',
      '?time=18:00',
      '?day=7&time=18:00',
      '?day=x&time=18:00',
      '?day=0&time=25:00',
      '?availableAt=soon',
      '?durationMinutes=60',
      `?availableAt=${tuesdayEvening}&durationMinutes=0`,
      `?availableAt=${tuesdayEvening}&day=1&time=18:00`,
      '?strict=yes',
      '?level=a&level=b'
    ]) {
      const answer = await list(f.leagueA, query)
      expect(answer.status, query).equals(400)
    }
  })

  it('gives an admin of two leagues only the named league’s filters', async function () {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(101),
        scope_type: 'league',
        scope_id: f.leagueB,
        role: 'admin',
        granted_by: userIdOfGumbo(102)
      })
      .execute()
    const inB = (await list(f.leagueB)).body.people
    expect(
      inB.map((person: any) => [person.id, person.umpireAvailability])
    ).deep.equals([
      [
        umpire,
        {
          levels: ['ulv_other'],
          days: [5],
          from: null,
          to: null,
          timezone: 'America/Chicago'
        }
      ]
    ])
    expect(
      ids(await list(f.leagueB, '?day=0&time=18:00&strict=true'))
    ).deep.equals([])
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('scope_id', '=', f.leagueB)
      .execute()
  })

  describe('commitments', function () {
    const window = '?from=2027-04-01T00:00:00Z&to=2027-04-30T00:00:00Z'
    const commitments = async (
      who: number,
      user = umpire,
      query = window
    ): Promise<{ status: number; body: any }> =>
      await call(
        'GET',
        `/leagues/${f.leagueA}/umpires/${user}/commitments${query}`,
        who
      )

    before(async function () {
      const base = {
        home_team_id: f.teamB,
        away_team_id: f.teamA,
        season_id: f.seasonA,
        timezone: 'America/Los_Angeles',
        venue: 'Demo Field'
      }
      await f.h.db
        .insertInto('games')
        .values([
          {
            ...base,
            id: 'gam_umpiring',
            home_team_id: f.teamB,
            away_team_id: f.teamB,
            start_at: new Date(tuesdayEvening),
            end_at: null
          },
          {
            ...base,
            id: 'gam_later',
            start_at: new Date('2027-05-20T01:30:00Z'),
            end_at: new Date('2027-05-20T03:30:00Z')
          },
          {
            ...base,
            id: 'gam_cancelled',
            start_at: new Date('2027-04-20T01:30:00Z'),
            end_at: null,
            status: 'cancelled'
          },
          {
            ...base,
            id: 'gam_elsewhere',
            season_id: f.seasonB,
            home_team_id: f.teamB,
            away_team_id: f.teamB,
            start_at: new Date('2027-04-10T01:30:00Z'),
            end_at: null
          }
        ])
        .execute()
      await f.h.db
        .insertInto('umpire_assignments')
        .values(
          ['gam_umpiring', 'gam_elsewhere', 'gam_later'].map(gameId => ({
            game_id: gameId,
            slot: 'uty_plate:1',
            user_id: umpire,
            assigned_by: userIdOfGumbo(101)
          }))
        )
        .execute()
    })

    it('reads the umpire’s assignments and player games in the window, in the leagues the caller administers', async function () {
      const answer = await commitments(101)
      expect(answer.status).equals(200)
      expect(answer.body.commitments).deep.equals([
        {
          gameId: 'gam_umpire',
          leagueId: f.leagueA,
          startAt: '2027-04-03T00:00:00.000Z',
          endAt: '2027-04-03T02:00:00.000Z',
          home: 'Demo Hawks',
          away: 'Demo Eagles',
          role: 'player'
        },
        {
          gameId: 'gam_umpiring',
          leagueId: f.leagueA,
          startAt: tuesdayEvening,
          endAt: '2027-04-14T04:30:00.000Z',
          home: 'Demo Eagles',
          away: 'Demo Eagles',
          role: 'umpire',
          slot: 'uty_plate:1'
        }
      ])
    })

    it('shows a site administrator every league', async function () {
      const answer = await commitments(105)
      expect(
        answer.body.commitments.map((one: { gameId: string }) => one.gameId)
      ).deep.equals(['gam_umpire', 'gam_elsewhere', 'gam_umpiring'])
    })

    it('refuses a window over 31 days, a bad time, a non-admin and a non-umpire', async function () {
      for (const query of [
        '?from=2027-04-01T00:00:00Z&to=2027-05-03T00:00:00Z',
        '?from=2027-04-30T00:00:00Z&to=2027-04-01T00:00:00Z',
        '?from=soon&to=2027-04-01T00:00:00Z',
        '?to=2027-04-01T00:00:00Z'
      ])
        expect((await commitments(101, umpire, query)).status, query).equals(
          400
        )
      expect([403, 404]).includes((await commitments(104)).status)
      expect([403, 404]).includes((await commitments(103)).status)
      expect((await commitments(101, userIdOfGumbo(103))).status).equals(404)
      expect((await commitments(101, 'usr_missing')).status).equals(404)
    })
  })
})
