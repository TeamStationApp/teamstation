import * as files from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  encodeFragmented,
  stampFile,
  writeLive
} from '../../test/wallClockFixtures'
import { parseMediaPlaylist, readRecordingStamps } from '../media/wallClockScan'
import {
  drainLiveController,
  drainPublishForTest,
  finishStream,
  queueLiveWorkForTest,
  RECONNECT_GRACE_MS,
  stopLiveController,
  sweepLocalCopies,
  sync
} from './controller'
import * as finishVideo from './finishVideo'
import { originFixture, until } from './originFixtures'
import { placeSegmentOnTimeline } from './segmentClock'
import { configureIngest, forcePublishForTest, writerForTest } from './splitter'

describe('closing a live Space origin', function () {
  this.timeout(60000)
  let f: Awaited<ReturnType<typeof originFixture>>
  beforeEach(async () => {
    f = await originFixture()
  })
  afterEach(async () => {
    await f?.close()
  })

  async function published(seconds = 3): Promise<void> {
    await f.stage(seconds)
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('spaces')
  }
  async function finish(): Promise<void> {
    await finishStream(f.options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
  }
  async function retry(): Promise<void> {
    await f.f.h.db
      .updateTable('videos')
      .set({ updated_at: new Date(Date.now() - 3600000) })
      .where('id', '=', f.videoId)
      .execute()
    await sweepLocalCopies(f.options)
    await drainPublishForTest(f.videoId)
  }

  it('closes the same objects, drains more than one scan batch, and removes scratch after verification', async () => {
    await published(12)
    f.requests.length = 0
    await finish()
    const row = await f.row()
    expect(row?.spaces_verified_at).not.equals(null)
    expect(row?.local_delete_after).equals(null)
    expect(row?.status).equals('ready')
    expect(await f.body()).contains('#EXT-X-ENDLIST')
    expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
    const names = await files.readdir(join(f.remote, 'videos', f.videoId))
    expect(names).not.contains('video.mp4')
    const stills = await files.readdir(
      join(f.remote, 'videos', f.videoId, 'stills')
    )
    expect(stills.some(name => name.endsWith('.jpg'))).equals(true)
    expect(
      f.requests.filter(r => r.method === 'PUT' && r.key.endsWith('.m4s'))
    ).length(0)
    const anchors = await f.f.h.db
      .selectFrom('video_wall_anchors')
      .select('media_ms')
      .where('video_id', '=', f.videoId)
      .orderBy('media_ms')
      .execute()
    expect(anchors).length(12)
    expect(anchors.at(-1)?.media_ms).equals(11000)
    console.log(
      'closed playlist:',
      await f.body(),
      'objects:',
      names,
      'scratch removed:',
      true
    )
  })

  for (const fault of ['put', 'read', 'different'] as const) {
    it(`retains scratch when the ${fault} close fails and retries after restart`, async () => {
      await published()
      f.store.faults.set(
        fault === 'put'
          ? { method: 'PUT', key: /index\.m3u8$/, status: 503 }
          : fault === 'read'
            ? { method: 'GET', key: /index\.m3u8$/, status: 503 }
            : {
                method: 'GET',
                key: /index\.m3u8$/,
                readBack: Buffer.from('#EXTM3U\n')
              }
      )
      await finish()
      expect((await f.row())?.spaces_verified_at).equals(null)
      expect((await f.row())?.status_message).equals(
        'Not yet copied off this machine'
      )
      expect((await files.stat(f.dir)).isDirectory()).equals(true)
      console.log('failed close:', (await f.row())?.status_message)
      stopLiveController()
      await drainLiveController()
      f.store.faults.clear()
      await retry()
      expect((await f.row())?.spaces_verified_at).not.equals(null)
      expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
      expect(await f.body()).contains('#EXT-X-ENDLIST')
      console.log('retried close:', await f.body())
    })
  }

  for (const phase of [
    'queued close',
    'finish',
    'retry',
    'sweep',
    'sync'
  ] as const) {
    it(`does not restart publication when stopped during a ${phase} query`, async () => {
      await published()
      if (phase === 'retry' || phase === 'sweep') {
        await f.f.h.db
          .updateTable('videos')
          .set({ status: 'ready', updated_at: new Date(Date.now() - 3600000) })
          .where('id', '=', f.videoId)
          .execute()
      }
      if (phase === 'sync') {
        await f.f.h.db
          .updateTable('live_streams')
          .set({ closes_at: new Date(Date.now() - 1000) })
          .where('id', '=', f.stream.id)
          .execute()
      }
      const db = f.options.db
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      let entered = false
      let paused = false
      f.options.db = db.withPlugin({
        transformQuery: ({ node }) => node,
        transformResult: async ({ result }) => {
          const retryRow = result.rows.some(row => 'streamId' in row)
          if (!paused && (phase !== 'retry' || retryRow)) {
            paused = true
            entered = true
            await blocked
          }
          return result
        }
      })
      let unblockQueue!: () => void
      let pending: Promise<void> = Promise.resolve()
      try {
        if (phase === 'queued close') {
          const queued = new Promise<void>(resolve => {
            unblockQueue = resolve
          })
          queueLiveWorkForTest(`publish:${f.videoId}`, async () => {
            await queued
          })
          // Finalization completes first; pause only the queued close's lookup.
          const finishingOptions = { ...f.options, db }
          await finishStream(finishingOptions, f.stream.id, 'Finished')
          finishingOptions.db = f.options.db
          unblockQueue()
          pending = drainPublishForTest(f.videoId)
        } else {
          pending =
            phase === 'finish'
              ? finishStream(f.options, f.stream.id, 'Finished')
              : phase === 'sync'
                ? sync(f.options)
                : sweepLocalCopies(f.options)
        }
        await until(async () => entered)
        stopLiveController()
        f.requests.length = 0
        release()
        await pending
        await drainPublishForTest(f.videoId)
        expect(f.requests.filter(request => request.method === 'PUT')).length(0)
        expect((await f.row())?.spaces_verified_at).equals(null)
        expect((await files.stat(f.dir)).isDirectory()).equals(true)
      } finally {
        release()
        unblockQueue?.()
        await pending
        f.options.db = db
      }
      // The next controller can still finish the retained recording.
      await retry()
      expect((await f.row())?.spaces_verified_at).not.equals(null)
      expect(await f.body()).contains('#EXT-X-ENDLIST')
    })
  }

  it('removes a deleted video after its origin close failed, retrying a failed prefix deletion', async () => {
    await published()
    f.store.faults.set({ method: 'PUT', key: /index\.m3u8$/, status: 503 })
    await finish()
    expect((await f.row())?.spaces_verified_at).equals(null)
    await f.f.h.db.deleteFrom('videos').where('id', '=', f.videoId).execute()
    f.store.faults.clear()
    f.store.faults.set({ method: 'DELETE', status: 503 })
    await sync(f.options)
    await drainPublishForTest(f.videoId)
    expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
    f.store.faults.clear()
    await sync(f.options)
    await drainPublishForTest(f.videoId)
    expect(
      await files.readdir(join(f.remote, 'videos', f.videoId))
    ).deep.equals([])
  })

  it('retries prefix deletion when a queued close finds its video already deleted', async () => {
    await published()
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
      f.store.faults.set({ method: 'DELETE', status: 503 })
      release()
      await drainPublishForTest(f.videoId)
      expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
      expect(
        (await files.readdir(join(f.remote, 'videos', f.videoId))).length
      ).greaterThan(0)
      f.store.faults.clear()
      await sync(f.options)
      await sweepLocalCopies(f.options)
      await drainPublishForTest(f.videoId)
      expect(
        await files.readdir(join(f.remote, 'videos', f.videoId))
      ).deep.equals([])
    } finally {
      release()
    }
  })

  it('queues a stale local retry behind the initial remux', async () => {
    await f.stage()
    f.store.faults.set({ method: 'PUT', status: 503 })
    await f.begin()
    await drainPublishForTest(f.videoId)
    const mutableFinish = finishVideo as {
      toRecording: typeof finishVideo.toRecording
    }
    const original = mutableFinish.toRecording
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    mutableFinish.toRecording = async (...args) => {
      calls++
      await blocked
      return await original(...args)
    }
    try {
      await finishStream(f.options, f.stream.id, 'Finished')
      await until(async () => calls === 1)
      await f.f.h.db
        .updateTable('videos')
        .set({ updated_at: new Date(Date.now() - 3600000) })
        .where('id', '=', f.videoId)
        .execute()
      await sweepLocalCopies(f.options)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(calls).equals(1)
      release()
      await drainPublishForTest(f.videoId)
      expect(calls).equals(1)
      expect((await files.stat(join(f.dir, 'video.mp4'))).isFile()).equals(true)
    } finally {
      release()
      await drainPublishForTest(f.videoId)
      mutableFinish.toRecording = original
    }
  })

  it('leaves durable cleanup work if removal fails after verification', async () => {
    await published()
    const mutableFiles = require('node:fs/promises') as { rm: typeof files.rm }
    const original = mutableFiles.rm
    let failed = false
    mutableFiles.rm = async (...args: Parameters<typeof files.rm>) => {
      if (args[0] === f.dir && !failed) {
        failed = true
        throw new Error('Synthetic removal failure')
      }
      await original(...args)
    }
    try {
      await finish()
    } finally {
      mutableFiles.rm = original
    }
    expect(failed).equals(true)
    expect((await f.row())?.spaces_verified_at).not.equals(null)
    expect((await f.row())?.local_delete_after).not.equals(null)
    expect((await files.stat(f.dir)).isDirectory()).equals(true)
    await sweepLocalCopies(f.options)
    expect((await f.row())?.local_delete_after).equals(null)
    expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
  })

  it('lets a first-segment acknowledgement race ready without blocking finish', async () => {
    await f.stage()
    f.store.faults.set({ method: 'PUT', key: /seg000000/, delayMs: 2500 })
    await f.begin()
    await until(async () =>
      f.requests.some(
        r => r.method === 'PUT' && r.key.endsWith('seg000000.m4s')
      )
    )
    await finishStream(f.options, f.stream.id, 'Finished')
    expect((await f.row())?.status).equals('ready')
    expect((await f.row())?.storage).equals('local')
    const viewerRoot = f.media.mediaRoot
    for (const root of [viewerRoot, f.options.mediaRoot]) {
      f.media.mediaRoot = root
      const reply = await f.f.h.request(
        'GET',
        `/videos/${f.videoId}/playback`,
        undefined,
        105
      )
      expect(await reply.json()).includes({
        url: null,
        unavailable: true,
        pending: true
      })
    }
    f.media.mediaRoot = viewerRoot
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('spaces')
    expect((await f.row())?.spaces_verified_at).not.equals(null)
    expect(await f.body()).contains('#EXT-X-ENDLIST')
    const playable = await f.f.h.request(
      'GET',
      `/videos/${f.videoId}/playback`,
      undefined,
      105
    )
    expect((await playable.json()).url).contains('/hls/index.m3u8?')
  })

  it('keeps no Space recordings on the existing local path', async () => {
    f.options.space = undefined
    await f.stage()
    await f.begin()
    await finish()
    expect((await f.row())?.storage).equals('local')
    expect((await files.stat(join(f.dir, 'video.mp4'))).isFile()).equals(true)
    expect(f.requests).length(0)
  })

  it('uses the existing recording fallback when the Space took no live fragment', async () => {
    await f.stage()
    f.store.faults.set({ method: 'PUT', status: 503 })
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('local')
    f.store.faults.clear()
    await finish()
    expect((await f.row())?.spaces_verified_at).not.equals(null)
    expect(
      await files.readFile(
        join(f.remote, 'videos', f.videoId, 'master.m3u8'),
        'utf8'
      )
    ).contains('video.m3u8')
    expect(
      (
        await files.stat(join(f.remote, 'videos', f.videoId, 'video.mp4'))
      ).isFile()
    ).equals(true)
  })

  it('reconciles settled frame clocks at close and preserves unstamped arrival spans', async () => {
    const plain = join(f.root, 'plain.mp4')
    const stamped = join(f.root, 'stamped.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 8 })
    await stampFile(plain, stamped, 1700000000000)
    await files.mkdir(f.dir, { recursive: true })
    await writeLive(stamped, f.dir, { seconds: 2 })
    await f.begin()
    await sync(f.options)
    await drainPublishForTest(f.videoId)
    await writeLive(plain, f.dir, { fromSec: 2, seconds: 2, startNumber: 2 })
    await sync(f.options)
    await writeLive(stamped, f.dir, { fromSec: 5, seconds: 2, startNumber: 4 })
    await sync(f.options)
    const init = await files.readFile(join(f.dir, 'init.mp4'))
    const playlist = parseMediaPlaylist(
      await files.readFile(join(f.dir, 'master.m3u8'), 'utf8')
    )
    for (const segment of playlist.segments.slice(4)) {
      const path = join(f.dir, segment.uri)
      await files.writeFile(
        path,
        placeSegmentOnTimeline(init, await files.readFile(path), 1.1)!
      )
    }
    const expected = await readRecordingStamps(f.dir, {
      playlistFile: 'master.m3u8'
    })
    const arrivals = await f.f.h.db
      .selectFrom('video_wall_anchors')
      .selectAll()
      .where('video_id', '=', f.videoId)
      .where('source', '=', 'arrival')
      .orderBy('media_ms')
      .execute()
    await finish()
    const actual = await f.f.h.db
      .selectFrom('video_wall_anchors')
      .selectAll()
      .where('video_id', '=', f.videoId)
      .orderBy('media_ms')
      .execute()
    expect(actual.filter(a => a.source === 'arrival')).deep.equals(arrivals)
    expect(
      actual
        .filter(a => a.source === 'sei')
        .map(a => [a.media_ms, new Date(a.wall).getTime()])
    ).deep.equals(expected.points.map(p => [p.mediaMs, p.wallMs]))
    expect((await f.row())?.spaces_verified_at).not.equals(null)
  })

  it('closes an uploaded replacement’s Space copy while retaining its restoration relationship', async () => {
    await published()
    const replacement = `${f.videoId}_replacement`
    await f.f.h.db
      .insertInto('videos')
      .values({
        id: replacement,
        game_id: 'gam_origin',
        kind: 'program',
        title: 'Replacement',
        storage: 'local',
        status: 'ready'
      })
      .execute()
    await f.f.h.db
      .updateTable('videos')
      .set({ replaced_by: replacement, hidden: true })
      .where('id', '=', f.videoId)
      .execute()
    await finish()
    expect((await f.row())?.replaced_by).equals(replacement)
    expect((await f.row())?.spaces_verified_at).not.equals(null)
    expect(await f.body()).contains('#EXT-X-ENDLIST')
    expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
  })

  it('publishes a grace close and the reopened growing playlist with a one-second cache', async () => {
    await published()
    await f.f.h.db
      .updateTable('live_streams')
      .set({
        state: 'idle',
        last_published_at: new Date(Date.now() - RECONNECT_GRACE_MS - 1000)
      })
      .where('id', '=', f.stream.id)
      .execute()
    await sync(f.options)
    await drainPublishForTest(f.videoId)
    const playback = await (
      await f.f.h.request(
        'GET',
        `/videos/${f.videoId}/playback`,
        undefined,
        105
      )
    ).json()
    const url = playback.url.replace('/api/v1', '')
    const closed = await f.f.h.request('GET', url, undefined, null)
    expect(closed.headers.get('cache-control')).contains('max-age=1')
    expect(await closed.text()).contains('#EXT-X-ENDLIST')
    const fake = join(f.root, 'writer.sh')
    await files.writeFile(fake, '#!/bin/sh\nexec sleep 30\n')
    await files.chmod(fake, 0o755)
    configureIngest({
      ...f.options.live,
      ffmpegPath: fake,
      log: () => {},
      onEvent: () => {}
    })
    forcePublishForTest(f.stream.key, true)
    await until(async () => writerForTest(f.stream.key) != null)
    await drainPublishForTest(f.videoId)
    expect(await f.body()).not.contains('#EXT-X-ENDLIST')
    await new Promise(resolve => setTimeout(resolve, 1100))
    const reopened = await f.f.h.request('GET', url, undefined, null)
    expect(reopened.headers.get('cache-control')).contains('max-age=1')
    expect(await reopened.text()).not.contains('#EXT-X-ENDLIST')
    console.log(
      'grace close and reopen:',
      closed.headers.get('cache-control'),
      await f.body()
    )
  })
})
