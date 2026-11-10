import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asGameDetail } from '../../common/api'
import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { teamRoutes } from '../routes/teams'
import { fenceDistanceFor } from './fenceDistance'

/**
 * The fence a game is played to: its own, its season's, its league's, or 200
 * feet — and the game's page says which.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_fence_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

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

const viewer = mintUserId(() => false)

describe('the fence a game is played to', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const league = makeId('league')
  const season = makeId('season')
  const loose = makeId('season')
  const home = makeId('team')
  const away = makeId('team')
  const game = makeId('game')
  const unseasoned = makeId('game')
  const inLoose = makeId('game')
  const scored = makeId('game')
  const ownFence = makeId('game')
  const cancelled = makeId('game')
  const sized = makeId('game')
  const missized = makeId('game')
  const raced = makeId('game')

  const setFence = async (
    table: 'leagues' | 'seasons' | 'games',
    id: string,
    feet: number | null
  ): Promise<void> => {
    await db!
      .updateTable(table)
      .set({ fence_distance_ft: feet })
      .where('id', '=', id)
      .execute()
  }

  before(async function () {
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
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(viewer.userId),
      legacyId: viewer.legacyId,
      display_name: 'Viewer',
      is_admin: true,
      created_at: now,
      updated_at: now
    })
    await db.insertInto('leagues').values({ id: league, name: 'L' }).execute()
    await db
      .insertInto('seasons')
      .values([
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: season,
          league_id: league,
          name: 'S',
          year: 2026
        },
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: loose,
          name: 'Loose',
          year: 2026
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home' },
        { id: away, name: 'Away' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values(
        [
          { id: game, season_id: season },
          { id: unseasoned, season_id: null },
          { id: inLoose, season_id: loose },
          { id: scored, season_id: season },
          { id: ownFence, season_id: season, fence_distance_ft: 150 },
          { id: cancelled, season_id: season, status: 'cancelled' as const },
          { id: sized, season_id: season },
          { id: missized, season_id: season },
          { id: raced, season_id: season }
        ].map(row => ({
          ...row,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        }))
      )
      .execute()

    const app = express()
    app.use((req, _res, next) => {
      req.actor = {
        userId: userIdOfGumbo(viewer.userId),
        isAdmin: true,
        scopes: []
      }
      next()
    })
    app.use('/api/v1', teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName} with (force)`)
      await admin.end()
    }
  })

  it('takes the game’s, then the season’s, then the league’s, then 200 feet', async function () {
    if (db == null) this.skip()
    expect(await fenceDistanceFor(db, game)).equals(200)
    await setFence('leagues', league, 250)
    expect(await fenceDistanceFor(db, game)).equals(250)
    await setFence('seasons', season, 220)
    expect(await fenceDistanceFor(db, game)).equals(220)
    await setFence('games', game, 175)
    expect(await fenceDistanceFor(db, game)).equals(175)
    // Clearing a level hands the fence back to the one above.
    await setFence('games', game, null)
    expect(await fenceDistanceFor(db, game)).equals(220)
    await setFence('seasons', season, null)
    expect(await fenceDistanceFor(db, game)).equals(250)
    await setFence('leagues', league, null)
    expect(await fenceDistanceFor(db, game)).equals(200)
    // No season, a season with no league, and no game at all.
    expect(await fenceDistanceFor(db, unseasoned)).equals(200)
    await setFence('games', unseasoned, 160)
    expect(await fenceDistanceFor(db, unseasoned)).equals(160)
    await setFence('seasons', loose, 190)
    expect(await fenceDistanceFor(db, inLoose)).equals(190)
    expect(await fenceDistanceFor(db, makeId('game'))).equals(200)
  })

  it('refuses a fence of no feet or past 600 in the database itself', async function () {
    if (db == null) this.skip()
    for (const feet of [0, -5, 601]) {
      let refused = ''
      try {
        await setFence('games', game, feet)
      } catch (error) {
        refused = String(error)
      }
      expect(refused, String(feet)).includes('fence_distance_ft_check')
    }
  })

  it('puts the resolved fence on the game’s page', async function () {
    if (db == null) this.skip()
    const page = async (id: string): Promise<number> => {
      const response = await fetch(`${base}/games/${id}`)
      expect(response.status).equals(200)
      return asGameDetail(await response.json()).fenceDistanceFt
    }
    await setFence('leagues', league, 240)
    expect(await page(game)).equals(240)
    await setFence('games', game, 210)
    expect(await page(game)).equals(210)
    expect(await page(unseasoned)).equals(160)
  })
  it('fixes a game’s fence when its first plays are posted, whatever its status', async function () {
    if (db == null) this.skip()
    const stolen = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    const post = async (
      id: string,
      plays: unknown[],
      fenceDistanceFt?: unknown
    ): Promise<void> => {
      await postGamePlays(
        db!,
        id,
        asPostEventsBody({
          plays,
          source: { system: 'manual' },
          fenceDistanceFt
        })
      )
    }
    const stored = async (id: string): Promise<number | null> =>
      (
        await db!
          .selectFrom('games')
          .select('fence_distance_ft')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).fence_distance_ft
    await setFence('seasons', season, null)
    await setFence('leagues', league, 230)
    // A post with no plays starts nothing, so nothing is fixed.
    await post(scored, [])
    expect(await stored(scored)).equals(null)
    await post(scored, [stolen])
    expect(await stored(scored)).equals(230)
    // The league and season move on; the game keeps the fence it began with.
    await setFence('leagues', league, 260)
    await setFence('seasons', season, 205)
    expect(await fenceDistanceFor(db, scored)).equals(230)
    await post(scored, [stolen])
    expect(await stored(scored)).equals(230)
    // A game's own fence stays its own.
    await post(ownFence, [stolen])
    expect(await stored(ownFence)).equals(150)
    // A cancelled game with plays has them all the same.
    await post(cancelled, [stolen])
    expect(await stored(cancelled)).equals(205)
    await setFence('seasons', season, 215)
    expect(await fenceDistanceFor(db, cancelled)).equals(205)
    // The fence the scorer's documents were sized by, when the post says,
    // and only on the first: the season's fence has moved since he opened
    // the game.
    await post(sized, [stolen], 240)
    expect(await stored(sized)).equals(240)
    await post(sized, [stolen], 180)
    expect(await stored(sized)).equals(240)
    // A fence that is no fence is left out, and the game's is fixed.
    await post(missized, [stolen], 900)
    expect(await stored(missized)).equals(215)
    await setFence('seasons', season, null)
    await setFence('leagues', league, null)
  })

  it('keeps the fence of the first of two first posts that race', async function () {
    if (db == null) this.skip()
    const stolen = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    const post = async (fenceDistanceFt: number): Promise<unknown> =>
      await postGamePlays(
        db!,
        raced,
        asPostEventsBody({
          plays: [stolen],
          source: { system: 'manual' },
          fenceDistanceFt
        })
      )
    const settle = async (): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    // Both wait on the game row, in turn, while something else holds it.
    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    await db.transaction().execute(async trx => {
      await trx
        .selectFrom('games')
        .select('id')
        .where('id', '=', raced)
        .forUpdate()
        .execute()
      first = post(240)
      await settle()
      second = post(180)
      await settle()
    })
    await Promise.all([first, second])
    const row = await db
      .selectFrom('games')
      .select('fence_distance_ft')
      .where('id', '=', raced)
      .executeTakeFirstOrThrow()
    expect(row.fence_distance_ft).equals(240)
  })
})
