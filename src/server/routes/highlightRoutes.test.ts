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
 * list. A player's list narrows to a season, a team or a year as their stats
 * do.
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
const dee = mintUserId(
  id =>
    id === admin.userId ||
    id === ada.userId ||
    id === bea.userId ||
    id === cal.userId ||
    id === bee.userId
)
const eve = mintUserId(
  id =>
    id === admin.userId ||
    id === ada.userId ||
    id === bea.userId ||
    id === cal.userId ||
    id === bee.userId ||
    id === dee.userId
)

/** When both recordings start. Every play is some minutes after it. */
const RECORDING = new Date('2026-05-02T18:00:00.000Z')
const minutesIn = (minutes: number, start = RECORDING): string =>
  new Date(start.getTime() + minutes * 60_000).toISOString()

/** Dee Gordon's three games, for the season, team and year filters. */
const DEE_AWAY = new Date('2026-05-09T18:00:00.000Z')
const DEE_SEASON = new Date('2026-06-06T18:00:00.000Z')
const DEE_LAST_YEAR = new Date('2025-05-03T18:00:00.000Z')

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
  const other = makeId('team')
  const season = makeId('season')
  const replacedLive = makeId('video')
  const shownLive = makeId('video')
  const deeGames = {
    away: { gameId: makeId('game'), videoId: makeId('video') },
    season: { gameId: makeId('game'), videoId: makeId('video') },
    lastYear: { gameId: makeId('game'), videoId: makeId('video') }
  }

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
    const first = await get(
      `/players/${userIdOfGumbo(ada.userId)}/highlights?limit=2`
    )
    expect(first.status).equals(200)
    expect(eventIdsOf(first.body)).deep.equals(['evt_ada3', 'evt_ada2'])
    expect(first.body.nextBefore).equals(minutesIn(30))
    expect(first.body.withoutVideo).equals(0)
    expect(first.body.highlights[0].videoId).equals(creditedVideo)
    expect(first.body.highlights[0].outcome).is.a('string')
    // Stops the node's 5 s past the play, wherever it starts.
    for (const highlight of first.body.highlights)
      expect(highlight.endOffsetSec).equals(highlight.playOffsetSec + 5)

    const second = await get(
      `/players/${userIdOfGumbo(ada.userId)}/highlights?limit=2&before=${encodeURIComponent(
        first.body.nextBefore
      )}`
    )
    expect(eventIdsOf(second.body)).deep.equals(['evt_ada1'])
    expect(second.body.nextBefore).equals(null)
  })

  it("times a player's plays on the program file a game is watched on, never on a hidden recording it replaced", async function () {
    const answer = await get(`/players/${userIdOfGumbo(dee.userId)}/highlights`)
    expect(answer.status).equals(200)
    const byEvent = new Map(
      (
        answer.body.highlights as Array<{
          eventId: string
          videoId: string
          startOffsetSec: number
        }>
      ).map(highlight => [highlight.eventId, highlight])
    )
    // Replaced and hidden: the game page never shows it, so a highlight
    // named on it could never open there.
    expect(byEvent.get('evt_dee_away')?.videoId).equals(deeGames.away.videoId)
    // Shown beside the program file, still not the one chosen.
    expect(byEvent.get('evt_dee_season')?.videoId).equals(
      deeGames.season.videoId
    )
    // Timed on the program file, as the game page's own list times it.
    const own = await get(`/videos/${deeGames.away.videoId}/highlights`)
    const listed = (
      own.body.highlights as Array<{ eventId: string; startOffsetSec: number }>
    ).find(highlight => highlight.eventId === 'evt_dee_away')
    expect(byEvent.get('evt_dee_away')?.startOffsetSec).equals(
      listed?.startOffsetSec
    )
  })

  it('finds a player credited under a row merged into them', async function () {
    const answer = await get(`/players/${userIdOfGumbo(bea.userId)}/highlights`)
    expect(answer.status).equals(200)
    expect(eventIdsOf(answer.body)).deep.equals(['evt_bea'])
  })

  it('answers an empty page for somebody credited with nothing', async function () {
    const answer = await get(`/players/${userIdOfGumbo(cal.userId)}/highlights`)
    expect(answer.body).deep.equals({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    })
  })

  it('answers 400 for a malformed user id', async function () {
    expect((await get('/players/not-a-user/highlights')).status).equals(400)
  })

  describe("narrowed as the player's stats are", function () {
    const dees = async (query = ''): Promise<string[]> => {
      const answer = await get(
        `/players/${userIdOfGumbo(dee.userId)}/highlights${query}`
      )
      expect(answer.status).equals(200)
      return eventIdsOf(answer.body)
    }

    it('answers every game with no filter', async function () {
      expect(await dees()).deep.equals([
        'evt_dee_season',
        'evt_dee_away',
        'evt_dee_last_year'
      ])
    })

    it('narrows to a season', async function () {
      expect(await dees(`?seasonId=${season}`)).deep.equals(['evt_dee_season'])
    })

    it('narrows to the team they played for, not a team they played against', async function () {
      expect(await dees(`?teamId=${away}`)).deep.equals([
        'evt_dee_season',
        'evt_dee_away'
      ])
      expect(await dees(`?teamId=${other}`)).deep.equals(['evt_dee_last_year'])
      // Home was in every one of Dee's games, and Dee never played for it.
      expect(await dees(`?teamId=${home}`)).deep.equals([])
    })

    it('leaves a play whose credit names no team to the teams in its game', async function () {
      const eves = async (teamId: string): Promise<string[]> =>
        eventIdsOf(
          (
            await get(
              `/players/${userIdOfGumbo(eve.userId)}/highlights?teamId=${teamId}`
            )
          ).body
        )
      expect(await eves(away)).deep.equals(['evt_eve'])
      expect(await eves(other)).deep.equals([])
    })

    it('narrows to a calendar year', async function () {
      expect(await dees('?year=2025')).deep.equals(['evt_dee_last_year'])
      expect(await dees('?year=2026')).deep.equals([
        'evt_dee_season',
        'evt_dee_away'
      ])
    })

    it('ignores a year that is not one, and empty values, as the stats do', async function () {
      const career = await dees()
      expect(await dees('?year=26')).deep.equals(career)
      expect(await dees('?year=twenty')).deep.equals(career)
      expect(await dees('?seasonId=&teamId=&year=')).deep.equals(career)
    })

    it('narrows before the page is cut, and pages through what is left', async function () {
      const first = await get(
        `/players/${userIdOfGumbo(dee.userId)}/highlights?teamId=${away}&limit=1`
      )
      expect(eventIdsOf(first.body)).deep.equals(['evt_dee_season'])
      expect(first.body.nextBefore).equals(minutesIn(10, DEE_SEASON))

      const second = await get(
        `/players/${userIdOfGumbo(dee.userId)}/highlights?teamId=${away}&limit=1&before=${encodeURIComponent(
          first.body.nextBefore
        )}`
      )
      expect(eventIdsOf(second.body)).deep.equals(['evt_dee_away'])
      expect(second.body.nextBefore).equals(null)
    })

    it('answers an empty page when nothing is left', async function () {
      const answer = await get(
        `/players/${userIdOfGumbo(dee.userId)}/highlights?seasonId=${season}&year=2025`
      )
      expect(answer.body).deep.equals({
        highlights: [],
        nextBefore: null,
        withoutVideo: 0
      })
    })
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
    for (const highlight of answer.body.highlights)
      expect(highlight.endOffsetSec).equals(highlight.playOffsetSec + 5)
  })

  it('keeps the highlights of a game whose plays nobody has credited yet', async function () {
    const answer = await get(`/videos/${oldVideo}/highlights`)
    expect(answer.status).equals(200)
    expect(eventIdsOf(answer.body)).deep.equals(['evt_old'])
    expect(answer.body.droppedCount).equals(0)
  })

  /**
   * Adam is credited on three plays, Brett on one under a row merged into
   * him, and Cal on none; and an older game holds a play from before credits.
   */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    await insertFixtureUsers(
      db,
      [
        { made: admin, name: 'Adam Dunn', isAdmin: true },
        { made: ada, name: 'Adam LaRoche', isAdmin: false },
        { made: bea, name: 'Brett Butler', isAdmin: false },
        { made: cal, name: 'Cal Ripken', isAdmin: false },
        { made: bee, name: 'Brett B', isAdmin: false },
        { made: dee, name: 'Dee Gordon', isAdmin: false },
        { made: eve, name: 'Evan Longoria', isAdmin: false }
      ].map(person => ({
        id: person.made.userId,
        legacyId: person.made.legacyId,
        display_name: person.name,
        is_admin: person.isAdmin,
        created_at: now,
        updated_at: now
      }))
    )
    await db
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: userIdOfGumbo(admin.userId),
        token_hash: hashToken(ADMIN),
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000)
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' },
        { id: other, name: 'Other', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values({
        starts_on: `2026-03-01`,
        ends_on: `2026-05-31`,
        id: season,
        name: 'Summer 2026',
        year: 2026
      })
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(bea.userId) })
      .where('id', '=', userIdOfGumbo(bee.userId))
      .execute()

    // Dee played for Away twice, once in a season, and for Other last year,
    // and Home was the other side every time.
    const games: Array<{
      gameId: string
      videoId: string
      start: Date
      seasonId?: string
      awayTeamId?: string
    }> = [
      { gameId: creditedGame, videoId: creditedVideo, start: RECORDING },
      { gameId: oldGame, videoId: oldVideo, start: RECORDING },
      { ...deeGames.away, start: DEE_AWAY },
      { ...deeGames.season, start: DEE_SEASON, seasonId: season },
      { ...deeGames.lastYear, start: DEE_LAST_YEAR, awayTeamId: other }
    ]
    for (const game of games) {
      await db
        .insertInto('games')
        .values({
          id: game.gameId,
          home_team_id: home,
          away_team_id: game.awayTeamId ?? away,
          season_id: game.seasonId ?? null,
          start_at: game.start,
          status: 'final'
        })
        .execute()
      await db
        .insertInto('videos')
        .values({
          id: game.videoId,
          game_id: game.gameId,
          kind: 'program',
          title: 'Home vs Away',
          storage: 'spaces',
          status: 'ready',
          start_at: game.start,
          duration_sec: 7200
        })
        .execute()
    }
    // Dee's away game was streamed live, and the stream's recording was
    // then replaced by the program file and hidden. Its own clock started
    // half a minute sooner, so a play timed on it would be wrong on the
    // program file.
    await db
      .insertInto('videos')
      .values({
        id: replacedLive,
        game_id: deeGames.away.gameId,
        kind: 'live',
        title: 'Home vs Away — Primary',
        storage: 'spaces',
        status: 'ready',
        start_at: new Date(DEE_AWAY.getTime() - 30_000),
        duration_sec: 7200,
        hidden: true,
        replaced_by: deeGames.away.videoId
      })
      .execute()
    // Dee's season game has a live recording that is still shown, beside
    // its program file: the program file is the one a game is watched on.
    await db
      .insertInto('videos')
      .values({
        id: shownLive,
        game_id: deeGames.season.gameId,
        kind: 'live',
        title: 'Home vs Away — Primary',
        storage: 'spaces',
        status: 'ready',
        start_at: new Date(DEE_SEASON.getTime() - 30_000),
        duration_sec: 7200
      })
      .execute()

    const credit = (
      name: string,
      creditUserId: number,
      teamId: string | null = away
    ): Record<string, unknown> => ({
      eventType: 'single',
      label: `Single: ${name}`,
      teamId,
      creditUserId,
      credit: { name, role: 'batter', position: null }
    })
    const plays: Array<{
      id: string
      gameId: string
      atBatIndex: number
      minutes: number
      start?: Date
      credits?: unknown[]
    }> = [
      {
        id: 'evt_dee_away',
        gameId: deeGames.away.gameId,
        atBatIndex: 0,
        minutes: 10,
        start: DEE_AWAY,
        credits: [credit('Dee G', dee.userId)]
      },
      // Credited to Evan on a team we do not know.
      {
        id: 'evt_eve',
        gameId: deeGames.away.gameId,
        atBatIndex: 1,
        minutes: 20,
        start: DEE_AWAY,
        credits: [credit('Evan L', eve.userId, null)]
      },
      {
        id: 'evt_dee_season',
        gameId: deeGames.season.gameId,
        atBatIndex: 0,
        minutes: 10,
        start: DEE_SEASON,
        credits: [credit('Dee G', dee.userId)]
      },
      {
        id: 'evt_dee_last_year',
        gameId: deeGames.lastYear.gameId,
        atBatIndex: 0,
        minutes: 10,
        start: DEE_LAST_YEAR,
        credits: [credit('Dee G', dee.userId, other)]
      },
      {
        id: 'evt_ada1',
        gameId: creditedGame,
        atBatIndex: 0,
        minutes: 10,
        credits: [credit('Adam L', ada.userId)]
      },
      {
        id: 'evt_bea',
        gameId: creditedGame,
        atBatIndex: 1,
        minutes: 20,
        credits: [credit('Brett B', bee.userId)]
      },
      {
        id: 'evt_ada2',
        gameId: creditedGame,
        atBatIndex: 2,
        minutes: 30,
        credits: [credit('Adam L', ada.userId)]
      },
      {
        id: 'evt_ada3',
        gameId: creditedGame,
        atBatIndex: 3,
        minutes: 40,
        credits: [credit('Adam L', ada.userId)]
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
          startTime: minutesIn(play.minutes, play.start),
          battingTeamId: away,
          gumbo: {
            about: {
              atBatIndex: play.atBatIndex,
              inning: 1,
              halfInning: 'top',
              isScoringPlay: false,
              startTime: minutesIn(play.minutes, play.start)
            },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            ...(play.credits == null ? {} : { credits: play.credits })
          }
        })
        .execute()
    }
  }
})
