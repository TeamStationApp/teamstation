import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  addGame,
  addPerson,
  addTeam,
  scratchDatabase
} from '../../test/scoreboardKit'
import {
  canEncode,
  encodeFragmented,
  FFMPEG,
  stampFile,
  writeLive
} from '../../test/wallClockFixtures'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { parseMediaPlaylist } from '../media/wallClockScan'
import type { LiveControllerOptions } from './controller'
import { finishStream, liveVideoDir, settleLiveWork, sync } from './controller'
import { replaceAnchorsFromRecording } from './finishVideo'
import { sealSecret } from './secrets'
import { configureIngest, resetForTest } from './splitter'
import { SCAN_FROM_START, scanNewSegments } from './wallAnchors'

const START = 1_700_000_000_000
const NOW = 1_800_000_000_000

/**
 * A live stream's wall-clock points (U25), through real FFmpeg writing the
 * HLS the way the splitter does: one second segments, a publisher that drops
 * out for a while and comes back behind a discontinuity, with its timestamps
 * starting again.
 */
describe('the wall clock of a live stream (U25)', function () {
  this.timeout(120_000)
  let dir = ''
  let stamped = ''
  let plain = ''

  before(async function () {
    if (!(await canEncode('libx265'))) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsWallLive-'))
    plain = join(dir, 'camera.mp4')
    stamped = join(dir, 'programme.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 8 })
    await stampFile(plain, stamped, START)
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('reads only listed segments, carries its cursor, and keeps one timeline across a reconnect', async function () {
    const live = join(dir, 'stamped')
    await mkdir(live)
    expect(await scanNewSegments(live)).deep.equals({
      points: [],
      cursor: SCAN_FROM_START
    })

    await writeLive(stamped, live, { seconds: 3 })
    // A segment still being written, under its temporary name, and one the
    // playlist does not list: neither is read.
    await writeFile(join(live, 'seg000003.m4s.tmp'), 'half')
    await writeFile(join(live, 'seg000009.m4s'), 'not listed')

    const first = await scanNewSegments(live, undefined, NOW)
    expect(first.cursor.segments).equals(3)
    expect(first.cursor.startMs).equals(3000)
    expect(
      first.points.map(point => [point.mediaMs, point.wallMs - START])
    ).deep.equals([
      [0, 0],
      [500, 500],
      [1000, 1000],
      [1500, 1500],
      [2000, 2000],
      [2500, 2500]
    ])
    expect(first.points.every(point => point.source === 'sei')).equals(true)

    // Nothing new: nothing added, the cursor where it was.
    const again = await scanNewSegments(live, first.cursor, NOW)
    expect(again).deep.equals({ points: [], cursor: first.cursor })

    // The publisher drops out for two seconds of the programme and comes
    // back; the second writer appends behind a discontinuity, its own
    // timestamps from zero.
    await writeLive(stamped, live, { fromSec: 5, startNumber: 3 })
    const playlist = parseMediaPlaylist(
      await readFile(join(live, 'master.m3u8'), 'utf8')
    )
    expect(playlist.segments[3].discontinuity).equals(true)
    const second = await scanNewSegments(live, first.cursor, NOW)
    expect(second.cursor.segments).equals(playlist.segments.length)
    // Media time carries straight on from 3 s; the wall clock jumps by the
    // two seconds that never arrived.
    expect(
      second.points.map(point => [point.mediaMs, point.wallMs - START])
    ).deep.equals([
      [3000, 5000],
      [3500, 5500],
      [4000, 6000],
      [4500, 6500],
      [5000, 7000],
      [5500, 7500]
    ])
  })

  it('places an unstamped segment by its arrival', async function () {
    const live = join(dir, 'plain')
    await mkdir(live)
    await writeLive(plain, live, { seconds: 2 })
    const scanned = await scanNewSegments(live, undefined, NOW)
    expect(scanned.points).deep.equals([
      { mediaMs: 0, wallMs: NOW - 1000, source: 'arrival', corrected: true },
      { mediaMs: 1000, wallMs: NOW - 1000, source: 'arrival', corrected: true }
    ])
  })

  it('places segments by arrival when there is no init segment to read them with', async function () {
    const live = join(dir, 'noInit')
    await mkdir(live)
    await writeLive(stamped, live, { seconds: 1 })
    await rm(join(live, 'init.mp4'))
    const scanned = await scanNewSegments(live, undefined, NOW)
    expect(scanned.points.map(point => point.source)).deep.equals(['arrival'])
  })
})

/**
 * The controller's tick stores the points of every stream (U25), and the end
 * of a stream moves them onto the recording it became (U26).
 */
describe('the controller and the wall clock (U25, U26)', function () {
  this.timeout(120_000)
  const SECRET = 's'.repeat(32)
  let db: Kysely<Database>
  let drop: (() => Promise<void>) | undefined
  let mediaRoot = ''
  let options: LiveControllerOptions
  let stamped = ''
  let plain = ''
  let gameId = ''
  let teamId = ''
  let userId = 0
  const said: string[] = []

  before(async function () {
    if (!(await canEncode('libx265'))) this.skip()
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsWallTick-'))
    plain = join(mediaRoot, 'camera.mp4')
    stamped = join(mediaRoot, 'programme.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 8 })
    await stampFile(plain, stamped, START)

    ;({ db, drop } = await scratchDatabase('wall_tick'))
    teamId = await addTeam(db, 'Pioneers')
    gameId = await addGame(db, {
      homeTeamId: teamId,
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date()
    })
    userId = (await addPerson(db, 'filmer', { isAdmin: true })).userId
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', userId)
      .execute()

    configureIngest({
      ffmpegPath: FFMPEG,
      bindHost: '127.0.0.1',
      port: 19_363,
      app: 'live',
      segmentSeconds: 1,
      log: () => undefined,
      onEvent: () => undefined
    })
    options = {
      db,
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 19_363,
        app: 'live',
        segmentSeconds: 1,
        freeDiskFloorGb: 1
      },
      ffmpegPath: FFMPEG,
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: SECRET,
      log: message => said.push(message),
      freeBytes: async () => 1_000_000_000_000
    }
  })

  after(async function () {
    resetForTest()
    await drop?.()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
  })

  let slots = 0
  /** A publishing stream and the live video it writes into. */
  async function stream(name: string): Promise<string> {
    slots += 1
    const now = new Date()
    const videoId = `vid_${name}`
    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: gameId,
        kind: 'live',
        title: 'Visitors at Pioneers',
        storage: 'local',
        status: 'live',
        hidden: false,
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    const key = `ts_${name}`.padEnd(24, 'k')
    await db
      .insertInto('live_streams')
      .values({
        id: `liv_${name}`,
        game_id: gameId,
        team_id: teamId,
        user_id: userId,
        key_hash: hashToken(key),
        key_prefix: key.slice(0, 8),
        key_cipher: sealSecret(SECRET, key),
        state: 'publishing',
        opens_at: new Date(now.getTime() - 3_600_000),
        closes_at: null,
        video_id: videoId,
        slot: slots,
        first_published_at: now,
        last_published_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    return videoId
  }

  async function anchors(
    videoId: string
  ): Promise<Array<[number, number, string]>> {
    const rows = await db
      .selectFrom('video_wall_anchors')
      .select(['media_ms', 'wall', 'source'])
      .where('video_id', '=', videoId)
      .orderBy('media_ms')
      .execute()
    return rows.map(row => [
      row.media_ms,
      new Date(row.wall).getTime(),
      row.source
    ])
  }

  it('stores a stamped stream’s points on each tick, and the recording’s at the end', async function () {
    const videoId = await stream('stamped')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    await sync(options)
    expect((await anchors(videoId)).length).equals(6)

    await writeLive(stamped, live, { fromSec: 5, startNumber: 3 })
    await sync(options)
    // Twice over the same segments adds nothing.
    await sync(options)
    const live12 = await anchors(videoId)
    expect(
      live12.map(([mediaMs, wall]) => [mediaMs, wall - START])
    ).deep.equals([
      [0, 0],
      [500, 500],
      [1000, 1000],
      [1500, 1500],
      [2000, 2000],
      [2500, 2500],
      [3000, 5000],
      [3500, 5500],
      [4000, 6000],
      [4500, 6500],
      [5000, 7000],
      [5500, 7500]
    ])

    // U26: the stream ends, becomes one file, and is scanned again there.
    // The live points are replaced by the recording's, which say the same.
    await db
      .updateTable('video_wall_anchors')
      .set({ media_ms: 99_999 })
      .where('video_id', '=', videoId)
      .where('media_ms', '=', 5500)
      .execute()
    await finishStream(options, 'liv_stamped', 'the stream was ended')
    await settleLiveWork()
    const recording = await anchors(videoId)
    expect(recording.every(([, , source]) => source === 'sei')).equals(true)
    expect(
      recording.map(([mediaMs, wall]) => [mediaMs, wall - START])
    ).deep.equals(live12.map(([mediaMs, wall]) => [mediaMs, wall - START]))
  })

  it('keeps an unstamped stream’s arrival points through its end, where the recording’s segments start', async function () {
    const videoId = await stream('plain')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(plain, live, { seconds: 2 })
    await sync(options)
    await writeLive(plain, live, { fromSec: 5, startNumber: 2 })
    await sync(options)
    const before = await anchors(videoId)
    expect(before.map(([mediaMs, , source]) => [mediaMs, source])).deep.equals([
      [0, 'arrival'],
      [1000, 'arrival'],
      [2000, 'arrival'],
      [3000, 'arrival'],
      [4000, 'arrival']
    ])

    await finishStream(options, 'liv_plain', 'the stream was ended')
    await settleLiveWork()
    expect(await anchors(videoId)).deep.equals(before)
    // The recording is the live segments end to end: as long as they were,
    // so each point is still at its segment's start.
    const vod = parseMediaPlaylist(
      await readFile(join(live, 'video.m3u8'), 'utf8')
    )
    const total = vod.segments.reduce((sum, one) => sum + one.durationSec, 0)
    expect(total).within(4.99, 5.01)
    expect(await replaceAnchorsFromRecording(db, videoId, live)).equals(0)
  })

  it('says why a stream could not be read, and tries again on the next tick', async function () {
    const videoId = await stream('broken')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 1 })
    await rm(join(live, 'seg000000.m4s'))
    await sync(options)
    expect(await anchors(videoId)).deep.equals([])
    expect(said.some(line => line.includes(`wall clock of ${videoId}`))).equals(
      true
    )
  })
})
