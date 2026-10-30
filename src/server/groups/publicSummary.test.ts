import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { gamesFor } from '../../app/screens/whenFilter'
import type { ListCounts } from '../../common/api'
import type { GameRequestTerms } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('limited public organization profiles', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('keeps long provider references in storage while returning localities compatible with installed readers', async () => {
    const locality = {
      city: 'Demo City',
      region: 'Demo Region',
      country: 'US',
      timezone: 'UTC',
      placeId: 'google:' + 'p'.repeat(27)
    }
    await f.h.db
      .updateTable('teams')
      .set({ locality })
      .where('id', '=', f.teamA)
      .execute()
    await f.h.db
      .updateTable('leagues')
      .set({ locality })
      .where('id', '=', f.leagueA)
      .execute()
    for (const [collection, id] of [
      ['teams', f.teamA],
      ['leagues', f.leagueA],
      ['seasons', f.seasonA]
    ]) {
      const response = await f.h.request(
        'GET',
        `/${collection}/${id}`,
        undefined,
        101
      )
      expect(response.status).equals(200)
      const profile = (await response.json()) as {
        group: { locality: typeof locality }
      }
      expect(profile.group.locality).deep.equals({ ...locality, placeId: null })
    }
    const stored = await f.h.db
      .selectFrom('teams')
      .select('locality')
      .where('id', '=', f.teamA)
      .executeTakeFirstOrThrow()
    expect(stored.locality).deep.equals(locality)
    await f.h.db
      .updateTable('teams')
      .set({ locality: { ...locality, placeId: '1234567' } })
      .where('id', '=', f.teamA)
      .execute()
    const response = await f.h.request(
      'GET',
      `/teams/${f.teamA}`,
      undefined,
      101
    )
    const profile = (await response.json()) as {
      group: { locality: typeof locality }
    }
    expect(profile.group.locality.placeId).equals('1234567')
  })
  it('returns every owned season while keeping public discovery capped separately', async () => {
    await f.h.db
      .insertInto('seasons')
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          id: `season_owned_extra_${index}`,
          name: `Demo Extra ${index}`,
          year: 2040,
          league_id: f.leagueA,
          starts_on: '2040-03-01',
          ends_on: '2040-05-31',
          timezone: 'UTC'
        }))
      )
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          id: `role_owned_extra_${index}`,
          scope_type: 'season' as const,
          scope_id: `season_owned_extra_${index}`,
          user_id: userIdOfGumbo(101),
          role: 'admin' as const,
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        }))
      )
      .execute()
    const owned = (await (
      await f.h.request('GET', '/me/groups', undefined, 101)
    ).json()) as Array<{ kind: string; id: string }>
    expect(owned.filter(group => group.kind === 'season')).length(53)
    expect(owned.some(group => group.id === f.seasonA)).equals(true)
    const publicRows = (await (
      await f.h.request('GET', '/seasons?view=public', undefined, null)
    ).json()) as unknown[]
    expect(publicRows).length(50)
  })
  it('lets public viewers find all group types and hides private user/team data', async () => {
    const search = await f.h.request(
      'GET',
      '/teams?view=public&query=Demo%20City',
      undefined,
      null
    )
    expect(search.status).equals(200)
    expect(((await search.json()) as unknown[]).length).greaterThan(0)
    const seasonsByCity = await f.h.request(
      'GET',
      '/seasons?view=public&query=Demo%20City',
      undefined,
      null
    )
    expect(((await seasonsByCity.json()) as unknown[]).length).greaterThan(0)
    await f.h.db
      .updateTable('teams')
      .set({ settings: sql`'{"secret":"PRIVATE_TEAM_DATA"}'::jsonb` })
      .where('id', '=', f.teamA)
      .execute()
    const response = await f.h.request(
      'GET',
      `/teams/${f.teamA}`,
      undefined,
      null
    )
    expect(response.status).equals(200)
    const detail = (await response.json()) as {
      staff: Array<{ name: string }>
      canManage: boolean
      parents: unknown[]
      group: unknown
    }
    expect(detail.canManage).equals(false)
    expect(detail.staff[0].name).equals('Babe R.')
    const text = JSON.stringify(detail)
    for (const forbidden of [
      'PRIVATE_TEAM_DATA',
      'Morgan',
      'alex@example.com',
      'userId',
      'roster',
      'stats'
    ])
      expect(text).not.includes(forbidden)
    expect(detail.parents).length(2)
    expect(
      (await f.h.request('GET', '/leagues?view=public', undefined, null)).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/seasons?view=public', undefined, null)).status
    ).equals(200)
    expect(
      (await f.h.request('GET', `/teams/${f.teamA}/roster`, undefined, null))
        .status
    ).equals(401)
  })
  it('lists the roles staff were given, never the ones those imply', async () => {
    const given = (
      userId: number,
      scopeType: 'season' | 'team',
      scopeId: string,
      role: 'assistant' | 'scorekeeper'
    ): {
      id: string
      scope_type: 'season' | 'team'
      scope_id: string
      user_id: string
      role: 'assistant' | 'scorekeeper'
      granted_by: string
      granted_at: Date
    } => ({
      id: `role_staff_${userId}_${role}`,
      scope_type: scopeType,
      scope_id: scopeId,
      user_id: userIdOfGumbo(userId),
      role,
      granted_by: userIdOfGumbo(101),
      granted_at: new Date()
    })
    await f.h.db
      .insertInto('scope_roles')
      .values([
        given(106, 'team', f.teamA, 'scorekeeper'),
        given(103, 'season', f.seasonA, 'assistant')
      ])
      .execute()
    try {
      const detail = (await (
        await f.h.request('GET', `/teams/${f.teamA}`, undefined, null)
      ).json()) as {
        staff: Array<{
          name: string
          roles: string[]
          inheritedFrom: { level: string; role: string } | null
        }>
      }
      const byName = Object.fromEntries(
        detail.staff.map(person => [person.name, person.roles])
      )
      // The admin is admin alone, the scorekeeper is not also a songkeeper,
      // and an assistant set on the season is listed on its team.
      expect(byName['Babe R.']).deep.equals(['admin'])
      expect(byName['Tim R.']).deep.equals(['scorekeeper'])
      expect(byName['Mike T.']).deep.equals(['assistant'])
      const inherited = Object.fromEntries(
        detail.staff.map(person => [person.name, person.inheritedFrom])
      )
      expect(inherited['Babe R.']).deep.equals({
        level: 'league',
        role: 'admin'
      })
      expect(inherited['Mike T.']).deep.equals({
        level: 'season',
        role: 'assistant'
      })
      expect(inherited['Tim R.']).equals(null)
    } finally {
      await f.h.db
        .deleteFrom('scope_roles')
        .where('id', 'like', 'role_staff_%')
        .execute()
    }
  })
  it('marks a team page as the non-member view for anybody signed in who is not a member, following it or not', async () => {
    const view = async (
      path: string,
      userId: number | null
    ): Promise<{ nonMemberView: boolean; canViewPrivate: boolean }> =>
      (await (await f.h.request('GET', path, undefined, userId)).json()) as {
        nonMemberView: boolean
        canViewPrivate: boolean
      }
    // Nobody signed in reads the public page.
    expect((await view(`/teams/${f.teamA}`, null)).nonMemberView).equals(false)
    // Signed in and following nothing: the non-member view already.
    const unfollowed = await view(`/teams/${f.teamA}`, 103)
    expect(unfollowed.canViewPrivate).equals(false)
    expect(unfollowed.nonMemberView).equals(true)
    await f.h.db
      .insertInto('follows')
      .values([
        { user_id: userIdOfGumbo(103), group_type: 'team', group_id: f.teamA },
        {
          user_id: userIdOfGumbo(103),
          group_type: 'season',
          group_id: f.seasonA
        },
        { user_id: userIdOfGumbo(101), group_type: 'team', group_id: f.teamA }
      ])
      .execute()
    try {
      // Following it changes nothing.
      const followed = await view(`/teams/${f.teamA}`, 103)
      expect(followed.canViewPrivate).equals(false)
      expect(followed.nonMemberView).equals(true)
      // A season or a league page is the same for everybody.
      expect((await view(`/seasons/${f.seasonA}`, 103)).nonMemberView).equals(
        false
      )
      expect((await view(`/leagues/${f.leagueA}`, 103)).nonMemberView).equals(
        false
      )
      // A member who follows their own team reads it as a member.
      const own = await view(`/teams/${f.teamA}`, 101)
      expect(own.canViewPrivate).equals(true)
      expect(own.nonMemberView).equals(false)
    } finally {
      await f.h.db
        .deleteFrom('follows')
        .where('user_id', 'in', [userIdOfGumbo(101), userIdOfGumbo(103)])
        .execute()
    }
  })
  it("says who manages a team's roster: its administrators, coaches, assistants and scorekeepers", async () => {
    const rights = async (
      path: string,
      userId: number | null
    ): Promise<{ canManage: boolean; canManageRoster: boolean }> =>
      (await (await f.h.request('GET', path, undefined, userId)).json()) as {
        canManage: boolean
        canManageRoster: boolean
      }
    // The team's creator administers it.
    expect(await rights(`/teams/${f.teamA}`, 101)).to.include({
      canManage: true,
      canManageRoster: true
    })
    // Nobody signed in, and somebody with no role, manage nothing.
    expect((await rights(`/teams/${f.teamA}`, null)).canManageRoster).equals(
      false
    )
    expect((await rights(`/teams/${f.teamA}`, 104)).canManageRoster).equals(
      false
    )
    // Never on a season or a league, even for whoever administers it.
    expect((await rights(`/seasons/${f.seasonA}`, 101)).canManageRoster).equals(
      false
    )
    expect((await rights(`/leagues/${f.leagueA}`, 101)).canManageRoster).equals(
      false
    )
    for (const role of ['scorekeeper', 'assistant', 'coach'] as const) {
      const id = makeId('scopeRole')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id,
          user_id: userIdOfGumbo(104),
          scope_type: 'team',
          scope_id: f.teamA,
          role
        })
        .execute()
      try {
        expect(await rights(`/teams/${f.teamA}`, 104), role).to.include({
          canManage: false,
          canManageRoster: true
        })
      } finally {
        await f.h.db.deleteFrom('scope_roles').where('id', '=', id).execute()
      }
    }
  })
  it('includes aggregate results and parent context without private play events or stats', async () => {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'publicGame',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date(),
        status: 'final',
        home_score: 3,
        away_score: 2
      })
      .execute()
    const body = (await (
      await f.h.request('GET', `/teams/${f.teamA}`, undefined, 106)
    ).json()) as { games: Array<Record<string, unknown>>; canManage: boolean }
    expect(body.games[0]).property('homeScore', 3)
    expect(body.games[0]).not.property('boxscore')
    expect(body.games[0]).not.property('events')
    expect(body.canManage).equals(false)
    const admin = (await (
      await f.h.request('GET', `/teams/${f.teamA}`, undefined, 101)
    ).json()) as { canManage: boolean }
    expect(admin.canManage).equals(true)
    expect(
      (await f.h.request('GET', '/teams/missing', undefined, null)).status
    ).equals(404)
  })
})

