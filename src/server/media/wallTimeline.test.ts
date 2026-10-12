import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { CompiledQuery, type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { WallTimeline } from '../../common/wallTimeline'
import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database, VideoWallAnchorsTable } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { openApiDocument } from '../openapi'
import { mediaRoutes } from '../routes/media'
import { anchorSummaryQuery, wallTimelineOf } from './wallTimeline'

/**
 * `GET /videos/:videoId/wall-timeline` (U20): every row of the confidence
 * table, from points written straight into `video_wall_anchors` (nothing
 * writes them yet), the start fallback, `afterMs`, and the access the
 * video's playback has.
 */
describe("a video's wall-clock timeline (U20)", function () {
  this.timeout(60_000)

  const T0 = Date.parse('2026-05-02T18:00:00.000Z')
  let db: Kysely<Database>
  let drop: (() => Promise<void>) | undefined
  let server: Server | undefined
  let base = ''
  let owner: Person
  let stranger: Person
  let gameId = ''

  before(async function () {
    ;({ db, drop } = await scratchDatabase('wall_timeline'))
    const home = await addTeam(db, 'Pioneers')
    owner = await addPerson(db, 'owner', { owns: home })
    stranger = await addPerson(db, 'stranger')
    gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date(T0)
    })
    const app = express()
    app.use(withActor(db))
    app.use(
      '/api/v1',
      mediaRoutes(db, {
        ffmpegPath: '/usr/bin/ffmpeg',
        mediaRoot: '/var/app/media',
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
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    await drop?.()
  })

  async function addVideo(
    fields: {
      startAt?: Date | null
      syncOffsetSec?: number
      clockOffsetMs?: number | null
      status?: 'live' | 'ready'
      hidden?: boolean
    } = {}
  ): Promise<string> {
    const id = makeId('video')
    const now = new Date()
    await db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: fields.status === 'live' ? 'live' : 'program',
        title: 'Programme',
        storage: 'spaces',
        status: fields.status ?? 'ready',
        start_at: fields.startAt === undefined ? new Date(T0) : fields.startAt,
        sync_offset_sec: fields.syncOffsetSec ?? 0,
        start_at_clock_offset_ms: fields.clockOffsetMs ?? null,
        hidden: fields.hidden ?? false,
        created_at: now,
        updated_at: now
      })
      .execute()
    return id
  }

  async function addAnchors(
    videoId: string,
    points: Array<[number, number, VideoWallAnchorsTable['source'], boolean?]>
  ): Promise<void> {
    await db
      .insertInto('video_wall_anchors')
      .values(
        points.map(([mediaMs, wallMs, source, corrected]) => ({
          video_id: videoId,
          media_ms: mediaMs,
          wall: new Date(wallMs),
          source,
          ...(corrected == null ? {} : { corrected })
        }))
      )
      .execute()
  }

  async function timeline(
    videoId: string,
    query = '',
    who: Person | null = owner
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(
      `${base}/videos/${videoId}/wall-timeline${query}`,
      {
        headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
      }
    )
    return { status: response.status, body: await response.json() }
  }

  async function answer(videoId: string, query = ''): Promise<WallTimeline> {
    const got = await timeline(videoId, query)
    expect(got.status, JSON.stringify(got.body)).equals(200)
    return got.body as WallTimeline
  }

  it('is frame-exact from SEI stamped on the server clock throughout', async function () {
    const videoId = await addVideo()
    await addAnchors(videoId, [
      [500, T0 + 1_500, 'sei'],
      [0, T0 + 1_000, 'sei'],
      [60_000, T0 + 81_000, 'sei']
    ])
    expect(await answer(videoId)).deep.equals({
      anchors: [
        [0, T0 + 1_000],
        [500, T0 + 1_500],
        [60_000, T0 + 81_000]
      ],
      source: 'sei',
      confidence: 'frame',
      live: false,
      startAt: new Date(T0).toISOString()
    })
  })

  it('is approximate from SEI when any of it was stamped without an offset', async function () {
    const videoId = await addVideo()
    await addAnchors(videoId, [
      [0, T0, 'sei'],
      [500, T0 + 500, 'sei', false]
    ])
    const got = await answer(videoId)
    expect([got.source, got.confidence]).deep.equals(['sei', 'approximate'])
    expect(got.anchors).deep.equals([
      [0, T0],
      [500, T0 + 500]
    ])
  })

  it('is approximate from arrival, and live while streaming', async function () {
    const videoId = await addVideo({ status: 'live' })
    await addAnchors(videoId, [
      [0, T0 + 2_000, 'arrival'],
      [4_000, T0 + 6_100, 'arrival']
    ])
    const got = await answer(videoId)
    expect([got.source, got.confidence, got.live]).deep.equals([
      'arrival',
      'approximate',
      true
    ])
    // A stream that carried SEI and then a segment that did not.
    const mixed = await addVideo()
    await addAnchors(mixed, [
      [0, T0, 'sei'],
      [4_000, T0 + 4_200, 'arrival']
    ])
    const both = await answer(mixed)
    expect([both.source, both.confidence]).deep.equals([
      'arrival',
      'approximate'
    ])
  })

  it('answers only the points after afterMs, described as the whole video', async function () {
    const videoId = await addVideo({ status: 'live' })
    await addAnchors(videoId, [
      [0, T0, 'sei'],
      [4_000, T0 + 4_000, 'sei'],
      [8_000, T0 + 8_000, 'sei', false]
    ])
    const got = await answer(videoId, '?afterMs=4000')
    expect(got.anchors).deep.equals([[8_000, T0 + 8_000]])
    expect([got.source, got.confidence]).deep.equals(['sei', 'approximate'])
    expect((await answer(videoId, '?afterMs=8000')).anchors).deep.equals([])
    expect((await answer(videoId, '?afterMs=0')).anchors).has.length(2)
  })

  it('falls back to the start, by the clock when its offset was measured', async function () {
    const videoId = await addVideo({ clockOffsetMs: 1234, syncOffsetSec: 2 })
    expect(await answer(videoId)).deep.equals({
      anchors: [[0, T0 - 2_000]],
      source: 'start',
      confidence: 'clock',
      live: false,
      startAt: new Date(T0).toISOString()
    })
    // A live player already holds the start's point.
    expect((await answer(videoId, '?afterMs=0')).anchors).deep.equals([])
  })

  it('falls back to the start, approximately, without an offset or a start', async function () {
    const plain = await answer(await addVideo())
    expect([plain.anchors, plain.source, plain.confidence]).deep.equals([
      [[0, T0]],
      'start',
      'approximate'
    ])
    const startless = await answer(
      await addVideo({ startAt: null, clockOffsetMs: 1234 })
    )
    expect(startless).deep.equals({
      anchors: [],
      source: 'start',
      confidence: 'approximate',
      live: false,
      startAt: null
    })
  })

  it('answers as the playback does: a token, a video to be seen and a caller who may', async function () {
    const videoId = await addVideo()
    expect((await timeline(videoId, '', null)).status).equals(401)
    expect((await timeline('vid_nothere')).status).equals(404)
    expect((await timeline(await addVideo({ hidden: true }))).status).equals(
      404
    )
    const unseen = await timeline(videoId, '', stranger)
    expect(unseen.status).equals(403)
    expect(unseen.body.code).equals('membersOnly')
    for (const query of [
      '?afterMs=-1',
      '?afterMs=soon',
      '?afterMs=1.5',
      // Past what a point's media time can hold.
      '?afterMs=2147483648',
      '?afterMs=3000000000'
    ]) {
      expect((await timeline(videoId, query)).status, query).equals(400)
    }
    expect((await timeline(videoId, '?afterMs=2147483647')).status).equals(200)
  })

  it('is described in the API document, with the upload field it reads', function () {
    const paths = openApiDocument('test').paths as Record<string, any>
    const route = paths['/videos/{videoId}/wall-timeline'].get
    expect(route.parameters.map((p: { name: string }) => p.name)).deep.equals([
      'videoId',
      'afterMs'
    ])
    expect(Object.keys(route.responses)).includes.members([
      '400',
      '401',
      '403',
      '404'
    ])
    const open = paths['/director/uploads'].post
    expect(
      open.requestBody.content['application/json'].schema.properties
    ).has.property('serverClockOffsetMs')
  })

  /**
   * The answer as it was read before the summary came from indexes: one
   * count and two `bool_and`s over every point of the video.
   */
  async function aggregated(
    videoId: string,
    afterMs?: number
  ): Promise<WallTimeline> {
    const row = await db
      .selectFrom('videos')
      .select([
        'id',
        'status',
        'start_at as startAt',
        'sync_offset_sec as syncOffsetSec',
        'start_at_clock_offset_ms as clockOffsetMs'
      ])
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow()
    const summary = await db
      .selectFrom('video_wall_anchors')
      .select([
        sql<number>`count(*)::int`.as('count'),
        sql<boolean>`coalesce(bool_and(source = 'sei'), true)`.as('allSei'),
        sql<boolean>`coalesce(bool_and(corrected), true)`.as('allCorrected')
      ])
      .where('video_id', '=', videoId)
      .executeTakeFirstOrThrow()
    let query = db
      .selectFrom('video_wall_anchors')
      .select(['media_ms as mediaMs', 'wall'])
      .where('video_id', '=', videoId)
      .orderBy('media_ms')
    if (afterMs != null) query = query.where('media_ms', '>', afterMs)
    const stored = (await query.execute()).map((point): [number, number] => [
      point.mediaMs,
      new Date(point.wall).getTime()
    ])
    return wallTimelineOf(
      { ...row, syncOffsetSec: Number(row.syncOffsetSec) },
      {
        any: summary.count > 0,
        allSei: summary.allSei,
        allCorrected: summary.allCorrected
      },
      stored,
      afterMs
    )
  }

  it('answers exactly as the whole-video aggregate did, for every row of the table, with and without afterMs', async function () {
    const cases: Array<{
      name: string
      video: Parameters<typeof addVideo>[0]
      points: Array<[number, number, VideoWallAnchorsTable['source'], boolean?]>
    }> = [
      {
        name: 'SEI, all corrected',
        video: { status: 'live' },
        points: [
          [0, T0, 'sei'],
          [4_000, T0 + 4_000, 'sei'],
          [8_000, T0 + 8_000, 'sei']
        ]
      },
      {
        name: 'SEI, the oldest uncorrected',
        video: {},
        points: [
          [0, T0, 'sei', false],
          [4_000, T0 + 4_000, 'sei'],
          [8_000, T0 + 8_000, 'sei']
        ]
      },
      {
        name: 'SEI, the newest uncorrected',
        video: {},
        points: [
          [0, T0, 'sei'],
          [4_000, T0 + 4_000, 'sei'],
          [8_000, T0 + 8_000, 'sei', false]
        ]
      },
      {
        name: 'arrival',
        video: { status: 'live' },
        points: [
          [0, T0 + 900, 'arrival'],
          [4_000, T0 + 4_950, 'arrival'],
          [8_000, T0 + 9_000, 'arrival']
        ]
      },
      {
        name: 'SEI, then an arrival long before the poll',
        video: { status: 'live' },
        points: [
          [0, T0 + 700, 'arrival'],
          [4_000, T0 + 4_000, 'sei'],
          [8_000, T0 + 8_000, 'sei']
        ]
      },
      {
        name: 'arrival, uncorrected SEI and corrected SEI',
        video: {},
        points: [
          [0, T0, 'sei', false],
          [4_000, T0 + 4_100, 'arrival'],
          [8_000, T0 + 8_000, 'sei']
        ]
      },
      {
        name: 'no points, offset recorded',
        video: { clockOffsetMs: 1234, syncOffsetSec: 2 },
        points: []
      },
      { name: 'no points, no offset', video: {}, points: [] },
      {
        name: 'no points, no start',
        video: { startAt: null, clockOffsetMs: 1234 },
        points: []
      }
    ]
    for (const one of cases) {
      const videoId = await addVideo(one.video)
      if (one.points.length > 0) await addAnchors(videoId, one.points)
      for (const afterMs of [undefined, 0, 2_000, 4_000, 8_000, 60_000]) {
        const query = afterMs == null ? '' : `?afterMs=${afterMs}`
        expect(await answer(videoId, query), `${one.name}${query}`).deep.equals(
          await aggregated(videoId, afterMs)
        )
      }
    }
  })

  it('sums up a three-hour programme from a few index pages, not its twenty thousand points', async function () {
    const videoId = await addVideo({ status: 'live' })
    // Twenty thousand frame-exact points, one every 500 ms: three hours.
    await sql`
      insert into video_wall_anchors (video_id, media_ms, wall, source)
      select ${videoId}, n * 500,
        ${new Date(T0)}::timestamptz + n * interval '500 milliseconds', 'sei'
      from generate_series(0, 19999) as n`.execute(db)
    await sql`analyze video_wall_anchors`.execute(db)

    /** The plan of a query as run, and the pages its execution touched. */
    const executed = async (
      text: string,
      parameters: readonly unknown[]
    ): Promise<{ plan: string; pages: number }> => {
      const explained = await db.executeQuery<{ 'QUERY PLAN': unknown }>(
        CompiledQuery.raw(`explain (analyze, buffers, format json) ${text}`, [
          ...parameters
        ])
      )
      const [root] = explained.rows[0]['QUERY PLAN'] as Array<{
        Plan: Record<string, number>
      }>
      return {
        plan: JSON.stringify(root),
        pages: root.Plan['Shared Hit Blocks'] + root.Plan['Shared Read Blocks']
      }
    }
    const summary = anchorSummaryQuery(videoId).compile(db)
    const now = await executed(summary.sql, summary.parameters)
    // Every node of the plan reads at most one row: the summary never walks
    // the video's points, and the two questions about kind are each answered
    // by its partial index.
    const rowsRead = [
      ...now.plan.matchAll(/"Actual Rows":(\d+(?:\.\d+)?)/g)
    ].map(match => Number(match[1]))
    expect(rowsRead.length).greaterThan(0)
    expect(Math.max(...rowsRead), now.plan).lessThanOrEqual(1)
    expect(now.plan).includes('"Index Name":"video_wall_anchors_not_sei"')
    expect(now.plan).includes('"Index Name":"video_wall_anchors_uncorrected"')
    // A handful of pages, where the aggregate it replaced read every page of
    // the video's points.
    const before = await executed(
      `select count(*)::int, coalesce(bool_and(source = 'sei'), true),
         coalesce(bool_and(corrected), true)
       from video_wall_anchors where video_id = $1`,
      [videoId]
    )
    expect(now.pages, now.plan).lessThanOrEqual(8)
    expect(before.pages, before.plan).greaterThan(50)

    // And the poll still answers the newest points, described as the whole.
    const got = await answer(videoId, `?afterMs=${19_998 * 500}`)
    expect(got.anchors).deep.equals([[19_999 * 500, T0 + 19_999 * 500]])
    expect([got.source, got.confidence]).deep.equals(['sei', 'frame'])
  })

  it('takes a start written as text as readily as a date', function () {
    const got = wallTimelineOf(
      {
        id: 'vid_text',
        status: 'ready',
        startAt: '2026-05-02T18:00:00Z',
        syncOffsetSec: 0,
        clockOffsetMs: null
      },
      { any: false, allSei: true, allCorrected: true },
      []
    )
    expect(got.anchors).deep.equals([[0, T0]])
  })
})
