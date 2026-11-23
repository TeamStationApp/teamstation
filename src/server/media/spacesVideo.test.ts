import { expect } from 'chai'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { createServer, type Server } from 'http'
import { after, before, beforeEach, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  FakeSpaceFaults,
  fakeSpaceHandler,
  startFakeSpace
} from '../dev/fakeSpace'
import { putObject, SpaceRefusal } from './images'
import type { SpaceSettings } from './spacesHls'
import {
  contentTypeFor,
  deleteVideoFromSpace,
  eachInFlight,
  lengthFromContentRange,
  listSpaceObjects,
  OBJECTS_IN_FLIGHT,
  SPACE_RETRY_WAITS_MS,
  uploadVideoDirectory,
  verifyVideoDirectory,
  withSpaceRetry
} from './spacesVideo'
import { videoPrefix } from './videoPrefix'

const SPACE = {
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  region: 'sfo3',
  bucket: 'teamstation',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  pathStyle: false
}

async function stagedVideo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ts-spaces-'))
  await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n')
  await writeFile(join(dir, 'video.m3u8'), '#EXTM3U\nvideo.mp4\n')
  await writeFile(join(dir, 'video.mp4'), Buffer.alloc(2048, 7))
  return dir
}

/** A Space that answers as the real one does, and can be told to lie. */
function fakeSpace(options: {
  size?: number
  playlist?: string
  status?: number
}): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = input
    const status = options.status ?? 200
    if (status !== 200) {
      return new Response('no', { status })
    }
    if (url.includes('.m3u8')) {
      const body = options.playlist ?? '#EXTM3U\n#EXT-X-VERSION:7\n'
      return new Response(body, { status: 200 })
    }
    const size = options.size ?? 2048
    const range = (init?.headers as Record<string, string> | undefined)?.range
    if (range == null) return new Response('', { status: 200 })
    return new Response(Buffer.from([0]), {
      status: 206,
      headers: { 'content-range': `bytes 0-0/${size}` }
    })
  }) as unknown as typeof fetch
}

