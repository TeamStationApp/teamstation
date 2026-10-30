import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

/**
 * `GET /players/:userId/highlights` on rows a page has to read past: plays the
 * viewer may not see, games not accepted, plays no video covers and several
 * plays of one instant. 101 reads team A's games and no others.
 */

const START = new Date('2026-05-02T18:00:00.000Z')
const minute = (minutes: number, seconds = 0): Date =>
  new Date(START.getTime() + minutes * 60_000 + seconds * 1000)

interface Answer {
  highlights: Array<{ eventId: string }>
  nextBefore: string | null
  withoutVideo: number
}

describe('a player highlight page (U10)', function () {
  this.timeout(120000)
  let f: GroupFixture
  let index = 0

  const route = (player: number): string =>
    `/players/${userIdOfGumbo(player)}/highlights`

  const read = async (
    path: string,
    status = 200,
    userId = 101
  ): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, userId)
    expect(response.status, path).equals(status)
    return await response.json()
  }

  const addGame = async (
    fields: { covered?: boolean; hiddenVideo?: boolean; others?: boolean } = {},
    columns: Record<string, unknown> = {}
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: fields.others === true ? f.standaloneTeam : f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: START,
        status: 'final',
        ...columns
      })
      .execute()
    if (fields.covered === true)
      await f.h.db
        .insertInto('videos')
        .values({
          id: makeId('video'),
          game_id: id,
          kind: 'program',
          title: 'Home vs Away',
          storage: 'spaces',
          status: 'ready',
          start_at: START,
          duration_sec: 7200,
          hidden: fields.hiddenVideo === true
        })
        .execute()
    return id
  }

  /** Plays of `player`, in rows of up to a thousand, ids as given. */
  const addPlays = async (
    player: number,
    gameId: string,
    plays: Array<{ id: string; at: Date; hidden?: boolean }>
  ): Promise<void> => {
    const values = plays.map(play => ({
      id: play.id,
      gameId,
      startTime: play.at.toISOString(),
      battingTeamId: f.teamB,
      hidden: play.hidden === true,
      gumbo: {
        about: {
          atBatIndex: index++,
          inning: 1,
          halfInning: 'top',
          isScoringPlay: false,
          startTime: play.at.toISOString()
        },
        result: { eventType: 'single', awayScore: 0, homeScore: 0 },
        credits: [
          {
            eventType: 'single',
            label: 'Single: Ichiro',
            teamId: f.teamB,
            creditUserId: player,
            credit: { name: 'Ichiro', role: 'batter', position: null },
            head: 'Single'
          }
        ]
      }
    }))
    for (let start = 0; start < values.length; start += 1000)
      await f.h.db
        .insertInto('events')
        .values(values.slice(start, start + 1000))
        .execute()
  }

  /** Every page, reading `nextBefore` to the end. */
  const walk = async (
    player: number,
    limit: number,
    userId = 101
  ): Promise<Answer[]> => {
    const pages: Answer[] = [
      await read(`${route(player)}?limit=${limit}`, 200, userId)
    ]
    while (pages.at(-1)?.nextBefore != null) {
      const before = encodeURIComponent(pages.at(-1)?.nextBefore ?? '')
      pages.push(
        await read(
          `${route(player)}?limit=${limit}&before=${before}`,
          200,
          userId
        )
      )
      expect(pages.length, 'a walk ends').lessThan(100)
    }
    return pages
  }

  const shown = (pages: Answer[]): string[] =>
    pages.flatMap(page => page.highlights.map(row => row.eventId))

  before(async () => {
    f = await groupFixture()

    // 103: from newest to oldest, rows no one may be shown lie between the
    // ones that can be.
    const covered = await addGame({ covered: true })
    const unseen = await addGame({ covered: true, others: true })
    const unaccepted = await addGame(
      { covered: true },
      { ingest_status: 'scoreMismatch' }
    )
    const uncovered = await addGame()
    const onHiddenVideo = await addGame({ covered: true, hiddenVideo: true })
    await addPlays(
      103,
      unseen,
      Array.from({ length: 6 }, (_, at) => ({
        id: `evt_unseen_${at}`,
        at: minute(100 - at)
      }))
    )
    await addPlays(103, covered, [
      { id: 'evt_c1', at: minute(90) },
      { id: 'evt_hidden_play', at: minute(89), hidden: true },
      { id: 'evt_c2', at: minute(80) },
      { id: 'evt_c3', at: minute(40) },
      { id: 'evt_c4', at: minute(39) },
      { id: 'evt_c5', at: minute(10) }
    ])
    await addPlays(
      103,
      unaccepted,
      Array.from({ length: 8 }, (_, at) => ({
        id: `evt_mismatch_${at}`,
        at: minute(70 - at)
      }))
    )
    await addPlays(
      103,
      uncovered,
      Array.from({ length: 9 }, (_, at) => ({
        id: `evt_uncovered_${at}`,
        at: minute(60 - at)
      }))
    )
    await addPlays(103, onHiddenVideo, [
      { id: 'evt_on_hidden_video', at: minute(35) }
    ])

    // 104: seven plays of one instant, and one with a finer start.
    const tied = await addGame({ covered: true })
    await addPlays(104, tied, [
      ...['A', 'b', 'C', 'd', 'E', 'f', 'G'].map(letter => ({
        id: `evt_tied_${letter}`,
        at: minute(50)
      })),
      { id: 'evt_fine', at: minute(49) },
      { id: 'evt_last', at: minute(48) }
    ])
    await sql`update events set "startTime" = "startTime" + interval '456 microseconds' where id = 'evt_fine'`.execute(
      f.h.db
    )

    // 106: more plays no video covers than one request reads, then two that
    // can be shown.
    const dark = await addGame()
    await addPlays(
      106,
      dark,
      Array.from({ length: 520 }, (_, at) => ({
        id: `evt_dark_${String(at).padStart(3, '0')}`,
        at: new Date(minute(115).getTime() - at * 1000)
      }))
    )
    const lit = await addGame({ covered: true })
    await addPlays(106, lit, [
      { id: 'evt_lit_1', at: minute(30) },
      { id: 'evt_lit_2', at: minute(29) }
    ])
  })

  after(async () => {
    await f?.h.close()
  })

  it('fills a page past what cannot be shown, and never ends early', async () => {
    const pages = await walk(103, 2)
    expect(pages.map(page => page.highlights.length)).deep.equals([2, 2, 1])
    expect(shown(pages)).deep.equals([
      'evt_c1',
      'evt_c2',
      'evt_c3',
      'evt_c4',
      'evt_c5'
    ])
    expect(pages.at(-1)?.nextBefore).equals(null)
  })

  it('says of every play read how many no recording covers, once', async () => {
    const pages = await walk(103, 2)
    const without = pages.reduce((sum, page) => sum + page.withoutVideo, 0)
    // The unaccepted, the uncovered and the one on a hidden video. A play the
    // viewer may not see is no business of theirs, and a hidden play no play.
    expect(without).equals(8 + 9 + 1)
  })

  it('shows every row to one who may see them all', async () => {
    const pages = await walk(103, 3, 105)
    expect(pages[0].highlights.map(row => row.eventId)).deep.equals([
      'evt_unseen_0',
      'evt_unseen_1',
      'evt_unseen_2'
    ])
    expect(shown(pages).length).equals(5 + 6)
  })

  it('has no nextBefore on a page that reaches the end of the list', async () => {
    const whole = await read(`${route(103)}?limit=5`)
    expect(whole.highlights.length).equals(5)
    expect(whole.nextBefore).equals(null)
  })

  it('names the last play read, past rows that cannot be shown', async () => {
    const first: Answer = await read(`${route(103)}?limit=2`)
    expect(first.nextBefore).equals(
      // evt_mismatch and evt_uncovered run down to here before evt_c3.
      `${minute(52).toISOString()}|evt_uncovered_8`
    )
  })

  it('loses no play of one instant across a page break', async () => {
    const pages = await walk(104, 1)
    expect(shown(pages)).deep.equals([
      'evt_tied_f',
      'evt_tied_d',
      'evt_tied_b',
      'evt_tied_G',
      'evt_tied_E',
      'evt_tied_C',
      'evt_tied_A',
      'evt_fine',
      'evt_last'
    ])
  })

  it('reads a bare time as an older client holds it', async () => {
    const before = encodeURIComponent(minute(50).toISOString())
    const answer: Answer = await read(`${route(104)}?before=${before}`)
    expect(answer.highlights.map(row => row.eventId)).deep.equals([
      'evt_fine',
      'evt_last'
    ])
    expect(answer.nextBefore).equals(null)
  })

  it('takes an empty before as none', async () => {
    const answer: Answer = await read(`${route(104)}?before=&limit=1`)
    expect(answer.highlights[0].eventId).equals('evt_tied_f')
  })

  it('refuses a before that parses as neither', async () => {
    for (const before of [
      'garbage',
      'garbage|evt_c1',
      `${minute(50).toISOString()}|`
    ]) {
      const refusal = await read(
        `${route(104)}?before=${encodeURIComponent(before)}`,
        400
      )
      expect(refusal.message).includes('before')
    }
    await read(`${route(104)}?before=a&before=b`, 400)
  })

  it('stops at the scan cap with nextBefore set, and reads on from there', async () => {
    const first: Answer = await read(`${route(106)}?limit=5`)
    expect(first.highlights).deep.equals([])
    expect(first.withoutVideo).equals(500)
    expect(first.nextBefore?.endsWith('|evt_dark_499')).equals(true)
    const second: Answer = await read(
      `${route(106)}?limit=5&before=${encodeURIComponent(first.nextBefore ?? '')}`
    )
    expect(second.highlights.map(row => row.eventId)).deep.equals([
      'evt_lit_1',
      'evt_lit_2'
    ])
    expect(second.withoutVideo).equals(20)
    expect(second.nextBefore).equals(null)
  })
})
