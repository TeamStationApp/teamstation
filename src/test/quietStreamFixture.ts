import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { userIdOfGumbo } from '../common/userId'
import {
  type LiveControllerOptions,
  liveVideoDir,
  settleLiveWork,
  stopLiveController,
  sync
} from '../server/live/controller'
import {
  configureIngest,
  LIVE_PLAYLIST_NAME,
  resetForTest
} from '../server/live/splitter'
import { createLiveStream } from '../server/live/streamKeys'
import { devMediaRoutes } from '../server/routes/devMedia'
import { mediaRoutes } from '../server/routes/media'
import type { AccountHarness } from './accountHarness'
import { creationHarness } from './creationHarness'

interface StreamInput {
  quietMs?: number
  endAgoMs?: number | null
  openedAgoMs?: number
  published?: boolean
  state?: 'idle' | 'publishing'
}
type FixtureStream = Awaited<ReturnType<typeof createLiveStream>> & {
  gameId: string
  videoId: string
  playlist: string
}
interface QuietStreamFixture {
  h: AccountHarness
  db: AccountHarness['db']
  options: LiveControllerOptions
  mediaRoot: string
  addStream: (input?: StreamInput) => Promise<FixtureStream>
  request: (path: string, method?: string) => Promise<any>
  tick: () => Promise<void>
  close: () => Promise<void>
}

const run = promisify(execFile)
const SECRET = 'quiet-stream-fixture-secret'
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const LIVE = {
  enabled: true,
  bindHost: '127.0.0.1',
  port: 0,
  app: 'live',
  segmentSeconds: 2,
  freeDiskFloorGb: 1
}

/** Real API, scratch database and real media; no production fixtures. */
export async function quietStreamFixture(
  bindHost = '127.0.0.1',
  publicOrigin?: string
): Promise<QuietStreamFixture> {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'quiet-stream-'))
  let origin = publicOrigin ?? ''
  const h = await creationHarness(
    undefined,
    undefined,
    bindHost,
    (app, { db, media }) => {
      const playback = { ...media, mediaRoot, ffmpegPath: FFMPEG }
      Object.defineProperty(playback, 'publicUrl', { get: () => origin })
      app.use('/api/v1', mediaRoutes(db, playback))
      app.use(devMediaRoutes(mediaRoot, media.mediaSecret))
    }
  )
  origin ||= h.origin
  const db = h.db
  const owner = userIdOfGumbo(101)
  await db
    .updateTable('users')
    .set({ is_admin: true })
    .where('id', '=', owner)
    .execute()
  await db
    .insertInto('teams')
    .values({ id: 'tem_quiet_away', name: 'Demo Owls' })
    .execute()
  configureIngest({
    ...LIVE,
    ffmpegPath: FFMPEG,
    log: () => undefined,
    onEvent: () => undefined
  })
  const options: LiveControllerOptions = {
    db,
    live: LIVE,
    ffmpegPath: FFMPEG,
    mediaRoot,
    workDir: join(mediaRoot, 'work'),
    sessionSecret: SECRET,
    freeBytes: async () => 1_000_000_000_000,
    log: () => undefined
  }
  let serial = 0
  async function addStream(input: StreamInput = {}): Promise<FixtureStream> {
    const now = Date.now()
    const gameId = `gam_quiet_${++serial}`
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: 'tem_account',
        away_team_id: 'tem_quiet_away',
        start_at: new Date(now - 3_600_000),
        home_score: 3,
        away_score: 2,
        end_at:
          input.endAgoMs === null
            ? null
            : new Date(now - (input.endAgoMs ?? 660_000))
      })
      .execute()
    const stream = await createLiveStream(db, {
      gameId,
      teamId: 'tem_account',
      startAt: new Date(now - 3_600_000),
      userId: owner,
      slot: 1,
      live: LIVE,
      sessionSecret: SECRET,
      videoTitle: 'Demo Owls at Demo Hawks'
    })
    const published = input.published !== false
    await db
      .updateTable('live_streams')
      .set({
        state: input.state ?? 'idle',
        opens_at: new Date(now - (input.openedAgoMs ?? 3_600_000)),
        first_published_at: published ? new Date(now - 3_600_000) : null,
        last_published_at: published
          ? new Date(now - (input.quietMs ?? 660_000))
          : null
      })
      .where('id', '=', stream.id)
      .execute()
    const videoId = stream.videoId!
    const dir = liveVideoDir(mediaRoot, videoId)
    const playlist = join(dir, LIVE_PLAYLIST_NAME)
    if (published) {
      await mkdir(dir, { recursive: true })
      await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30:duration=4',
        '-c:v',
        'libx264',
        '-g',
        '30',
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
        playlist
      ])
      await writeFile(
        playlist,
        (await readFile(playlist, 'utf8')).replace('#EXT-X-ENDLIST\n', '')
      )
      await db
        .updateTable('videos')
        .set({
          status: 'live',
          hidden: false,
          start_at: new Date(now - 3_600_000)
        })
        .where('id', '=', videoId)
        .execute()
    }
    return { ...stream, gameId, videoId, playlist }
  }
  async function request(path: string, method = 'GET'): Promise<any> {
    const response = await fetch(h.origin + '/api/v1' + path, {
      method,
      headers: { Authorization: `Bearer ${h.tokens.get(101)!}` }
    })
    const body = await response.json()
    if (!response.ok)
      throw new Error(
        `${method} ${path}: ${response.status} ${JSON.stringify(body)}`
      )
    return body
  }
  return {
    h,
    db,
    options,
    mediaRoot,
    addStream,
    request,
    tick: async () => {
      await sync(options)
      await settleLiveWork()
    },
    close: async () => {
      stopLiveController()
      resetForTest()
      await settleLiveWork()
      await h.close()
      await rm(mediaRoot, { recursive: true, force: true })
    }
  }
}
