import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import type { ListCounts } from '../../common/api'
import type { GameRequestTerms } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { nextGameIndex } from '../../common/nextGame'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { encodeScheduleCursor } from '../schedule/scheduleCursor'

/**
 * `GET /events` and `GET /teams/:teamId/games` a page at a time, on real rows:
 * games either side of now, several on one instant, with a practice and a
 * proposal on it too, a start finer than JavaScript reads, team events,
 * proposals, games with and without videos, and games 101 may not see.
 */

const DAY = 24 * 60 * 60 * 1000

interface Row {
  id: string
  startAt: string
  seasonId: string | null
  videoCount: number
  awayScore: number | null
  status: string
  endAt?: string | null
}

interface Answer {
  items: Row[]
  nextCursor: string | null
  prevCursor: string | null
  anchorId: string | null
  counts: ListCounts | null
}

function ids(rows: Row[]): string[] {
  return rows.map(row => row.id)
}

/** The list's order, written out apart from the code that sorts it. */
function sorted(rows: Row[], order: 'asc' | 'desc'): boolean {
  return rows.every((row, index) => {
    if (index === 0) return true
    const before = rows[index - 1]
    const date = Date.parse(before.startAt) - Date.parse(row.startAt)
    const rising = date !== 0 ? date < 0 : before.id < row.id
    return order === 'asc' ? rising : !rising
  })
}

