import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import { migrateOne } from '../dev/migratePeertubeToSpaces'
import { remuxToHls } from './ffmpeg'
import { locateVideo, videoFrameSource } from './locations'
import type { SpaceSettings } from './spacesHls'
import { listSpaceObjects } from './spacesVideo'
import { ensureStill, stillKey } from './stills'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

/**
 * A recording on this host that is segments: a finished stream's
 * `recording/`, or an upload segmented in its own directory. Where it is
 * found, how its pictures are read, and how it goes to the Space.
 */
describe('a segmented recording on this host', function () {
  this.timeout(120000)

  let root = ''
  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined
  let databaseUrl = ''
  let store: Awaited<ReturnType<typeof startFakeSpace>> | undefined
  let gameId = ''
  const space: SpaceSettings = {
    bucket: 'test',
    region: 'sfo3',
    endpoint: '',
    accessKeyId: 'k',
    secretAccessKey: 's',
    pathStyle: true
  }
  const videos = (id: string): string => join(root, 'work', 'videos', id)

  before(async function () {
    root = await mkdtemp(join(tmpdir(), 'tsLocalRecording-'))
    const source = join(root, 'source.mp4')
    await run(FFMPEG, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=14:size=320x240:rate=30',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-pix_fmt',
      'yuv420p',
      source
    ])
    // A finished stream: live pieces in the directory, the recording in
    // `recording/`.
    await mkdir(videos('vid_finished'), { recursive: true })
    await writeFile(join(videos('vid_finished'), 'master.m3u8'), '#EXTM3U\n')
    await mkdir(join(videos('vid_finished'), 'recording'))
    await remuxToHls(FFMPEG, {
      input: source,
      outDir: join(videos('vid_finished'), 'recording'),
      videoTag: 'avc1'
    })
    // An upload segmented in its own directory, as `npm run sample-video`.
    await mkdir(videos('vid_sample'), { recursive: true })
    await remuxToHls(FFMPEG, {
      input: source,
      outDir: videos('vid_sample'),
      videoTag: 'avc1'
    })
    // One left in the shape the release before this one wrote.
    await mkdir(videos('vid_single'), { recursive: true })
    await remuxToHls(FFMPEG, {
      input: source,
      outDir: videos('vid_single'),
      videoTag: 'avc1',
      layout: 'single-file'
    })

    ;({ db, drop, url: databaseUrl } = await scratchDatabase('local_recording'))
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date()
    })
    for (const id of ['vid_finished', 'vid_sample', 'vid_single']) {
      await db
        .insertInto('videos')
        .values({
          id,
          game_id: gameId,
          kind: 'program',
          title: id,
          storage: 'local',
          status: 'ready'
        })
        .execute()
    }
    store = await startFakeSpace({ space, dir: join(root, 'space') })
    space.endpoint = store.url
  })

  after(async function () {
    store?.server.close()
    await drop?.()
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  const where = { mediaRoot: '', storage: 'local' as const }

  it('is found in recording/ when a finished stream left one', async function () {
    expect(
      await locateVideo({ ...where, mediaRoot: root, videoId: 'vid_finished' })
    ).deep.equals({
      dir: 'work/videos/vid_finished/recording',
      master: 'master.m3u8'
    })
    expect(
      await locateVideo({ ...where, mediaRoot: root, videoId: 'vid_sample' })
    ).deep.equals({ dir: 'work/videos/vid_sample', master: 'master.m3u8' })
  })

  it('finds nothing for an id that is not a plain one', async function () {
    for (const videoId of ['../videos/vid_finished', 'vid_finished/..', '']) {
      expect(await locateVideo({ ...where, mediaRoot: root, videoId })).equals(
        undefined
      )
      expect(
        await videoFrameSource({
          ...where,
          mediaRoot: root,
          videoId,
          space,
          spaceSecret: null
        })
      ).equals(undefined)
    }
  })

  it('has its frames read a segment at a time, and a single file as a file', async function () {
    const source = async (videoId: string): Promise<unknown> =>
      await videoFrameSource({
        ...where,
        mediaRoot: root,
        videoId,
        space,
        spaceSecret: null
      })
    expect(await source('vid_finished')).deep.equals({
      kind: 'dir',
      dir: join(videos('vid_finished'), 'recording')
    })
    expect(await source('vid_sample')).deep.equals({
      kind: 'dir',
      dir: videos('vid_sample')
    })
    expect(await source('vid_single')).deep.equals({
      kind: 'file',
      path: join(videos('vid_single'), 'video.mp4')
    })
  })

  it('cuts a poster from its segments', async function () {
    const key = await ensureStill({
      ffmpegPath: FFMPEG,
      source: { kind: 'dir', dir: videos('vid_sample') },
      space,
      videoId: 'vid_sample',
      atSec: 9
    })
    expect(key).equals(stillKey('vid_sample', 9))
    expect(
      await listSpaceObjects(space, 'videos/vid_sample/stills/')
    ).deep.equals([key])
  })

  it('cuts a poster through the playlist when its pieces are not ones it reads one at a time', async function () {
    // A recording whose playlist names its pieces otherwise: the one-segment
    // reader takes only seg######.m4s, so FFmpeg is pointed at the playlist.
    const odd = videos('vid_odd')
    await mkdir(odd, { recursive: true })
    for (const name of await readdir(videos('vid_sample'))) {
      const renamed = name.replace(/^seg(\d{6})\.m4s$/, 'part$1.m4s')
      await copyFile(join(videos('vid_sample'), name), join(odd, renamed))
    }
    const playlist = await readFile(join(odd, 'video.m3u8'), 'utf8')
    await writeFile(
      join(odd, 'video.m3u8'),
      playlist.replace(/^seg(\d{6})\.m4s$/gm, 'part$1.m4s')
    )
    const key = await ensureStill({
      ffmpegPath: FFMPEG,
      source: { kind: 'dir', dir: odd },
      space,
      videoId: 'vid_odd',
      atSec: 9
    })
    expect(key).equals(stillKey('vid_odd', 9))
  })

  it('goes to the Space as it lies when it is segments, and is remuxed when it is a file', async function () {
    const settings = { space, ffmpegPath: FFMPEG }
    const library = (id: string): Parameters<typeof migrateOne>[0] => ({
      id,
      title: id,
      kind: 'program',
      storage: 'local',
      gameId,
      startAt: null,
      startAtSource: null,
      numCameras: 1
    })
    for (const id of ['vid_finished', 'vid_single']) {
      await migrateOne(library(id), root, databaseUrl, settings)
      const row = await db!
        .selectFrom('videos')
        .select(['storage', 'space_secret'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.storage, id).equals('spaces')
      const prefix = `videos/${id}-${row.space_secret}/`
      const names = (await listSpaceObjects(space, prefix))
        .map(key => key.slice(prefix.length))
        .sort((a, b) => a.localeCompare(b))
      expect(names, id).does.not.contain('video.mp4')
      expect(names, id).contains('init.mp4')
      expect(names, id).contains('seg000000.m4s')
      if (id === 'vid_finished') {
        // Exactly the recording's own files: nothing was remuxed.
        expect(names).deep.equals(
          (await readdir(join(videos(id), 'recording'))).sort((a, b) =>
            a.localeCompare(b)
          )
        )
      }
    }
  })
})
