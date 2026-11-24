import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { remuxToHls } from '../media/ffmpeg'
import { putObject } from '../media/images'
import { presignGetUrl } from '../media/presign'
import { slicePlan } from '../media/sliceRecording'
import type { SpaceSettings } from '../media/spacesHls'
import { listSpaceObjectEntries, listSpaceObjects } from '../media/spacesVideo'
import { oldVideoPrefix, videoPrefix } from '../media/videoPrefix'
import { startFakeSpace } from './fakeSpace'
import {
  parseSegmentArgs,
  segmentSpaceVideos,
  summary
} from './segmentSpaceVideos'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const SECRET = '0123456789abcdef0123456789abcdef'
/** A secret of a video's own: they are unique across videos. */
const secretOf = (id: string): string =>
  createHash('md5').update(id).digest('hex')

/**
 * Repackaging the single-file recordings already in the Space, against a
 * scratch database and the fake Space, on real remuxes of real video.
 */
describe('repackaging single-file videos into segments', function () {
  this.timeout(120000)
  const name = `teamstation_segment_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  let media = ''
  let root = ''
  let fake: Awaited<ReturnType<typeof startFakeSpace>>
  const lines: string[] = []
  const space: SpaceSettings = {
    endpoint: '',
    region: 'test',
    bucket: 'test',
    accessKeyId: 'example',
    secretAccessKey: 'example',
    pathStyle: true,
    readOnlySource: {
      endpoint: 'http://127.0.0.1:1',
      region: 'test',
      bucket: 'shared',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true,
      keys: ['videos/vid_demo/video.mp4']
    }
  }
  /** Two remuxes of different pictures, one file each, made once. */
  let first = ''
  let second = ''

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await pool.query(`
      insert into teams (id, name) values ('tem_home', 'Home'), ('tem_away', 'Away');
      insert into games (id, home_team_id, away_team_id, start_at)
        values ('gam_one', 'tem_home', 'tem_away', now())`)
    media = await mkdtemp(join(tmpdir(), 'tsSegmentMedia-'))
    for (const [dir, size, seconds] of [
      ['first', '320x240', 20],
      ['second', '160x120', 8]
    ] as const) {
      const source = join(media, `${dir}.mp4`)
      await run(FFMPEG, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${seconds}:size=${size}:rate=30`,
        '-c:v',
        'libx264',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        source
      ])
      await mkdir(join(media, dir))
      await remuxToHls(FFMPEG, {
        input: source,
        outDir: join(media, dir),
        videoTag: 'avc1',
        layout: 'single-file'
      })
    }
    first = join(media, 'first')
    second = join(media, 'second')
  })

  after(async function () {
    await db?.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
    if (media !== '') await rm(media, { recursive: true, force: true })
  })

  beforeEach(async function () {
    root = await mkdtemp(join(tmpdir(), 'tsSegmentSpace-'))
    space.endpoint = ''
    fake = await startFakeSpace({ space, dir: root })
    space.endpoint = fake.url
    lines.length = 0
    await pool.query(`delete from live_streams; delete from videos`)
  })

  afterEach(async function () {
    fake.server.close()
    await rm(root, { recursive: true, force: true })
  })

  const log = (line: string): void => {
    lines.push(line)
  }

  const addVideo = async (
    id: string,
    spaceSecret: string | null,
    options: { kind?: 'program' | 'live'; closed?: boolean } = {}
  ): Promise<void> => {
    await db
      .insertInto('videos')
      .values({
        id,
        game_id: 'gam_one',
        kind: options.kind ?? 'program',
        title: id,
        storage: 'spaces',
        status: 'ready',
        space_secret: spaceSecret,
        start_at: new Date('2026-11-22T22:00:00Z'),
        duration_sec: 20,
        spaces_verified_at: options.closed === false ? null : new Date()
      })
      .execute()
  }

  const putFile = async (key: string, body: Buffer): Promise<void> => {
    await putObject({
      space,
      key,
      body,
      contentType: 'application/octet-stream'
    })
  }

  /** A single-file recording under `prefix`, and a still under the old path. */
  const seedSingle = async (
    id: string,
    secret: string | null
  ): Promise<void> => {
    const prefix = videoPrefix({ id, spaceSecret: secret })
    for (const file of ['master.m3u8', 'video.m3u8', 'video.mp4'])
      await putFile(`${prefix}${file}`, await readFile(join(first, file)))
    await putFile(`${oldVideoPrefix(id)}stills/3.jpg`, Buffer.from('still'))
  }

  /**
   * What the no-origin fallback packed before segments: two configurations'
   * remuxes one after the other in one file, the second's ranges moved along.
   */
  const seedTwoConfigurations = async (id: string): Promise<void> => {
    const one = await readFile(join(first, 'video.mp4'))
    const two = await readFile(join(second, 'video.mp4'))
    const shift = (playlist: string, by: number): string =>
      playlist
        .replace(
          /(#EXT-X-MAP:.*BYTERANGE=")(\d+)@(\d+)"/,
          (_l, head: string, n: string, at: string) =>
            `${head}${n}@${String(Number(at) + by)}"`
        )
        .replace(
          /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/gm,
          (_l, n: string, at: string) =>
            `#EXT-X-BYTERANGE:${n}@${String(Number(at) + by)}`
        )
    const a = (await readFile(join(first, 'video.m3u8'), 'utf8')).trimEnd()
    const b = shift(
      await readFile(join(second, 'video.m3u8'), 'utf8'),
      one.length
    )
    const body = b.split('\n')
    const joined = [
      ...a.split('\n').filter(line => line !== '#EXT-X-ENDLIST'),
      '#EXT-X-DISCONTINUITY',
      ...body.slice(body.findIndex(line => line.startsWith('#EXT-X-MAP:')))
    ].join('\n')
    const prefix = videoPrefix({ id, spaceSecret: SECRET })
    await putFile(
      `${prefix}master.m3u8`,
      await readFile(join(first, 'master.m3u8'))
    )
    await putFile(`${prefix}video.m3u8`, Buffer.from(joined))
    await putFile(`${prefix}video.mp4`, Buffer.concat([one, two]))
  }

  const read = async (key: string): Promise<Buffer> => {
    const response = await fetch(
      presignGetUrl({ ...space, key, expiresSec: 60 })
    )
    expect(response.status, key).equals(200)
    return Buffer.from(await response.arrayBuffer())
  }

  const rowOf = async (
    id: string
  ): Promise<{
    secret: string | null
    size: string | null
    start: Date | null
    duration: number | null
  }> => {
    const row = await db
      .selectFrom('videos')
      .select(['space_secret', 'size_bytes', 'start_at', 'duration_sec'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return {
      secret: row.space_secret,
      size: row.size_bytes,
      start: row.start_at,
      duration: row.duration_sec
    }
  }

  /** The bytes of a piece, from the single file the plan cut it from. */
  const original = async (
    id: string,
    secret: string | null
  ): Promise<Map<string, Buffer>> => {
    const prefix = videoPrefix({ id, spaceSecret: secret })
    const plan = slicePlan((await read(`${prefix}video.m3u8`)).toString('utf8'))
    const file = await read(`${prefix}video.mp4`)
    return new Map(
      plan.pieces.map(piece => [
        piece.name,
        file.subarray(piece.offset, piece.offset + piece.length)
      ])
    )
  }

  it('repackages single files on the plain and the secret path under new secrets, byte for byte', async function () {
    await addVideo('vid_plain', null)
    await seedSingle('vid_plain', null)
    await addVideo('vid_secret', SECRET)
    await seedSingle('vid_secret', SECRET)
    const before = {
      plain: await original('vid_plain', null),
      secret: await original('vid_secret', SECRET),
      rows: [await rowOf('vid_plain'), await rowOf('vid_secret')]
    }
    const oldPlaylist = (
      await read(
        `${videoPrefix({ id: 'vid_secret', spaceSecret: SECRET })}video.m3u8`
      )
    ).toString('utf8')

    const report = await segmentSpaceVideos({ db, space, log })
    expect(report.repackaged.sort((a, b) => a.localeCompare(b))).deep.equals([
      'vid_plain',
      'vid_secret'
    ])
    for (const [id, pieces, was] of [
      ['vid_plain', before.plain, before.rows[0]],
      ['vid_secret', before.secret, before.rows[1]]
    ] as const) {
      const row = await rowOf(id)
      expect(row.secret).match(/^[0-9a-f]{32}$/)
      expect(row.secret).not.equals(was.secret)
      // The timeline the highlights are read on does not move.
      expect([row.start, row.duration]).deep.equals([was.start, was.duration])
      const prefix = videoPrefix({ id, spaceSecret: row.secret })
      const entries = await listSpaceObjectEntries(space, prefix)
      const names = entries.map(entry => entry.key.slice(prefix.length))
      expect(names).does.not.contain('video.mp4')
      expect(names).contains('init.mp4')
      expect(Number(row.size)).equals(
        entries.reduce((sum, e) => sum + e.size, 0)
      )
      for (const [piece, bytes] of pieces) {
        expect((await read(`${prefix}${piece}`)).equals(bytes), piece).equals(
          true
        )
      }
      const playlist = (await read(`${prefix}video.m3u8`)).toString('utf8')
      expect(playlist).does.not.contain('BYTERANGE')
      if (id === 'vid_secret') {
        // The same entries, the same durations, in the same places.
        const durations = (text: string): string[] =>
          text.split('\n').filter(line => line.startsWith('#EXTINF:'))
        expect(durations(playlist)).deep.equals(durations(oldPlaylist))
      }
      // The pieces are public under the new secret, the playlists are not.
      expect(
        (
          await fetch(
            `${space.endpoint}/${space.bucket}/${prefix}seg000000.m4s`
          )
        ).status
      ).equals(200)
      expect(
        (await fetch(`${space.endpoint}/${space.bucket}/${prefix}video.m3u8`))
          .status
      ).equals(403)
    }
    // A player still holding the old playlist plays on: the old objects stay.
    expect(
      await listSpaceObjects(
        space,
        videoPrefix({ id: 'vid_secret', spaceSecret: SECRET })
      )
    ).contains(
      `${videoPrefix({ id: 'vid_secret', spaceSecret: SECRET })}video.mp4`
    )
    // No secret, old or new, in what it said.
    const said = lines.join('\n')
    expect(said).does.not.match(/[0-9a-f]{32}/)
    expect(said).contains('repackaged vid_secret')
  })

  it('names a later configuration’s init after its first segment', async function () {
    await addVideo('vid_live', SECRET, { kind: 'live' })
    await seedTwoConfigurations('vid_live')
    await segmentSpaceVideos({ db, space, log })
    const row = await rowOf('vid_live')
    const prefix = videoPrefix({ id: 'vid_live', spaceSecret: row.secret })
    const names = (await listSpaceObjects(space, prefix)).map(key =>
      key.slice(prefix.length)
    )
    const inits = names
      .filter(n => /^init\d*\.mp4$/.test(n))
      .sort((a, b) => a.localeCompare(b))
    expect(inits).length(2)
    expect(inits[0]).equals('init.mp4')
    const later = inits[1]
    expect(later).match(/^init\d{6}\.mp4$/)
    const playlist = (await read(`${prefix}video.m3u8`)).toString('utf8')
    expect(playlist).contains(`#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${later}"`)
    expect(playlist).contains(`seg${later.slice(4, 10)}.m4s`)
  })

  it('leaves segmented, read-only-source and still-open live videos alone', async function () {
    await addVideo('vid_already', secretOf('vid_already'))
    for (const file of [
      'master.m3u8',
      'video.m3u8',
      'init.mp4',
      'seg000000.m4s'
    ])
      await putFile(
        `${videoPrefix({ id: 'vid_already', spaceSecret: secretOf('vid_already') })}${file}`,
        Buffer.from(file)
      )
    await addVideo('vid_demo', null)
    await addVideo('vid_open', secretOf('vid_open'), {
      kind: 'live',
      closed: false
    })
    await seedSingle('vid_open', secretOf('vid_open'))
    const report = await segmentSpaceVideos({ db, space, log })
    expect(report.repackaged).deep.equals([])
    expect(report.segmented).deep.equals(['vid_already'])
    expect(report.skipped.sort((a, b) => a.localeCompare(b))).deep.equals([
      'vid_demo',
      'vid_open'
    ])
    expect((await rowOf('vid_already')).secret).equals(secretOf('vid_already'))
    expect((await rowOf('vid_open')).secret).equals(secretOf('vid_open'))
  })

  it('writes nothing in a dry run, and does nothing the second time', async function () {
    await addVideo('vid_dry', SECRET)
    await seedSingle('vid_dry', SECRET)
    const objects = async (): Promise<string[]> =>
      await listSpaceObjects(space, 'videos/')
    const before = await objects()
    const dry = await segmentSpaceVideos({ db, space, log, dryRun: true })
    expect(dry.repackaged).deep.equals(['vid_dry'])
    expect(await objects()).deep.equals(before)
    expect((await rowOf('vid_dry')).secret).equals(SECRET)
    expect(lines.join('\n')).contains('would repackage vid_dry')

    await segmentSpaceVideos({ db, space, log })
    const after = await objects()
    const again = await segmentSpaceVideos({ db, space, log })
    expect(again.repackaged).deep.equals([])
    expect(again.segmented).deep.equals(['vid_dry'])
    expect(await objects()).deep.equals(after)
    expect(summary(again, parseSegmentArgs([]))).equals(
      '0 repackaged, 1 already segments, 0 skipped, 0 failed'
    )
  })

  it('takes back a copy that fails half way, finishes the next time, and deletes the old and what a killed run abandoned', async function () {
    await addVideo('vid_cut', SECRET)
    await seedSingle('vid_cut', SECRET)
    // Fails part way: the copies stop after a few pieces.
    let gets = 0
    const dying = (async (input: string, init?: RequestInit) => {
      if (init?.headers != null && ++gets > 4) throw new Error('reset')
      return await fetch(input, init)
    }) as typeof fetch
    const cut = await segmentSpaceVideos({ db, space, log, fetch: dying })
    expect(cut.failed).deep.equals(['vid_cut'])
    expect(
      (await rowOf('vid_cut')).secret,
      'still on its old, working prefix'
    ).equals(SECRET)
    const others = async (): Promise<string[]> =>
      (await listSpaceObjects(space, 'videos/vid_cut-')).filter(
        key =>
          !key.startsWith(videoPrefix({ id: 'vid_cut', spaceSecret: SECRET }))
      )
    expect(await others(), 'the partial copy is deleted').deep.equals([])
    // A run killed part way gets no chance to take its copy back.
    const killed = videoPrefix({ id: 'vid_cut', spaceSecret: 'f'.repeat(32) })
    await putFile(`${killed}seg000000.m4s`, Buffer.from('piece'))
    expect(await others()).length(1)

    const done = await segmentSpaceVideos({ db, space, log })
    expect(done.repackaged).deep.equals(['vid_cut'])
    const current = videoPrefix({
      id: 'vid_cut',
      spaceSecret: (await rowOf('vid_cut')).secret
    })

    const dry = await segmentSpaceVideos({
      db,
      space,
      log,
      deleteOld: true,
      dryRun: true
    })
    expect(dry.cleaned).deep.equals(['vid_cut'])
    expect(
      await listSpaceObjects(
        space,
        videoPrefix({ id: 'vid_cut', spaceSecret: SECRET })
      )
    ).length(3)

    const cleaned = await segmentSpaceVideos({
      db,
      space,
      log,
      deleteOld: true
    })
    expect(cleaned.cleaned).deep.equals(['vid_cut'])
    const left = await listSpaceObjects(space, 'videos/vid_cut')
    expect(
      left.every(
        key =>
          key.startsWith(current) || key.startsWith('videos/vid_cut/stills/')
      )
    ).equals(true)
    expect(left).contains('videos/vid_cut/stills/3.jpg')
    expect(left.some(key => key.startsWith(current))).equals(true)
    // And again, nothing.
    expect(
      (await segmentSpaceVideos({ db, space, log, deleteOld: true })).cleaned
    ).deep.equals([])
    expect(lines.join('\n')).does.not.match(/[0-9a-f]{32}/)
  })

  it('deletes nothing of a video whose current prefix does not hold its recording', async function () {
    // A row pointing at a secret prefix with nothing under it, and its only
    // copy on the old path: not segmented, so not "old".
    await addVideo('vid_hollow', secretOf('vid_hollow'))
    for (const file of [
      'master.m3u8',
      'video.m3u8',
      'init.mp4',
      'seg000000.m4s'
    ])
      await putFile(`${oldVideoPrefix('vid_hollow')}${file}`, Buffer.from(file))
    const cleaned = await segmentSpaceVideos({
      db,
      space,
      log,
      deleteOld: true
    })
    expect(cleaned.cleaned).deep.equals([])
    expect(await listSpaceObjects(space, oldVideoPrefix('vid_hollow'))).length(
      4
    )
    const repack = await segmentSpaceVideos({ db, space, log })
    expect(repack.segmented).deep.equals([])
    expect(repack.skipped).deep.equals(['vid_hollow'])
    expect(lines.join('\n')).contains('skip vid_hollow: videos/vid_hollow-')
  })

  it('deletes its new copy of a video deleted while it was being copied', async function () {
    await addVideo('vid_gone', secretOf('vid_gone'))
    await seedSingle('vid_gone', secretOf('vid_gone'))
    // The row goes as the pieces are copied, as a delete from the app would.
    let gets = 0
    const deleting = (async (input: string, init?: RequestInit) => {
      if (init?.headers != null && ++gets === 3)
        await db.deleteFrom('videos').where('id', '=', 'vid_gone').execute()
      return await fetch(input, init)
    }) as typeof fetch
    const report = await segmentSpaceVideos({ db, space, log, fetch: deleting })
    expect(report.failed).deep.equals(['vid_gone'])
    expect(lines.join('\n')).contains('it was deleted meanwhile')
    const left = await listSpaceObjects(space, 'videos/vid_gone-')
    expect(
      left.filter(
        key =>
          !key.startsWith(
            videoPrefix({ id: 'vid_gone', spaceSecret: secretOf('vid_gone') })
          )
      )
    ).deep.equals([])
  })

  it('bounds a run by --video and --limit, and reads its flags', async function () {
    await addVideo('vid_a', secretOf('vid_a'))
    await seedSingle('vid_a', secretOf('vid_a'))
    await addVideo('vid_b', secretOf('vid_b'))
    await seedSingle('vid_b', secretOf('vid_b'))
    expect(
      (await segmentSpaceVideos({ db, space, log, videoId: 'vid_b' }))
        .repackaged
    ).deep.equals(['vid_b'])
    await addVideo('vid_c', secretOf('vid_c'))
    await seedSingle('vid_c', secretOf('vid_c'))
    expect(
      (await segmentSpaceVideos({ db, space, log, limit: 1 })).repackaged
    ).deep.equals(['vid_a'])
    expect(
      parseSegmentArgs([
        '--dry-run',
        '--video',
        'vid_x',
        '--limit',
        '3',
        '--delete-old'
      ])
    ).deep.equals({
      dryRun: true,
      deleteOld: true,
      limit: 3,
      videoId: 'vid_x',
      config: undefined
    })
    expect(() => parseSegmentArgs(['--limit', '0'])).throws(/positive/)
    expect(() => parseSegmentArgs(['--video'])).throws(/needs a value/)
    expect(() => parseSegmentArgs(['--everything'])).throws(/Unknown flag/)
    // A bare id must not run over every video.
    expect(() => parseSegmentArgs(['vid_abc'])).throws(/--video/)
    expect(() => parseSegmentArgs(['--delete-old', 'vid_abc'])).throws(
      /Unexpected argument vid_abc/
    )
    expect(
      summary(
        {
          repackaged: [],
          segmented: [],
          cleaned: ['x'],
          skipped: [],
          failed: []
        },
        parseSegmentArgs(['--delete-old', '--dry-run'])
      )
    ).equals('dry run: 1 cleaned, 0 skipped, 0 failed')
  })

  it('keeps nothing of the seeded files on this machine', async function () {
    // The repackage runs Space to Space: no local copy is ever written.
    await addVideo('vid_disk', SECRET)
    await seedSingle('vid_disk', SECRET)
    const tmp = await readdir(tmpdir())
    await segmentSpaceVideos({ db, space, log })
    const added = (await readdir(tmpdir())).filter(
      entry => !tmp.includes(entry)
    )
    for (const entry of added) {
      const info = await stat(join(tmpdir(), entry)).catch(() => undefined)
      expect(
        info?.isDirectory() === true && entry.startsWith('tsSegment'),
        entry
      ).equals(false)
    }
  })
})
