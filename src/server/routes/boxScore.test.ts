import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asBoxScore } from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { asUserId, mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { battingLines, pitchingLines } from '../stats'
import { boxScoreOrder } from '../stats/boxScoreOrder'
import { statRows } from '../stats/rows'
import { teamRoutes } from './teams'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_boxscore_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const season = makeId('season')
const home = makeId('team')
const away = makeId('team')
const gameId = makeId('game')
const held = new Set<number>()
const legacies = new Map<number, string>()
function mint(): number {
  const made = mintUserId(id => held.has(id))
  held.add(made.userId)
  legacies.set(made.userId, made.legacyId)
  return made.userId
}
const batter = mint()
const pitcher = mint()
const reliever = mint()
const viewer = mint()

const media: MediaContext = {
  ffmpegPath: 'ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

describe('GET /games/:gameId/box-score stats', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let base = ''
  let server: ReturnType<express.Express['listen']> | undefined

  const ask = async (): Promise<ReturnType<typeof asBoxScore>> => {
    const res = await fetch(`${base}/games/${gameId}/box-score`, {
      headers: { 'x-test-actor': String(viewer) }
    })
    expect(res.status).equals(200)
    return asBoxScore(await res.json())
  }

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    const now = new Date()
    await db
      .insertInto('seasons')
      .values({
        starts_on: `2026-03-01`,
        ends_on: `2026-05-31`,
        id: season,
        name: 'Fall',
        year: 2026,
        era_innings: 6
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home' },
        { id: away, name: 'Away' }
      ])
      .execute()
    for (const [id, name] of [
      [batter, 'Batter Bat'],
      [pitcher, 'Pitcher Pit'],
      [reliever, 'Reliever Pen'],
      [viewer, 'Viewer View']
    ] as const) {
      await insertFixtureUsers(db, {
        id,
        legacyId: legacies.get(id)!,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ')[1],
        is_admin: id === viewer,
        created_at: now,
        updated_at: now
      })
    }
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: home,
        away_team_id: away,
        season_id: season,
        start_at: now,
        status: 'final'
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values([
        {
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: batter,
          team_id: away,
          pa: 3,
          ab: 2,
          h: 1,
          singles: 1,
          r: 1,
          rbi: 1
        },
        {
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: pitcher,
          team_id: home,
          pitch_bf: 4,
          pitch_outs: 3,
          pitch_h: 1,
          pitch_k: 1
        },
        {
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: reliever,
          team_id: home,
          pitch_bf: 6,
          pitch_outs: 6,
          pitch_k: 2
        }
      ])
      .execute()
    // The starter pitches the first play; the reliever, who gets more outs,
    // comes in during the second.
    await db
      .insertInto('events')
      .values([
        {
          id: makeId('event'),
          gameId,
          startTime: now,
          battingTeamId: away,
          gumbo: JSON.stringify({
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single' },
            matchup: { batter: { id: batter }, pitcher: { id: pitcher } },
            playEvents: [{ index: 0, isPitch: true, player: { id: pitcher } }]
          })
        },
        {
          id: makeId('event'),
          gameId,
          startTime: now,
          battingTeamId: away,
          gumbo: JSON.stringify({
            about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
            result: { eventType: 'strikeout' },
            matchup: { batter: { id: batter }, pitcher: { id: reliever } },
            playEvents: [
              {
                index: 0,
                details: { eventType: 'pitching_substitution' },
                player: { id: reliever },
                replacedPlayer: { id: pitcher }
              },
              { index: 1, isPitch: true, player: { id: reliever } }
            ]
          })
        }
      ])
      .execute()

    const app = express()
    app.use((req, _res, next) => {
      const id = req.header('x-test-actor')
      if (id != null) {
        req.actor = {
          userId: userIdOfGumbo(asUserId(id)),
          isAdmin: asUserId(id) === viewer,
          scopes: []
        }
      }
      next()
    })
    app.use('/api/v1', teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0)
    const address = server.address()
    base =
      typeof address === 'object' && address != null
        ? `http://127.0.0.1:${address.port}/api/v1`
        : ''
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function setState(
    status: 'pending' | 'built' | 'incomplete' | 'failed',
    detail: string | null = null,
    builtAt: Date | null = null
  ): Promise<void> {
    await db!
      .insertInto('game_stats_state')
      .values({
        game_id: gameId,
        requested_generation: 1,
        built_generation: status === 'pending' ? 0 : 1,
        status,
        detail,
        attempts: status === 'failed' ? 1 : 0,
        retry_at: null,
        requested_at: new Date(),
        built_at: builtAt
      })
      .onConflict(oc =>
        oc.column('game_id').doUpdateSet({
          status,
          detail,
          built_generation: status === 'pending' ? 0 : 1,
          attempts: status === 'failed' ? 1 : 0,
          built_at: builtAt
        })
      )
      .execute()
  }

  it('returns stats.status none when the game has no state row', async function () {
    await db!
      .deleteFrom('game_stats_state')
      .where('game_id', '=', gameId)
      .execute()
    const box = await ask()
    expect(box.stats).deep.equals({ status: 'none' })
  })

  it('returns pending, built, incomplete with detail, and failed', async function () {
    await setState('pending')
    expect((await ask()).stats?.status).equals('pending')

    const builtAt = new Date('2026-09-25T12:00:00.000Z')
    await setState('built', null, builtAt)
    const built = await ask()
    expect(built.stats).deep.equals({
      status: 'built',
      detail: null,
      builtAt: builtAt.toISOString()
    })

    await setState('incomplete', 'play 5: matchup.pitcher missing')
    expect((await ask()).stats).deep.equals({
      status: 'incomplete',
      detail: 'play 5: matchup.pitcher missing',
      builtAt: null
    })

    await setState('failed', 'constraint violation')
    expect((await ask()).stats).deep.equals({
      status: 'failed',
      detail: 'constraint violation',
      builtAt: null
    })
  })

  it('batting and pitching lines match battingLines/pitchingLines of the rows', async function () {
    await setState('built', null, new Date())
    const box = await ask()
    const rows = await statRows(db!, { gameId })
    const batting = battingLines(rows)
    const pitching = pitchingLines(rows)
    expect(box.batting.map(line => line.userId)).deep.equals(
      batting.map(line => line.userId)
    )
    // The same pitchers, in the order they pitched rather than by outs.
    expect(box.pitching.map(line => line.userId).sort()).deep.equals(
      pitching.map(line => line.userId).sort()
    )
    expect(box.batting[0]).includes({
      userId: userIdOfGumbo(batter),
      h: 1,
      ab: 2,
      pa: 3
    })
    expect(box.pitching[0]).includes({
      userId: userIdOfGumbo(pitcher),
      outs: 3
    })
  })

  it('keeps numeric identity order across Base58 letter case when first appearances tie', async function () {
    const [row] = await statRows(db!, { gameId })
    const lines = battingLines(
      [33, 32, 10].map(id => ({
        ...row,
        userId: userIdOfGumbo(id),
        pa: 1,
        extra: null
      }))
    )
    expect(
      (await boxScoreOrder(db!, gameId, lines)).map(line => line.userId)
    ).deep.equals([10, 32, 33].map(userIdOfGumbo))
    const first = lines.map(line => ({
      ...line,
      firstPa: line.userId === userIdOfGumbo(33) ? 0 : 1
    }))
    expect(
      (await boxScoreOrder(db!, gameId, first)).map(line => line.userId)
    ).deep.equals([33, 10, 32].map(userIdOfGumbo))
  })

  it('lists pitchers in the order they pitched, not by outs', async function () {
    const box = await ask()
    expect(box.pitching.map(line => line.userId)).deep.equals([
      userIdOfGumbo(pitcher),
      userIdOfGumbo(reliever)
    ])
    expect(box.pitching[0]).includes({
      userId: userIdOfGumbo(pitcher),
      outs: 3
    })
    expect(box.pitching[1]).includes({
      userId: userIdOfGumbo(reliever),
      outs: 6
    })
  })
})
