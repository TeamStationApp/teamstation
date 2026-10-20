import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { setScopeRoles } from '../invites/people'
import {
  beganPublishing,
  type LiveControllerOptions,
  resolveKey,
  settleLiveWork,
  sync
} from '../live/controller'
import {
  attachSessionForTest,
  configureIngest,
  liveKeys,
  resetForTest,
  setLive
} from '../live/splitter'
import { createLiveStream } from '../live/streamKeys'

const run = promisify(execFile)
describe('revoked streams retain and finalize actual recordings', function () {
  this.timeout(120000)
  let f: GroupFixture
  let root: string
  let options: LiveControllerOptions
  beforeEach(async () => {
    f = await groupFixture()
    root = await mkdtemp(join(tmpdir(), 'tsRevokedRecording-'))
    options = {
      db: f.h.db,
      mediaRoot: root,
      workDir: join(root, 'work'),
      ffmpegPath: process.env.TS_FFMPEG ?? 'ffmpeg',
      sessionSecret: 'synthetic-recording-secret',
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
        id: 'gam_demo_recorded_revocation',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
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
  })
  afterEach(async () => {
    await settleLiveWork()
    resetForTest()
    await f?.h.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const mode of [
    'suspended',
    'cold-role-loss',
    'sync-role-loss'
  ] as const) {
    it(`disconnects and retains a playable uploaded recording after ${mode}, with the key permanently revoked`, async () => {
      const stream = await createLiveStream(f.h.db, {
        gameId: 'gam_demo_recorded_revocation',
        teamId: f.teamA,
        userId: userIdOfGumbo(106),
        slot: 1,
        startAt: new Date(),
        videoTitle: 'Demo retained recording',
        live: options.live,
        sessionSecret: options.sessionSecret
      })
      const spec = await resolveKey(stream.key, options)
      expect(typeof spec).equals('object')
      if (spec == null || typeof spec === 'string')
        throw new Error('Expected stream specification')
      setLive(stream.key, spec)
      let closed = false
      attachSessionForTest(stream.key, {
        id: 'demo-retained-session',
        close: () => {
          closed = true
        }
      })
      await beganPublishing(options, stream.id)
      await mkdir(spec.hlsDir, { recursive: true })
      await run(options.ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=10:duration=2',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'log-level=none',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '10',
        '-f',
        'hls',
        '-hls_time',
        '1',
        '-hls_playlist_type',
        'event',
        '-hls_segment_type',
        'fmp4',
        '-hls_flags',
        'omit_endlist',
        join(spec.hlsDir, 'master.m3u8')
      ])
      expect(
        (await readFile(join(spec.hlsDir, 'master.m3u8'), 'utf8')).includes(
          '#EXT-X-ENDLIST'
        )
      ).equals(false)
      if (mode === 'suspended')
        await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
          suspended: true
        })
      else {
        await setScopeRoles(
          f.h.db,
          'team',
          f.teamA,
          userIdOfGumbo(106),
          { admin: false, flags: [] },
          userIdOfGumbo(101)
        )
        if (mode === 'cold-role-loss')
          expect(typeof (await resolveKey(stream.key, options))).equals(
            'string'
          )
      }
      await Promise.all([sync(options), sync(options)])
      expect(closed).equals(true)
      expect(liveKeys()).not.includes(stream.key)
      const revoked = await f.h.db
        .selectFrom('live_streams')
        .select(['state', 'ended_at'])
        .where('id', '=', stream.id)
        .executeTakeFirstOrThrow()
      expect(revoked.state).equals('revoked')
      expect(revoked.ended_at).not.equals(null)
      expect(typeof (await resolveKey(stream.key, options))).equals('string')
      const retained = await f.h.db
        .selectFrom('videos')
        .select(['status', 'hidden', 'duration_sec'])
        .where('id', '=', stream.videoId!)
        .executeTakeFirstOrThrow()
      expect(retained.status).equals('ready')
      expect(retained.hidden).equals(false)
      expect(retained.duration_sec ?? 0).greaterThan(1.5)
      expect(await readFile(join(spec.hlsDir, 'master.m3u8'), 'utf8')).includes(
        '#EXT-X-ENDLIST'
      )
      await settleLiveWork()
      expect((await stat(join(spec.hlsDir, 'video.mp4'))).size).greaterThan(0)
      const uploaded = await f.h.db
        .selectFrom('videos')
        .select(['status', 'storage', 'spaces_verified_at'])
        .where('id', '=', stream.videoId!)
        .executeTakeFirstOrThrow()
      expect(uploaded).includes({ status: 'ready', storage: 'spaces' })
      expect(uploaded.spaces_verified_at).not.equals(null)
      expect(
        [...f.h.objects.keys()].some(
          key => key.includes(stream.videoId!) && key.endsWith('/video.mp4')
        )
      ).equals(true)
      const detail = await f.h.request(
        'GET',
        '/games/gam_demo_recorded_revocation',
        undefined,
        101
      )
      expect(detail.status).equals(200)
      const body = (await detail.json()) as {
        videos: Array<{ id: string; status: string }>
      }
      expect(
        body.videos.find(video => video.id === stream.videoId)?.status
      ).equals('ready')
      const before = await f.h.db
        .selectFrom('videos')
        .selectAll()
        .where('id', '=', stream.videoId!)
        .executeTakeFirstOrThrow()
      await sync(options)
      await settleLiveWork()
      expect(
        await f.h.db
          .selectFrom('videos')
          .selectAll()
          .where('id', '=', stream.videoId!)
          .executeTakeFirstOrThrow()
      ).deep.equals(before)
    })
  }
})
