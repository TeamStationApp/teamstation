import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Selectable } from 'kysely'

import { userIdOfGumbo } from '../../common/userId'
import { groupFixture } from '../../test/groupFixtures'
import type { VideosTable } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import { setScopeRoles } from '../invites/people'
import type { MediaContext } from '../media/mediaContext'
import { mediaRoutes } from '../routes/media'
import {
  beganPublishing,
  drainLiveController,
  type LiveControllerOptions,
  liveVideoDir,
  stopLiveController
} from './controller'
import { configureIngest, resetForTest } from './splitter'
import { createLiveStream } from './streamKeys'

export interface OriginFixture {
  f: Awaited<ReturnType<typeof groupFixture>>
  root: string
  remote: string
  store: Awaited<ReturnType<typeof startFakeSpace>>
  requests: Array<{ method: string; key: string; range?: string }>
  options: LiveControllerOptions
  media: MediaContext
  stream: Awaited<ReturnType<typeof createLiveStream>>
  videoId: string
  dir: string
  stage: (seconds?: number) => Promise<void>
  begin: () => Promise<void>
  row: () => Promise<Selectable<VideosTable> | undefined>
  body: () => Promise<string>
  close: () => Promise<void>
}
export async function originFixture(): Promise<OriginFixture> {
  const root = await mkdtemp(join(tmpdir(), 'tsOriginLive-'))
  let mediaContext!: MediaContext
  const f = await groupFixture(undefined, undefined, (app, { db, media }) => {
    media.mediaRoot = join(root, 'empty-viewer')
    mediaContext = media
    app.use('/api/v1', mediaRoutes(db, media))
  })
  const remote = join(root, 'space')
  const store = await startFakeSpace({ space: f.h.space, dir: remote })
  f.h.space.endpoint = store.url
  const requests: Array<{ method: string; key: string; range?: string }> = []
  store.server.on('request', req =>
    requests.push({
      method: req.method!,
      key: new URL(req.url!, store.url).pathname.split('/').slice(2).join('/'),
      range: req.headers.range
    })
  )
  const options: LiveControllerOptions = {
    db: f.h.db,
    mediaRoot: root,
    workDir: join(root, 'work'),
    ffmpegPath: process.env.TS_FFMPEG ?? 'ffmpeg',
    sessionSecret: 'synthetic-origin-secret',
    space: f.h.space,
    live: {
      enabled: true,
      bindHost: '127.0.0.1',
      port: 0,
      app: 'live',
      segmentSeconds: 1,
      freeDiskFloorGb: 1
    },
    freeBytes: async () => 1_000_000_000_000,
    log: () => {}
  }
  configureIngest({
    ...options.live,
    ffmpegPath: options.ffmpegPath,
    onEvent: () => {},
    log: () => {}
  })
  await f.h.db
    .insertInto('games')
    .values({
      id: 'gam_origin',
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      start_at: new Date()
    })
    .execute()
  await setScopeRoles(
    f.h.db,
    'team',
    f.teamA,
    userIdOfGumbo(106),
    { admin: false, flags: ['videographer'] },
    userIdOfGumbo(101)
  )
  const stream = await createLiveStream(f.h.db, {
    gameId: 'gam_origin',
    teamId: f.teamA,
    userId: userIdOfGumbo(106),
    slot: 1,
    startAt: new Date(),
    videoTitle: 'Demo camera',
    live: options.live,
    sessionSecret: options.sessionSecret
  })
  const row = await f.h.db
    .selectFrom('live_streams')
    .select('video_id')
    .where('id', '=', stream.id)
    .executeTakeFirstOrThrow()
  const videoId = row.video_id!
  const dir = liveVideoDir(root, videoId)
  const stage = async (seconds = 3): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await promisify(execFile)(options.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=160x90:rate=10:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-g',
      '10',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_playlist_type',
      'event',
      '-hls_flags',
      'omit_endlist',
      '-hls_segment_type',
      'fmp4',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'master.m3u8')
    ])
  }
  return {
    f,
    root,
    remote,
    store,
    requests,
    options,
    media: mediaContext,
    stream,
    videoId,
    dir,
    stage,
    begin: async () => {
      await beganPublishing(options, stream.id)
    },
    row: async () =>
      await f.h.db
        .selectFrom('videos')
        .selectAll()
        .where('id', '=', videoId)
        .executeTakeFirst(),
    body: async () =>
      await readFile(join(remote, 'videos', videoId, 'index.m3u8'), 'utf8'),
    close: async () => {
      stopLiveController()
      await drainLiveController()
      resetForTest()
      store.server.close()
      await f.h.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

export async function until(
  check: () => Promise<boolean>,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for live origin')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
