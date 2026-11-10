import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import {
  loadScorebookFixture,
  mapScorebookFixture,
  parseFixtureArgs,
  postStatsFixture,
  type RosterPlayer
} from '../dev/postStatsFixture'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import { teamRoutes } from '../routes/teams'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_stats_fix_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const TOKEN = 'tok_fixture_000000000000000000000000'

/** The address a `fetch` was asked for, however it was given. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('postStatsFixture', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const home = makeId('team')
  const away = makeId('team')
  const gameId = makeId('game')
  const held = new Set<number>()
  const adminUser = mintUserId(id => held.has(id))
  held.add(adminUser.userId)

  const awayPlayers: Array<{ userId: number; legacyId: string }> = []
  const homePlayers: Array<{ userId: number; legacyId: string }> = []
  let shared: { userId: number; legacyId: string }

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()

    shared = mintUserId(id => held.has(id))
    held.add(shared.userId)
    awayPlayers.push(shared)
    for (let i = 0; i < 9; i++) {
      const u = mintUserId(id => held.has(id))
      held.add(u.userId)
      awayPlayers.push(u)
    }
    homePlayers.push(shared)
    for (let i = 0; i < 9; i++) {
      const u = mintUserId(id => held.has(id))
      held.add(u.userId)
      homePlayers.push(u)
    }

    const uniqueUsers = [
      ...new Map(
        [...awayPlayers, ...homePlayers].map(u => [u.userId, u])
      ).values()
    ]
    await insertFixtureUsers(db, [
      {
        id: userIdOfGumbo(adminUser.userId),
        legacyId: adminUser.legacyId,
        display_name: 'Admin',
        is_admin: true,
        created_at: now,
        updated_at: now
      },
      ...uniqueUsers.map((u, index) => ({
        id: u.userId,
        legacyId: u.legacyId,
        display_name: `P${index}`,
        created_at: now,
        updated_at: now
      }))
    ])
    await db
      .insertInto('auth_sessions')
      .values({
        id: 'ses_fixture',
        user_id: userIdOfGumbo(adminUser.userId),
        token_hash: hashToken(TOKEN),
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000)
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        ...awayPlayers.map(u => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(u.userId),
          team_id: away,
          role: 'member' as const,
          is_player: true
        })),
        ...homePlayers.map(u => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(u.userId),
          team_id: home,
          role: 'member' as const,
          is_player: true
        })),
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(adminUser.userId),
          team_id: away,
          role: 'owner' as const,
          is_player: false
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(adminUser.userId),
          team_id: home,
          role: 'owner' as const,
          is_player: false
        }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: home,
        away_team_id: away,
        start_at: now
      })
      .execute()

    const mediaRoot = mkdtempSync(join(tmpdir(), 'tsStatsFixture-'))
    const media: MediaContext = {
      mediaRoot,
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const addr = server!.address() as AddressInfo
    base = `http://127.0.0.1:${addr.port}`
  })

  after(async function () {
    if (server != null) {
      await new Promise<void>((resolve, reject) => {
        server!.close(err => {
          if (err != null) reject(err)
          else resolve()
        })
      })
    }
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  it('parses fixture args', function () {
    expect(
      parseFixtureArgs([
        '--game',
        'g1',
        '--url',
        'http://x',
        '--cookie',
        'tok',
        '--innings',
        '3',
        '--no-scores',
        '--drop',
        'matchup.pitcher@5'
      ])
    ).deep.equals({
      game: 'g1',
      url: 'http://x',
      cookie: 'tok',
      options: {
        innings: 3,
        noScores: true,
        drop: 'matchup.pitcher@5'
      }
    })
  })

  it('maps nested credits with unequal scoring IDs and preserves baseball numbers', () => {
    const fixture = loadScorebookFixture()
    fixture.plays[0].credits = [
      { creditUserId: 1, creditType: 'assist' },
      { creditUserId: 999, creditType: 'putout' }
    ]
    const original = structuredClone(fixture.plays[0])
    const roster = Array.from({ length: 19 }, (_, i) => ({
      userId: userIdOfGumbo(1000 + i),
      gumboId: 2000 + i,
      isPlayer: true
    }))
    const mapped = mapScorebookFixture(
      fixture,
      roster.slice(0, 10),
      roster.slice(10),
      {
        awayTeamId: 'away',
        homeTeamId: 'home'
      }
    )
    expect(mapped.plays[0].credits).deep.equals([
      { creditUserId: 2000, creditType: 'assist' },
      { creditUserId: null, creditType: 'putout' }
    ])
    expect(mapped.plays[0].count).deep.equals(original.count)
    expect(fixture.plays[0]).deep.equals(original)
  })

  it('maps dual-roster skip and leaves placeholder 20 without an id', function () {
    const fixture = loadScorebookFixture()
    const awayRoster: RosterPlayer[] = awayPlayers.map(u => ({
      userId: userIdOfGumbo(u.userId),
      gumboId: u.userId,
      isPlayer: true
    }))
    const homeRoster: RosterPlayer[] = homePlayers.map(u => ({
      userId: userIdOfGumbo(u.userId),
      gumboId: u.userId,
      isPlayer: true
    }))
    const mapped = mapScorebookFixture(fixture, awayRoster, homeRoster, {
      awayTeamId: away,
      homeTeamId: home
    })
    expect(mapped.idMap.size).equals(19)
    expect([...mapped.idMap.values()].includes(shared.userId)).equals(true)
    const homeIds = [11, 12, 13, 14, 15, 16, 17, 18, 19].map(n =>
      mapped.idMap.get(n)!
    )
    expect(homeIds.includes(shared.userId)).equals(false)
    expect(homeIds.length).equals(9)

    // The scorebook's unmapped opponent has no id; it stays that way.
    const oppIndexes: number[] = []
    for (let i = 0; i < fixture.plays.length; i++) {
      if (/"fullName"\s*:\s*"Opp"/.test(JSON.stringify(fixture.plays[i]))) {
        oppIndexes.push(i)
      }
    }
    expect(oppIndexes.length).greaterThan(0)
    for (const i of oppIndexes) {
      expect(
        /"fullName"\s*:\s*"Opp"/.test(JSON.stringify(mapped.plays[i]))
      ).equals(true)
      const batter = mapped.plays[i].matchup?.batter as
        { id?: number; fullName?: string } | undefined
      if (batter?.fullName === 'Opp') {
        expect(batter.id).equals(undefined)
      }
    }

    // Placeholder 20 is stripped even when present on a play.
    const withTwenty = structuredClone(fixture)
    withTwenty.plays = [
      {
        ...fixture.plays[0],
        matchup: {
          batter: { id: 20 },
          pitcher: { id: 11 }
        },
        runners: [
          {
            movement: { start: null, end: '1B', isOut: false },
            details: { eventType: 'single', runner: { id: 20 } }
          }
        ]
      }
    ]
    const stripped = mapScorebookFixture(withTwenty, awayRoster, homeRoster, {
      awayTeamId: away,
      homeTeamId: home
    })
    expect(stripped.plays[0].matchup?.batter?.id).equals(undefined)
    expect(stripped.plays[0].runners?.[0]?.details?.runner?.id).equals(
      undefined
    )
  })

  it('posts mapped plays and writes expected; options reshape plays', async function () {
    if (db == null) this.skip()
    const written: Record<string, string> = {}
    const mapped = await postStatsFixture({
      game: gameId,
      url: base,
      cookie: TOKEN,
      options: { noScores: true },
      writeExpected: (path, body) => {
        written[path] = body
      }
    })
    expect(written[`${gameId}.expected.json`]).includes(
      String(mapped.expected[0].gumboId)
    )

    const stored = await db
      .selectFrom('events')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .where('gameId', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(Number(stored.n)).equals(mapped.plays.length)

    await db
      .updateTable('games')
      .set({ status: 'scheduled', away_score: null, home_score: null })
      .where('id', '=', gameId)
      .execute()

    const innings = await postStatsFixture({
      game: gameId,
      url: base,
      cookie: TOKEN,
      options: { innings: 3, noScores: true },
      writeExpected: () => undefined
    })
    expect(
      innings.plays.every(
        play => typeof play.about.inning === 'number' && play.about.inning <= 3
      )
    ).equals(true)

    await db
      .updateTable('games')
      .set({ status: 'scheduled', away_score: null, home_score: null })
      .where('id', '=', gameId)
      .execute()

    const noScores = await postStatsFixture({
      game: gameId,
      url: base,
      cookie: TOKEN,
      options: { noScores: true },
      writeExpected: () => undefined
    })
    expect(
      noScores.plays.every(
        play => play.result?.awayScore == null && play.result?.homeScore == null
      )
    ).equals(true)

    await db
      .updateTable('games')
      .set({ status: 'scheduled', away_score: null, home_score: null })
      .where('id', '=', gameId)
      .execute()

    const dropped = await postStatsFixture({
      game: gameId,
      url: base,
      cookie: TOKEN,
      options: { drop: 'matchup.pitcher@5', noScores: true },
      writeExpected: () => undefined
    })
    const play5 = dropped.plays.find(play => play.about.atBatIndex === 5)!
    expect(play5.matchup?.pitcher).equals(undefined)
  })

  it('rejects bad args and HTTP failures', async function () {
    expect(() => parseFixtureArgs([])).throws(/Usage/)
    expect(() =>
      parseFixtureArgs([
        '--game',
        'g',
        '--url',
        'u',
        '--cookie',
        'c',
        '--innings',
        'nope'
      ])
    ).throws(/--innings/)
    // parseFixtureArgs stores --drop; mapping validates the form.
    expect(
      parseFixtureArgs([
        '--game',
        'g',
        '--url',
        'u',
        '--cookie',
        'c',
        '--drop',
        'bad'
      ]).options.drop
    ).equals('bad')

    const fixture = loadScorebookFixture()
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home },
        { drop: 'bad' }
      )
    ).throws(/Bad --drop/)
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home },
        { drop: 'matchup.pitcher@notanumber' }
      )
    ).throws(/Bad --drop atBatIndex/)
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home },
        { drop: 'matchup.pitcher@9999' }
      )
    ).throws(/No play/)
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home },
        { drop: 'nowhere.at.all@5' }
      )
    ).throws(/Cannot drop nowhere\.at\.all: missing nowhere\.at/)
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home },
        { drop: 'matchup.missing.deep@0' }
      )
    ).throws(/Cannot drop/)

    // Roster size checks.
    const nineAway = awayPlayers.slice(0, 9).map(u => ({
      userId: userIdOfGumbo(u.userId),
      gumboId: u.userId,
      isPlayer: true
    }))
    expect(() =>
      mapScorebookFixture(
        fixture,
        nineAway,
        homePlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        { awayTeamId: away, homeTeamId: home }
      )
    ).throws(/Away roster needs 10/)
    const homeEight = homePlayers
      .filter(u => u.userId !== shared.userId)
      .slice(0, 8)
      .map(u => ({
        userId: userIdOfGumbo(u.userId),
        gumboId: u.userId,
        isPlayer: true
      }))
    homeEight.push({
      userId: userIdOfGumbo(shared.userId),
      gumboId: shared.userId,
      isPlayer: true
    })
    expect(() =>
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homeEight,
        { awayTeamId: away, homeTeamId: home }
      )
    ).throws(/Home roster needs 9/)
    const homeNine = homePlayers
      .filter(u => u.userId !== shared.userId)
      .slice(0, 9)
      .map(u => ({
        userId: userIdOfGumbo(u.userId),
        gumboId: u.userId,
        isPlayer: true
      }))
    homeNine.push({
      userId: userIdOfGumbo(shared.userId),
      gumboId: shared.userId,
      isPlayer: true
    })
    expect(
      mapScorebookFixture(
        fixture,
        awayPlayers.map(u => ({
          userId: userIdOfGumbo(u.userId),
          gumboId: u.userId,
          isPlayer: true
        })),
        homeNine,
        { awayTeamId: away, homeTeamId: home }
      ).idMap.size
    ).equals(19)

    await expectFail(
      postStatsFixture({
        game: 'missing',
        url: base,
        cookie: TOKEN,
        writeExpected: () => undefined
      })
    )
    const failFetch: typeof fetch = async (input, init) => {
      const url = urlOf(input)
      if (url.includes('/roster')) {
        return new Response('nope', { status: 500 })
      }
      return await fetch(input, init)
    }
    await expectFail(
      postStatsFixture({
        game: gameId,
        url: base,
        cookie: TOKEN,
        fetchImpl: failFetch,
        options: { noScores: true },
        writeExpected: () => undefined
      })
    )
    const failPost: typeof fetch = async (input, init) => {
      const url = urlOf(input)
      if (url.endsWith('/events') && init?.method === 'POST') {
        return new Response('nope', { status: 500 })
      }
      return await fetch(input, init)
    }
    await db!
      .updateTable('games')
      .set({ status: 'scheduled', away_score: null, home_score: null })
      .where('id', '=', gameId)
      .execute()
    await expectFail(
      postStatsFixture({
        game: gameId,
        url: base,
        cookie: TOKEN,
        fetchImpl: failPost,
        options: { noScores: true },
        writeExpected: () => undefined
      })
    )
  })
})

async function expectFail(promise: Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await promise
  } catch {
    failed = true
  }
  expect(failed).equals(true)
}
