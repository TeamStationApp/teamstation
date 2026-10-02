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
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { playerRoutes } from './players'
import { teamRoutes } from './teams'

/**
 * A player's highlights and a video's, through the real routers.
 *
 * Both are read from the credits the stored plays carry. A player is found
 * by the user id on the credit, under any row that is them, and a game whose
 * plays nobody has credited yet still shows its plays rather than an empty
 * list.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_highlights_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_highlights_admin_0000000000000000'

const admin = mintUserId(() => false)
const ada = mintUserId(id => id === admin.userId)
const bea = mintUserId(id => id === admin.userId || id === ada.userId)
const cal = mintUserId(
  id => id === admin.userId || id === ada.userId || id === bea.userId
)
const bee = mintUserId(
  id =>
    id === admin.userId ||
    id === ada.userId ||
    id === bea.userId ||
    id === cal.userId
)

/** When both recordings start. Every play is some minutes after it. */
const RECORDING = new Date('2026-05-02T18:00:00.000Z')
const minutesIn = (minutes: number): string =>
  new Date(RECORDING.getTime() + minutes * 60_000).toISOString()

describe('the highlight routes', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const home = makeId('team')
  const away = makeId('team')
  const creditedGame = makeId('game')
  const creditedVideo = makeId('video')
  const oldGame = makeId('game')
  const oldVideo = makeId('video')

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
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    await seed(db)

    // No file and no Space, so warming stills after an answer finds nothing
    // to cut and makes no request.
    const mediaRoot = mkdtempSync(join(tmpdir(), 'tsHighlightRoutes-'))
    const media: MediaContext = {
      mediaRoot,
      workDir: mediaRoot,
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
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null) {
      await new Promise(resolve => listening.close(resolve))
    }
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function get(path: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${ADMIN}` }
    })
    return { status: response.status, body: await response.json() }
  }

  const eventIdsOf = (body: {
    highlights: Array<{ eventId: string }>
  }): string[] => body.highlights.map(highlight => highlight.eventId)

  it("finds a player's plays by our own user id, newest first, a page at a time", async function () {
    const first = await get(`/players/${ada.userId}/highlights?limit=2`)
    expect(first.status).equals(200)
    expect(eventIdsOf(first.body)).deep.equals(['evt_ada3', 'evt_ada2'])
    expect(first.body.nextBefore).equals(minutesIn(30))
    expect(first.body.withoutVideo).equals(0)
    expect(first.body.highlights[0].videoId).equals(creditedVideo)
    expect(first.body.highlights[0].outcome).is.a('string')

    const second = await get(
      `/players/${ada.userId}/highlights?limit=2&before=${encodeURIComponent(
        first.body.nextBefore
      )}`
    )
    expect(eventIdsOf(second.body)).deep.equals(['evt_ada1'])
    expect(second.body.nextBefore).equals(null)
  })

  it('finds a player credited under a row merged into them', async function () {
    const answer = await get(`/players/${bea.userId}/highlights`)
    expect(answer.status).equals(200)
    expect(eventIdsOf(answer.body)).deep.equals(['evt_bea'])
  })

  it('answers an empty page for somebody credited with nothing', async function () {
    const answer = await get(`/players/${cal.userId}/highlights`)
    expect(answer.body).deep.equals({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    })
  })

  it('answers 404 for a user id that is not one', async function () {
    expect((await get('/players/not-a-user/highlights')).status).equals(404)
  })

  it("lists a video's credited plays", async function () {
    const answer = await get(`/videos/${creditedVideo}/highlights`)
    expect(answer.status).equals(200)
    expect(eventIdsOf(answer.body)).deep.equals([
      'evt_ada1',
      'evt_bea',
      'evt_ada2',
      'evt_ada3'
    ])
    expect(answer.body.withheld).equals(null)
  })

  it('keeps the highlights of a game whose plays nobody has credited yet', async function () {
    const answer = await get(`/videos/${oldVideo}/highlights`)
    expect(answer.status).equals(200)
    expect(eventIdsOf(answer.body)).deep.equals(['evt_old'])
    expect(answer.body.droppedCount).equals(0)
  })

  /**
   * Ada is credited on three plays, Bea on one under Bee, a row merged into
   * her, and Cal on none; and an older game holds a play from before credits.
   */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    await db
      .insertInto('users')
      .values(
        [
          { made: admin, name: 'Ada Admin', isAdmin: true },
          { made: ada, name: 'Ada Lovelace', isAdmin: false },
          { made: bea, name: 'Bea Brown', isAdmin: false },
          { made: cal, name: 'Cal Carter', isAdmin: false },
          { made: bee, name: 'Bea B', isAdmin: false }
        ].map(person => ({
          id: person.made.userId,
          legacyId: person.made.legacyId,
          display_name: person.name,
          is_admin: person.isAdmin,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    await db
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: admin.userId,
        token_hash: hashToken(ADMIN),
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
      .updateTable('users')
      .set({ merged_into: bea.userId })
      .where('id', '=', bee.userId)
      .execute()

    for (const [gameId, videoId] of [
      [creditedGame, creditedVideo],
      [oldGame, oldVideo]
    ]) {
      await db
        .insertInto('games')
        .values({
          id: gameId,
          home_team_id: home,
          away_team_id: away,
          start_at: RECORDING,
          status: 'final'
        })
        .execute()
      await db
        .insertInto('videos')
        .values({
          id: videoId,
          game_id: gameId,
          kind: 'program',
          title: 'Home vs Away',
          storage: 'spaces',
          status: 'ready',
          start_at: RECORDING,
          duration_sec: 7200
        })
        .execute()
    }

    const credit = (
      name: string,
      creditUserId: number
    ): Record<string, unknown> => ({
      eventType: 'single',
      label: `Single: ${name}`,
      teamId: away,
      creditUserId,
      credit: { name, role: 'batter', position: null }
    })
    const plays: Array<{
      id: string
      gameId: string
      atBatIndex: number
      minutes: number
      credits?: unknown[]
    }> = [
      {
        id: 'evt_ada1',
        gameId: creditedGame,
        atBatIndex: 0,
        minutes: 10,
        credits: [credit('Ada L', ada.userId)]
      },
      {
        id: 'evt_bea',
        gameId: creditedGame,
        atBatIndex: 1,
        minutes: 20,
        credits: [credit('Bea B', bee.userId)]
      },
      {
        id: 'evt_ada2',
        gameId: creditedGame,
        atBatIndex: 2,
        minutes: 30,
        credits: [credit('Ada L', ada.userId)]
      },
      {
        id: 'evt_ada3',
        gameId: creditedGame,
        atBatIndex: 3,
        minutes: 40,
        credits: [credit('Ada L', ada.userId)]
      },
      // Stored before credits existed: no `credits` key at all.
      { id: 'evt_old', gameId: oldGame, atBatIndex: 0, minutes: 15 }
    ]
    for (const play of plays) {
      await db
        .insertInto('events')
        .values({
          id: play.id,
          gameId: play.gameId,
          startTime: minutesIn(play.minutes),
          battingTeamId: away,
          gumbo: {
            about: {
              atBatIndex: play.atBatIndex,
              inning: 1,
              halfInning: 'top',
              isScoringPlay: false,
              startTime: minutesIn(play.minutes)
            },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            ...(play.credits == null ? {} : { credits: play.credits })
          }
        })
        .execute()
    }
  }
})
