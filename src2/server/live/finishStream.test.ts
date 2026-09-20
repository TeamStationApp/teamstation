import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import type { LiveControllerOptions } from './controller'
import { finishStream, liveVideoDir, settleLiveWork } from './controller'
import { LIVE_PLAYLIST_NAME } from './splitter'

/**
 * The end of a game, from the moment the window shuts.
 *
 * This is the path with the most to go wrong in it and the least chance of
 * anybody noticing when it does: it runs after the stream has gone, with
 * nobody watching, and what it decides is whether a game that was filmed still
 * exists an hour later. So it is exercised whole — a real playlist ffmpeg
 * wrote, a real remux, a real upload to a stand-in Space — against a scratch
 * database, and skipped where there is no Postgres.
 */
const run = promisify(execFile)
const FFMPEG = process.env.GS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_finish_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('the end of a live stream', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let mediaRoot = ''
  let space: Server | undefined
  const held = new Map<string, Buffer>()
  let options: LiveControllerOptions | undefined

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
    mediaRoot = await mkdtemp(join(tmpdir(), 'gsFinish-'))

    space = createServer((req, res) => {
      const key = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          held.set(key, Buffer.concat(chunks))
          res.writeHead(200).end()
        })
        return
      }
      const body = held.get(key)
      if (body == null) {
        res.writeHead(404).end()
        return
      }
      if (req.headers.range != null) {
        res
          .writeHead(206, {
            'content-range': `bytes 0-0/${body.length}`,
            'content-length': '1'
          })
          .end(body.subarray(0, 1))
        return
      }
      res.writeHead(200, { 'content-length': String(body.length) }).end(body)
    })
    await new Promise<void>(resolve => {
      space?.listen(0, '127.0.0.1', resolve)
    })
    const address = space.address()
    const port =
      typeof address === 'object' && address != null ? address.port : 0
    const settings: SpaceSettings = {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'sfo3',
      bucket: 'gamestation',
      accessKeyId: 'AKIAEXAMPLE000000000',
      secretAccessKey: 'secret',
      pathStyle: true
    }
    options = {
      db,
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 1936,
        app: 'live',
        segmentSeconds: 2,
        closeAfterHours: 6,
        freeDiskFloorGb: 1
      },
      ffmpegPath: FFMPEG,
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: 'a'.repeat(32),
      space: settings,
      log: () => undefined
    }
  })

  after(async function () {
    space?.close()
    if (db != null) await db.destroy()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  /** A live stream and the hidden video it writes into, as `create` makes them. */
  async function makeStream(options: {
    id: string
    videoId: string
    published: boolean
  }): Promise<void> {
    const now = new Date()
    for (const side of ['home', 'away']) {
      await db
        ?.insertInto('teams')
        .values({
          id: `tem_${side}_${options.id}`,
          name: side === 'home' ? 'Demo Home' : 'Demo Away',
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    await db
      ?.insertInto('games')
      .values({
        id: `gam_${options.id}`,
        home_team_id: `tem_home_${options.id}`,
        away_team_id: `tem_away_${options.id}`,
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      ?.insertInto('videos')
      .values({
        id: options.videoId,
        game_id: `gam_${options.id}`,
        kind: 'live',
        title: 'Demo Away at Demo Home',
        storage: 'local',
        status: 'processing',
        hidden: !options.published,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      ?.insertInto('live_streams')
      .values({
        id: options.id,
        game_id: `gam_${options.id}`,
        team_id: `tem_home_${options.id}`,
        key_hash: `hash_${options.id}`,
        key_prefix: 'gs_demo',
        key_cipher: 'v1.x.y.z',
        state: options.published ? 'publishing' : 'idle',
        opens_at: new Date(now.getTime() - 3_600_000),
        closes_at: new Date(now.getTime() + 3_600_000),
        video_id: options.videoId,
        first_published_at: options.published ? now : null,
        last_published_at: options.published ? now : null,
        created_at: now,
        updated_at: now
      })
      .execute()
  }

  /** Six seconds of real HEVC, written the way the live output writes it. */
  async function recordSomething(videoId: string): Promise<string> {
    const dir = liveVideoDir(mediaRoot, videoId)
    await mkdir(dir, { recursive: true })
    await run(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-t',
        '6',
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=none',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'hls',
        '-hls_time',
        '2',
        '-hls_playlist_type',
        'event',
        '-hls_segment_type',
        'fmp4',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        join(dir, 'seg%06d.m4s'),
        join(dir, LIVE_PLAYLIST_NAME)
      ],
      { maxBuffer: 1 << 22 }
    )
    // ffmpeg closes a playlist it finished; a stream that was cut off has no
    // ENDLIST, which is the case this path exists for.
    const path = join(dir, LIVE_PLAYLIST_NAME)
    const playlist = await readFile(path, 'utf8')
    await writeFile(path, playlist.replace('#EXT-X-ENDLIST\n', ''))
    return dir
  }

  it('throws away the placeholder of a stream nobody ever used', async function () {
    if (options == null) this.skip()
    await makeStream({
      id: 'liv_unused',
      videoId: 'vid_unused',
      published: false
    })

    await finishStream(options, 'liv_unused', 'the stream window closed')
    await settleLiveWork()

    const video = await db
      ?.selectFrom('videos')
      .select(['id'])
      .where('id', '=', 'vid_unused')
      .executeTakeFirst()
    expect(video, 'no recording, no row').equals(undefined)
    const stream = await db
      ?.selectFrom('live_streams')
      .select(['state', 'last_error as lastError'])
      .where('id', '=', 'liv_unused')
      .executeTakeFirst()
    expect(stream?.state).equals('ended')
    expect(stream?.lastError).equals('the stream window closed')
  })

  it('closes the playlist, packs the game up and puts it in the Space', async function () {
    if (options == null) this.skip()
    await makeStream({
      id: 'liv_played',
      videoId: 'vid_played',
      published: true
    })
    const dir = await recordSomething('vid_played')

    await finishStream(options, 'liv_played', 'the stream window closed')
    // The video is watchable the moment the stream ends; the packing and the
    // upload happen behind it.
    const ready = await db
      ?.selectFrom('videos')
      .select(['status', 'duration_sec as durationSec'])
      .where('id', '=', 'vid_played')
      .executeTakeFirst()
    expect(ready?.status, 'watchable at once').equals('ready')
    expect(ready?.durationSec ?? 0, 'as long as the game was').greaterThan(5.5)

    await settleLiveWork()

    // One file instead of three segments, with the byte-range playlist every
    // other recording has.
    expect((await stat(join(dir, 'video.mp4'))).size).greaterThan(0)
    const media = await readFile(join(dir, 'video.m3u8'), 'utf8')
    expect(media).contains('#EXT-X-BYTERANGE:')
    // The segments stay for whoever is still watching the stream that just
    // ended; they go with the local copy, hours later.
    expect((await stat(join(dir, 'seg000000.m4s'))).size).greaterThan(0)

    const row = await db
      ?.selectFrom('videos')
      .select([
        'storage',
        'codecs',
        'width',
        'spaces_verified_at as verifiedAt',
        'status_message as message'
      ])
      .where('id', '=', 'vid_played')
      .executeTakeFirst()
    expect(row?.storage, 'the Space has it').equals('spaces')
    expect(row?.codecs).equals('hvc1')
    expect(row?.width).equals(320)
    expect(row?.verifiedAt).not.equals(null)
    expect(row?.message).equals(null)

    // And what it uploaded is the recording, not the segments it was made of.
    const keys = [...held.keys()]
    expect(keys.some(key => key.endsWith('vid_played/video.mp4'))).equals(true)
    expect(keys.some(key => key.includes('seg000000'))).equals(false)
  })
})
