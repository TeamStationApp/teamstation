import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  drainLiveController,
  drainPublishForTest,
  handleLiveEventForTest,
  startLiveController,
  stopLiveController,
  sync
} from './controller'
import { hevcSegment, IDR_SLICE, wallClockNal } from './frameWallFixture'
import { originFixture, until } from './originFixtures'
import {
  configureIngest,
  forcePublishForTest,
  ingestPort,
  type LiveEvent,
  publishArrivedForTest,
  setLive,
  tickSamplerForTest,
  writerForTest
} from './splitter'
import { firstPublishOnDisk, placedAt } from './splitterFixtures'

describe('a live origin shared by API nodes', function () {
  this.timeout(60000)
  let f: Awaited<ReturnType<typeof originFixture>>
  beforeEach(async () => {
    f = await originFixture()
  })
  afterEach(async () => {
    await f?.close()
  })

  it('publishes while a real writer is streaming and another node has no local media', async () => {
    expect(await startLiveController(f.options)).equals(true)
    const encoder = spawn(
      f.options.ffmpegPath,
      [
        '-v',
        'error',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=10:duration=9',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'log-level=error:bframes=0',
        '-g',
        '10',
        '-f',
        'flv',
        `rtmp://127.0.0.1:${ingestPort()}/live/${f.stream.key}`
      ],
      { stdio: 'ignore' }
    )
    const done = new Promise<void>((resolve, reject) => {
      encoder.once('error', reject)
      encoder.once('exit', code => {
        code === 0 ? resolve() : reject(new Error(`encoder ${code}`))
      })
    })
    done.catch(() => {})
    try {
      await until(async () => (await f.row())?.storage === 'spaces')
      expect(encoder.exitCode).equals(null)
      const response = await f.f.h.request(
        'GET',
        `/videos/${f.videoId}/playback`,
        undefined,
        105
      )
      const playback = await response.json()
      expect(playback.url).contains('/hls/index.m3u8?t=')
      const playlist = await (
        await f.f.h.request(
          'GET',
          playback.url.replace('/api/v1', ''),
          undefined,
          null
        )
      ).text()
      const url = playlist
        .split('\n')
        .find((line: string) => line.startsWith('http'))!
      expect((await fetch(url)).status).equals(200)
      const puts = f.requests
        .filter((r: { method: string }) => r.method === 'PUT')
        .map((r: { key: string }) => r.key.split('/').at(-1))
      expect(puts.indexOf('init.mp4')).lessThan(puts.indexOf('seg000000.m4s'))
      expect(puts.indexOf('seg000000.m4s')).lessThan(puts.indexOf('index.m3u8'))
      console.log('live request order:', puts.join(', '))
      expect(
        await stat(join(f.root, 'empty-viewer/work')).catch(() => undefined)
      ).equals(undefined)
      await done
    } finally {
      if (encoder.exitCode == null) encoder.kill('SIGKILL')
      await done.catch(() => {})
    }
  })

  it('restarts an idle publisher from ETags without uploading unchanged fragments', async () => {
    await f.stage()
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('spaces')
    stopLiveController()
    await drainLiveController()
    f.requests.length = 0
    expect(await startLiveController(f.options)).equals(true)
    await drainPublishForTest(f.videoId)
    expect(
      f.requests.filter((r: { method: string }) => r.method === 'PUT')
    ).length(0)
    expect(
      f.requests.filter((r: { range?: string }) => r.range != null)
    ).length(0)
    console.log(
      'restart:',
      f.requests
        .map((r: { method: string; key: string }) => `${r.method} ${r.key}`)
        .join('\n')
    )
  })

  it('publishes a reconnect before clock settlement and reuploads moved fragments without shrinking', async () => {
    await f.stage()
    await f.begin()
    await drainPublishForTest(f.videoId)
    const back = Date.now() - 300
    const videoStartMs = back - 41960
    const { init } = firstPublishOnDisk(f.dir, videoStartMs)
    const fake = join(f.root, 'writer.sh')
    writeFileSync(
      fake,
      '#!/bin/sh\nwhile :; do echo out_time_us=1000000 >&2; sleep 0.1; done\n'
    )
    chmodSync(fake, 0o755)
    configureIngest({
      ...f.options.live,
      ffmpegPath: fake,
      log: () => {},
      onEvent: () => {}
    })
    setLive(f.stream.key, {
      liveStreamId: f.stream.id,
      hlsDir: f.dir,
      destinations: [],
      videoStartMs
    })
    forcePublishForTest(f.stream.key, true)
    await until(async () => writerForTest(f.stream.key) != null)
    const segment3 = join(f.dir, 'seg000003.m4s')
    writeFileSync(
      segment3,
      hevcSegment(0, [wallClockNal(back - 5000, false), IDR_SLICE])
    )
    expect(await placedAt(f.dir, init, 'seg000003.m4s')).greaterThan(30)
    appendFileSync(
      join(f.dir, 'master.m3u8'),
      '#EXT-X-DISCONTINUITY\n#EXTINF:4,\nseg000003.m4s\n'
    )
    const before = Date.now()
    await drainPublishForTest(f.videoId)
    expect(Date.now() - before).lessThan(10000)
    expect(await f.body()).contains('seg000003.m4s')
    const remote3 = join(f.remote, 'videos', f.videoId, 'seg000003.m4s')
    const first = await readFile(remote3)
    writeFileSync(
      join(f.dir, 'seg000004.m4s'),
      hevcSegment(4, [wallClockNal(back + 4000), IDR_SLICE])
    )
    expect(await placedAt(f.dir, init, 'seg000004.m4s', 10)).closeTo(
      45.96,
      0.001
    )
    appendFileSync(join(f.dir, 'master.m3u8'), '#EXTINF:4,\nseg000004.m4s\n')
    f.store.faults.set({ method: 'PUT', key: /seg000003/, status: 503 })
    await drainPublishForTest(f.videoId)
    expect(await f.body()).contains('seg000003.m4s')
    expect(await f.body()).not.contains('seg000004.m4s')
    f.store.faults.clear()
    await drainPublishForTest(f.videoId)
    const local = await readFile(segment3)
    const remote = await readFile(remote3)
    expect(remote.equals(first)).equals(false)
    expect(remote.equals(local)).equals(true)
    expect(await f.body()).contains('#EXT-X-DISCONTINUITY')
    expect(await f.body()).contains('seg000004.m4s')
    console.log(
      'reconnect settled MD5:',
      createHash('md5').update(local).digest('hex'),
      createHash('md5').update(remote).digest('hex')
    )
  })

  it('removes the origin when the video is deleted while idle, after any in-flight PUT', async () => {
    await f.stage()
    await f.begin()
    await drainPublishForTest(f.videoId)
    await f.f.h.db
      .updateTable('live_streams')
      .set({ state: 'idle' })
      .where('id', '=', f.stream.id)
      .execute()
    await f.f.h.db.deleteFrom('videos').where('id', '=', f.videoId).execute()
    await sync(f.options)
    await drainPublishForTest(f.videoId)
    const names = await readdir(join(f.remote, 'videos', f.videoId)).catch(
      () => []
    )
    expect(names).deep.equals([])
    expect(await stat(f.dir).catch(() => undefined)).equals(undefined)
    console.log('prefix after idle delete:', names)
  })

  it('takes a refused first publish back off the Space, keeping its placeholder', async () => {
    await f.stage()
    const refusedSince = new Date()
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('spaces')

    await handleLiveEventForTest(
      {
        type: 'publishEnded',
        key: f.stream.key,
        liveStreamId: f.stream.id,
        reason: 'TeamStation takes HEVC.',
        refusedSince
      },
      f.options
    )

    expect(
      await readdir(join(f.remote, 'videos', f.videoId)).catch(() => [])
    ).deep.equals([])
    expect(await stat(f.dir).catch(() => undefined)).equals(undefined)
    expect(await f.row()).to.deep.include({
      storage: 'local',
      status: 'processing',
      hidden: true,
      codecs: null
    })
  })

  it('leaves the Space as it was when a recording is refused its next publish', async () => {
    await f.stage()
    await f.begin()
    await drainPublishForTest(f.videoId)
    const onSpace = async (): Promise<Record<string, string>> => {
      const folder = join(f.remote, 'videos', f.videoId)
      const held: Record<string, string> = {}
      for (const name of await readdir(folder)) {
        const bytes = await readFile(join(folder, name))
        held[name] = createHash('md5').update(bytes).digest('hex')
      }
      return held
    }
    const before = await onSpace()
    expect(Object.keys(before)).includes('init.mp4')
    f.requests.length = 0

    // What FFmpeg does as soon as it has read the publish's first packets.
    const fake = join(f.root, 'clobbering-writer.sh')
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf refused > '${join(f.dir, 'init.mp4')}'\nexec sleep 30\n`
    )
    chmodSync(fake, 0o755)
    const events: LiveEvent[] = []
    configureIngest({
      ...f.options.live,
      ffmpegPath: fake,
      log: () => {},
      onEvent: event => events.push(event)
    })
    setLive(f.stream.key, {
      liveStreamId: f.stream.id,
      hlsDir: f.dir,
      destinations: [],
      videoStartMs: Date.now() - 60_000
    })
    publishArrivedForTest({
      id: 'wrong-camera',
      streamApp: 'live',
      streamName: f.stream.key,
      streamPath: `/live/${f.stream.key}`,
      videoCodec: 7
    })
    await f.begin()
    await new Promise(resolve => setTimeout(resolve, 300))
    await drainPublishForTest(f.videoId)
    tickSamplerForTest()
    const refusal = events.find(
      event => event.type === 'publishEnded' && event.refusedSince != null
    )
    expect(refusal, 'the publish was refused').not.equals(undefined)
    await handleLiveEventForTest(refusal!, f.options)
    await drainPublishForTest(f.videoId)

    expect(await onSpace()).deep.equals(before)
    expect(
      f.requests.filter((r: { method: string }) => r.method === 'PUT')
    ).length(0)
    expect((await f.row())?.status).equals('live')
  })

  it('queues one flush without blocking the tick when the Space is slow', async () => {
    await f.stage()
    f.store.faults.set({ method: 'PUT', key: /seg000000/, delayMs: 800 })
    await f.begin()
    const started = Date.now()
    await sync(f.options)
    await sync(f.options)
    expect(Date.now() - started).lessThan(600)
    await drainPublishForTest(f.videoId)
    expect(
      f.requests.filter(
        (r: { method: string; key: string }) =>
          r.method === 'PUT' && r.key.endsWith('seg000000.m4s')
      )
    ).length(1)
    expect(await f.body()).contains('seg000002.m4s')
  })

  it('keeps no Space streams local without issuing object requests', async () => {
    f.options.space = undefined
    await f.stage()
    await f.begin()
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('local')
    expect(f.requests).length(0)
    expect(await readFile(join(f.dir, 'master.m3u8'), 'utf8')).contains(
      'seg000000.m4s'
    )
  })
})
