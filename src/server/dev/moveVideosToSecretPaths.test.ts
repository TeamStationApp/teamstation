import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

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
import { copyObject, putObject } from '../media/images'
import type { SpaceSettings } from '../media/spacesHls'
import { listSpaceObjects } from '../media/spacesVideo'
import { oldVideoPrefix, videoPrefix } from '../media/videoPrefix'
import { startFakeSpace } from './fakeSpace'
import {
  maskedPrefix,
  moveVideosToSecretPaths,
  parseMoveArgs
} from './moveVideosToSecretPaths'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('moving videos to their secret paths', function () {
  this.timeout(60000)
  const name = `teamstation_move_secret_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  let root: string
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
  })

  after(async function () {
    await db?.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  beforeEach(async function () {
    root = await mkdtemp(join(tmpdir(), 'tsMoveSecret-'))
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

  const addVideo = async (
    id: string,
    storage: 'local' | 'spaces',
    spaceSecret: string | null = null
  ): Promise<void> => {
    await db
      .insertInto('videos')
      .values({
        id,
        game_id: 'gam_one',
        kind: storage === 'local' ? 'live' : 'program',
        title: id,
        storage,
        space_secret: spaceSecret
      })
      .execute()
  }
  const put = async (key: string, bytes: number): Promise<void> => {
    await putObject({
      space,
      key,
      body: Buffer.alloc(bytes, 7),
      contentType: 'application/octet-stream'
    })
  }
  /** A finished recording and a live one from before secrets, on their old paths. */
  const seed = async (): Promise<void> => {
    await addVideo('vid_done', 'spaces')
    for (const [file, bytes] of [
      ['master.m3u8', 40],
      ['video.m3u8', 80],
      ['video.mp4', 5000],
      ['stills/10.jpg', 30]
    ] as const)
      await put(`videos/vid_done/${file}`, bytes)
    await addVideo('vid_live', 'local')
    for (const [file, bytes] of [
      ['master.m3u8', 40],
      ['index.m3u8', 90],
      ['init.mp4', 700],
      ['seg000000.m4s', 3000],
      ['seg000001.m4s', 3100]
    ] as const)
      await put(`videos/vid_live/${file}`, bytes)
    await addVideo('vid_empty', 'spaces')
    await addVideo('vid_kept', 'spaces', SECRET)
    await addVideo('vid_demo', 'spaces')
    await put('videos/vid_demo/master.m3u8', 40)
  }
  const files = async (): Promise<string[]> =>
    (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => relative(root, join(entry.parentPath, entry.name)))
      .sort()
  const secrets = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      (
        await db
          .selectFrom('videos')
          .select(['id', 'space_secret'])
          .orderBy('id')
          .execute()
      ).map(row => [row.id, row.space_secret])
    )
  const secretOf = async (id: string): Promise<string> => (await secrets())[id]!
  const move = async (
    options: Partial<Parameters<typeof moveVideosToSecretPaths>[0]> = {}
  ): Promise<Awaited<ReturnType<typeof moveVideosToSecretPaths>>> =>
    await moveVideosToSecretPaths({
      db,
      space,
      batchSize: 2,
      log: line => lines.push(line),
      ...options
    })
  const plain = (key: string): string =>
    `${space.endpoint}/${space.bucket}/${key}`

  it('writes nothing in a dry run, and says what it would do', async function () {
    await seed()
    const before = { files: await files(), secrets: await secrets() }
    const report = await move({ dryRun: true })
    expect(report).deep.equals({
      moved: ['vid_done', 'vid_live'],
      finished: [],
      secretOnly: ['vid_empty'],
      skipped: ['vid_demo']
    })
    expect(await files()).deep.equals(before.files)
    expect(await secrets()).deep.equals(before.secrets)
    expect(lines.join('\n')).contains('would move vid_live: 5 objects')
    // The whole secret is a capability; a log line holds four characters.
    for (const line of lines) expect(line).not.matches(/[0-9a-f]{32}/)
  })

  it('copies every object with its kind’s headers, sets the secret, and deletes the old objects last', async function () {
    await seed()
    const report = await move()
    expect(report).deep.equals({
      moved: ['vid_done', 'vid_live'],
      finished: [],
      secretOnly: ['vid_empty'],
      skipped: ['vid_demo']
    })
    const done = await secretOf('vid_done')
    const live = await secretOf('vid_live')
    expect(done).matches(/^[0-9a-f]{32}$/)
    expect(live).matches(/^[0-9a-f]{32}$/)
    expect(done).not.equals(live)
    expect(await secretOf('vid_empty')).matches(/^[0-9a-f]{32}$/)
    expect(await secretOf('vid_kept')).equals(SECRET)
    expect((await secrets()).vid_demo, 'read-only source').equals(null)

    const donePrefix = videoPrefix({ id: 'vid_done', spaceSecret: done })
    const livePrefix = videoPrefix({ id: 'vid_live', spaceSecret: live })
    expect(await listSpaceObjects(space, donePrefix)).deep.equals([
      `${donePrefix}master.m3u8`,
      `${donePrefix}video.m3u8`,
      `${donePrefix}video.mp4`
    ])
    expect(await listSpaceObjects(space, livePrefix)).length(5)
    // Stills stay where every still is.
    expect(
      await listSpaceObjects(space, oldVideoPrefix('vid_done'))
    ).deep.equals(['videos/vid_done/stills/10.jpg'])
    expect(
      await listSpaceObjects(space, oldVideoPrefix('vid_live'))
    ).deep.equals([])
    expect(
      await listSpaceObjects(space, oldVideoPrefix('vid_demo'))
    ).deep.equals(['videos/vid_demo/master.m3u8'])

    const piece = await fetch(plain(`${livePrefix}seg000001.m4s`))
    expect(piece.status).equals(200)
    expect(piece.headers.get('cache-control')).equals('public, max-age=600')
    expect(Number(piece.headers.get('content-length'))).equals(3100)
    const init = await fetch(plain(`${livePrefix}init.mp4`))
    expect(init.headers.get('cache-control')).equals('no-cache')
    const recording = await fetch(plain(`${donePrefix}video.mp4`))
    expect(recording.status).equals(200)
    expect(recording.headers.get('content-type')).equals('video/mp4')
    for (const playlist of [
      `${livePrefix}index.m3u8`,
      `${livePrefix}master.m3u8`,
      `${donePrefix}video.m3u8`
    ])
      expect((await fetch(plain(playlist))).status, playlist).equals(403)
    expect(lines.join('\n')).contains(
      `moved vid_live: 5 objects, 6930 bytes, to ${maskedPrefix('vid_live', live)}`
    )

    // A second run changes nothing.
    const after = { files: await files(), secrets: await secrets() }
    lines.length = 0
    expect(await move()).deep.equals({
      moved: [],
      finished: [],
      secretOnly: [],
      skipped: ['vid_demo']
    })
    expect(await files()).deep.equals(after.files)
    expect(await secrets()).deep.equals(after.secrets)
  })

  it('sets no secret and deletes nothing when a copy comes back short', async function () {
    await seed()
    fake.faults.set({
      method: 'PUT',
      key: /-[0-9a-f]{32}\/video\.mp4$/,
      truncateTo: 10
    })
    let message = ''
    await move({ videoId: 'vid_done' }).catch(
      (error: unknown) => (message = (error as Error).message)
    )
    expect(message).matches(/video\.mp4 is 10, not 5000 bytes/)
    expect(message).not.matches(/[0-9a-f]{32}/)
    expect((await secrets()).vid_done).equals(null)
    expect(await listSpaceObjects(space, oldVideoPrefix('vid_done'))).length(4)
    // The next run reuses the copies that are whole, and finishes.
    fake.faults.clear()
    expect((await move({ videoId: 'vid_done' })).moved).deep.equals([
      'vid_done'
    ])
    expect(
      await listSpaceObjects(
        space,
        videoPrefix({ id: 'vid_done', spaceSecret: await secretOf('vid_done') })
      )
    ).length(3)
  })

  it('finishes a run stopped after its copies by deleting the old objects', async function () {
    await addVideo('vid_stop', 'spaces')
    await put('videos/vid_stop/master.m3u8', 40)
    await put('videos/vid_stop/video.m3u8', 80)
    await put('videos/vid_stop/video.mp4', 900)
    // Another video whose id starts with this one's is not mistaken for it.
    await addVideo('vid_stop-x', 'spaces', SECRET)
    const prefix = videoPrefix({
      id: 'vid_stop',
      spaceSecret: 'fedcba9876543210fedcba9876543210'
    })
    for (const [file, bytes] of [
      ['master.m3u8', 40],
      ['video.m3u8', 80],
      ['video.mp4', 900]
    ] as const)
      await copyObject({
        space,
        sourceKey: `videos/vid_stop/${file}`,
        key: `${prefix}${file}`,
        contentType: 'application/octet-stream',
        size: bytes
      })
    const report = await move({ videoId: 'vid_stop' })
    expect(report.finished).deep.equals(['vid_stop'])
    expect(report.moved).deep.equals([])
    expect(await secretOf('vid_stop')).equals(
      'fedcba9876543210fedcba9876543210'
    )
    expect(
      await listSpaceObjects(space, oldVideoPrefix('vid_stop'))
    ).deep.equals([])
    expect(await listSpaceObjects(space, prefix)).length(3)
  })

  it('moves at most --limit videos, and copies a large object in parts', async function () {
    await seed()
    const report = await move({
      limit: 1,
      copyLimitBytes: 1000,
      partSize: 2048
    })
    expect(report.moved).deep.equals(['vid_done'])
    expect((await secrets()).vid_live).equals(null)
    const prefix = videoPrefix({
      id: 'vid_done',
      spaceSecret: await secretOf('vid_done')
    })
    const recording = await fetch(plain(`${prefix}video.mp4`))
    expect(Number(recording.headers.get('content-length'))).equals(5000)
    expect(recording.headers.get('cache-control')).equals('public, max-age=600')
  })

  it('leaves a video whose stream is open, publishing or idle in its reconnect grace, and moves one whose stream ended', async function () {
    await seed()
    await pool.query(
      `insert into live_streams (id, game_id, team_id, key_hash, key_prefix, key_cipher, opens_at, video_id, state)
       values ('liv_one', 'gam_one', 'tem_home', 'h', 'p', 'c', now(), 'vid_live', 'publishing')`
    )
    for (const state of ['publishing', 'idle']) {
      await pool.query(`update live_streams set state = $1`, [state])
      const report = await move()
      expect(report.skipped, state).deep.equals(['vid_demo', 'vid_live'])
      expect((await secrets()).vid_live, state).equals(null)
      expect(
        await listSpaceObjects(space, oldVideoPrefix('vid_live')),
        state
      ).length(5)
    }
    await pool.query(`update live_streams set ended_at = now()`)
    const report = await move()
    expect(report.skipped).deep.equals(['vid_demo'])
    expect((await secrets()).vid_live).not.equals(null)
  })

  it('refuses without a Space', async function () {
    let message = ''
    await moveVideosToSecretPaths({
      db,
      space: { ...space, accessKeyId: '' }
    }).catch((error: unknown) => (message = (error as Error).message))
    expect(message).equals('No Space is configured')
  })
})

describe('the move script’s arguments', function () {
  it('reads --dry-run, --limit, --video and --config', function () {
    expect(parseMoveArgs([])).deep.equals({
      dryRun: false,
      limit: undefined,
      videoId: undefined,
      config: undefined
    })
    expect(
      parseMoveArgs([
        '--dry-run',
        '--limit',
        '5',
        '--video',
        'vid_one',
        '--config',
        'c.json'
      ])
    ).deep.equals({
      dryRun: true,
      limit: 5,
      videoId: 'vid_one',
      config: 'c.json'
    })
  })

  it('refuses a bad limit, a missing value and an unknown flag', function () {
    expect(() => parseMoveArgs(['--limit', '0'])).throws('positive')
    expect(() => parseMoveArgs(['--limit', 'x'])).throws('positive')
    expect(() => parseMoveArgs(['--video'])).throws('needs a value')
    expect(() => parseMoveArgs(['--video', '--dry-run'])).throws(
      'needs a value'
    )
    expect(() => parseMoveArgs(['--force'])).throws('Unknown flag')
  })
})
