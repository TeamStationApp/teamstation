import { readdir } from 'node:fs/promises'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { putObject } from '../media/images'
import { listSpaceObjects } from '../media/spacesVideo'
import { videoPrefix } from '../media/videoPrefix'
import {
  drainLiveController,
  drainPublishForTest,
  finishStream,
  queueLiveWorkForTest,
  startLiveController,
  stopLiveController
} from './controller'
import { originFixture } from './originFixtures'
import { createLiveStream } from './streamKeys'

/** M5: where a live video's objects go, by the secret its row holds. */
describe('a live origin under its secret path', function () {
  this.timeout(60000)
  let f: Awaited<ReturnType<typeof originFixture>>
  beforeEach(async () => {
    f = await originFixture()
  })
  afterEach(async () => {
    await f?.close()
  })
  const plain = (key: string): string =>
    `${f.store.url}/${f.f.h.space.bucket}/${key}`
  const secretOf = async (): Promise<string | null | undefined> =>
    (await f.row())?.space_secret
  /** As a row from before the migration: no secret. */
  const forgetSecret = async (): Promise<void> => {
    await f.f.h.db
      .updateTable('videos')
      .set({ space_secret: null })
      .where('id', '=', f.videoId)
      .execute()
  }

  it('gives every stream key’s video a secret of its own, before any publish', async () => {
    expect(f.spaceSecret).matches(/^[0-9a-f]{32}$/)
    const other = await createLiveStream(f.f.h.db, {
      gameId: 'gam_origin',
      teamId: f.f.teamA,
      userId: userIdOfGumbo(106),
      slot: 2,
      startAt: new Date(),
      videoTitle: 'Demo camera',
      live: f.options.live,
      sessionSecret: f.options.sessionSecret
    })
    const row = await f.f.h.db
      .selectFrom('live_streams')
      .innerJoin('videos', 'videos.id', 'live_streams.video_id')
      .select('videos.space_secret')
      .where('live_streams.id', '=', other.id)
      .executeTakeFirstOrThrow()
    expect(row.space_secret).matches(/^[0-9a-f]{32}$/)
    expect(row.space_secret).not.equals(f.spaceSecret)
  })

  it('publishes under the secret path: pieces public, playlists private, nothing on the old path', async () => {
    await f.stage(3)
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('spaces')
    expect(await secretOf(), 'onFirstSegment leaves it').equals(f.spaceSecret)
    const keys = await listSpaceObjects(f.f.h.space, f.prefix)
    expect(keys).includes(`${f.prefix}init.mp4`)
    expect(keys).includes(`${f.prefix}index.m3u8`)
    expect(
      await listSpaceObjects(f.f.h.space, `videos/${f.videoId}/`)
    ).deep.equals([])
    const piece = keys.find(key => key.endsWith('.m4s'))!
    const unsigned = await fetch(plain(piece))
    expect(unsigned.status).equals(200)
    expect(unsigned.headers.get('cache-control')).equals('public, max-age=600')
    expect((await fetch(plain(`${f.prefix}index.m3u8`))).status).equals(403)
  })

  it('gives a row from before secrets one before its origin starts, when its old prefix holds no media', async () => {
    await forgetSecret()
    // Stills stay on the old path whatever the secret, so they do not count.
    await putObject({
      space: f.f.h.space,
      key: `videos/${f.videoId}/stills/3.jpg`,
      body: Buffer.from('a still'),
      contentType: 'image/jpeg'
    })
    await f.stage(3)
    await f.begin()
    await drainPublishForTest(f.videoId)
    const filled = await secretOf()
    expect(filled).matches(/^[0-9a-f]{32}$/)
    const prefix = videoPrefix({ id: f.videoId, spaceSecret: filled! })
    expect(await listSpaceObjects(f.f.h.space, prefix)).includes(
      `${prefix}index.m3u8`
    )
    expect(
      await listSpaceObjects(f.f.h.space, `videos/${f.videoId}/`)
    ).deep.equals([`videos/${f.videoId}/stills/3.jpg`])
  })

  it('keeps a row from before secrets on its old path when the Space does not answer the listing in time', async () => {
    await forgetSecret()
    f.options.listTimeoutMs = 200
    // The listing of its old prefix hangs, as a stalled Space does.
    f.store.faults.set({ method: 'GET', key: /^$/, delayMs: 3000, times: 1 })
    await f.stage(3)
    const started = Date.now()
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect(Date.now() - started).below(2500)
    expect(await secretOf()).equals(null)
    expect(
      await listSpaceObjects(f.f.h.space, `videos/${f.videoId}/`)
    ).includes(`videos/${f.videoId}/index.m3u8`)
  })

  it('keeps a row with objects on its old path there, private, with no secret', async () => {
    await forgetSecret()
    const sent: Array<string | undefined> = []
    f.store.server.on('request', req => {
      if (req.method === 'PUT')
        sent.push(
          (req.headers['x-amz-acl'] as string | undefined) ??
            req.headers['cache-control']
        )
    })
    // What an origin publishing before the deploy left there.
    await putObject({
      space: f.f.h.space,
      key: `videos/${f.videoId}/master.m3u8`,
      body: Buffer.from('#EXTM3U\n'),
      contentType: 'application/vnd.apple.mpegurl'
    })
    await f.stage(3)
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect(await secretOf()).equals(null)
    expect((await f.row())?.storage).equals('spaces')
    const keys = await listSpaceObjects(f.f.h.space, `videos/${f.videoId}/`)
    expect(keys).includes(`videos/${f.videoId}/index.m3u8`)
    expect(sent.length).greaterThan(1)
    expect(sent.every(header => header == null)).equals(true)
    const piece = keys.find(key => key.endsWith('.m4s'))!
    expect((await fetch(plain(piece))).status).equals(403)
    expect(
      (await listSpaceObjects(f.f.h.space, `videos/${f.videoId}-`)).length
    ).equals(0)
  })

  it('restores an origin after a restart under the row’s secret, filling one only for an empty old prefix', async () => {
    await forgetSecret()
    await f.stage(3)
    expect(await startLiveController(f.options)).equals(true)
    try {
      await drainPublishForTest(f.videoId)
      const filled = await secretOf()
      expect(filled).matches(/^[0-9a-f]{32}$/)
      const prefix = videoPrefix({ id: f.videoId, spaceSecret: filled! })
      expect(await listSpaceObjects(f.f.h.space, prefix)).includes(
        `${prefix}init.mp4`
      )
    } finally {
      stopLiveController()
      await drainLiveController()
    }
  })

  it('removes a deleted video’s secret prefix by listing when no origin holds its secret', async () => {
    await f.stage(3)
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect(await f.objects()).not.deep.equals([])
    // A restart: nothing is held, and the close finds the row gone.
    stopLiveController()
    await drainLiveController()
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    queueLiveWorkForTest(`publish:${f.videoId}`, async () => {
      await blocked
    })
    try {
      await finishStream(f.options, f.stream.id, 'Finished')
      await f.f.h.db.deleteFrom('videos').where('id', '=', f.videoId).execute()
    } finally {
      release()
    }
    await drainPublishForTest(f.videoId)
    expect(await f.objects()).deep.equals([])
    expect(await readdir(f.remoteDir)).deep.equals([])
  })
})
