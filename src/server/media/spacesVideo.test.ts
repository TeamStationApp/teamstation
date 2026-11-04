import { expect } from 'chai'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { after, before, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import { startFakeSpace } from '../dev/fakeSpace'
import { putObject } from './images'
import type { SpaceSettings } from './spacesHls'
import {
  contentTypeFor,
  deleteVideoFromSpace,
  lengthFromContentRange,
  listSpaceObjects,
  uploadVideoDirectory,
  verifyVideoDirectory
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

  it('deletes only the old prefix of a video with no secret', async function () {
    await put('videos/vid_c/video.mp4')
    await put(`videos/vid_c-${SECRET}/video.mp4`)
    expect(
      await deleteVideoFromSpace({ space, videoId: 'vid_c', spaceSecret: null })
    ).deep.equals({ deleted: 1 })
    expect(await listSpaceObjects(space, 'videos/vid_c')).deep.equals([
      `videos/vid_c-${SECRET}/video.mp4`
    ])
  })
})
