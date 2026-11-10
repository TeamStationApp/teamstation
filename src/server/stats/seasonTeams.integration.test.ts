import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  ANSWER_GAMES,
  answersSeason,
  seasonAnswers,
  seasonAnswersFixture
} from '../../test/seasonAnswers'
import type { Database } from '../db/database'
import { seasonRoutes } from '../routes/seasons'
import { statsRoutes } from '../routes/stats'
import { seasonParticipants, seasonResults } from './seasonTeams'

/** Every statement the counted routes ran, with the rows it returned. */
const counted: Array<{ text: string; rows: number }> = []

/**
 * Kysely's driver checks a client out and runs each statement as its
 * `query`, so the count is taken there and not on the pool.
 */
class CountingClient extends Client {
  override query(...args: any[]): any {
    const result = (super.query as (...given: any[]) => any)(...args)
    if (typeof args[0] === 'string' && result instanceof Promise)
      return result.then((answer: any) => {
        counted.push({
          text: args[0],
          rows: answer.rowCount ?? answer.rows?.length ?? 0
        })
        return answer
      })
    return result
  }
}

describe('season teams and standings without the season game rows', function () {
  this.timeout(120000)
  let f: GroupFixture
  let countingDb: Kysely<Database> | undefined
  let countedMedia: unknown
  let countedRoutes:
    ((req: any, res: any, next: (error?: unknown) => void) => void) | undefined
  before(async () => {
    f = await groupFixture(undefined, undefined, (app, { media }) => {
      // The season and standings routes again, on a pool that counts rows.
      app.use('/api/v1/counted', (req, res, next) => {
        if (countedRoutes == null) next()
        else countedRoutes(req, res, next)
      })
      countedMedia = media
    })
    await seasonAnswersFixture(f)
    const name = (
      await sql<{
        name: string
      }>`select current_database() as name`.execute(f.h.db)
    ).rows[0].name
    countingDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`),
          Client: CountingClient,
          max: 2
        })
      })
    })
    const seasons = seasonRoutes(countingDb, countedMedia as never)
    const stats = statsRoutes(countingDb, countedMedia as never)
    countedRoutes = (req, res, next) => {
      seasons(req, res, (error?: unknown) => {
        if (error != null) next(error)
        else stats(req, res, next)
      })
    }
  })
  after(async () => {
    await countingDb?.destroy()
    await f?.h.close()
  })

  it('answers byte for byte as the season game rows did', async () => {
    const saved = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'seasonAnswers.json'), 'utf8')
    ) as Record<string, unknown>
    const answers = await seasonAnswers(f)
    expect(Object.keys(answers)).deep.equals(Object.keys(saved))
    for (const [key, body] of Object.entries(answers))
      expect(body, key).equals(JSON.stringify(saved[key]))
  })

  it('counts each team once by its games, with the flags the standings filter reads', async () => {
    const { teams } = await seasonParticipants(f.h.db, answersSeason)
    const of = (n: number): (typeof teams)[number] | undefined =>
      teams.find(
        row => row.id === `tem_seasonAnswers${String(n).padStart(2, '0')}`
      )
    expect(teams.length).equals(new Set(teams.map(row => row.id)).size)
    // Merged away: its games stay, its row does not.
    expect(of(22)).equals(undefined)
    expect(of(1)).deep.include({
      activeMember: true,
      seasonCategory: 'inSeason',
      playsInSeason: true
    })
    expect(of(13)).deep.include({
      exhibition: true,
      seasonCategory: 'exhibition',
      playsInSeason: true
    })
    expect(of(14)).deep.include({
      exhibition: false,
      seasonCategory: 'unscheduled',
      playsInSeason: false
    })
    expect(of(15)).deep.include({
      activeMember: false,
      parentMember: false,
      seasonCategory: 'inSeason'
    })
    expect(of(16)).deep.include({
      parentMember: true,
      seasonCategory: 'unscheduled',
      playsInSeason: false
    })
    expect(of(17)).deep.include({
      parentMember: true,
      seasonCategory: 'exhibition',
      playsInSeason: false
    })
    // Its only non-exhibition game is cancelled: an exhibition team that
    // still plays in the season.
    expect(of(19)).deep.include({
      seasonCategory: 'exhibition',
      playsInSeason: true
    })
    expect(of(20)).deep.include({
      seasonCategory: 'unscheduled',
      playsInSeason: true
    })
    expect(of(21)).deep.include({
      kind: 'external',
      seasonCategory: 'exhibition',
      playsInSeason: false
    })
    expect(of(23)).deep.include({
      seasonCategory: 'inSeason',
      playsInSeason: true
    })
  })

  it('reads only final games with both scores, oldest first', async () => {
    const results = await seasonResults(f.h.db, answersSeason)
    const expected = await f.h.db
      .selectFrom('games')
      .select(['id', 'start_at'])
      .where('season_id', '=', answersSeason)
      .where('status', '=', 'final')
      .where('home_score', 'is not', null)
      .where('away_score', 'is not', null)
      .execute()
    expect(results.length).equals(expected.length)
    expect(results.length).greaterThan(0).lessThan(ANSWER_GAMES)
    expect(
      results.every(
        game =>
          game.status === 'final' &&
          game.homeScore != null &&
          game.awayScore != null
      )
    ).equals(true)
    expect(results.some(game => game.exhibition)).equals(true)
    expect(results.some(game => game.homeScore === game.awayScore)).equals(true)
    expect(results.map(game => game.id)).deep.equals(
      [...expected]
        .sort(
          (a, b) =>
            Math.sign(a.start_at.getTime() - b.start_at.getTime()) * 2 +
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        )
        .map(game => game.id)
    )
    expect(typeof results[0].startAt).equals('string')
    expect(await seasonResults(f.h.db, 'sea_none')).deep.equals([])
    expect(await seasonParticipants(f.h.db, 'sea_none')).deep.equals({
      teams: []
    })
  })

  it('returns no statement with more rows than the season has teams, or standings than its final games', async () => {
    const { teams } = await seasonParticipants(f.h.db, answersSeason)
    const finals = (await seasonResults(f.h.db, answersSeason)).length
    const read = async (path: string): Promise<typeof counted> => {
      counted.length = 0
      const response = await f.h.request('GET', `/counted${path}`)
      expect(response.status, path).equals(200)
      return [...counted]
    }

    const teamsRead = await read(`/seasons/${answersSeason}/teams`)
    // The counter sees the route's own reads.
    expect(teamsRead.length).greaterThan(3)
    expect(teamsRead.some(row => row.text.includes('group by team_id'))).equals(
      true
    )
    const listed = (
      (await (
        await f.h.request('GET', `/counted/seasons/${answersSeason}/teams`)
      ).json()) as unknown[]
    ).length
    expect(listed).equals(teams.length)
    for (const row of teamsRead)
      if (!row.text.includes('"memberships"'))
        expect(row.rows, row.text).at.most(teams.length)

    for (const query of ['', '?includeExhibitions=false']) {
      const standingsRead = await read(
        `/seasons/${answersSeason}/standings${query}`
      )
      expect(standingsRead.length).greaterThan(3)
      expect(
        standingsRead.some(
          row => row.text.includes('"games"') && row.rows === finals
        )
      ).equals(true)
      for (const row of standingsRead)
        expect(row.rows, row.text).at.most(finals)
    }
  })
})
