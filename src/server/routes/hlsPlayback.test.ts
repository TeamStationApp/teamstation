import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { startFakeSpace } from '../dev/fakeSpace'
import { createLiveStream } from '../live/streamKeys'
import type { MediaContext } from '../media/mediaContext'
import { signQueryToken } from '../media/mediaTokens'
import { mediaRoutes } from './media'

const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nindex.m3u8\n'
const index = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg000000.m4s\n'

describe('playback through an API node without media files', function () {
  this.timeout(60000)
  let f: GroupFixture
  let root: string
  let media: MediaContext
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  const reads: string[] = []
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsHlsPlayback-'))
    f = await groupFixture(undefined, undefined, (app, fixture) => {
      media = fixture.media
      media.mediaRoot = join(root, 'viewer')
      app.use('/api/v1', mediaRoutes(fixture.db, media))
    })
    store = await startFakeSpace({ space: f.h.space, dir: join(root, 'space') })
    f.h.space.endpoint = store.url
    store.server.on('request', req => {
      if (req.method === 'GET') reads.push(req.url!.split('?')[0])
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
    for (const [id, kind] of [
      ['vid_live', 'live'],
      ['vid_upload', 'program'],
      ['vid_missing', 'live']
    ] as const) {
      await f.h.db
        .insertInto('videos')
        .values({
          id,
          title: 'Demo recording',
          game_id: 'gam_origin',
          kind,
          status: 'ready',
          storage: 'spaces'
        })
        .execute()
    }
    await put('vid_live', 'master.m3u8', master)
    await put('vid_live', 'index.m3u8', index)
    await put('vid_live', 'init.mp4', 'init')
    await put('vid_live', 'seg000000.m4s', 'fragment')
    await put(
      'vid_upload',
      'master.m3u8',
      master.replace('index.m3u8', 'video.m3u8')
    )
    await put(
      'vid_upload',
      'video.m3u8',
      '#EXTM3U\n#EXT-X-MAP:URI="video.mp4",BYTERANGE="4@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:8@4\nvideo.mp4\n#EXT-X-ENDLIST\n'
    )
  })
  after(async () => {
    store?.server.close()
    await f?.h.close()
    await rm(root, { recursive: true, force: true })
  })
  async function put(video: string, file: string, body: string): Promise<void> {
    const dir = join(root, 'space/videos', video)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), body)
  }
  const hls = async (
    id: string,
    file: string,
    token = signQueryToken(media.mediaSecret, `hls:${id}`)
  ): Promise<Response> =>
    await f.h.request(
      'GET',
      `/videos/${id}/hls/${file}?t=${token}`,
      undefined,
      null
    )

  it('gives live viewers the media playlist and uploaded recordings their master', async () => {
    for (const [id, file] of [
      ['vid_live', 'index.m3u8'],
      ['vid_upload', 'master.m3u8']
    ]) {
      const response = await f.h.request(
        'GET',
        `/videos/${id}/playback`,
        undefined,
        105
      )
      expect(response.status).equals(200)
      const body = await response.json()
      expect(body.url).contains(`/hls/${file}?t=`)
      expect(body.unavailable).equals(false)
    }
    const live = await hls('vid_live', 'index.m3u8')
    expect(live.status).equals(200)
    expect(live.headers.get('cache-control')).equals('private, max-age=1')
    const body = await live.text()
    const fragment = body.split('\n').find(line => line.startsWith('http'))!
    expect(await (await fetch(fragment)).text()).equals('fragment')
    const variant = await (await hls('vid_live', 'master.m3u8')).text()
    expect(variant).contains('/hls/index.m3u8?t=')
    const uploaded = await (await hls('vid_upload', 'master.m3u8')).text()
    expect(uploaded).contains('/hls/video.m3u8?t=')
    const ranges = await (await hls('vid_upload', 'video.m3u8')).text()
    expect(ranges).contains('#EXT-X-BYTERANGE:8@4')
    expect(ranges).contains('/video.mp4?X-Amz-')
  })

  it('refreshes a grace close and then caches the verified final body', async () => {
    await put('vid_live', 'index.m3u8', index + '#EXT-X-ENDLIST\n')
    await new Promise(resolve => setTimeout(resolve, 1050))
    const closed = await hls('vid_live', 'index.m3u8')
    expect(closed.headers.get('cache-control')).equals('private, max-age=1')
    expect(await closed.text()).contains('#EXT-X-ENDLIST')
    await put('vid_live', 'index.m3u8', index + '#EXTINF:4,\nseg000001.m4s\n')
    await new Promise(resolve => setTimeout(resolve, 1050))
    reads.length = 0
    const replies = await Promise.all(
      Array.from(
        { length: 8 },
        async () => await (await hls('vid_live', 'index.m3u8')).text()
      )
    )
    expect(new Set(replies).size).equals(1)
    expect(replies[0]).contains('seg000001.m4s?')
    expect(replies[0]).not.contains('#EXT-X-ENDLIST')
    expect(reads.filter(path => path.endsWith('/index.m3u8'))).length(1)
    await put('vid_live', 'index.m3u8', index + '#EXT-X-ENDLIST\n')
    await f.h.db
      .updateTable('videos')
      .set({ spaces_verified_at: new Date() })
      .where('id', '=', 'vid_live')
      .execute()
    const final = await hls('vid_live', 'index.m3u8')
    expect(final.headers.get('cache-control')).equals('private, max-age=3600')
    const finalBody = await final.text()
    expect(finalBody).contains('#EXT-X-ENDLIST')
    reads.length = 0
    expect(await (await hls('vid_live', 'index.m3u8')).text()).equals(finalBody)
    expect(reads).length(0)
  })

  it('checks tokens and current visibility before returning cached playlists', async () => {
    expect((await hls('vid_live', 'index.m3u8', 'invalid')).status).equals(403)
    expect((await hls('vid_live', 'anything.m3u8')).status).equals(404)
    expect((await hls('vid_gone', 'index.m3u8')).status).equals(404)
    expect((await hls('vid_missing', 'index.m3u8')).status).equals(404)
    await put('vid_missing', 'master.m3u8', '#EXTM3U\nunsupported.m3u8\n')
    expect((await hls('vid_missing', 'master.m3u8')).status).equals(404)
    await f.h.db
      .updateTable('videos')
      .set({ hidden: true })
      .where('id', '=', 'vid_live')
      .execute()
    expect((await hls('vid_live', 'index.m3u8')).status).equals(404)
    expect(
      (await f.h.request('GET', '/videos/vid_live/playback', undefined, 105))
        .status
    ).equals(404)
    await f.h.db
      .updateTable('videos')
      .set({ hidden: false })
      .where('id', '=', 'vid_live')
      .execute()
    const bucket = media.space.bucket
    media.space.bucket = ''
    expect((await hls('vid_live', 'index.m3u8')).status).equals(404)
    media.space.bucket = bucket
  })

  it('withholds local live playback through finish until publication, preserving the no-Space path', async () => {
    const stream = await createLiveStream(f.h.db, {
      gameId: 'gam_origin',
      teamId: f.teamA,
      userId: userIdOfGumbo(101),
      slot: 1,
      startAt: new Date(),
      videoTitle: 'Demo camera',
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 0,
        app: 'live',
        segmentSeconds: 1,
        freeDiskFloorGb: 1
      },
      sessionSecret: 'synthetic-test-secret'
    })
    const row = await f.h.db
      .selectFrom('live_streams')
      .select('video_id')
      .where('id', '=', stream.id)
      .executeTakeFirstOrThrow()
    const id = row.video_id!
    await f.h.db
      .updateTable('videos')
      .set({ hidden: false, status: 'live' })
      .where('id', '=', id)
      .execute()
    const dir = join(media.mediaRoot, 'work/videos', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'master.m3u8'), index)
    const request = async (): Promise<any> =>
      await (
        await f.h.request('GET', `/videos/${id}/playback`, undefined, 105)
      ).json()
    expect((await request()).unavailable).equals(true)
    expect((await hls(id, 'index.m3u8')).status).equals(404)
    const bucket = media.space.bucket
    media.space.bucket = ''
    expect((await request()).url).contains('/media/')
    media.space.bucket = bucket
    await f.h.db
      .updateTable('live_streams')
      .set({ ended_at: new Date() })
      .where('id', '=', stream.id)
      .execute()
    await f.h.db
      .updateTable('videos')
      .set({ status: 'ready' })
      .where('id', '=', id)
      .execute()
    expect(await request()).includes({
      url: null,
      unavailable: true,
      pending: true
    })
  })
})