describe('schedule pages', function () {
  this.timeout(120000)
  let f: GroupFixture
  let idleTeam: string
  let overTeam: string
  let tied: string[]
  let practiceNext: string
  let filmed: string
  let hiddenOnly: string
  let stub: string
  let finer: string
  const proposed = makeId('game')

  before(async () => {
    f = await groupFixture()
    // On a whole second, which is how a proposal below writes its start.
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
    const rows = Array.from({ length: 24 }, (_, index) =>
      game((index - 12) * 2 * DAY + DAY / 2)
    )
    // Eight games on one instant, one of them in the other season.
    const tiedAt = -3 * DAY
    const ties = Array.from({ length: 8 }, (_, index) =>
      game(tiedAt, index === 3 ? { season_id: f.playoffs } : {})
    )
    tied = ties.map(row => row.id)
    rows.push(...ties)
    const scoredAhead = game(5 * DAY, {
      home_score: 2,
      away_score: 0,
      status: 'final'
    })
    const cancelled = game(7 * DAY, { status: 'cancelled' })
    rows.push(scoredAhead, cancelled)

    // A start finer than a millisecond, which a cursor cannot hold exactly.
    const fine = game(-40 * DAY)
    finer = fine.id
    rows.push(fine)

    const withVideo = rows[2]
    const hidden = rows[4]
    const stubbed = rows[6]
    filmed = withVideo.id
    hiddenOnly = hidden.id
    stub = stubbed.id

    // What 101 may never see, in a league and on teams of their own.
    const unseen = game(-2 * DAY, {
      home_team_id: f.standaloneTeam,
      away_team_id: f.standaloneTeam,
      season_id: f.standaloneSeason
    })
    idleTeam = makeId('team')
    overTeam = makeId('team')
    await f.h.db
      .insertInto('teams')
      .values([
        { id: idleTeam, name: 'Demo Idle' },
        { id: overTeam, name: 'Demo Over' }
      ])
      .execute()
    const over = Array.from({ length: 6 }, (_, index) =>
      game(-(index + 1) * DAY, {
        home_team_id: overTeam,
        away_team_id: f.teamB,
        season_id: f.seasonB
      })
    )
    await f.h.db
      .insertInto('games')
      .values([...rows, unseen, ...over])
      .execute()
    await sql`update games set start_at = start_at + interval '456 microseconds' where id = ${fine.id}`.execute(
      f.h.db
    )

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
        video('vid_pages_one', withVideo.id),
        video('vid_pages_two', withVideo.id),
        video('vid_pages_three', rows[8].id),
        video('vid_pages_hidden', hidden.id, { hidden: true }),
        video('vid_pages_stub', stubbed.id, {
          status: 'unavailable',
          duration_sec: 0
        })
      ])
      .execute()

    const event = (id: string, offset: number, teamId = f.teamA): any => ({
      id,
      team_id: teamId,
      title: 'Practice',
      event_type: 'practice',
      start_at: at(offset),
      timezone: 'UTC',
      venue: 'Demo Practice Field'
    })
    practiceNext = 'tev_pages_next'
    await f.h.db
      .insertInto('team_events')
      .values([
        event('tev_pages_tied', tiedAt),
        event(practiceNext, 10 * 60 * 1000),
        event('tev_pages_early', -9 * DAY),
        event('tev_pages_late', 11 * DAY),
        event('tev_pages_newest', 60 * DAY)
      ])
      .execute()

    await propose('req_pages_new', proposed, at(9 * DAY))
    await propose('req_pages_tied', makeId('game'), at(tiedAt))
  })

  after(async () => {
    await f?.h.close()
  })

  const propose = async (
    id: string,
    gameId: string,
    start: Date
  ): Promise<void> => {
    const terms: GameRequestTerms = {
      kind: 'game',
      game: {
        homeTeamId: f.teamB,
        awayTeamId: f.teamA,
        seasonId: f.seasonA,
        // As a request stores it: not the spelling the database gives back.
        startAt: start.toISOString().replace(/\.\d+Z$/, 'Z'),
        venue: 'Demo Field',
        outsideTournament: null,
        status: 'scheduled'
      },
      affectedTeamIds: [f.teamA, f.teamB],
      hostSeasonIds: [f.seasonA],
      gameId: null,
      proposedGameId: gameId,
      expected: null,
      previous: null
    }
    await f.h.db
      .insertInto('group_requests')
      .values({
        id,
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
  }

  const read = async (
    path: string,
    userId = 101,
    status = 200
  ): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, userId)
    expect(response.status, path).equals(status)
    return await response.json()
  }

  const withParam = (path: string, param: string): string =>
    `${path}${path.includes('?') ? '&' : '?'}${param}`

  const withCursor = (path: string, cursor: string): string =>
    withParam(path, `cursor=${encodeURIComponent(cursor)}`)

  /** Every row, reading `nextCursor` to the end. Pages hold at most `limit`. */
  const walk = async (
    path: string,
    limit: number,
    userId = 101
  ): Promise<{ rows: Row[]; pages: Answer[] }> => {
    const paged = withParam(path, `paged=1&limit=${limit}`)
    const pages: Answer[] = [await read(paged, userId)]
    while (pages.at(-1)?.nextCursor != null) {
      const page: Answer = await read(
        withCursor(paged, pages.at(-1)?.nextCursor ?? ''),
        userId
      )
      pages.push(page)
      expect(pages.length, 'a walk ends').lessThan(200)
    }
    for (const page of pages) expect(page.items.length, path).most(limit)
    return { rows: pages.flatMap(page => page.items), pages }
  }

  /** Every row before a page, nearest last, reading `prevCursor` back. */
  const walkBack = async (
    paged: string,
    from: Answer,
    userId = 101
  ): Promise<Row[]> => {
    const rows: Row[] = []
    let page = from
    while (page.prevCursor != null) {
      page = await read(withCursor(paged, page.prevCursor), userId)
      rows.unshift(...page.items)
      expect(rows.length, 'a walk back ends').lessThan(1000)
    }
    return rows
  }

  describe('walking every page (U1)', function () {
    const lists = (): string[] => [
      '/events',
      `/events?season=${f.seasonA}`,
      `/teams/${f.teamA}/games`
    ]

    for (const when of ['all', 'past', 'upcoming']) {
      for (const order of ['asc', 'desc', undefined]) {
        it(`loses and repeats nothing, when=${when} order=${order ?? 'default'}`, async () => {
          for (const list of lists()) {
            let path = withParam(list, `when=${when}`)
            if (order != null) path = withParam(path, `order=${order}`)
            const whole: Row[] = await read(path)
            expect(whole.length, path).greaterThan(5)
            for (const limit of [4, 11]) {
              const { rows } = await walk(path, limit)
              expect(ids(rows), `${path} limit=${limit}`).deep.equals(
                ids(whole)
              )
            }
          }
        })
      }
    }

    it('holds rows of one instant across a page break, one a page', async () => {
      const whole: Row[] = await read('/events?when=past')
      const { rows, pages } = await walk('/events?when=past', 1)
      expect(ids(rows)).deep.equals(ids(whole))
      expect(pages.length).equals(whole.length)
      const onTheTie = ids(whole).filter(id => tied.includes(id))
      expect(onTheTie.length).equals(tied.length)
      // The practice and the proposal share the instant too.
      const instant = whole.find(row => row.id === tied[0])?.startAt ?? ''
      expect(
        whole.filter(row => Date.parse(row.startAt) === Date.parse(instant))
          .length
      ).equals(tied.length + 2)
    })

    it('reads a start finer than a millisecond once, in both directions', async () => {
      // One a page, so a cursor stands on it, on a list of games alone, so no
      // team event can make up for a row the page lost.
      for (const path of ['/events?scope=run&order=asc', '/events?scope=run']) {
        const { rows } = await walk(path, 1)
        expect(ids(rows)).include(finer)
        expect(ids(rows), path).deep.equals(ids(await read(path)))
      }
    })

    it('reads a page the same on the list it came from', async () => {
      const whole: Row[] = await read(`/teams/${f.teamA}/games?order=asc`)
      const first: Answer = await read(
        `/teams/${f.teamA}/games?order=asc&paged=1&limit=5`
      )
      expect(ids(first.items)).deep.equals(ids(whole.slice(0, 5)))
      expect(first.prevCursor).equals(null)
      expect(first.items[0]).not.property('homeLogoPath')
      expect(first.items[0]).property('homeLogoUrl')
      const fromEvents: Answer = await read('/events?paged=1&limit=2')
      expect(fromEvents.items[0]).deep.include({
        gameId: fromEvents.items[0].id
      })
      expect(fromEvents.items[0]).property('liveState')
    })

    it('walks back from the end to the same rows, in list order', async () => {
      const path = '/events?paged=1&limit=7&order=asc'
      const whole: Row[] = await read('/events?order=asc')
      const { pages } = await walk('/events?order=asc', 7)
      const last = pages.at(-1)!
      expect(last.nextCursor).equals(null)
      expect(last.prevCursor).a('string')
      const before = await walkBack(path, last)
      expect(ids([...before, ...last.items])).deep.equals(ids(whole))
      for (const page of pages.slice(1))
        expect(page.prevCursor, 'a page after the first').a('string')
    })

    it('walks back through a list that runs newest first', async () => {
      const whole: Row[] = await read('/events')
      const { pages } = await walk('/events', 9)
      const last = pages.at(-1)!
      const before = await walkBack('/events?paged=1&limit=9', last)
      expect(ids([...before, ...last.items])).deep.equals(ids(whole))
    })

    it('can turn back on a page it reached by walking back', async () => {
      const whole: Row[] = await read('/events?order=asc')
      const { pages } = await walk('/events?order=asc', 6)
      const path = '/events?paged=1&limit=6&order=asc'
      const back: Answer = await read(
        withCursor(path, pages[2].prevCursor ?? '')
      )
      expect(ids(back.items)).deep.equals(ids(pages[1].items))
      const on: Answer = await read(withCursor(path, back.nextCursor ?? ''))
      expect(ids(on.items)).deep.equals(ids(pages[2].items))
      expect(ids([...back.items, ...on.items])).deep.equals(
        ids(whole.slice(6, 18))
      )
    })

    it('reads in the order a cursor carries, with no order in the query', async () => {
      const path = `/teams/${f.teamA}/games?paged=1&limit=5`
      const opened: Answer = await read(`${path}&around=next`)
      const rest: Answer = await read(withCursor(path, opened.nextCursor ?? ''))
      expect(sorted([...opened.items, ...rest.items], 'asc')).equals(true)
      const back: Answer = await read(withCursor(path, opened.prevCursor ?? ''))
      expect(sorted([...back.items, ...opened.items], 'asc')).equals(true)
    })

    it('refuses an order that disagrees with its cursor', async () => {
      const path = '/events?paged=1&limit=5&when=past'
      const first: Answer = await read(path)
      const refusal = await read(
        `${withCursor(path, first.nextCursor ?? '')}&order=asc`,
        101,
        400
      )
      expect(refusal.message).equals('order must be desc with this cursor')
    })

    it('answers a cursor past the end with no rows, and the way back', async () => {
      const cursor = encodeScheduleCursor({
        startAt: new Date(Date.now() + 1000 * DAY).toISOString(),
        id: 'gam_gone',
        direction: 'next',
        order: 'asc'
      })
      const path = '/events?order=asc&paged=1'
      const empty: Answer = await read(withCursor(path, cursor))
      expect(empty.items).deep.equals([])
      expect(empty.nextCursor).equals(null)
      const back: Answer = await read(withCursor(path, empty.prevCursor ?? ''))
      expect(back.items.length).greaterThan(0)
    })
  })

  describe('without paged (U2)', function () {
    it('answers the same array in the same order', async () => {
      const rows: Row[] = await read('/events')
      expect(rows).an('array')
      expect(sorted(rows, 'desc')).equals(true)
      expect(ids(rows)).include(proposed)
      expect(ids(rows)).include('tev_pages_late')

      const team: Row[] = await read(`/teams/${f.teamA}/games`)
      expect(team).an('array')
      expect(sorted(team, 'desc')).equals(true)
      expect(ids(team)).include(proposed)
    })

    it("answers the Director's and scoreboard's queries as they were", async () => {
      for (const [path, order] of [
        ['/events?scope=film&lookbackHours=2&limit=10', 'asc'],
        ['/events?scope=run&lookbackHours=2&limit=20', 'asc'],
        ['/events?scope=run&when=finished&lookbackHours=2&limit=10', 'desc'],
        ['/events?scope=run&when=future&limit=5', 'asc'],
        ['/events?played=1&limit=1', 'desc']
      ] as const) {
        const rows: Row[] = await read(path)
        expect(rows, path).an('array')
        expect(rows.length, path).greaterThan(0)
        expect(sorted(rows, order), path).equals(true)
        expect(rows[0], path).property('gameId')
        expect(
          rows.some(row => row.id === proposed),
          path
        ).equals(false)
      }
    })

    it('leaves a limit over a page uncapped, and a team list unlimited', async () => {
      const every: Row[] = await read('/events')
      expect(every.length).greaterThan(30)
      expect((await read('/events?limit=500')).length).equals(every.length)
      const team: Row[] = await read(`/teams/${f.teamA}/games`)
      expect((await read(`/teams/${f.teamA}/games?limit=1`)).length).equals(
        team.length
      )
    })

    it('filters a team list by when and order, as the events list does', async () => {
      const team: Row[] = await read(`/teams/${f.teamA}/games`)
      const upcoming: Row[] = await read(
        `/teams/${f.teamA}/games?when=upcoming`
      )
      expect(sorted(upcoming, 'asc')).equals(true)
      expect(upcoming.length).greaterThan(0)
      expect(upcoming.length).lessThan(team.length)
      expect(
        (await read(`/teams/${f.teamA}/games?order=asc`)).map(
          (row: Row) => row.id
        )
      ).deep.equals(ids(team).reverse())
    })
  })

  describe('refusing what a page cannot be (U3)', function () {
    const refused = async (path: string, words: string): Promise<void> => {
      const answer = await read(path, 101, 400)
      expect(JSON.stringify(answer), path).includes(words)
    }

    it('names the parameter on both lists', async () => {
      for (const list of ['/events', `/teams/${f.teamA}/games`]) {
        await refused(withParam(list, 'cursor=abc'), 'cursor needs paged')
        await refused(
          withParam(list, 'paged=1&cursor=abc'),
          'cursor is not a cursor'
        )
        await refused(withParam(list, 'around=next'), 'around needs paged')
        await refused(
          withParam(list, 'paged=1&around=next&cursor=abc'),
          'around does not apply with cursor'
        )
        await refused(withParam(list, 'paged=1&limit=101'), 'limit')
        await refused(withParam(list, 'hasVideo=2'), 'hasVideo')
        await refused(withParam(list, 'when=soon'), 'when')
      }
      await refused(
        '/events?paged=1&scoreboard=open',
        'paged does not apply with scoreboard=open'
      )
    })
  })

  describe('hasVideo (U4)', function () {
    it('keeps only games with a real, shown video, across pages', async () => {
      for (const list of ['/events', `/teams/${f.teamA}/games`]) {
        const path = withParam(list, 'hasVideo=1&order=asc')
        const { rows, pages } = await walk(path, 1)
        expect(rows.length, list).equals(2)
        expect(pages.length).equals(2)
        expect(ids(rows), list).include(filmed)
        expect(ids(rows), list).not.include(hiddenOnly)
        expect(ids(rows), list).not.include(stub)
        expect(rows.every(row => row.videoCount > 0)).equals(true)
        expect(ids(rows)).deep.equals(ids(await read(path)))
      }
    })

    it('counts the list without it, so a pill does not move the hero', async () => {
      const all: Answer = await read('/events?paged=1')
      const videos: Answer = await read('/events?paged=1&hasVideo=1')
      expect(videos.counts).deep.equals(all.counts)
      expect(videos.counts?.withVideo).equals(2)
      expect(videos.counts?.videos).equals(3)
    })
  })

  describe('around=next (U5)', function () {
    const list = (): string => `/teams/${f.teamA}/games?paged=1&around=next`

    it('opens on the shared rule, a practice as readily as a game', async () => {
      const whole: Row[] = await read(`/teams/${f.teamA}/games?order=asc`)
      const page: Answer = await read(`${list()}&limit=6`)
      const index = nextGameIndex(whole)
      expect(page.anchorId).equals(whole[index].id)
      expect(page.anchorId).equals(practiceNext)
      expect(ids(page.items)).deep.equals(
        ids(whole.slice(index - 3, index + 6))
      )
      expect(sorted(page.items, 'asc')).equals(true)
      expect(page.prevCursor).a('string')
      expect(page.nextCursor).a('string')
      expect(page.counts?.total).equals(whole.length)
    })

    it('meets every row walking both ends', async () => {
      const whole: Row[] = await read(`/teams/${f.teamA}/games?order=asc`)
      const path = `/teams/${f.teamA}/games?paged=1&limit=5&order=asc`
      const page: Answer = await read(`${list()}&limit=5`)
      const before = await walkBack(path, page)
      const after: Row[] = []
      let cursor = page.nextCursor
      while (cursor != null) {
        const next: Answer = await read(withCursor(path, cursor))
        expect(next.prevCursor, 'rows lie before it').a('string')
        expect(next.counts).equals(null)
        after.push(...next.items)
        cursor = next.nextCursor
      }
      expect(ids([...before, ...page.items, ...after])).deep.equals(ids(whole))
    })

    it('sees proposals in the list it opens on', async () => {
      const page: Answer = await read('/events?paged=1&around=next&limit=100')
      const whole: Row[] = await read('/events?order=asc')
      expect(page.anchorId).equals(whole[nextGameIndex(whole)].id)
      expect(ids(page.items)).include(proposed)
    })

    it('has no prevCursor with nothing before the opening row', async () => {
      const page: Answer = await read(
        `/teams/${f.teamA}/games?paged=1&around=next&when=upcoming&limit=4`
      )
      const upcoming: Row[] = await read(
        `/teams/${f.teamA}/games?when=upcoming`
      )
      expect(page.anchorId).equals(upcoming[0].id)
      expect(page.items[0].id).equals(upcoming[0].id)
      expect(page.prevCursor).equals(null)
    })

    it('opens a season that is over on the last one played', async () => {
      const page: Answer = await read(
        `/teams/${overTeam}/games?paged=1&around=next&limit=4`,
        105
      )
      const whole: Row[] = await read(`/teams/${overTeam}/games?order=asc`, 105)
      expect(whole.length).equals(6)
      expect(page.anchorId).equals(whole[5].id)
      expect(ids(page.items)).deep.equals(ids(whole.slice(3)))
      expect(page.nextCursor).equals(null)
      expect(page.prevCursor).a('string')
    })

    it('answers an empty list with an empty page', async () => {
      expect(
        await read(`/teams/${idleTeam}/games?paged=1&around=next`, 105)
      ).deep.equals({
        items: [],
        nextCursor: null,
        prevCursor: null,
        anchorId: null,
        counts: {
          total: 0,
          upcoming: 0,
          withVideo: 0,
          videos: 0,
          newestSeasonId: null
        }
      })
    })
  })

  describe('counts (U6)', function () {
    const expected = (rows: Row[]): ListCounts => ({
      total: rows.length,
      upcoming: rows.filter(
        row => row.awayScore == null && Date.parse(row.startAt) > Date.now()
      ).length,
      withVideo: rows.filter(row => row.videoCount > 0).length,
      videos: rows.reduce((total, row) => total + row.videoCount, 0),
      newestSeasonId: rows.find(row => row.seasonId != null)?.seasonId ?? null
    })

    it('are on a first page, right for the whole list, whatever the when', async () => {
      for (const list of ['/events', `/teams/${f.teamA}/games`]) {
        const whole: Row[] = await read(list)
        const want = expected(whole)
        expect(want.withVideo, list).equals(2)
        for (const when of ['all', 'past', 'upcoming', 'future', 'finished']) {
          for (const order of ['asc', 'desc']) {
            const page: Answer = await read(
              withParam(list, `paged=1&limit=3&when=${when}&order=${order}`)
            )
            expect(page.counts, `${list} ${when} ${order}`).deep.equals(want)
          }
        }
      }
    })

    it('are on no later page', async () => {
      const first: Answer = await read('/events?paged=1&limit=3')
      expect(first.counts).not.equals(null)
      const second: Answer = await read(
        withCursor('/events?paged=1&limit=3', first.nextCursor ?? '')
      )
      expect(second.counts).equals(null)
      expect(second.anchorId).equals(null)
    })

    it("read the newest season over rows that have none, as today's find", async () => {
      const whole: Row[] = await read(`/teams/${f.teamA}/games`)
      // The newest row is a practice, and practices have no season.
      expect(whole[0].seasonId).equals(null)
      const page: Answer = await read(
        `/teams/${f.teamA}/games?paged=1&limit=1&order=asc`
      )
      expect(page.counts?.newestSeasonId).equals(
        whole.find(row => row.seasonId != null)?.seasonId
      )
    })

    it('hold to the season asked for', async () => {
      const whole: Row[] = await read(`/events?season=${f.playoffs}`)
      expect(whole.length).equals(1)
      const page: Answer = await read(`/events?season=${f.playoffs}&paged=1`)
      expect(page.counts).deep.equals(expected(whole))
      expect(page.counts?.newestSeasonId).equals(f.playoffs)
    })

    it('hold to what a scope may reach', async () => {
      const run: Row[] = await read('/events?scope=run')
      const page: Answer = await read('/events?scope=run&paged=1&limit=2')
      expect(page.counts).deep.equals(expected(run))
      expect(page.counts?.total).lessThan(
        ((await read('/events?paged=1')) as Answer).counts?.total ?? 0
      )
    })

    it('hold to the games only a non-member sees', async () => {
      const list = `/teams/${f.teamA}/games`
      const seen: Row[] = await read(list, 104)
      const page: Answer = await read(`${list}?paged=1&limit=2`, 104)
      expect(page.counts).deep.equals(expected(seen))
      expect(ids(seen)).not.include('tev_pages_late')
    })

    it('are moved by no game the caller may not see', async () => {
      const before: Answer = await read('/events?paged=1')
      await f.h.db
        .insertInto('games')
        .values({
          id: makeId('game'),
          home_team_id: f.standaloneTeam,
          away_team_id: f.standaloneTeam,
          season_id: f.standaloneSeason,
          start_at: new Date(Date.now() + 90 * DAY),
          status: 'scheduled'
        })
        .execute()
      const after: Answer = await read('/events?paged=1')
      expect(after.counts).deep.equals(before.counts)
    })
  })
})
