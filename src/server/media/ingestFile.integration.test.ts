import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import { ffmpegEncoders, remuxToHls } from './ffmpeg'
import { ingestVideoFile, probeVideoFile } from './ingestFile'
import { presignGetUrl } from './presign'
import type { SpaceSettings } from './spacesHls'
import { listSpaceObjectEntries } from './spacesVideo'
import { boxesInFile, readFragment, readTracks } from './trackStarts'
import { videoPrefix } from './videoPrefix'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

describe('a remux of sound whose priming is undeclared, through real ffmpeg', function () {
  this.timeout(60_000)
  let dir = ''
  let file = ''

  before(async function () {
    let encoders: Set<string>
    try {
      encoders = await ffmpegEncoders(FFMPEG)
    } catch {
      this.skip()
      return
    }
    if (!encoders.has('libx264') || !encoders.has('aac')) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsPriming-'))
    // AAC carried as ADTS declares no priming, so muxed into a .mov it
    // arrives the way TS Director's and TS Distributor's files do.
    const adts = join(dir, 'sound.aac')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=3',
      '-c:a',
      'aac',
      '-f',
      'adts',
      adts
    ])
    file = join(dir, 'take.mov')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=3',
      '-i',
      adts,
      '-c:v',
      'libx264',
      '-bf',
      '0',
      '-c:a',
      'copy',
      file
    ])
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  /** How far the sound's first fragment starts after the picture's. */
  async function soundAfterPicture(outDir: string): Promise<number> {
    const path = join(outDir, 'video.mp4')
    let tracks = readTracks(Buffer.alloc(0))
    for await (const moov of boxesInFile(path, 'moov'))
      tracks = readTracks(moov)
    for await (const moof of boxesInFile(path, 'moof')) {
      const runs = readFragment(moof, tracks)
      const picture = runs.find(one => one.kind === 'video')
      const sound = runs.find(one => one.kind === 'audio')
      if (picture != null && sound != null) {
        return sound.startSec - picture.startSec
      }
    }
    throw new Error('no fragment carried both')
  }

  it('starts the real sound with the picture', async function () {
    const probed = await probeVideoFile(FFMPEG, file)
    expect(probed.soundPrimingSamples).equals(2112)

    const asIs = join(dir, 'asIs')
    await mkdir(asIs)
    await remuxToHls(FFMPEG, { input: file, outDir: asIs, videoTag: null })
    const honoured = join(dir, 'honoured')
    await mkdir(honoured)
    await remuxToHls(FFMPEG, {
      input: file,
      outDir: honoured,
      videoTag: null,
      soundPrimingSamples: probed.soundPrimingSamples
    })

    expect(await soundAfterPicture(asIs)).closeTo(0, 0.0001)
    // The priming now plays before the first picture, so the first real
    // sample is with it.
    expect(await soundAfterPicture(honoured)).closeTo(-2112 / 48000, 0.0001)
    expect(await readFile(join(honoured, 'video.m3u8'), 'utf8')).contains(
      '#EXT-X-ENDLIST'
    )
  })
})

describe('what has to name an ingested video, in the commit that writes it', function () {
  this.timeout(120000)

  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined
  let store: Awaited<ReturnType<typeof startFakeSpace>> | undefined
  let dir = ''
  let gameId = ''
  const space: SpaceSettings = {
    bucket: 'test',
    region: 'sfo3',
    endpoint: '',
    accessKeyId: 'k',
    secretAccessKey: 's',
    pathStyle: true
  }

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsIngestNamed-'))
    await run(FFMPEG, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'take.mp4')
    ])
    ;({ db, drop } = await scratchDatabase('ingest_named'))
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date()
    })
    store = await startFakeSpace({ space, dir: join(dir, 'space') })
    space.endpoint = store.url
  })

  after(async function () {
    if (store != null) {
      await new Promise<void>(resolve =>
        store!.server.close(() => {
          resolve()
        })
      )
    }
    await drop?.()
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  const ingest = async (
    videoId: string,
    onWritten: NonNullable<Parameters<typeof ingestVideoFile>[0]['onWritten']>
  ): Promise<string> =>
    (
      await ingestVideoFile({
        db: db!,
        space,
        ffmpegPath: FFMPEG,
        file: join(dir, 'take.mp4'),
        gameId,
        kind: 'program',
        title: 'Programme',
        startAt: new Date(),
        startAtSource: 'distributor',
        videoId,
        onWritten
      })
    ).videoId

  /** The video's objects in the fake Space: its files, not its folders. */
  const objects = async (videoId: string): Promise<string[]> => {
    const entries = await readdir(join(dir, 'space', 'videos', videoId), {
      recursive: true,
      withFileTypes: true
    }).catch(() => [])
    return entries
      .filter(entry => entry.isFile() && !entry.name.endsWith('.content-type'))
      .map(entry => entry.name)
  }

  it('runs inside the transaction that writes the video, and commits with it', async function () {
    const videoId = makeId('video')
    let inside: string | undefined
    let outside: string | undefined
    await ingest(videoId, async (trx, written) => {
      inside = (
        await trx
          .selectFrom('videos')
          .select('id')
          .where('id', '=', written)
          .executeTakeFirst()
      )?.id
      // Not yet committed: nobody else sees the video before what names it.
      outside = (
        await db!
          .selectFrom('videos')
          .select('id')
          .where('id', '=', written)
          .executeTakeFirst()
      )?.id
      await trx
        .updateTable('videos')
        .set({ title: 'Named in the same commit' })
        .where('id', '=', written)
        .execute()
    })
    expect(inside).equals(videoId)
    expect(outside).equals(undefined)
    const row = await db!
      .selectFrom('videos')
      .select('title')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow()
    expect(row.title).equals('Named in the same commit')
  })

  it('writes no video, and leaves none of it in the Space, when it fails', async function () {
    const videoId = makeId('video')
    let failure: unknown
    try {
      await ingest(videoId, async () => {
        throw new Error('nothing could name it')
      })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).contains('nothing could name it')
    const row = await db!
      .selectFrom('videos')
      .select('id')
      .where('id', '=', videoId)
      .executeTakeFirst()
    expect(row).equals(undefined)
    expect(await objects(videoId)).deep.equals([])
  })
})