describe('a recording in the Space', function () {
  it('tells a player what each file is', function () {
    expect(contentTypeFor('master.m3u8')).equals(
      'application/vnd.apple.mpegurl'
    )
    expect(contentTypeFor('seg000001.m4s')).equals('video/iso.segment')
    expect(contentTypeFor('video.mp4')).equals('video/mp4')
    expect(contentTypeFor('notes.txt')).equals('application/octet-stream')
  })

  it('reads a length out of a byte-range answer', function () {
    expect(lengthFromContentRange('bytes 0-0/12345')).equals(12345)
    expect(lengthFromContentRange('bytes 0-99/500')).equals(500)
    expect(lengthFromContentRange('')).equals(undefined)
    expect(lengthFromContentRange('bytes */1000')).equals(undefined)
  })

  it('passes when every file is there at the right length', async function () {
    const dir = await stagedVideo()
    try {
      // A Space that gives back exactly what was put in it, which is the
      // whole of what "it uploaded" is supposed to mean.
      const honest = (async (input: string, init?: RequestInit) => {
        const name = /videos\/vid_test\/([^?]+)/.exec(input)?.[1] ?? ''
        const bytes = await readFile(join(dir, name))
        const range = (init?.headers as Record<string, string> | undefined)
          ?.range
        if (range == null) return new Response(bytes, { status: 200 })
        return new Response(bytes.subarray(0, 1), {
          status: 206,
          headers: { 'content-range': `bytes 0-0/${bytes.length}` }
        })
      }) as unknown as typeof fetch

      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_test',
        spaceSecret: null,
        dir,
        files: ['master.m3u8', 'video.m3u8', 'video.mp4'],
        fetch: honest
      })
      expect(result.ok).equals(true)
      if (!result.ok) return
      expect(result.checked).equals(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a file that came back a different length', async function () {
    const dir = await stagedVideo()
    try {
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_test',
        spaceSecret: null,
        dir,
        files: ['video.mp4'],
        fetch: fakeSpace({ size: 2047 })
      })
      expect(result.ok).equals(false)
      if (result.ok) return
      expect(result.reason).contains('2047 bytes there and 2048 here')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a playlist that came back different', async function () {
    const dir = await stagedVideo()
    try {
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_test',
        spaceSecret: null,
        dir,
        files: ['master.m3u8'],
        fetch: fakeSpace({ playlist: '#EXTM3U\nsomething else\n' })
      })
      expect(result.ok).equals(false)
      if (result.ok) return
      expect(result.reason).contains('came back different')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses when the Space will not answer at all', async function () {
    const dir = await stagedVideo()
    try {
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_test',
        spaceSecret: null,
        dir,
        files: ['video.mp4'],
        fetch: fakeSpace({ status: 403 })
      })
      expect(result.ok).equals(false)
      if (result.ok) return
      expect(result.reason).contains('403')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to call an empty upload verified', async function () {
    const dir = await stagedVideo()
    try {
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_test',
        spaceSecret: null,
        dir,
        files: ['nothing-here.m4s'],
        fetch: fakeSpace({})
      })
      expect(result.ok).equals(false)
      if (result.ok) return
      expect(result.reason).equals('nothing to verify')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a video’s objects under its secret path', function () {
  this.timeout(30000)
  const SECRET = '0123456789abcdef0123456789abcdef'
  const OTHER = 'fedcba9876543210fedcba9876543210'
  let root: string
  let fake: Awaited<ReturnType<typeof startFakeSpace>>
  const space: SpaceSettings = {
    endpoint: '',
    region: 'test',
    bucket: 'test',
    accessKeyId: 'example',
    secretAccessKey: 'example',
    pathStyle: true
  }
  const plain = (key: string): string =>
    `${space.endpoint}/${space.bucket}/${key}`
  const put = async (key: string): Promise<void> => {
    await putObject({
      space,
      key,
      body: Buffer.from('x'),
      contentType: 'video/mp4'
    })
  }

  before(async function () {
    root = await mkdtemp(join(tmpdir(), 'ts-secret-space-'))
    fake = await startFakeSpace({ space, dir: root })
    space.endpoint = fake.url
  })
  after(async function () {
    fake.server.close()
    await rm(root, { recursive: true, force: true })
  })

  it('uploads a finished recording public where its kind is, and verifies it there', async function () {
    const dir = await stagedVideo()
    try {
      const video = { id: 'vid_up', spaceSecret: SECRET }
      const uploaded = await uploadVideoDirectory({
        space,
        videoId: video.id,
        spaceSecret: SECRET,
        dir
      })
      expect(
        await verifyVideoDirectory({
          space,
          videoId: video.id,
          spaceSecret: SECRET,
          dir,
          files: uploaded.files
        })
      ).deep.equals({ ok: true, checked: 3 })
      const prefix = videoPrefix(video)
      const recording = await fetch(plain(`${prefix}video.mp4`))
      expect(recording.status).equals(200)
      expect(recording.headers.get('cache-control')).equals(
        'public, max-age=600'
      )
      expect((await fetch(plain(`${prefix}video.m3u8`))).status).equals(403)
      expect((await fetch(plain(`${prefix}master.m3u8`))).status).equals(403)

      // With no secret: the old path, every object private.
      await uploadVideoDirectory({
        space,
        videoId: 'vid_up',
        spaceSecret: null,
        dir,
        files: ['video.mp4']
      })
      const old = await fetch(plain('videos/vid_up/video.mp4'))
      expect(old.status).equals(403)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deletes both of a video’s prefixes, and leaves a video whose id shares them', async function () {
    await put(`videos/vid_a-${SECRET}/seg000000.m4s`)
    await put('videos/vid_a/stills/3.jpg')
    await put(`videos/vid_a-b-${OTHER}/seg000000.m4s`)
    await put('videos/vid_a-b/stills/3.jpg')
    expect(
      await deleteVideoFromSpace({
        space,
        videoId: 'vid_a',
        spaceSecret: SECRET
      })
    ).deep.equals({ deleted: 2 })
    expect(await listSpaceObjects(space, 'videos/vid_a')).deep.equals([
      `videos/vid_a-b-${OTHER}/seg000000.m4s`,
      'videos/vid_a-b/stills/3.jpg'
    ])
    await deleteVideoFromSpace({
      space,
      videoId: 'vid_a-b',
      spaceSecret: OTHER
    })
  })

  it('names a failed delete under a secret path without the secret', async function () {
    await put(`videos/vid_a-${SECRET}/seg000000.m4s`)
    fake.faults.set({ method: 'DELETE', key: /seg000000/, status: 500 })
    let message = ''
    try {
      await deleteVideoFromSpace({
        space,
        videoId: 'vid_a',
        spaceSecret: SECRET
      })
    } catch (error) {
      message = String(error)
    }
    expect(message).contains(
      `Deleting videos/vid_a-${SECRET.slice(0, 4)}…/seg000000.m4s answered 500`
    )
    expect(message).not.contains(SECRET)
    fake.faults.clear()
    await deleteVideoFromSpace({ space, videoId: 'vid_a', spaceSecret: SECRET })
  })

  it('finds a secret prefix nobody holds the secret of, by listing, exactly', async function () {
    await put(`videos/vid_a-${SECRET}/seg000000.m4s`)
    await put(`videos/vid_a-${OTHER}/init.mp4`)
    await put('videos/vid_a/stills/3.jpg')
    await put(`videos/vid_a-b-${OTHER}/seg000000.m4s`)
    await put(`videos/vid_a-${SECRET}x/seg000000.m4s`)
    expect(
      await deleteVideoFromSpace({
        space,
        videoId: 'vid_a',
        spaceSecret: undefined
      })
    ).deep.equals({ deleted: 3 })
    expect(await listSpaceObjects(space, 'videos/vid_a')).deep.equals([
      `videos/vid_a-${SECRET}x/seg000000.m4s`,
      `videos/vid_a-b-${OTHER}/seg000000.m4s`
    ])
  })

  it('deletes a video with no secret, and the copies a stopped move left under a secret prefix', async function () {
    await put('videos/vid_c/video.mp4')
    await put(`videos/vid_c-${SECRET}/video.mp4`)
    await put(`videos/vid_c-d-${OTHER}/video.mp4`)
    expect(
      await deleteVideoFromSpace({ space, videoId: 'vid_c', spaceSecret: null })
    ).deep.equals({ deleted: 2 })
    expect(await listSpaceObjects(space, 'videos/vid_c')).deep.equals([
      `videos/vid_c-d-${OTHER}/video.mp4`
    ])
    await deleteVideoFromSpace({
      space,
      videoId: 'vid_c-d',
      spaceSecret: OTHER
    })
  })
})

