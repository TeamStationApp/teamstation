import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely, KyselyPlugin } from 'kysely'
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
  withBrokenRun,
  writeLive
} from '../../test/wallClockFixtures'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import {
  isStampedAt,
  parseMediaPlaylist,
  readRecordingStamps
} from '../media/wallClockScan'
import { storeWallPoints } from '../media/wallTimeline'
import type { LiveControllerOptions } from './controller'
import {
  finishStream,
  liveVideoDir,
  settleLiveWork,
  stopLiveController,
  sync
} from './controller'
import { replaceAnchorsFromRecording } from './finishVideo'
import { sealSecret } from './secrets'
import { placeSegmentOnTimeline } from './segmentClock'
import { configureIngest, resetForTest } from './splitter'
import {
  resumeScan,
  SCAN_FROM_START,
  scanNewSegments,
  SEGMENTS_PER_SCAN
} from './wallAnchors'

const START = 1_700_000_000_000
const NOW = 1_800_000_000_000
/** A clock stopped at `NOW`. */
const atNow = (): number => NOW

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
      cursor: SCAN_FROM_START,
      unreadable: []
    })

    await writeLive(stamped, live, { seconds: 3 })
    // A segment still being written, under its temporary name, and one the
    // playlist does not list: neither is read.
    await writeFile(join(live, 'seg000003.m4s.tmp'), 'half')
    await writeFile(join(live, 'seg000009.m4s'), 'not listed')

    const first = await scanNewSegments(live, undefined, atNow)
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
    const again = await scanNewSegments(live, first.cursor, atNow)
    expect(again).deep.equals({
      points: [],
      cursor: first.cursor,
      unreadable: []
    })

    // The publisher drops out for two seconds of the programme and comes
    // back; the second writer appends behind a discontinuity, its own
    // timestamps from zero.
    await writeLive(stamped, live, { fromSec: 5, startNumber: 3 })
    const playlist = parseMediaPlaylist(
      await readFile(join(live, 'master.m3u8'), 'utf8')
    )
    expect(playlist.segments[3].discontinuity).equals(true)
    const second = await scanNewSegments(live, first.cursor, atNow)
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

  it('reads a few segments at a look, and the rest on the next', async function () {
    const live = join(dir, 'limited')
    await mkdir(live)
    await writeLive(stamped, live, { seconds: 3 })
    const whole = await scanNewSegments(live, undefined, atNow)
    const first = await scanNewSegments(live, undefined, atNow, 2)
    expect(first.cursor.segments).equals(2)
    const rest = await scanNewSegments(live, first.cursor, atNow, 2)
    expect(rest.cursor).deep.equals(whole.cursor)
    expect([...first.points, ...rest.points]).deep.equals(whole.points)
    expect(SEGMENTS_PER_SCAN).within(2, 16)
  })

  it('places an unstamped segment by its arrival, never behind the one before it', async function () {
    const live = join(dir, 'plain')
    await mkdir(live)
    await writeLive(plain, live, { seconds: 2 })
    // Both are found at one look; the second is not put at the first's moment.
    const scanned = await scanNewSegments(live, undefined, atNow)
    expect(scanned.points).deep.equals([
      { mediaMs: 0, wallMs: NOW - 1000, source: 'arrival', corrected: true },
      { mediaMs: 1000, wallMs: NOW, source: 'arrival', corrected: true }
    ])
    expect(scanned.cursor.latest).deep.equals({ mediaMs: 1000, wallMs: NOW })
  })

  it('times an arrival from the moment the playlist was read, and keeps the timeline going forward', async function () {
    const live = join(dir, 'looks')
    await mkdir(live)
    await writeLive(plain, live, { seconds: 1 })
    // The clock is read once a look, once the playlist has been read.
    let reads = 0
    const clock = (ms: number) => (): number => {
      reads += 1
      return ms
    }
    const late = await scanNewSegments(live, undefined, clock(NOW + 5000))
    expect(reads).equals(1)
    expect(late.points.map(point => point.wallMs)).deep.equals([NOW + 4000])
    // A prompt look after that late one: the next segment is put where the
    // one before it leaves off, not a second behind it.
    await writeLive(plain, live, { fromSec: 1, seconds: 1, startNumber: 1 })
    const prompt = await scanNewSegments(live, late.cursor, clock(NOW + 5500))
    expect(
      prompt.points.map(point => [point.mediaMs, point.wallMs])
    ).deep.equals([[1000, NOW + 5000]])
    // Across an outage the arrival moves on by the time that passed.
    await writeLive(plain, live, { fromSec: 2, seconds: 1, startNumber: 2 })
    const after = await scanNewSegments(
      live,
      prompt.cursor,
      clock(NOW + 30_000)
    )
    expect(
      after.points.map(point => [point.mediaMs, point.wallMs])
    ).deep.equals([[2000, NOW + 29_000]])
  })

  /** Damages one listed segment of a live directory, as `withBrokenRun`. */
  async function breakSegment(live: string, uri: string): Promise<void> {
    const path = join(live, uri)
    await writeFile(path, withBrokenRun(await readFile(path)))
  }

  it('passes over a damaged segment of a stamped stream, and places the ones after it', async function () {
    const live = join(dir, 'damagedStamped')
    await mkdir(live)
    await writeLive(stamped, live, { seconds: 3 })
    await breakSegment(live, 'seg000001.m4s')
    const scanned = await scanNewSegments(live, undefined, atNow)
    expect(scanned.cursor.segments).equals(3)
    expect(scanned.cursor.startMs).equals(3000)
    // No point for the damaged second: the one before runs on through it.
    expect(
      scanned.points.map(point => [point.mediaMs, point.wallMs - START])
    ).deep.equals([
      [0, 0],
      [500, 500],
      [2000, 2000],
      [2500, 2500]
    ])
    expect(scanned.points.every(point => point.source === 'sei')).equals(true)
    expect(scanned.unreadable).has.length(1)
    expect(scanned.unreadable[0]).matches(
      /^seg000001\.m4s: MalformedBox: the trun box at byte \d+ runs past its end$/
    )
    // Passed over once: the next look starts after it.
    expect(await scanNewSegments(live, scanned.cursor, atNow)).deep.equals({
      points: [],
      cursor: scanned.cursor,
      unreadable: []
    })
  })

  it('places a damaged segment of an unstamped stream by its arrival', async function () {
    const live = join(dir, 'damagedPlain')
    await mkdir(live)
    await writeLive(plain, live, { seconds: 2 })
    await breakSegment(live, 'seg000000.m4s')
    const scanned = await scanNewSegments(live, undefined, atNow)
    expect(scanned.points).deep.equals([
      { mediaMs: 0, wallMs: NOW - 1000, source: 'arrival', corrected: true },
      { mediaMs: 1000, wallMs: NOW, source: 'arrival', corrected: true }
    ])
    expect(scanned.unreadable).has.length(1)
  })

  it('places segments by arrival when there is no init segment to read them with', async function () {
    const live = join(dir, 'noInit')
    await mkdir(live)
    await writeLive(stamped, live, { seconds: 1 })
    await rm(join(live, 'init.mp4'))
    const scanned = await scanNewSegments(live, undefined, atNow)
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
  let userId = ''
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
  /**
   * A publishing stream and the live video it writes into, in a game of its
   * own every four, as a person has four slots in a game.
   */
  async function stream(name: string): Promise<string> {
    slots += 1
    if (slots > 4) {
      slots = 1
      gameId = await addGame(db, {
        homeTeamId: teamId,
        awayTeamId: await addTeam(db, `Visitors ${name}`),
        startAt: new Date()
      })
    }
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

  it('maps a phone’s return, moved onto the wall clock behind its discontinuity, to its frames’ wall clock, live and once it is a recording with the hole', async function () {
    // A phone stamps every frame. Its publish runs 3 s, it is away for 2 s,
    // and it comes back behind a discontinuity with its timestamps from zero;
    // the splitter moves each new segment to where its pictures sit on the
    // wall clock, 5 s from the playlist's start (placeSegmentOnTimeline).
    const videoId = await stream('phoneReturn')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    await sync(options)
    await writeLive(stamped, live, { fromSec: 5, startNumber: 3 })
    const init = await readFile(join(live, 'init.mp4'))
    const listed = parseMediaPlaylist(
      await readFile(join(live, 'master.m3u8'), 'utf8')
    )
    expect(listed.segments[3].discontinuity).equals(true)
    for (const segment of listed.segments.slice(3)) {
      const path = join(live, segment.uri)
      const placed = placeSegmentOnTimeline(init, await readFile(path), 5)
      expect(placed, segment.uri).not.equals(undefined)
      await writeFile(path, placed!)
    }
    await sync(options)
    // Live, the return sits where a player puts it, after the media before
    // the discontinuity, and every point says the wall clock its frame
    // carries: the board at a position is the board when that frame was
    // taken.
    expect(
      (await anchors(videoId)).map(([mediaMs, wall]) => [mediaMs, wall - START])
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

    // Ended, the recording keeps the hole, and its points move with it: the
    // return's frames are as far into the video as they are into the game.
    await finishStream(options, 'liv_phoneReturn', 'the stream was ended')
    await settleLiveWork()
    const recording = await anchors(videoId)
    expect(recording.every(([, , source]) => source === 'sei')).equals(true)
    expect(
      recording.map(([mediaMs, wall]) => [mediaMs, wall - START])
    ).deep.equals([
      [0, 0],
      [500, 500],
      [1000, 1000],
      [1500, 1500],
      [2000, 2000],
      [2500, 2500],
      [5000, 5000],
      [5500, 5500],
      [6000, 6000],
      [6500, 6500],
      [7000, 7000],
      [7500, 7500]
    ])
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

  it('keeps the arrival points of a stream’s unstamped stretch through its end, beside the recording’s stamped points (U26)', async function () {
    // TS Director publishes, a publisher that stamps nothing takes over at a
    // reconnect, and TS Director comes back at another.
    const videoId = await stream('mixed')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    await sync(options)
    await writeLive(plain, live, { fromSec: 5, startNumber: 3 })
    await sync(options)
    await writeLive(stamped, live, { fromSec: 3, seconds: 2, startNumber: 6 })
    await sync(options)
    const before = await anchors(videoId)
    const arrivals = before.filter(([, , source]) => source === 'arrival')
    expect(arrivals.map(([mediaMs]) => mediaMs)).deep.equals([3000, 4000, 5000])
    expect(
      before
        .filter(([, , source]) => source === 'sei')
        .map(([mediaMs, wall]) => [mediaMs, wall - START])
    ).deep.equals([
      [0, 0],
      [500, 500],
      [1000, 1000],
      [1500, 1500],
      [2000, 2000],
      [2500, 2500],
      [6000, 3000],
      [6500, 3500],
      [7000, 4000],
      [7500, 4500]
    ])

    await finishStream(options, 'liv_mixed', 'the stream was ended')
    await settleLiveWork()
    const after = await anchors(videoId)
    // The unstamped stretch keeps its arrival points, at the same media
    // times and walls; the stamped stretches have the recording's points.
    expect(after.filter(([, , source]) => source === 'arrival')).deep.equals(
      arrivals
    )
    const scan = await readRecordingStamps(live)
    expect(
      after
        .filter(([, , source]) => source === 'sei')
        .map(([mediaMs, wall]) => ({ mediaMs, wallMs: wall }))
    ).deep.equals(
      scan.points.map(({ mediaMs, wallMs }) => ({ mediaMs, wallMs }))
    )
    expect(scan.points.map(point => point.mediaMs)).deep.equals([
      0, 500, 1000, 1500, 2000, 2500, 6000, 6500, 7000, 7500
    ])
    // The recording finds no stamp from where the first stamped stretch
    // ended to where the second began, which is where the arrival points
    // are: the first at the frame after the last stamped one, to a frame.
    expect(scan.stamped).has.length(2)
    const [[firstFrom, firstTo], [secondFrom, secondTo]] = scan.stamped
    expect(firstFrom).equals(0)
    expect(firstTo - arrivals[0][0]).within(0, 40)
    expect(secondFrom - 6000).within(0, 40)
    expect(secondTo).within(7990, 8040)
    for (const [mediaMs] of arrivals)
      expect(isStampedAt(scan.stamped, mediaMs + 500)).equals(false)
  })

  it('scans a finished stream’s recording again only when the stream carried the SEI', async function () {
    const videoId = await stream('rescanned')
    const recording = liveVideoDir(mediaRoot, videoId)
    await mkdir(recording, { recursive: true })
    await writeLive(stamped, recording, { seconds: 3 })
    await sync(options)
    await finishStream(options, 'liv_rescanned', 'the stream was ended')
    await settleLiveWork()
    const scanned = await anchors(videoId)
    expect(scanned.length).greaterThan(0)

    // A stream that stored only arrival points is never scanned: handed a
    // stamped recording, it still keeps its own points and writes none.
    const plainId = await stream('neverScanned')
    const arrival = [
      { mediaMs: 0, wallMs: START + 700, corrected: true },
      { mediaMs: 1000, wallMs: START + 1700, corrected: true }
    ]
    await storeWallPoints(
      db,
      plainId,
      arrival.map(point => ({ ...point, source: 'arrival' as const }))
    )
    const kept = await anchors(plainId)
    expect(await replaceAnchorsFromRecording(db, plainId, recording)).equals(0)
    expect(await anchors(plainId)).deep.equals(kept)
    // Nor is one that stored nothing.
    const emptyId = await stream('nothingStored')
    expect(await replaceAnchorsFromRecording(db, emptyId, recording)).equals(0)
    expect(await anchors(emptyId)).deep.equals([])

    // One `sei` point is enough, even after an arrival one: a stamped stream
    // whose first segment could not be read is scanned, and its points are
    // the recording's.
    const mixedId = await stream('stampedAfterDamage')
    await storeWallPoints(db, mixedId, [
      { mediaMs: 0, wallMs: START + 900, corrected: true, source: 'arrival' },
      { mediaMs: 1000, wallMs: START + 1000, corrected: true, source: 'sei' }
    ])
    expect(await replaceAnchorsFromRecording(db, mixedId, recording)).equals(
      scanned.length
    )
    expect(await anchors(mixedId)).deep.equals(scanned)
  })

  /** What the controller said about one video's wall clock. */
  function saidAbout(videoId: string): string[] {
    return said.filter(line => line.includes(`wall clock of ${videoId}`))
  }

  it('carries a stamped stream on after a restart from the points it stored, without reading the segments behind them', async function () {
    const videoId = await stream('resumed')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    await sync(options)
    // The server restarts. A segment the scan read before is gone, so a scan
    // from the start would fail on it; the run's first segment, which places
    // the run, and the one holding the newest point are still there.
    stopLiveController()
    await rm(join(live, 'seg000001.m4s'))
    await writeLive(stamped, live, { fromSec: 5, startNumber: 3 })
    await sync(options)
    expect(saidAbout(videoId)).deep.equals([])
    expect(
      (await anchors(videoId)).map(([mediaMs, wall]) => [mediaMs, wall - START])
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
  })

  it('places the segment it carries on from by the playlist when the run’s first segment is gone', async function () {
    const videoId = await stream('resumedBare')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    await sync(options)
    const before = await anchors(videoId)
    stopLiveController()
    await rm(join(live, 'seg000000.m4s'))
    await rm(join(live, 'seg000001.m4s'))
    expect(await resumeScan(db, videoId, live)).deep.equals({
      segments: 2,
      startMs: 2000,
      placement: undefined,
      last: { mediaMs: 2500, wallMs: START + 2500, corrected: true },
      latest: { mediaMs: 2500, wallMs: START + 2500 }
    })
    await rm(join(live, 'init.mp4'))
    expect((await resumeScan(db, videoId, live)).placement).equals(undefined)
    await sync(options)
    expect(saidAbout(videoId)).deep.equals([])
    expect(await anchors(videoId)).deep.equals(before)
  })

  it('carries an unstamped stream on after a restart with the segment after its newest arrival', async function () {
    const videoId = await stream('resumedPlain')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    expect(await resumeScan(db, videoId, live)).deep.equals(SCAN_FROM_START)
    await writeLive(plain, live, { seconds: 2 })
    await sync(options)
    stopLiveController()
    const stored = await anchors(videoId)
    expect(await resumeScan(db, videoId, live)).deep.equals({
      segments: 2,
      startMs: 2000,
      latest: { mediaMs: 1000, wallMs: stored[1][1] }
    })
    await rm(join(live, 'seg000000.m4s'))
    await rm(join(live, 'seg000001.m4s'))
    await writeLive(plain, live, { fromSec: 5, startNumber: 2 })
    await sync(options)
    expect(saidAbout(videoId)).deep.equals([])
    expect(
      (await anchors(videoId)).map(([mediaMs, , source]) => [mediaMs, source])
    ).deep.equals([
      [0, 'arrival'],
      [1000, 'arrival'],
      [2000, 'arrival'],
      [3000, 'arrival'],
      [4000, 'arrival']
    ])
    // A video whose points are stored but whose playlist is gone starts over.
    await rm(join(live, 'master.m3u8'))
    expect(await resumeScan(db, videoId, live)).deep.equals(SCAN_FROM_START)
  })

  it('places an unstamped stream’s arrivals after a slow database and disk, never before they were listed nor backwards', async function () {
    const videoId = await stream('slow')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    const pause = async (ms: number): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, ms))
    }
    // Every query takes a while, as on a machine busy with other work.
    const slowQueries: KyselyPlugin = {
      transformQuery: args => args.node,
      transformResult: async args => {
        await pause(150)
        return args.result
      }
    }
    let listed = 0
    const slow: LiveControllerOptions = {
      ...options,
      db: db.withPlugin(slowQueries),
      // The segments are listed after the tick has begun, while it waits
      // seconds on the disk.
      freeBytes: async () => {
        await writeLive(plain, live, { seconds: 2 })
        listed = Date.now()
        await pause(2000)
        return 1_000_000_000_000
      }
    }
    await sync(slow)
    const [first, second] = await anchors(videoId)
    expect(first[0]).equals(0)
    expect(second[0]).equals(1000)
    // The first segment had all arrived by the time both were listed, so it
    // began a second before that at the earliest.
    expect(first[1]).at.least(listed - 1000)
    expect(second[1]).at.least(first[1] + 1000)
    expect(second[1]).at.most(Date.now())

    // A prompt tick after the slow one: the next segment carries on from
    // where the one before it ends, not from a second before its own look.
    await writeLive(plain, live, { fromSec: 2, seconds: 1, startNumber: 2 })
    await sync(options)
    const third = (await anchors(videoId))[2]
    expect(third[0]).equals(2000)
    expect(third[1]).at.least(second[1] + 1000)
    expect(third.slice(2)).deep.equals(['arrival'])
  })

  it('says once that it passed over a damaged segment, and goes on with the rest', async function () {
    const videoId = await stream('damaged')
    const live = liveVideoDir(mediaRoot, videoId)
    await mkdir(live, { recursive: true })
    await writeLive(stamped, live, { seconds: 3 })
    const path = join(live, 'seg000001.m4s')
    await writeFile(path, withBrokenRun(await readFile(path)))
    await sync(options)
    expect(await anchors(videoId)).deep.equals([
      [0, START, 'sei'],
      [500, START + 500, 'sei'],
      [2000, START + 2000, 'sei'],
      [2500, START + 2500, 'sei']
    ])
    const passedOver = (): string[] =>
      said.filter(line =>
        line.startsWith(`live: wall clock of ${videoId}: passed over`)
      )
    expect(passedOver()).has.length(1)
    expect(passedOver()[0]).includes('seg000001.m4s')
    await writeLive(stamped, live, { fromSec: 3, seconds: 1, startNumber: 3 })
    await sync(options)
    expect((await anchors(videoId)).at(-1)?.[2]).equals('sei')
    expect((await anchors(videoId)).at(-1)?.[0]).at.least(3000)
    expect(passedOver()).has.length(1)
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
