import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'

import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import { encodeFragmented, FFMPEG } from '../../test/wallClockFixtures'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import { migrateOne, secretForMigration } from '../dev/migratePeertubeToSpaces'
import { ingestVideoFile } from './ingestFile'
import type { SpaceSettings } from './spacesHls'
import { listSpaceObjects } from './spacesVideo'
import { videoPrefix } from './videoPrefix'

const run = promisify(execFile)

/**
 * M5: every path that creates a video row from a file, and the PeerTube
 * migration, puts its objects under the row's secret path.
 */
describe('uploads under a video’s secret path', function () {
  this.timeout(120000)
  let db: Kysely<Database>
  let url: string
  let drop: () => Promise<void>
  let dir: string
  let gameId: string
  let fake: Awaited<ReturnType<typeof startFakeSpace>>
  const space: SpaceSettings = {
    endpoint: '',
    region: 'test',
    bucket: 'test',
    accessKeyId: 'example',
    secretAccessKey: 'example',
    pathStyle: true
  }
  const plain = (key: string): string =>
    `${space.endpoint}/${space.bucket}/${key}`
  const secretOf = async (id: string): Promise<string | null | undefined> =>
    (
      await db
        .selectFrom('videos')
        .select('space_secret')
        .where('id', '=', id)
        .executeTakeFirst()
    )?.space_secret

  /** What a finished recording's secret path should hold, and how. */
  const expectPublished = async (id: string, secret: string): Promise<void> => {
    const prefix = videoPrefix({ id, spaceSecret: secret })
    expect(await listSpaceObjects(space, prefix)).deep.equals([
      `${prefix}master.m3u8`,
      `${prefix}video.m3u8`,
      `${prefix}video.mp4`
    ])
    const recording = await fetch(plain(`${prefix}video.mp4`), {
      method: 'HEAD'
    })
    expect(recording.status).equals(200)
    expect(recording.headers.get('cache-control')).equals('public, max-age=600')
    expect((await fetch(plain(`${prefix}video.m3u8`))).status).equals(403)
    expect(
      await listSpaceObjects(space, `videos/${id}/`),
      'nothing on the old path'
    ).deep.equals([])
  }

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsSecretUploads-'))
    await encodeFragmented(join(dir, 'take.mp4'), { codec: 'h264', seconds: 2 })
    ;({ db, url, drop } = await scratchDatabase('secret_uploads'))
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date()
    })
    fake = await startFakeSpace({ space, dir: join(dir, 'space') })
    space.endpoint = fake.url
  })
  after(async function () {
    fake?.server.close()
    await drop?.()
    await rm(dir, { recursive: true, force: true })
  })
  afterEach(function () {
    fake.faults.clear()
  })

  const ingest = async (): Promise<string> =>
    (
      await ingestVideoFile({
        db,
        space,
        ffmpegPath: FFMPEG,
        file: join(dir, 'take.mp4'),
        gameId,
        kind: 'program',
        title: 'Programme',
        startAt: new Date(),
        startAtSource: 'distributor',
        log: () => {}
      })
    ).videoId

  it('puts a Director upload under the secret its row is written with, a new one each time', async function () {
    const one = await ingest()
    const two = await ingest()
    const secret = await secretOf(one)
    expect(secret).matches(/^[0-9a-f]{32}$/)
    expect(await secretOf(two)).not.equals(secret)
    await expectPublished(one, secret!)
  })

  it('takes a failed upload’s copy back out of its secret path', async function () {
    fake.faults.set({ method: 'GET', key: /video\.mp4$/, status: 503 })
    let message = ''
    const before = await listSpaceObjects(space, 'videos/')
    await ingest().catch(
      (error: unknown) => (message = (error as Error).message)
    )
    expect(message).contains('did not verify')
    expect(await listSpaceObjects(space, 'videos/')).deep.equals(before)
  })

  it('imports a file from a disk under its secret path', async function () {
    const work = await mkdtemp(join(dir, 'import-'))
    await writeFile(
      join(work, 'serverConfig.json'),
      JSON.stringify({ databaseUrl: url, space, ffmpegPath: FFMPEG })
    )
    const root = resolve(__dirname, '../../..')
    const { stdout } = await run(
      process.execPath,
      [
        '-r',
        join(root, 'node_modules/sucrase/register'),
        join(root, 'src/server/dev/importVideoFile.ts'),
        '--file',
        join(dir, 'take.mp4'),
        '--game',
        gameId,
        '--title',
        'Imported',
        '--start',
        new Date().toISOString()
      ],
      { cwd: work }
    )
    const id = /imported as (vid_\S+)/.exec(stdout)?.[1]
    expect(id, stdout).not.equals(undefined)
    const secret = await secretOf(id!)
    expect(secret).matches(/^[0-9a-f]{32}$/)
    await expectPublished(id!, secret!)
  })

  it('gives a PeerTube video a secret before its first upload, and keeps one it has', async function () {
    const media = join(dir, 'media')
    const migrate = async (id: string): Promise<void> => {
      const peertube = join(media, 'peertube', id)
      await mkdir(peertube, { recursive: true })
      await writeFile(join(peertube, 'x-master.m3u8'), '#EXTM3U\n')
      await copyFile(join(dir, 'take.mp4'), join(peertube, 'x-fragmented.mp4'))
      await db
        .insertInto('videos')
        .values({
          id,
          game_id: gameId,
          kind: 'program',
          title: id,
          storage: 'peertube'
        })
        .execute()
      await migrateOne(
        {
          id,
          title: id,
          kind: 'program',
          storage: 'peertube',
          gameId,
          startAt: null,
          startAtSource: null,
          numCameras: 1
        },
        media,
        url,
        { space, ffmpegPath: FFMPEG }
      )
    }
    await migrate('vid_peertube')
    const secret = await secretOf('vid_peertube')
    expect(secret).matches(/^[0-9a-f]{32}$/)
    await expectPublished('vid_peertube', secret!)
    const row = await db
      .selectFrom('videos')
      .select(['storage', 'spaces_verified_at'])
      .where('id', '=', 'vid_peertube')
      .executeTakeFirstOrThrow()
    expect(row.storage).equals('spaces')
    expect(row.spaces_verified_at).not.equals(null)
    expect(await secretForMigration(db, 'vid_peertube')).equals(secret)
    let message = ''
    await secretForMigration(db, 'vid_none').catch(
      (error: unknown) => (message = (error as Error).message)
    )
    expect(message).equals('no row for vid_none')
  })
})
