import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { startFakeSpace } from '../dev/fakeSpace'
import type { ProbedStream } from '../media/ffmpeg'
import type { SpaceSettings } from '../media/spacesHls'
import { OriginPublisher, type OriginPublisherOptions } from './originPublisher'

const header =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
const segment = (n: number): string => `seg${String(n).padStart(6, '0')}.m4s`
const playlist = (count: number, ended = false): string =>
  header +
  Array.from({ length: count }, (_, n) => `#EXTINF:4,\n${segment(n)}\n`).join(
    ''
  ) +
  (ended ? '#EXT-X-ENDLIST\n' : '')
const failure = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (error) {
    return String(error)
  }
  throw new Error('Expected failure')
}

describe('publishing a live origin', function () {
  this.timeout(30_000)
  let folder: string
  let dir: string
  let remote: string
  let space: SpaceSettings
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  let options: OriginPublisherOptions
  let notifications: ProbedStream[]
  let requests: Array<{ method: string; key: string; range?: string }>
  let exists: boolean
  let final: Set<string> | undefined
  beforeEach(async function () {
    folder = await mkdtemp(join(tmpdir(), 'tsOriginPublisher-'))
    dir = join(folder, 'local')
    remote = join(folder, 'space')
    await mkdir(dir)
    space = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    store = await startFakeSpace({ space, dir: remote })
    space.endpoint = store.url
    requests = []
    store.server.on('request', req =>
      requests.push({
        method: req.method!,
        key: decodeURIComponent(new URL(req.url!, store.url).pathname).slice(
          '/test/'.length
        ),
        range: req.headers.range
      })
    )
    notifications = []
    exists = true
    final = undefined
    options = {
      space,
      videoId: 'vid_origin',
      dir,
      ffmpegPath: 'ffmpeg',
      isFinal: name => final == null || final.has(name),
      rowExists: async () => exists,
      onFirstSegment: async probe => {
        notifications.push(probe)
      },
      probe: async () => ({
        codecName: 'hevc',
        codecTag: 'hvc1',
        width: 1280,
        height: 720
      })
    }
  })
  afterEach(async function () {
    store.server.close()
    await rm(folder, { recursive: true, force: true })
  })
  const object = (name: string): string =>
    join(remote, 'videos/vid_origin', name)
  const puts = (): string[] =>
    requests
      .filter(req => req.method === 'PUT')
      .map(req => req.key.split('/').at(-1)!)
  async function stage(count = 3, ended = false): Promise<void> {
    await writeFile(join(dir, 'master.m3u8'), playlist(count, ended))
    await writeFile(join(dir, 'init.mp4'), 'an init segment')
    for (let n = 0; n < count; n++)
      await writeFile(join(dir, segment(n)), `fragment ${n}`)
  }

  it('does not query the video row once per historical segment on an unchanged tick', async () => {
    await stage(100)
    const publisher = new OriginPublisher(options)
    await publisher.flush()
    let reads = 0
    options.rowExists = async () => {
      reads++
      return exists
    }
    requests.length = 0
    await publisher.flush()
    expect(reads).at.most(3)
    expect(requests).length(0)
    exists = false
    await publisher.flush()
    expect(requests).length(0)
  })
  async function rewrite(name: string, body: string): Promise<void> {
    await writeFile(join(dir, name), body)
    const date = new Date(Date.now() + 1000)
    await utimes(join(dir, name), date, date)
  }

  it('waits for a playlist and for final segments, and puts init before media before index', async function () {
    const publisher = new OriginPublisher(options)
    await publisher.start()
    expect(await publisher.flush()).deep.equals({ complete: false })
    await stage(0)
    expect(await publisher.flush()).deep.equals({ complete: false })
    await stage()
    final = new Set([segment(0)])
    await publisher.flush()
    expect(puts()).deep.equals([
      'init.mp4',
      segment(0),
      'index.m3u8',
      'master.m3u8'
    ])
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(1))
    expect(notifications).length(1)
    expect(await readFile(object('master.m3u8'), 'utf8')).contains(
      'RESOLUTION=1280x720'
    )
    requests.length = 0
    await publisher.flush()
    expect(puts()).deep.equals([])
    final = undefined
    await publisher.flush()
    expect(puts()).deep.equals([segment(1), segment(2), 'index.m3u8'])
    expect(notifications).length(1)
  })

  it('holds the prefix at a failed verification and advances only after retry', async function () {
    await stage(3, true)
    const publisher = new OriginPublisher(options)
    store.faults.set({ method: 'PUT', key: /seg000001/, truncateTo: 2 })
    expect(await failure(publisher.flush())).contains('2 bytes there')
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(1))
    console.log(
      'prefix after failed upload:\n' +
        (await readFile(object('index.m3u8'), 'utf8'))
    )
    store.faults.clear()
    expect((await publisher.flush()).complete).equals(true)
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(
      playlist(3, true)
    )
    console.log(
      'prefix after retry:\n' + (await readFile(object('index.m3u8'), 'utf8'))
    )
    await rewrite('init.mp4', 'another init segment')
    await rewrite(segment(0), 'restamped first fragment')
    requests.length = 0
    await publisher.flush()
    expect(puts()).deep.equals(['init.mp4', segment(0)])
    store.faults.set({ method: 'PUT', key: /seg000000/, status: 503 })
    await rewrite(segment(0), 'another restamped fragment')
    expect(await failure(publisher.flush())).contains('503')
    const held = await readFile(object('index.m3u8'), 'utf8')
    expect(held).contains(segment(2))
    expect(held).not.contains('#EXT-X-ENDLIST')
    store.faults.clear()
    expect((await publisher.flush()).complete).equals(true)
  })

  it('resumes from ETags without per-segment reads or reuploads, and retains the remote prefix after a restamp', async function () {
    await stage()
    await new OriginPublisher(options).flush()
    requests.length = 0
    const resumed = new OriginPublisher(options)
    await resumed.start()
    await resumed.start()
    expect(requests.filter(req => req.range != null)).length(0)
    await resumed.flush()
    expect(puts()).deep.equals([])
    await rewrite(segment(1), 'changed  1')
    store.faults.set({ method: 'PUT', key: /seg000001/, status: 500 })
    const moved = new OriginPublisher(options)
    expect(await failure(moved.flush())).contains('500')
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(3))
    store.faults.clear()
    requests.length = 0
    await moved.flush()
    expect(puts()).deep.equals([segment(1)])
    expect(await readFile(object(segment(1)), 'utf8')).equals('changed  1')
  })

  it('does not acknowledge a file rewritten while its PUT is in flight', async function () {
    await stage(1)
    store.faults.set({ method: 'PUT', key: /seg000000/, delayMs: 100 })
    const arrived = new Promise<void>(resolve =>
      store.server.on('request', req => {
        if (req.method === 'PUT' && req.url!.includes('seg000000')) resolve()
      })
    )
    const publisher = new OriginPublisher(options)
    const flushing = publisher.flush()
    await arrived
    await rewrite(segment(0), 'changed  0')
    await flushing
    expect(puts()).not.contains('index.m3u8')
    expect(notifications).length(0)
    store.faults.clear()
    await publisher.flush()
    expect(await readFile(object(segment(0)), 'utf8')).equals('changed  0')
    expect(notifications).length(1)
  })

  it('stops before the next PUT if the row is deleted, and rejects tick flushes during close', async function () {
    await stage(1, true)
    const publisher = new OriginPublisher(options)
    publisher.closing = true
    await publisher.flush()
    expect(puts()).length(0)
    expect((await publisher.flush({ close: true })).complete).equals(true)
    publisher.stop()
    requests.length = 0
    await publisher.flush({ close: true })
    expect(requests).length(0)
    exists = false
    await new OriginPublisher(options).flush()
    expect(puts()).length(0)
  })

  it('handles a deletion during upload without advertising media or notifying the controller', async function () {
    await stage(1)
    store.server.on('request', req => {
      if (req.method === 'PUT' && req.url!.includes('init.mp4')) exists = false
    })
    await new OriginPublisher(options).flush()
    expect(puts()).deep.equals(['init.mp4'])
    expect(notifications).length(0)
  })

  it('retries failed startup reads, master PUTs, probes and callbacks', async function () {
    await stage(1)
    const publisher = new OriginPublisher(options)
    store.faults.set({ method: 'GET', key: /^$/, status: 503 })
    expect(await failure(publisher.flush())).contains('Listing')
    store.faults.clear()
    store.faults.set({ method: 'GET', key: /index.m3u8/, status: 503 })
    expect(await failure(publisher.flush())).contains('Reading live origin')
    store.faults.clear()
    options.probe = async () => {
      throw new Error('probe failed')
    }
    expect(await failure(publisher.flush())).contains('probe failed')
    expect(
      await readFile(join(dir, '.origin-probe.m3u8')).catch(() => undefined)
    ).equals(undefined)
    options.probe = async () => ({ codecName: 'h264', codecTag: 'avc1' })
    store.faults.set({ method: 'PUT', key: /master.m3u8/, status: 500 })
    expect(await failure(publisher.flush())).contains('500')
    store.faults.clear()
    options.onFirstSegment = async () => {
      throw new Error('database failed')
    }
    expect(await failure(publisher.flush())).contains('database failed')
    options.onFirstSegment = async probe => {
      notifications.push(probe)
    }
    await publisher.flush()
    expect(notifications).length(1)
  })

  it('stores a later init segment ahead of the segments listed under it', async function () {
    await stage(2)
    await writeFile(join(dir, 'init000002.mp4'), 'a second init segment')
    await writeFile(join(dir, segment(2)), 'a later picture')
    await writeFile(
      join(dir, 'master.m3u8'),
      `${playlist(2)}#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init000002.mp4"\n#EXTINF:4,\n${segment(2)}\n`
    )
    await new OriginPublisher(options).flush()

    const put = puts()
    expect(put.indexOf('init000002.mp4')).above(-1)
    expect(put.indexOf('init000002.mp4')).below(put.indexOf(segment(0)))
    expect(await readFile(object('init000002.mp4'), 'utf8')).equals(
      'a second init segment'
    )
    expect(await readFile(object('index.m3u8'), 'utf8')).contains(
      '#EXT-X-MAP:URI="init000002.mp4"'
    )

    // A new publisher object seeds itself from what the store holds.
    requests.length = 0
    await new OriginPublisher(options).flush()
    expect(puts()).deep.equals([])
  })

  it('holds a playlist back while a later init segment is being replaced', async function () {
    await stage(1)
    await writeFile(join(dir, 'init000001.mp4'), 'a second init segment')
    await writeFile(join(dir, segment(1)), 'a later picture')
    await writeFile(
      join(dir, 'master.m3u8'),
      `${playlist(1)}#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init000001.mp4"\n#EXTINF:4,\n${segment(1)}\n`
    )
    let changed = false
    const publisher = new OriginPublisher({
      ...options,
      isFinal: name => {
        if (!changed && name === segment(1)) {
          changed = true
          writeFileSync(join(dir, 'init000001.mp4'), 'changed under it, longer')
        }
        return true
      }
    })
    const first = await publisher.flush()
    expect(first.complete).equals(false)
  })

  it('refuses a later map with a name no writer gives', async function () {
    await stage(1)
    await writeFile(
      join(dir, 'master.m3u8'),
      `${playlist(1)}#EXT-X-MAP:URI="../other.mp4"\n#EXTINF:4,\n${segment(1)}\n`
    )
    await writeFile(join(dir, segment(1)), 'a later picture')
    expect(await failure(new OriginPublisher(options).flush())).contains(
      'Invalid live object'
    )
  })

  it('refuses malformed playlists and does not hide local read errors', async function () {
    await stage(1)
    await writeFile(
      join(dir, 'master.m3u8'),
      playlist(1).replace('init.mp4', 'other.mp4')
    )
    expect(await failure(new OriginPublisher(options).flush())).contains(
      'no init.mp4'
    )
    await writeFile(
      join(dir, 'master.m3u8'),
      playlist(1).replace(segment(0), '../escape.m4s')
    )
    expect(await failure(new OriginPublisher(options).flush())).contains(
      'Invalid live object'
    )
    await rm(join(dir, 'master.m3u8'))
    await mkdir(join(dir, 'master.m3u8'))
    expect(await failure(new OriginPublisher(options).flush())).contains(
      'EISDIR'
    )
    await rm(join(dir, 'master.m3u8'), { recursive: true })
    await stage(1)
    await mkdir(join(remote, 'videos/vid_origin'), { recursive: true })
    await writeFile(
      object('index.m3u8'),
      '#EXTM3U\n#EXTINF:4,\n../escape.m4s\n'
    )
    expect(await failure(new OriginPublisher(options).flush())).contains(
      'Invalid published live segment'
    )
  })

  it('probes real fragments and writes their exact codec and resolution', async function () {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=10:duration=2',
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
      '-hls_segment_type',
      'fmp4',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'master.m3u8')
    ])
    delete options.probe
    const result = await new OriginPublisher(options).flush({ close: true })
    expect(result.complete).equals(true)
    expect(notifications[0]).include({
      width: 160,
      height: 90,
      codecTag: 'avc1'
    })
    const master = await readFile(object('master.m3u8'), 'utf8')
    expect(master).contains('CODECS="avc1.')
    expect(master).contains('RESOLUTION=160x90')
  })
})