/** A segmented recording: init.mp4, `count` segments and the two playlists. */
async function segmentedVideo(count: number): Promise<{
  dir: string
  names: string[]
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ts-segmented-'))
  const segments = Array.from(
    { length: count },
    (_, i) => `seg${String(i).padStart(6, '0')}.m4s`
  )
  await writeFile(join(dir, 'init.mp4'), Buffer.alloc(512, 1))
  for (const name of segments)
    await writeFile(join(dir, name), Buffer.alloc(4096, 2))
  await writeFile(
    join(dir, 'video.m3u8'),
    `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n${segments.map(n => `#EXTINF:6.0,\n${n}\n`).join('')}#EXT-X-ENDLIST\n`
  )
  await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n')
  return {
    dir,
    names: ['init.mp4', 'master.m3u8', ...segments, 'video.m3u8']
  }
}

describe('a segmented recording going up', function () {
  this.timeout(60000)
  const SECRET = '0123456789abcdef0123456789abcdef'
  let root: string
  let server: Server
  const faults = new FakeSpaceFaults()
  const space: SpaceSettings = {
    endpoint: '',
    region: 'test',
    bucket: 'test',
    accessKeyId: 'example',
    secretAccessKey: 'example',
    pathStyle: true
  }
  /** Every request the Space saw: when it began and ended, in order. */
  let seen: Array<{ method: string; key: string; start: number; end: number }>
  let inFlight = 0
  let mostInFlight = 0

  before(async function () {
    root = await mkdtemp(join(tmpdir(), 'ts-segmented-space-'))
    const handler = fakeSpaceHandler({ space, dir: root, faults })
    server = createServer((req, res) => {
      const entry = {
        method: req.method ?? '',
        key: (req.url ?? '').split('?')[0],
        start: performance.now(),
        end: 0
      }
      seen.push(entry)
      inFlight++
      mostInFlight = Math.max(mostInFlight, inFlight)
      res.once('close', () => {
        inFlight--
        entry.end = performance.now()
      })
      handler(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    space.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  after(async function () {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(function () {
    seen = []
    inFlight = 0
    mostInFlight = 0
    faults.clear()
  })

  it('puts eight objects at a time, and the playlists after everything they list', async function () {
    const { dir, names } = await segmentedVideo(40)
    try {
      faults.set({ method: 'PUT', delayMs: 20 })
      const uploaded = await uploadVideoDirectory({
        space,
        videoId: 'vid_seg',
        spaceSecret: SECRET,
        dir
      })
      expect(uploaded.files).deep.equals([...names].sort())
      const puts = seen.filter(r => r.method === 'PUT')
      proofTrace(
        'upload of init.mp4, 40 segments and 2 playlists',
        puts,
        mostInFlight
      )
      expect(puts).length(names.length)
      expect(mostInFlight).equals(OBJECTS_IN_FLIGHT)
      const playlists = puts.filter(r => r.key.endsWith('.m3u8'))
      const media = puts.filter(r => !r.key.endsWith('.m3u8'))
      expect(playlists).length(2)
      const lastMedia = Math.max(...media.map(r => r.end))
      for (const playlist of playlists)
        expect(playlist.start).greaterThanOrEqual(lastMedia)
      expect(uploaded.bytes).equals(
        512 +
          40 * 4096 +
          (await sizeOf(dir, 'video.m3u8')) +
          (await sizeOf(dir, 'master.m3u8'))
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('checks every object, eight at a time, and the playlists last', async function () {
    const { dir, names } = await segmentedVideo(20)
    try {
      await uploadVideoDirectory({
        space,
        videoId: 'vid_check',
        spaceSecret: SECRET,
        dir
      })
      seen = []
      mostInFlight = 0
      faults.set({ method: 'GET', delayMs: 20 })
      const result = await verifyVideoDirectory({
        space,
        videoId: 'vid_check',
        spaceSecret: SECRET,
        dir,
        files: names
      })
      expect(result).deep.equals({ ok: true, checked: names.length })
      expect(mostInFlight).equals(OBJECTS_IN_FLIGHT)
      const gets = seen.filter(r => r.method === 'GET')
      const lastMedia = Math.max(
        ...gets.filter(r => !r.key.endsWith('.m3u8')).map(r => r.end)
      )
      for (const get of gets.filter(r => r.key.endsWith('.m3u8')))
        expect(get.start).greaterThanOrEqual(lastMedia)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops checking at the first object that is wrong', async function () {
    const { dir, names } = await segmentedVideo(60)
    try {
      let calls = 0
      const result = await verifyVideoDirectory({
        space,
        videoId: 'vid_wrong',
        spaceSecret: SECRET,
        dir,
        files: names,
        fetch: (async (url: string, init?: RequestInit) => {
          calls++
          await new Promise(resolve => setTimeout(resolve, 5))
          const size = url.includes('seg000000.m4s')
            ? 1
            : url.includes('init.mp4')
              ? 512
              : 4096
          return new Response(Buffer.from([0]), {
            status: init == null ? 200 : 206,
            headers: { 'content-range': `bytes 0-0/${size}` }
          })
        }) as unknown as typeof fetch
      })
      expect(result.ok).equals(false)
      if (!result.ok) expect(result.reason).contains('seg000000.m4s')
      // What was already running finishes; nothing new starts after it.
      expect(calls).lessThanOrEqual(OBJECTS_IN_FLIGHT * 2)
      expect(calls).lessThan(names.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('puts an object again when the Space says to slow down', async function () {
    const { dir } = await segmentedVideo(3)
    try {
      faults.set({ method: 'PUT', key: /seg000001/, status: 503, times: 2 })
      await uploadVideoDirectory({
        space,
        videoId: 'vid_slow',
        spaceSecret: SECRET,
        dir
      })
      const tries = seen.filter(
        r => r.method === 'PUT' && r.key.endsWith('seg000001.m4s')
      )
      proofTrace('a 503 Slow Down on seg000001.m4s, twice', seen, mostInFlight)
      expect(tries).length(3)
      expect(tries[1].start - tries[0].end).greaterThanOrEqual(
        SPACE_RETRY_WAITS_MS[0] - 5
      )
      expect(tries[2].start - tries[1].end).greaterThanOrEqual(
        SPACE_RETRY_WAITS_MS[1] - 5
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('slowing down for the Space', function () {
  it('waits 0.5 s doubling to 8 s, then gives up', async function () {
    const waits: number[] = []
    let tries = 0
    const refusal = new SpaceRefusal('Upload of k answered 503 SlowDown', 503)
    let thrown: unknown
    try {
      await withSpaceRetry(
        async () => {
          tries++
          throw refusal
        },
        async ms => {
          waits.push(ms)
        }
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).equals(refusal)
    expect(waits).deep.equals([500, 1000, 2000, 4000, 8000])
    expect(tries).equals(6)
  })

  it('does not retry any other failure', async function () {
    let tries = 0
    const refusal = new SpaceRefusal('Upload of k answered 403', 403)
    let thrown: unknown
    try {
      await withSpaceRetry(
        async () => {
          tries++
          throw refusal
        },
        async () => {}
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).equals(refusal)
    expect(tries).equals(1)
  })

  it('retries a reset, a timeout and any 5xx, and not a refusal of the request', async function () {
    const reset = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET'
    })
    const cases: Array<[unknown, number]> = [
      [reset, 6],
      [
        Object.assign(new Error('fetch failed'), {
          cause: { code: 'ETIMEDOUT' }
        }),
        6
      ],
      [new SpaceRefusal('Upload of k answered 500', 500), 6],
      [new SpaceRefusal('Upload of k answered 429', 429), 6],
      [new Error('The Space stopped answering'), 6],
      [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 6],
      [
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UND_ERR_HEADERS_TIMEOUT' }
        }),
        6
      ],
      [Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }), 6],
      // A caller cancelling is not the Space failing.
      [Object.assign(new Error('aborted'), { name: 'AbortError' }), 1],
      [new SpaceRefusal('Upload of k answered 404', 404), 1],
      [new Error('a bug'), 1]
    ]
    for (const [failure, expected] of cases) {
      let tries = 0
      await withSpaceRetry(
        async () => {
          tries++
          throw failure
        },
        async () => {}
      ).catch(() => undefined)
      expect(tries, String(failure)).equals(expected)
    }
  })

  it('answers once the Space takes it', async function () {
    let tries = 0
    const answer = await withSpaceRetry(
      async () => {
        if (++tries < 3) throw new SpaceRefusal('503', 503)
        return 'done'
      },
      async () => {}
    )
    expect(answer).equals('done')
    expect(tries).equals(3)
  })
})

describe('eachInFlight', function () {
  it('runs nothing for nothing', async function () {
    let ran = 0
    await eachInFlight([], 8, async () => {
      ran++
    })
    expect(ran).equals(0)
  })

  it('throws the first failure once what was running has finished', async function () {
    const finished: number[] = []
    let thrown: unknown
    try {
      await eachInFlight([1, 2, 3, 4, 5, 6], 3, async n => {
        if (n === 2) throw new Error('two')
        await new Promise(resolve => setTimeout(resolve, 10))
        finished.push(n)
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).equals('two')
    expect([...finished].sort((a, b) => a - b)).deep.equals([1, 3])
  })
})

async function sizeOf(dir: string, name: string): Promise<number> {
  return (await readFile(join(dir, name))).length
}

/** With TS_PROOF_TRACE set, prints the Space's requests as the proof log has them. */
function proofTrace(
  title: string,
  requests: Array<{ method: string; key: string; start: number; end: number }>,
  most: number
): void {
  if (process.env.TS_PROOF_TRACE == null) return
  const zero = Math.min(...requests.map(r => r.start))
  const name = (key: string): string => key.split('/').slice(-1)[0]
  console.log(
    `\n    ${title}: ${requests.length} requests, at most ${most} in flight`
  )
  console.log('    start ms   end ms  method object')
  for (const r of requests)
    console.log(
      `    ${(r.start - zero).toFixed(0).padStart(8)} ${(r.end - zero).toFixed(0).padStart(8)}  ${r.method.padEnd(6)} ${name(r.key)}`
    )
}

describe('checking a segmented recording that the Space is slowing down', function () {
  it('signs each try again, so retries cannot outlast one signature', async function () {
    const { dir, names } = await segmentedVideo(2)
    try {
      const signed: string[] = []
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_resigned',
        spaceSecret: null,
        dir,
        files: names,
        // Long enough for the next signature to carry a later second.
        sleep: async () => {
          await new Promise(resolve => setTimeout(resolve, 1100))
        },
        fetch: (async (url: string, init?: RequestInit) => {
          const name = url.split('?')[0].split('/').at(-1) ?? ''
          if (name === 'seg000001.m4s') {
            signed.push(new URL(url).searchParams.get('X-Amz-Date') ?? '')
            if (signed.length === 1)
              throw new DOMException('stalled', 'TimeoutError')
          }
          if (name.endsWith('.m3u8'))
            return new Response(await readFile(join(dir, name)), {
              status: 200
            })
          const size = (await readFile(join(dir, name))).length
          return new Response(Buffer.from([0]), {
            status: init == null ? 200 : 206,
            headers: { 'content-range': `bytes 0-0/${size}` }
          })
        }) as unknown as typeof fetch
      })
      expect(result).deep.equals({ ok: true, checked: names.length })
      expect(signed.length).equals(2)
      expect(signed[1] > signed[0], 'the retry is signed afresh').equals(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks again after a 503, and passes when the answer comes', async function () {
    const { dir, names } = await segmentedVideo(4)
    try {
      let refusals = 2
      const waits: number[] = []
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_slow',
        spaceSecret: null,
        dir,
        files: names,
        sleep: async ms => {
          waits.push(ms)
        },
        fetch: (async (url: string, init?: RequestInit) => {
          if (url.includes('seg000001.m4s') && refusals-- > 0)
            return new Response('SlowDown', { status: 503 })
          const name = url.split('?')[0].split('/').at(-1) ?? ''
          if (name.endsWith('.m3u8'))
            return new Response(await readFile(join(dir, name)), {
              status: 200
            })
          const size = (await readFile(join(dir, name))).length
          return new Response(Buffer.from([0]), {
            status: init == null ? 200 : 206,
            headers: { 'content-range': `bytes 0-0/${size}` }
          })
        }) as unknown as typeof fetch
      })
      expect(result).deep.equals({ ok: true, checked: names.length })
      expect(waits).deep.equals([500, 1000])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says it did not verify once the retries run out', async function () {
    const { dir, names } = await segmentedVideo(2)
    try {
      const result = await verifyVideoDirectory({
        space: SPACE,
        videoId: 'vid_slow',
        spaceSecret: null,
        dir,
        files: names,
        sleep: async () => {},
        fetch: async () => new Response('', { status: 503 })
      })
      expect(result.ok).equals(false)
      if (!result.ok) expect(result.reason).contains('503')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
