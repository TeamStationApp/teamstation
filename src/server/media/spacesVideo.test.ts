import { expect } from 'chai'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  contentTypeFor,
  lengthFromContentRange,
  verifyVideoDirectory
} from './spacesVideo'

const SPACE = {
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  region: 'sfo3',
  bucket: 'gamestation',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  pathStyle: false
}

async function stagedVideo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gs-spaces-'))
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