const DAY = 24 * 60 * 60 * 1000

interface Row {
  id: string
  startAt: string
  seasonId: string | null
  videoCount: number
  homeScore: number | null
  awayScore: number | null
}

interface Answer {
  items: Row[]
  nextCursor: string | null
  prevCursor: string | null
  anchorId: string | null
  counts: ListCounts | null
}

describe('public games a page at a time', function () {
  this.timeout(60000)
  let f: GroupFixture
  let tied: string[]
  let filmed: string
  let merged: string
  const rescheduled = makeId('game')
  const proposed = makeId('game')

  before(async () => {
    f = await groupFixture()
    const now = Math.floor(Date.now() / 1000) * 1000
    const at = (offset: number): Date => new Date(now + offset)
    const game = (
      offset: number,
      fields: Record<string, unknown> = {}
    ): any => ({
      id: makeId('game'),
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: at(offset),
      status: offset < 0 ? 'final' : 'scheduled',
      home_score: offset < 0 ? 3 : null,
      away_score: offset < 0 ? 1 : null,
      ...fields
    })
    const rows = Array.from({ length: 16 }, (_, index) =>
      game((index - 8) * 2 * DAY + DAY / 2)
    )
    const ties = Array.from({ length: 5 }, () => game(-3 * DAY))
    tied = ties.map(row => row.id)
    rows.push(
      ...ties,
      // Scored ahead of its date, so not upcoming.
      game(5 * DAY, { home_score: 2, away_score: 0, status: 'final' }),
      game(7 * DAY, { status: 'cancelled' }),
      game(4 * DAY, {
        id: rescheduled,
        status: 'cancelled',
        cancellation_reason: 'rescheduled'
      }),
      // The newest game with a season is in another of the team's seasons.
      game(90 * DAY, { season_id: null }),
      game(80 * DAY, { season_id: f.playoffs }),
      game(-1 * DAY, {
        home_team_id: f.standaloneTeam,
        away_team_id: f.standaloneTeam,
        season_id: f.standaloneSeason
      })
    )
    await f.h.db.insertInto('games').values(rows).execute()

    filmed = rows[2].id
    const video = (id: string, gameId: string, fields = {}): any => ({
      id,
      game_id: gameId,
      kind: 'program',
      storage: 'spaces',
      status: 'ready',
      title: 'Demo game video',
      start_at: new Date(now),
      duration_sec: 3600,
      ...fields
    })
    await f.h.db
      .insertInto('videos')
      .values([
        video('vid_public_one', filmed),
        video('vid_public_two', filmed),
        video('vid_public_three', rows[9].id),
        video('vid_public_hidden', rows[4].id, { hidden: true }),
        video('vid_public_stub', rows[5].id, {
          status: 'unavailable',
          duration_sec: 0
        })
      ])
      .execute()

    await f.h.db
      .insertInto('team_events')
      .values({
        id: 'tev_public_private',
        team_id: f.teamA,
        title: 'Private practice',
        event_type: 'practice',
        start_at: at(DAY),
        timezone: 'UTC',
        venue: 'Demo Practice Field'
      })
      .execute()

    const terms: GameRequestTerms = {
      kind: 'game',
      game: {
        homeTeamId: f.teamB,
        awayTeamId: f.teamA,
        seasonId: f.seasonA,
        // As a request stores it: not the spelling the database gives back.
        startAt: at(9 * DAY)
          .toISOString()
          .replace(/\.\d+Z$/, 'Z'),
        venue: 'Demo Field',
        outsideTournament: null,
        status: 'scheduled'
      },
      affectedTeamIds: [f.teamA, f.teamB],
      hostSeasonIds: [f.seasonA],
      gameId: null,
      proposedGameId: proposed,
      expected: null,
      previous: null
    }
    await f.h.db
      .insertInto('group_requests')
      .values({
        id: 'req_public_new',
        kind: 'game',
        sender_scope_type: 'team',
        sender_scope_id: f.teamB,
        initiating_team_id: f.teamB,
        terms,
        sender_id: userIdOfGumbo(102),
        status: 'pending',
        sent_at: new Date(),
        expires_at: new Date('2090-01-01T00:00:00Z')
      })
      .execute()

    merged = makeId('team')
    await f.h.db
      .insertInto('teams')
      .values({ id: merged, name: 'Demo Merged', merged_into: f.teamA })
      .execute()
  })

  after(async () => {
    await f?.h.close()
  })

  const read = async (
    path: string,
    status = 200,
    userId: number | null = null
  ): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, userId)
    expect(response.status, path).equals(status)
    // A path nothing answers has no JSON to give, as today.
    return status === 404 ? null : await response.json()
  }

  const lists = (): string[] => [
    `/teams/${f.teamA}/games`,
    `/seasons/${f.seasonA}/games`
  ]

  const details = (list: string): string => list.replace(/\/games$/, '')

  const withCursor = (path: string, cursor: string): string =>
    `${path}&cursor=${encodeURIComponent(cursor)}`

  const walk = async (
    path: string,
    limit: number,
    userId: number | null = null
  ): Promise<{ rows: Row[]; pages: Answer[] }> => {
    const paged = `${path}${path.includes('?') ? '&' : '?'}public=1&paged=1&limit=${limit}`
    const pages: Answer[] = [await read(paged, 200, userId)]
    while (pages.at(-1)?.nextCursor != null) {
      const page: Answer = await read(
        withCursor(paged, pages.at(-1)?.nextCursor ?? ''),
        200,
        userId
      )
      pages.push(page)
      expect(pages.length, 'a walk ends').lessThan(100)
    }
    for (const page of pages) expect(page.items.length, path).most(limit)
    return { rows: pages.flatMap(page => page.items), pages }
  }

  const ids = (rows: Row[]): string[] => rows.map(row => row.id)

  describe('what a page holds (U7)', function () {
    it('walks to the rows of publicGames, in its order', async () => {
      for (const list of lists()) {
        const whole: Row[] = (await read(details(list))).games
        expect(whole.length, list).greaterThan(10)
        const { rows } = await walk(`${list}?order=asc`, 4)
        expect(ids(rows), list).deep.equals(ids(whole))
      }
    })

    it('walks to the rows of each pill of a season, in its order', async () => {
      for (const list of lists()) {
        const whole: Row[] = (await read(details(list))).games
        for (const [when, order] of [
          ['upcoming', 'asc'],
          ['past', 'desc'],
          ['all', 'desc']
        ] as const) {
          const { rows } = await walk(`${list}?when=${when}&order=${order}`, 5)
          const pill = gamesFor(whole, when)
          expect(ids(rows).toSorted(), `${list} ${when}`).deep.equals(
            ids(pill).toSorted()
          )
          // Rows of one instant run by id, where the pill leaves them be.
          expect(
            rows.map(row => row.startAt),
            `${list} ${when}`
          ).deep.equals(pill.map(row => row.startAt))
        }
      }
    })

    it('holds rows of one instant across a page break', async () => {
      const { rows } = await walk(`/teams/${f.teamA}/games?order=asc`, 1)
      const walked = ids(rows).filter(id => tied.includes(id))
      expect(walked).deep.equals(tied.toSorted())
    })

    it('reads in the order its cursor carries, and refuses another', async () => {
      const list = `/teams/${f.teamA}/games?public=1&paged=1&limit=3`
      const first: Answer = await read(`${list}&order=asc`)
      const on: Answer = await read(withCursor(list, first.nextCursor ?? ''))
      const whole: Row[] = (await read(`/teams/${f.teamA}`)).games
      expect(ids([...first.items, ...on.items])).deep.equals(
        ids(whole.slice(0, 6))
      )
      const refusal = await read(
        `${withCursor(list, first.nextCursor ?? '')}&order=desc`,
        400
      )
      expect(refusal.message).equals('order must be asc with this cursor')
    })

    it('walks back through a page to the same rows', async () => {
      const list = `/teams/${f.teamA}/games?public=1&paged=1&limit=4&order=asc`
      const first: Answer = await read(list)
      const second: Answer = await read(
        withCursor(list, first.nextCursor ?? '')
      )
      const back: Answer = await read(withCursor(list, second.prevCursor ?? ''))
      expect(ids(back.items)).deep.equals(ids(first.items))
      expect(back.prevCursor).equals(null)
    })

    it('keeps only games with a video that is not hidden, across pages', async () => {
      for (const list of lists()) {
        const { rows } = await walk(`${list}?hasVideo=1`, 1)
        expect(
          rows.map(row => row.videoCount).toSorted((a, b) => a - b),
          list
        ).deep.equals([1, 2])
        expect(ids(rows), list).includes(filmed)
      }
    })

    it('holds a proposal, and leaves out a private event and a rescheduled game', async () => {
      for (const userId of [null, 101]) {
        const { rows } = await walk(`/teams/${f.teamA}/games`, 50, userId)
        expect(ids(rows)).includes(proposed)
        expect(ids(rows)).not.includes('tev_public_private')
        expect(ids(rows)).not.includes(rescheduled)
      }
    })

    it('has counts on a first page only, for all a public viewer may see', async () => {
      const list = `/teams/${f.teamA}/games`
      const whole: Row[] = (await read(`/teams/${f.teamA}`)).games
      const want: ListCounts = {
        total: whole.length,
        upcoming: gamesFor(whole, 'upcoming').length,
        withVideo: 2,
        videos: 3,
        newestSeasonId: f.playoffs
      }
      for (const query of [
        'when=past',
        'when=upcoming',
        'hasVideo=1',
        'order=asc'
      ]) {
        const { pages } = await walk(`${list}?${query}`, 2)
        expect(pages[0].counts, query).deep.equals(want)
        for (const page of pages.slice(1))
          expect(page.counts, query).equals(null)
      }
      const season: Answer = await read(
        `/seasons/${f.seasonA}/games?public=1&paged=1&limit=1`
      )
      expect(season.counts?.newestSeasonId).equals(f.seasonA)
      expect(season.anchorId).equals(null)
    })

    it('reads a merged team as the team it became, and a missing group as 404', async () => {
      const { rows } = await walk(`/teams/${merged}/games?order=asc`, 50)
      expect(ids(rows)).deep.equals(
        ids((await read(`/teams/${f.teamA}`)).games)
      )
      await read('/teams/tem_gone/games?public=1&paged=1', 404)
      await read('/seasons/sea_gone/games?public=1&paged=1', 404)
    })
  })

  describe('who may read it (U8)', function () {
    it('admits a guest only with public', async () => {
      for (const list of lists()) await read(`${list}?public=1&paged=1`)
      await read(`/teams/${f.teamA}/games`, 401)
      await read(`/teams/${f.teamA}/games?paged=1`, 401)
      await read(`/seasons/${f.seasonA}/games`, 404)
      await read(`/seasons/${f.seasonA}/games?paged=1`, 404)
    })

    it('answers anybody signed in the same public rows', async () => {
      const guest = await walk(`/teams/${f.teamA}/games`, 50)
      for (const userId of [101, 103]) {
        const signedIn = await walk(`/teams/${f.teamA}/games`, 50, userId)
        expect(ids(signedIn.rows)).deep.equals(ids(guest.rows))
      }
    })

    it("leaves a member's own list as it was without public", async () => {
      const rows: Row[] = await read(`/teams/${f.teamA}/games`, 200, 101)
      expect(ids(rows)).includes('tev_public_private')
      await read(`/seasons/${f.seasonA}/games`, 404, 101)
    })

    it('refuses what a public read cannot be, naming the parameter', async () => {
      for (const list of lists()) {
        const says = async (query: string): Promise<string> =>
          (await read(`${list}?${query}`, 400)).message
        expect(await says('public=1')).equals('public needs paged')
        expect(await says('public=2&paged=1')).equals(
          'public must be 1 or true'
        )
        expect(await says('public=1&paged=1&around=next')).equals(
          'around does not apply with public'
        )
        expect(await says('public=1&paged=1&cursor=abc')).equals(
          'cursor is not a cursor this list gave'
        )
        expect(await says('public=1&paged=1&limit=101')).includes('limit')
      }
    })
  })
})
