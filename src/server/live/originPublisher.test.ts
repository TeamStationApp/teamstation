import { execFileSync } from 'node:child_process'
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { startFakeSpace } from '../dev/fakeSpace'
import type { ProbedStream } from '../media/ffmpeg'
import type { SpaceSettings } from '../media/spacesHls'
import type { PartReader } from '../media/wallClockScan'
import type { PictureSize } from './finishVideo'
import {
  OriginPublisher,
  type OriginPublisherOptions,
  type PlaylistSink
} from './originPublisher'
import { PlaylistTail } from './playlistTail'
import { spacePartReader } from './spacePieceReader'

const header =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
const segment = (n: number): string => `seg${String(n).padStart(6, '0')}.m4s`
const playlist = (count: number, ended = false): string =>
  header +
  Array.from({ length: count }, (_, n) => `#EXTINF:4,\n${segment(n)}\n`).join(
    ''
  ) +
  (ended ? '#EXT-X-ENDLIST\n' : '')
/** What `append_list` leaves after a reconnect: the old pieces, then more. */
const reconnected = (before: number, count: number, ended = false): string =>
  playlist(before) +
  '#EXT-X-DISCONTINUITY\n' +
  Array.from(
    { length: count - before },
    (_, n) => `#EXTINF:4,\n${segment(before + n)}\n`
  ).join('') +
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
  let pictures: PictureSize[]
  let logged: string[]
  let requests: Array<{ method: string; key: string; range?: string }>
  let final: Set<string> | undefined
  let stats: string[]
  let sunk: Array<{ kind: 'append' | 'replace'; text: string }>
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
    pictures = []
    logged = []
    final = undefined
    stats = []
    sunk = []
    const sink: PlaylistSink = {
      append: async (videoId, text) => {
        expect(videoId).equals('vid_origin')
        sunk.push({ kind: 'append', text })
      },
      replace: async (videoId, text) => {
        expect(videoId).equals('vid_origin')
        sunk.push({ kind: 'replace', text })
      }
    }
    options = {
      space,
      videoId: 'vid_origin',
      spaceSecret: null,
      dir,
      ffmpegPath: 'ffmpeg',
      isFinal: name => final == null || final.has(name),
      onFirstSegment: async probe => {
        notifications.push(probe)
      },
      onLargestPicture: async size => {
        pictures.push(size)
      },
      log: message => {
        logged.push(message)
      },
      probe: async () => ({
        codecName: 'hevc',
        codecTag: 'hvc1',
        width: 1280,
        height: 720
      }),
      playlistSink: sink,
      files: {
        stat: async path => {
          stats.push(basename(path))
          return await stat(path)
        }
      }
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

  it('makes pieces and init files public under a secret path, and keeps playlists private', async () => {
    const secret = '0123456789abcdef0123456789abcdef'
    const sent = new Map<string, { acl?: string; cache?: string }>()
    store.server.on('request', req => {
      if (req.method !== 'PUT') return
      sent.set(new URL(req.url!, store.url).pathname.split('/').at(-1)!, {
        acl: req.headers['x-amz-acl'] as string | undefined,
        cache: req.headers['cache-control']
      })
    })
    await stage(2)
    const publisher = new OriginPublisher({ ...options, spaceSecret: secret })
    expect((await publisher.flush()).body).contains(segment(1))
    const piece = { acl: 'public-read', cache: 'public, max-age=600' }
    expect(Object.fromEntries(sent)).deep.equals({
      'init.mp4': { acl: 'public-read', cache: 'no-cache' },
      [segment(0)]: piece,
      [segment(1)]: piece,
      'index.m3u8': { acl: undefined, cache: undefined },
      'master.m3u8': { acl: undefined, cache: undefined }
    })
    const plain = (name: string): string =>
      `${store.url}/test/videos/vid_origin-${secret}/${name}`
    const unsigned = await fetch(plain(segment(1)))
    expect(unsigned.status).equals(200)
    expect(await unsigned.text()).equals('fragment 1')
    expect((await fetch(plain('init.mp4'))).status).equals(200)
    expect((await fetch(plain('index.m3u8'))).status).equals(403)
    expect((await fetch(plain('master.m3u8'))).status).equals(403)
    // Nothing went to the old path.
    expect(await stat(object('init.mp4')).catch(() => undefined)).equals(
      undefined
    )
    // A restarted publisher reads the secret path back and sends nothing new.
    requests.length = 0
    const restarted = new OriginPublisher({ ...options, spaceSecret: secret })
    expect((await restarted.flush()).body).contains(segment(1))
    expect(puts()).deep.equals([])

    // A piece the writer may still restamp is listed, but never kept at the
    // edge; once it settles and is rewritten, the new bytes are cached.
    let moving = true
    const continuing = new OriginPublisher({
      ...options,
      spaceSecret: secret,
      mayMove: name => moving && name === segment(2)
    })
    await stage(3)
    expect((await continuing.flush()).body).contains(segment(2))
    expect(sent.get(segment(2))).deep.equals({
      acl: 'public-read',
      cache: 'no-cache'
    })
    moving = false
    await writeFile(join(dir, segment(2)), 'fragment 2, restamped')
    await continuing.flush()
    expect(sent.get(segment(2))).deep.equals(piece)
    expect(await (await fetch(plain(segment(2)))).text()).equals(
      'fragment 2, restamped'
    )
  })

  it('counts a kept piece the tail deletes later as deleted, so a flush that checks the playlist again skips it', async () => {
    // Pieces end at 4, 8, 12 and 16 s: with a 4 s tail, the first two may go.
    let placement: number | undefined = 1
    const publisher = new OriginPublisher({
      ...options,
      localTailSec: 4,
      scanned: () => ({ segments: 3, placementSegment: placement })
    })
    await stage(4)
    await publisher.flush()
    await publisher.flush()
    expect(await readdir(dir)).not.includes(segment(0))
    expect(await readdir(dir)).includes(segment(1))
    // The scan moves on, and the placement piece goes with nothing after it.
    placement = undefined
    await publisher.flush()
    expect(await readdir(dir)).not.includes(segment(1))
    // A playlist that no longer holds the cursor's piece where it was makes
    // the next flush check every piece again.
    ;(publisher as unknown as { cursor: number }).cursor = 0
    requests.length = 0
    expect((await publisher.flush()).body).contains(segment(3))
    expect(puts()).deep.equals([])
    // Nor does the deleted piece hold back the pieces that follow.
    await writeFile(join(dir, segment(4)), 'fragment 4')
    await writeFile(join(dir, 'master.m3u8'), playlist(5))
    expect((await publisher.flush()).body).contains(segment(4))
    expect(puts()).deep.equals([segment(4), 'index.m3u8'])
  })

  it('deletes nothing once the recording starts to finish, and still uploads', async () => {
    // Pieces end at 4, 8, 12, 16 and 20 s, with a 4 s tail.
    let scannedTo = 3
    const publisher = new OriginPublisher({
      ...options,
      localTailSec: 4,
      scanned: () => ({ segments: scannedTo })
    })
    await stage(3)
    await publisher.flush()
    await publisher.flush()
    expect(await readdir(dir)).not.includes(segment(0))
    // The close has begun: the playlist is about to be closed and probed.
    publisher.holdPieces = true
    for (const n of [3, 4])
      await writeFile(join(dir, segment(n)), `fragment ${n}`)
    await writeFile(join(dir, 'master.m3u8'), playlist(5))
    scannedTo = 5
    requests.length = 0
    expect((await publisher.flush()).body).contains(segment(4))
    await publisher.flush()
    expect(puts()).includes(segment(4))
    for (let n = 1; n < 5; n++) expect(await readdir(dir)).includes(segment(n))
    // Without the hold, the next flush deletes what the tail no longer needs.
    publisher.holdPieces = false
    scannedTo = 4
    await publisher.flush()
    expect(await readdir(dir)).not.includes(segment(1))
    expect(await readdir(dir)).not.includes(segment(2))
  })

  it('uploads a video with no secret on its old path, private, with no access headers', async () => {
    const acls: Array<string | undefined> = []
    store.server.on('request', req => {
      if (req.method === 'PUT')
        acls.push(
          (req.headers['x-amz-acl'] as string | undefined) ??
            req.headers['cache-control']
        )
    })
    await stage(1)
    await new OriginPublisher(options).flush()
    expect(acls.length).greaterThan(0)
    expect(acls.every(header => header == null)).equals(true)
    expect(
      (await fetch(`${store.url}/test/videos/vid_origin/${segment(0)}`)).status
    ).equals(403)
  })

  it('sends nothing on an unchanged tick, and nothing at all once stopped', async () => {
    await stage(100)
    const publisher = new OriginPublisher(options)
    await publisher.flush()
    requests.length = 0
    await publisher.flush()
    expect(requests).length(0)
    await writeFile(join(dir, 'master.m3u8'), playlist(101))
    await writeFile(join(dir, segment(100)), 'fragment 100')
    publisher.stop()
    expect(await publisher.flush()).deep.equals({ complete: false })
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
    // A reconnect rewrites the init and appends; a piece before the cursor
    // is not opened again, even when its file changed.
    await rewrite('init.mp4', 'another init segment')
    await rewrite(segment(0), 'restamped first fragment')
    await rewrite('master.m3u8', reconnected(3, 4))
    await writeFile(join(dir, segment(3)), 'fragment 3')
    store.faults.set({ method: 'PUT', key: /seg000003/, status: 503 })
    requests.length = 0
    expect(await failure(publisher.flush())).contains('503')
    expect(puts()).deep.equals(['init.mp4', segment(3), 'index.m3u8'])
    const held = await readFile(object('index.m3u8'), 'utf8')
    expect(held).contains(segment(2))
    expect(held).not.contains('#EXT-X-ENDLIST')
    store.faults.clear()
    await rewrite('master.m3u8', reconnected(3, 4, true))
    expect((await publisher.flush()).complete).equals(true)
    expect(await readFile(object(segment(0)), 'utf8')).equals('fragment 0')
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

  it('stops before the next PUT once stopped, and rejects tick flushes during close', async function () {
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
    const stopped = new OriginPublisher(options)
    stopped.stop()
    await stopped.flush()
    expect(puts()).length(0)
  })

  it('handles a stop during upload, as for a deleted video, without advertising media or notifying the controller', async function () {
    await stage(1)
    const publisher = new OriginPublisher(options)
    store.server.on('request', req => {
      if (req.method === 'PUT' && req.url!.includes('init.mp4'))
        publisher.stop()
    })
    await publisher.flush()
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

    // A new publisher object seeds itself from what the store holds, and says
    // every part in the master again.
    requests.length = 0
    await new OriginPublisher(options).flush()
    expect(puts()).deep.equals(['master.m3u8'])
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

  it('waits out an init segment a starting writer has emptied', async function () {
    await stage(1)
    await writeFile(join(dir, 'init.mp4'), '')
    const publisher = new OriginPublisher(options)
    expect((await publisher.flush()).complete).equals(false)
    expect(puts()).deep.equals([])

    await writeFile(join(dir, 'init.mp4'), 'its writer filled it')
    await publisher.flush()
    expect(await readFile(object('init.mp4'), 'utf8')).equals(
      'its writer filled it'
    )
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

  it('stats only the playlist file when it is unchanged and everything is published', async function () {
    await stage(3)
    const publisher = new OriginPublisher(options)
    await publisher.flush()
    stats.length = 0
    requests.length = 0
    const result = await publisher.flush()
    expect(stats).deep.equals(['master.m3u8'])
    expect(requests).length(0)
    expect(result.body).equals(playlist(3))
  })

  it('stats the playlist, init.mp4 and only the new piece at 900, 1,800 and 2,700 acknowledged pieces', async function () {
    this.timeout(300_000)
    await writeFile(join(dir, 'init.mp4'), 'an init segment')
    const publisher = new OriginPublisher(options)
    const counts: Array<Record<string, number>> = []
    let staged = 0
    for (const acknowledged of [900, 1800, 2700]) {
      for (; staged < acknowledged; staged++)
        await writeFile(join(dir, segment(staged)), `fragment ${staged}`)
      await writeFile(join(dir, 'master.m3u8'), playlist(acknowledged))
      await publisher.flush()
      expect(await readFile(object('index.m3u8'), 'utf8')).equals(
        playlist(acknowledged)
      )
      // One more piece on top of the acknowledged ones.
      await writeFile(join(dir, segment(staged)), `fragment ${staged}`)
      await writeFile(join(dir, 'master.m3u8'), playlist(acknowledged + 1))
      stats.length = 0
      await publisher.flush()
      const count: Record<string, number> = {}
      for (const name of stats) count[name] = (count[name] ?? 0) + 1
      console.log(
        `${acknowledged} acknowledged pieces + 1: ${stats.length} stats ${JSON.stringify(count)}`
      )
      expect(count).deep.equals({
        'master.m3u8': 1,
        'init.mp4': 2,
        [segment(acknowledged)]: 4
      })
      counts.push(
        Object.fromEntries(
          Object.entries(count).map(([name, n]) => [
            name.startsWith('seg') ? 'new piece' : name,
            n
          ])
        )
      )
      staged++
    }
    expect(counts[1]).deep.equals(counts[0])
    expect(counts[2]).deep.equals(counts[0])
  })

  it('reads only the bytes a playlist added since the last flush, the same at 100 pieces as at 2,700', async function () {
    this.timeout(300_000)
    await writeFile(join(dir, 'init.mp4'), 'an init segment')
    let calls: Record<string, number> = {}
    const count = (call: string): void => {
      calls[call] = (calls[call] ?? 0) + 1
    }
    const reader = new PlaylistTail(join(dir, 'master.m3u8'), {
      readFileSync: path => {
        count('readFileSync')
        return readFileSync(path)
      },
      openSync: (path, flags) => {
        count('openSync')
        return openSync(path, flags)
      },
      fstatSync: fd => {
        count('fstatSync')
        return fstatSync(fd)
      },
      readSync: (fd, buffer, offset, length, position) => {
        count('readSync')
        return readSync(fd, buffer, offset, length, position)
      },
      closeSync: fd => {
        count('closeSync')
        closeSync(fd)
      }
    })
    const publisher = new OriginPublisher({ ...options, playlist: reader })
    const measured: Array<{ bytes: number; calls: Record<string, number> }> = []
    let staged = 0
    for (const pieces of [100, 2700]) {
      for (; staged < pieces; staged++)
        await writeFile(join(dir, segment(staged)), `fragment ${staged}`)
      await writeFile(join(dir, 'master.m3u8'), playlist(pieces))
      await publisher.flush()
      // The writer adds one piece, and writes the playlist again whole.
      await writeFile(join(dir, segment(staged)), `fragment ${staged}`)
      staged++
      await writeFile(join(dir, 'master.m3u8'), playlist(pieces + 1))
      calls = {}
      const before = reader.bytesRead
      sunk.length = 0
      await publisher.flush()
      const bytes = reader.bytesRead - before
      console.log(
        `${pieces} pieces + 1: read ${bytes} bytes of ${playlist(pieces + 1).length}, ${JSON.stringify(calls)}`
      )
      expect(await readFile(object('index.m3u8'), 'utf8')).equals(
        playlist(pieces + 1)
      )
      expect(sunk).deep.equals([
        { kind: 'append', text: `#EXTINF:4,\n${segment(pieces)}\n` }
      ])
      // The first and last kilobyte before the old end, and the new piece.
      expect(bytes).equals(2048 + `#EXTINF:4,\n${segment(pieces)}\n`.length)
      measured.push({ bytes, calls: { ...calls } })
    }
    expect(measured[0].calls).deep.equals({
      openSync: 1,
      fstatSync: 1,
      readSync: 2,
      closeSync: 1
    })
    expect(measured[1]).deep.equals(measured[0])
  })

  it('publishes a playlist it cannot build on piece by piece from its whole text, as before', async function () {
    const publisher = new OriginPublisher(options)
    await stage(2)
    // A name with space after it, last: the published body trims it.
    await writeFile(
      join(dir, 'master.m3u8'),
      playlist(2).replace(`${segment(1)}\n`, `${segment(1)}  \n`)
    )
    await publisher.flush()
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(2))
    // Clean again, one piece on: built on, and the sink gets the piece.
    await writeFile(join(dir, segment(2)), 'fragment 2')
    await writeFile(join(dir, 'master.m3u8'), playlist(3))
    sunk.length = 0
    await publisher.flush()
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(3))
    expect(sunk).deep.equals([
      { kind: 'append', text: `#EXTINF:4,\n${segment(2)}\n` }
    ])
    // A piece listed twice is published from the whole text too.
    await writeFile(
      join(dir, 'master.m3u8'),
      playlist(3) + `#EXTINF:4,\n${segment(2)}\n`
    )
    const twice = await publisher.flush()
    expect(twice.body).equals(playlist(3) + `#EXTINF:4,\n${segment(2)}\n`)
  })

  it('refuses a rewritten playlist that lost a published piece, at every flush', async function () {
    const publisher = new OriginPublisher(options)
    await stage(3)
    await publisher.flush()
    await writeFile(join(dir, 'master.m3u8'), playlist(2))
    expect(await failure(publisher.flush())).contains(
      'lost a published segment'
    )
    expect(await failure(publisher.flush())).contains(
      'lost a published segment'
    )
  })

  it('holds every piece by sequence number across the flushes of a growing recording, so no playlist body stays alive', async function () {
    // A piece's name parsed out of a playlist body is a slice of that body,
    // and a slice keeps the whole body it was cut from. Names kept across
    // flushes kept every body the recording had: n²/2 lines at n pieces.
    this.timeout(120_000)
    await writeFile(join(dir, 'init.mp4'), 'an init segment')
    const pieces = 120
    const publisher = new OriginPublisher(options)
    for (let n = 0; n < pieces; n++) {
      await writeFile(join(dir, segment(n)), `fragment ${n}`)
      await writeFile(join(dir, 'master.m3u8'), playlist(n + 1))
      await publisher.flush()
    }
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(
      playlist(pieces)
    )
    interface Held {
      acknowledged: Map<unknown, unknown>
      published: Set<unknown>
      kept: Map<unknown, unknown>
      cursor: number
      cursorNumber?: unknown
    }
    const keys = (held: Held): unknown[] => [
      ...held.acknowledged.keys(),
      ...held.published,
      ...held.kept.keys(),
      held.cursorNumber
    ]
    const held = publisher as unknown as Held
    expect(held.published.size).equals(pieces)
    expect(held.acknowledged.size).equals(pieces + 1)
    expect(held.cursor).equals(pieces)
    expect(held.cursorNumber).equals(pieces - 1)
    expect(keys(held).filter(key => typeof key !== 'number')).deep.equals([])
    // A restart seeds them from the published body it reads back.
    const restarted = new OriginPublisher(options)
    await restarted.flush()
    const seeded = restarted as unknown as Held
    expect(seeded.published.size).equals(pieces)
    expect(keys(seeded).filter(key => typeof key !== 'number')).deep.equals([])
  })

  it('uploads again a piece rewritten after acknowledgement while it is after the cursor', async function () {
    await stage(3)
    store.faults.set({ method: 'PUT', key: /seg000002/, delayMs: 100 })
    const arrived = new Promise<void>(resolve =>
      store.server.on('request', req => {
        if (req.method === 'PUT' && req.url!.includes('seg000002')) resolve()
      })
    )
    const publisher = new OriginPublisher(options)
    const flushing = publisher.flush()
    await arrived
    // seg000001 is already acknowledged; the cursor stops before it.
    await rewrite(segment(1), 'changed  1')
    await flushing
    store.faults.clear()
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(1))
    requests.length = 0
    stats.length = 0
    await publisher.flush()
    expect(puts()).deep.equals([segment(1), 'index.m3u8'])
    expect(stats).not.contains(segment(0))
    expect(await readFile(object(segment(1)), 'utf8')).equals('changed  1')
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(3))
  })

  it('uploads no empty init or piece, and fails no flush over one, until it has bytes', async function () {
    await stage(2)
    await writeFile(join(dir, 'init.mp4'), '')
    const publisher = new OriginPublisher(options)
    expect(await publisher.flush()).deep.equals({ complete: false })
    expect(puts()).deep.equals([])
    await rewrite('init.mp4', 'an init segment')
    await rewrite(segment(1), '')
    await publisher.flush()
    expect(puts()).deep.equals([
      'init.mp4',
      segment(0),
      'index.m3u8',
      'master.m3u8'
    ])
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(1))
    requests.length = 0
    await rewrite(segment(1), 'fragment 1')
    await publisher.flush()
    expect(puts()).deep.equals([segment(1), 'index.m3u8'])
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(2))
  })

  it('keeps a piece the writer may still move after the cursor until it settles', async function () {
    await stage(3)
    let movable = new Set([segment(1), segment(2)])
    options.mayMove = name => movable.has(name)
    const publisher = new OriginPublisher(options)
    await publisher.flush()
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(playlist(3))
    // Placing the writer moves its pieces with no change to the playlist.
    await rewrite(segment(1), 'placed  1')
    movable = new Set()
    requests.length = 0
    stats.length = 0
    await publisher.flush()
    expect(puts()).deep.equals([segment(1)])
    expect(stats).not.contains(segment(0))
    expect(await readFile(object(segment(1)), 'utf8')).equals('placed  1')
    stats.length = 0
    await publisher.flush()
    expect(stats).deep.equals(['master.m3u8'])
  })

  it("uploads a reconnect's rewritten init.mp4 before any piece after the cursor", async function () {
    await stage(3)
    const publisher = new OriginPublisher(options)
    await publisher.flush()
    await rewrite('init.mp4', 'a reconnected init')
    await writeFile(join(dir, segment(3)), 'fragment 3')
    await writeFile(join(dir, segment(4)), 'fragment 4')
    await rewrite('master.m3u8', reconnected(3, 5))
    requests.length = 0
    stats.length = 0
    await publisher.flush()
    expect(puts()).deep.equals([
      'init.mp4',
      segment(3),
      segment(4),
      'index.m3u8'
    ])
    for (const n of [0, 1, 2]) expect(stats).not.contains(segment(n))
    expect(await readFile(object('init.mp4'), 'utf8')).equals(
      'a reconnected init'
    )
    expect(await readFile(object('index.m3u8'), 'utf8')).equals(
      reconnected(3, 5)
    )
  })

  it('hands the sink suffixes that add up to the published body, and a replacement for a body that does not extend', async function () {
    const publisher = new OriginPublisher(options)
    await stage(1)
    await publisher.flush()
    for (const [count, ended] of [
      [2, false],
      [3, true]
    ] as const) {
      await writeFile(join(dir, segment(count - 1)), `fragment ${count - 1}`)
      await rewrite('master.m3u8', playlist(count, ended))
      await publisher.flush()
    }
    expect(sunk.map(call => call.kind)).deep.equals([
      'replace',
      'append',
      'append'
    ])
    const published = await readFile(object('index.m3u8'), 'utf8')
    expect(published).equals(playlist(3, true))
    expect(sunk.map(call => call.text).join('')).equals(published)
    // Reopened after its end: the new body drops #EXT-X-ENDLIST.
    await writeFile(join(dir, segment(3)), 'fragment 3')
    await rewrite('master.m3u8', reconnected(3, 4))
    await publisher.flush()
    expect(sunk.at(-1)).deep.equals({
      kind: 'replace',
      text: await readFile(object('index.m3u8'), 'utf8')
    })
    await writeFile(join(dir, segment(4)), 'fragment 4')
    await rewrite('master.m3u8', reconnected(3, 5))
    await publisher.flush()
    expect(sunk.at(-1)?.kind).equals('append')
    expect(
      sunk
        .slice(-2)
        .map(call => call.text)
        .join('')
    ).equals(await readFile(object('index.m3u8'), 'utf8'))
    // A publisher without a sink publishes the same, into the no-op sink.
    delete options.playlistSink
    delete options.files
    const plain = new OriginPublisher({
      ...options,
      videoId: 'vid_plain'
    })
    await plain.flush()
    expect(
      await readFile(join(remote, 'videos/vid_plain/index.m3u8'), 'utf8')
    ).equals(reconnected(3, 5))
  })

  describe('a recording that goes on at a larger picture', function () {
    /** Real fragments of one configuration, under the names a writer gives. */
    const encode = (
      size: string,
      level: string,
      init: string,
      firstSegment: number
    ): void => {
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=10:duration=2`,
        '-c:v',
        'libx264',
        '-level',
        level,
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
        '-hls_fmp4_init_filename',
        init,
        '-start_number',
        String(firstSegment),
        '-hls_segment_filename',
        join(dir, 'seg%06d.m4s'),
        join(dir, 'part.m3u8')
      ])
    }
    const SECOND_INIT = 'init000002.mp4'
    const entry = (n: number): string => `#EXTINF:1,\n${segment(n)}\n`
    const listed = (ended: boolean): string =>
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n${entry(0)}${entry(1)}#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${SECOND_INIT}"\n${entry(2)}${entry(3)}${ended ? '#EXT-X-ENDLIST\n' : ''}`
    const master = async (): Promise<string> =>
      await readFile(object('master.m3u8'), 'utf8')

    beforeEach(async function () {
      encode('160x90', '3.0', 'init.mp4', 0)
      encode('320x180', '4.0', SECOND_INIT, 2)
      options.probe = async () => ({
        codecName: 'h264',
        codecTag: 'avc1',
        width: 160,
        height: 90
      })
    })

    it('says the most any part needs in the master, and the largest picture on the row', async function () {
      await writeFile(join(dir, 'master.m3u8'), listed(false))
      await new OriginPublisher(options).flush()
      const written = await master()
      expect(written).contains('RESOLUTION=320x180')
      expect(written).matches(/CODECS="avc1\.[0-9a-f]{4}28"/)
      expect(written).contains('\nindex.m3u8\n')
      expect(pictures).deep.equals([{ width: 320, height: 180 }])
      expect(logged).deep.equals([])
    })

    it('leaves the first part’s master alone until a second part is listed, and writes it once', async function () {
      await writeFile(
        join(dir, 'master.m3u8'),
        listed(false).split('#EXT-X-DISCONTINUITY')[0]
      )
      const publisher = new OriginPublisher(options)
      await publisher.flush()
      expect(await master()).contains('RESOLUTION=160x90')
      expect(pictures).deep.equals([])

      await writeFile(join(dir, 'master.m3u8'), listed(false))
      await publisher.flush()
      expect(await master()).contains('RESOLUTION=320x180')
      expect(pictures).length(1)

      requests.length = 0
      await publisher.flush()
      expect(puts()).deep.equals([])
      expect(pictures).length(1)
    })

    it('writes it again from a new process, and at close', async function () {
      await writeFile(join(dir, 'master.m3u8'), listed(false))
      await new OriginPublisher(options).flush()
      await writeFile(object('master.m3u8'), 'an old master')
      await writeFile(join(dir, 'master.m3u8'), listed(true))
      const closed = await new OriginPublisher(options).flush({ close: true })
      expect(closed.complete).equals(true)
      expect(await master()).contains('RESOLUTION=320x180')
    })

    it('finishes the close and logs it when the master cannot be written, and tries again', async function () {
      await writeFile(join(dir, 'master.m3u8'), listed(false))
      const publisher = new OriginPublisher(options)
      store.faults.set({ method: 'PUT', key: /master\.m3u8$/, status: 500 })
      await failure(publisher.flush())
      store.faults.clear()
      await publisher.flush()
      expect(await master()).contains('RESOLUTION=320x180')
      expect(logged).deep.equals([])

      const closing = new OriginPublisher(options)
      await writeFile(join(dir, 'master.m3u8'), listed(true))
      store.faults.set({ method: 'PUT', key: /master\.m3u8$/, status: 500 })
      const closed = await closing.flush({ close: true })
      expect(closed.complete, 'the recording is on the Space').equals(true)
      expect(logged.join('\n')).contains('vid_origin master of 2 parts')

      store.faults.clear()
      await closing.flush({ close: true })
      expect(puts()).contains('master.m3u8')
    })

    it('finishes the close when the row cannot be told', async function () {
      await writeFile(join(dir, 'master.m3u8'), listed(true))
      options.onLargestPicture = async () => {
        throw new Error('database failed')
      }
      const closed = await new OriginPublisher(options).flush({ close: true })
      expect(closed.complete).equals(true)
      expect(logged.join('\n')).contains('database failed')
    })

    it('sizes a part the tail has deleted whole from what it knew of it, before and after a restart', async function () {
      const THIRD_INIT = 'init000004.mp4'
      encode('640x360', '4.1', THIRD_INIT, 4)
      const three =
        listed(false) +
        `#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${THIRD_INIT}"\n${entry(4)}${entry(5)}`
      // Pieces end at 1, 2, 3 and 4 s: with a 1 s tail, all of part 1 goes.
      const tailing = {
        ...options,
        localTailSec: 1,
        scanned: () => ({ segments: 6 })
      }
      await writeFile(join(dir, 'master.m3u8'), listed(false))
      const publisher = new OriginPublisher(tailing)
      await publisher.flush()
      await publisher.flush()
      const left = await readdir(dir)
      expect(left).not.includes(segment(0))
      expect(left).not.includes(segment(1))

      await writeFile(join(dir, 'master.m3u8'), three)
      await publisher.flush()
      expect(logged).deep.equals([])
      const written = await master()
      expect(written).contains('RESOLUTION=640x360')
      expect(pictures.at(-1)).deep.equals({ width: 640, height: 360 })

      // A new process knows part 1's first piece only from the Space.
      await writeFile(object('master.m3u8'), 'an old master')
      await new OriginPublisher(tailing).flush()
      expect(logged).deep.equals([])
      expect(await master()).equals(written)
    })

    it('leaves out a picture size no part can say', async function () {
      options.probe = async () => ({ codecName: 'h264', codecTag: 'avc1' })
      await writeFile(join(dir, 'init.mp4'), 'an init segment')
      await writeFile(join(dir, SECOND_INIT), 'a second init segment')
      await writeFile(join(dir, 'master.m3u8'), listed(false))
      await new OriginPublisher(options).flush()
      expect(await master()).not.contains('RESOLUTION')
      expect(pictures).deep.equals([])
    })
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

describe('reading a deleted piece back from the Space', function () {
  /** A Space answering each GET with the next status, then 200 and the piece. */
  async function answering(
    statuses: number[]
  ): Promise<{ read: PartReader; asked: () => number; close: () => void }> {
    let asked = 0
    const server = createServer((_req, res) => {
      const status = statuses[asked++] ?? 200
      res.writeHead(status).end(status === 200 ? 'fragment 0' : '')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
      read: spacePartReader(
        {
          endpoint: `http://127.0.0.1:${port}`,
          region: 'test',
          bucket: 'test',
          accessKeyId: 'example',
          secretAccessKey: 'example',
          pathStyle: true
        },
        { id: 'vid_origin', spaceSecret: null },
        { retryMs: 0 }
      ),
      asked: () => asked,
      close: () => {
        server.closeAllConnections()
        server.close()
      }
    }
  }
  const gone = join(tmpdir(), 'tsPartReaderGone', segment(0))

  it('asks again after a 5xx or a slow-down, three times in all', async () => {
    const once = await answering([503])
    try {
      expect(Buffer.from(await once.read(gone)).toString()).equals('fragment 0')
      expect(once.asked()).equals(2)
    } finally {
      once.close()
    }
    const always = await answering([500, 429, 503, 200])
    try {
      expect(await failure(always.read(gone))).contains('answered 503')
      expect(always.asked()).equals(3)
    } finally {
      always.close()
    }
  })

  it('fails at once on an answer the Space will give again', async () => {
    const missing = await answering([404])
    try {
      expect(await failure(missing.read(gone))).contains('answered 404')
      expect(missing.asked()).equals(1)
    } finally {
      missing.close()
    }
  })

  it('gives up on a read that stalls, rather than holding the close', async () => {
    // Accepts the connection and never answers.
    const server = createServer(() => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const folder = await mkdtemp(join(tmpdir(), 'tsPartReader-'))
    try {
      const read = spacePartReader(
        {
          endpoint: `http://127.0.0.1:${port}`,
          region: 'test',
          bucket: 'test',
          accessKeyId: 'example',
          secretAccessKey: 'example',
          pathStyle: true
        },
        { id: 'vid_origin', spaceSecret: null },
        { timeoutMs: 100, attempts: 2, retryMs: 0 }
      )
      const started = Date.now()
      expect(await failure(read(join(folder, segment(0))))).matches(
        /TimeoutError|aborted/
      )
      expect(Date.now() - started).below(2000)
    } finally {
      server.closeAllConnections()
      server.close()
      await rm(folder, { recursive: true, force: true })
    }
  })
})
