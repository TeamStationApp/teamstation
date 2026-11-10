import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { quietStreamFixture } from '../../test/quietStreamFixture'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import {
  beganPublishing,
  finishStream,
  handleLiveEventForTest,
  queueLiveWorkForTest,
  resolveKey,
  settleLiveWork,
  sync
} from './controller'
import {
  configureIngest,
  forcePublishForTest,
  liveKeys,
  publishArrivedForTest,
  setLive,
  statusFor
} from './splitter'

describe('quiet streams through the running API and controller', function () {
  this.timeout(120000)
  let f: Awaited<ReturnType<typeof quietStreamFixture>>
  before(async () => {
    f = await quietStreamFixture()
  })
  after(async () => {
    await f?.close()
  })
  const row = async (
    id: string
  ): Promise<{ state: string; video_id: string | null }> =>
    await f.db
      .selectFrom('live_streams')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  it('keeps a long dropout before game end, including its key and recording on reconnect', async () => {
    const s = await f.addStream({ endAgoMs: -1_200_000 })
    await f.tick()
    expect((await row(s.id)).state).equals('idle')
    expect(liveKeys()).includes(s.key)
    expect(await readFile(s.playlist, 'utf8')).contains('#EXT-X-ENDLIST')
    const spec = await resolveKey(s.key, f.options)
    expect(spec).is.an('object')
    expect(typeof spec === 'object' && spec?.liveStreamId).equals(s.id)
    forcePublishForTest(s.key, true)
    expect(statusFor(s.key)?.ingress.publishing).equals(true)
    await f.tick()
    expect((await row(s.id)).video_id).equals(s.videoId)
    expect((await row(s.id)).state).equals('idle')
    forcePublishForTest(s.key, false)
  })

  it('keeps an active row after the scheduled end even if its last timestamp is old', async () => {
    const s = await f.addStream({ state: 'publishing' })
    await f.tick()
    expect((await row(s.id)).state).equals('publishing')
    expect(liveKeys()).includes(s.key)
  })

  it('protects an ingest reconnect while the row still says idle, including on-demand keys', async () => {
    const s = await f.addStream()
    const spec = await resolveKey(s.key, f.options)
    if (typeof spec !== 'object' || spec == null)
      throw new Error('Expected live key')
    setLive(s.key, spec)
    forcePublishForTest(s.key, true)
    expect(statusFor(s.key)?.ingress.publishing).equals(true)
    await f.tick()
    expect((await row(s.id)).state).equals('idle')
    expect(liveKeys()).includes(s.key)
    expect(await readFile(s.playlist, 'utf8')).not.contains('#EXT-X-ENDLIST')
    forcePublishForTest(s.key, false)
  })

  for (const pending of [false, true]) {
    it(`resets quiet time for a brief reconnect during sync (${pending ? 'queued' : 'completed'} events)`, async () => {
      const s = await f.addStream({ quietMs: 0 })
      await f.tick()
      await f.db
        .updateTable('live_streams')
        .set({ last_published_at: new Date(Date.now() - 660_000) })
        .where('id', '=', s.id)
        .execute()
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const reconnect = async (): Promise<void> => {
        await beganPublishing(f.options, s.id)
        await handleLiveEventForTest(
          {
            type: 'publishEnded',
            key: s.key,
            liveStreamId: s.id,
            reason: 'A brief reconnect ended'
          },
          f.options
        )
      }
      try {
        await sync({
          ...f.options,
          freeBytes: async () => {
            if (pending)
              queueLiveWorkForTest(s.key, async () => {
                await held
                await reconnect()
              })
            else await reconnect()
            return 1_000_000_000_000
          }
        })
        expect((await row(s.id)).state).equals('idle')
        expect(liveKeys()).includes(s.key)
      } finally {
        release()
        await settleLiveWork()
      }
      await f.tick()
      expect((await row(s.id)).state).equals('idle')
      expect((await row(s.id)).video_id).equals(s.videoId)
      expect(await resolveKey(s.key, f.options)).is.an('object')
    })
  }

  it('rejects an ingest lookup that resumes after automatic finalization', async () => {
    const s = await f.addStream({ quietMs: 0 })
    await f.tick()
    await f.db
      .updateTable('live_streams')
      .set({ last_published_at: new Date(Date.now() - 660_000) })
      .where('id', '=', s.id)
      .execute()
    let entered!: () => void
    let release!: () => void
    let done!: () => void
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const resolved = new Promise<void>(resolve => {
      done = resolve
    })
    let closed = false
    configureIngest({
      ...f.options.live,
      ffmpegPath: f.options.ffmpegPath,
      log: () => undefined,
      onEvent: () => undefined,
      resolve: async key => {
        try {
          return await resolveKey(key, {
            ...f.options,
            freeBytes: async () => {
              entered()
              await held
              return 1_000_000_000_000
            }
          })
        } finally {
          done()
        }
      }
    })
    try {
      publishArrivedForTest({
        id: 'quiet-reconnect',
        streamApp: 'live',
        streamName: s.key,
        close: () => {
          closed = true
        }
      })
      await waiting
      await f.tick()
      expect((await row(s.id)).state).equals('ended')
    } finally {
      release()
    }
    await resolved
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).equals(true)
    expect(liveKeys()).not.includes(s.key)
    expect(statusFor(s.key)?.ingress.publishing).not.equals(true)
  })

  it('refuses a key while its finalization is still waiting to commit', async () => {
    const s = await f.addStream({ quietMs: 0 })
    await f.tick()
    let finishing!: Promise<void>
    await f.db.transaction().execute(async trx => {
      await trx
        .selectFrom('live_streams')
        .select('id')
        .where('id', '=', s.id)
        .forUpdate()
        .execute()
      finishing = finishStream(f.options, s.id, 'The stream was ended')
      expect(await resolveKey(s.key, f.options)).is.a('string')
      expect(liveKeys()).not.includes(s.key)
    })
    await finishing
    expect((await row(s.id)).state).equals('ended')
  })

  it('invalidates a lookup that starts during finalization and resumes after it completes', async () => {
    const s = await f.addStream({ quietMs: 0 })
    await f.tick()
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let finishing!: Promise<void>
    let resolving!: ReturnType<typeof resolveKey>
    try {
      await f.db.transaction().execute(async trx => {
        await trx
          .selectFrom('live_streams')
          .select('id')
          .where('id', '=', s.id)
          .forUpdate()
          .execute()
        finishing = finishStream(f.options, s.id, 'The stream was ended')
        resolving = resolveKey(s.key, {
          ...f.options,
          freeBytes: async () => {
            entered()
            await held
            return 1_000_000_000_000
          }
        })
        await waiting
      })
      await finishing
      expect((await row(s.id)).state).equals('ended')
    } finally {
      release()
    }
    expect(await resolving).is.a('string')
    expect(liveKeys()).not.includes(s.key)
  })

  it('still admits a current key when an unrelated stream finishes during its lookup', async () => {
    const s = await f.addStream({ quietMs: 0 })
    const other = await f.addStream({ quietMs: 0 })
    await f.tick()
    let first = true
    const spec = await resolveKey(s.key, {
      ...f.options,
      freeBytes: async () => {
        if (first) {
          first = false
          await finishStream(f.options, other.id, 'The stream was ended')
        }
        return 1_000_000_000_000
      }
    })
    expect(spec).is.an('object')
    expect(typeof spec === 'object' && spec?.liveStreamId).equals(s.id)
    expect((await row(s.id)).state).equals('idle')
    expect((await row(other.id)).state).equals('ended')
  })

  it('ends on both clocks, rejects the key, retains a playable recording and removes home LIVE', async () => {
    const s = await f.addStream({ quietMs: 0 })
    await f.tick()
    expect(
      (await f.request('/live')).map((r: { gameId: string }) => r.gameId)
    ).includes(s.gameId)
    const notices = await listenScreenScopes(f.db)
    try {
      const mark = notices.mark()
      await f.db
        .updateTable('live_streams')
        .set({ last_published_at: new Date(Date.now() - 600_000) })
        .where('id', '=', s.id)
        .execute()
      await f.tick()
      expect((await row(s.id)).state).equals('ended')
      expect(liveKeys()).not.includes(s.key)
      expect(await resolveKey(s.key, f.options)).is.a('string')
      expect(
        await readFile(join(dirname(s.playlist), 'video.m3u8'), 'utf8')
      ).contains('#EXT-X-ENDLIST')
      const video = await f.db
        .selectFrom('videos')
        .selectAll()
        .where('id', '=', s.videoId)
        .executeTakeFirstOrThrow()
      expect(video.status).equals('ready')
      expect(video.duration_sec).greaterThan(3)
      expect(
        (await notices.since(mark)).some(n => n.gameId === s.gameId)
      ).equals(true)
      expect(
        (await f.request('/live')).map((r: { gameId: string }) => r.gameId)
      ).not.includes(s.gameId)
      const games = await f.request('/events?played=1')
      expect(
        games.find((r: { id: string }) => r.id === s.gameId).isLive
      ).equals(false)
      const playback = await f.request(`/videos/${s.videoId}/playback`)
      expect(playback).has.property('url')
      console.log(
        'GET /live + /events: ended game is no longer live; recording ready and playback URL available'
      )
    } finally {
      await notices.close()
    }
  })

  it('gives a never-published URL ten minutes from opening, then removes its placeholder', async () => {
    const s = await f.addStream({ published: false, openedAgoMs: 0 })
    await f.tick()
    expect((await row(s.id)).state).equals('idle')
    expect(liveKeys()).includes(s.key)
    await f.db
      .updateTable('live_streams')
      .set({ opens_at: new Date(Date.now() - 600_000) })
      .where('id', '=', s.id)
      .execute()
    await f.tick()
    expect((await row(s.id)).state).equals('ended')
    expect(liveKeys()).not.includes(s.key)
    expect(
      await f.db
        .selectFrom('videos')
        .select('id')
        .where('id', '=', s.videoId)
        .executeTakeFirst()
    ).equals(undefined)
  })

  it('does not guess an absent game end or end a recent dropout', async () => {
    const noEnd = await f.addStream({ endAgoMs: null })
    const recent = await f.addStream({ quietMs: 30_000 })
    const early = await f.addStream({ endAgoMs: 30_000 })
    await f.tick()
    for (const s of [noEnd, recent, early]) {
      expect((await row(s.id)).state).equals('idle')
      expect(liveKeys()).includes(s.key)
    }
  })

  it('honors manual End stream through the API before either clock', async () => {
    const s = await f.addStream({ quietMs: 0, endAgoMs: -3_600_000 })
    await f.tick()
    await f.request(`/games/${s.gameId}/live-streams/${s.id}/end`, 'POST')
    await sync(f.options)
    expect((await row(s.id)).state).equals('ended')
    expect(liveKeys()).not.includes(s.key)
    expect(await readFile(s.playlist, 'utf8')).contains('#EXT-X-ENDLIST')
  })
})