describe('an ingested take in the Space, segmented', function () {
  this.timeout(120000)

  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined
  let store: Awaited<ReturnType<typeof startFakeSpace>> | undefined
  let dir = ''
  let gameId = ''
  const space: SpaceSettings = {
    bucket: 'test',
    region: 'sfo3',
    endpoint: '',
    accessKeyId: 'k',
    secretAccessKey: 's',
    pathStyle: true
  }

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsIngestSegmented-'))
    // Twenty seconds at a keyframe a second: four segments.
    await run(FFMPEG, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=20:size=320x240:rate=30',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'take.mp4')
    ])
    ;({ db, drop } = await scratchDatabase('ingest_segmented'))
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date()
    })
    store = await startFakeSpace({ space, dir: join(dir, 'space') })
    space.endpoint = store.url
  })

  after(async function () {
    if (store != null) {
      await new Promise<void>(resolve =>
        store!.server.close(() => {
          resolve()
        })
      )
    }
    await drop?.()
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  afterEach(function () {
    store?.faults.clear()
  })

  const ingest = async (videoId: string): Promise<void> => {
    await ingestVideoFile({
      db: db!,
      space,
      ffmpegPath: FFMPEG,
      file: join(dir, 'take.mp4'),
      gameId,
      kind: 'program',
      title: 'Programme',
      startAt: new Date(),
      startAtSource: 'distributor',
      videoId,
      log: () => {}
    })
  }

  /** Every object of the video, under any of its prefixes, with its size. */
  const objects = async (
    videoId: string
  ): Promise<Array<{ name: string; size: number }>> =>
    (await listSpaceObjectEntries(space, `videos/${videoId}`)).map(entry => ({
      name: entry.key.split('/').slice(-1)[0],
      size: entry.size
    }))

  it('holds the playlists, init.mp4 and its segments, and no single file', async function () {
    const videoId = makeId('video')
    await ingest(videoId)
    const found = await objects(videoId)
    const names = found.map(object => object.name).sort()
    const segments = names.filter(name => /^seg\d{6}\.m4s$/.test(name))
    expect(segments).deep.equals(
      segments.map((_, i) => `seg${String(i).padStart(6, '0')}.m4s`)
    )
    expect(segments.length).greaterThanOrEqual(3)
    expect(names).deep.equals(
      ['init.mp4', 'master.m3u8', ...segments, 'video.m3u8'].sort()
    )
    expect(names).does.not.contain('video.mp4')

    // The row's size is what the Space holds for it.
    const row = await db!
      .selectFrom('videos')
      .select(['size_bytes', 'duration_sec', 'space_secret'])
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow()
    expect(Number(row.size_bytes)).equals(
      found.reduce((sum, object) => sum + object.size, 0)
    )
    expect(row.duration_sec).equals(20)
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: `${videoPrefix({ id: videoId, spaceSecret: row.space_secret })}video.m3u8`,
        expiresSec: 60
      })
    )
    expect(response.status).equals(200)
    const playlist = await response.text()
    expect(playlist).contains('#EXT-X-MAP:URI="init.mp4"')
    expect(playlist).contains('seg000000.m4s')
    expect(playlist).does.not.contain('BYTERANGE')
  })

  it('leaves the Space empty when a put fails after the third', async function () {
    const videoId = makeId('video')
    // The fourth object to go up, in upload order: init.mp4, then segments.
    store!.faults.set({ method: 'PUT', key: /seg000002\.m4s$/, status: 500 })
    let failure: unknown
    try {
      await ingest(videoId)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).contains('500')
    expect(await objects(videoId)).deep.equals([])
    const row = await db!
      .selectFrom('videos')
      .select('id')
      .where('id', '=', videoId)
      .executeTakeFirst()
    expect(row).equals(undefined)
  })
})
