import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { clearFragmentCache, fetchSpaceFrame, fragmentAt } from './spaceFrames'

const SPACE = {
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  region: 'sfo3',
  bucket: 'example-media-bkt',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
}

// Four six-second fragments, shaped like the ones the remux writes.
const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="video.mp4",BYTERANGE="1402@0"
#EXTINF:6.000000,
#EXT-X-BYTERANGE:1000@1402
video.mp4
#EXTINF:6.000000,
#EXT-X-BYTERANGE:2000@2402
video.mp4
#EXTINF:6.000000,
#EXT-X-BYTERANGE:3000@4402
video.mp4
#EXTINF:6.000000,
#EXT-X-BYTERANGE:4000@7402
video.mp4
#EXT-X-ENDLIST
`

describe('finding the fragment that holds a second', function () {
  it('takes the fragment the moment falls inside', function () {
    expect(fragmentAt(PLAYLIST, 0)?.segment).deep.equals({
      length: 1000,
      offset: 1402
    })
    expect(fragmentAt(PLAYLIST, 13)?.segment).deep.equals({
      length: 3000,
      offset: 4402
    })
    expect(fragmentAt(PLAYLIST, 23.9)?.segment).deep.equals({
      length: 4000,
      offset: 7402
    })
  })

  it('reports where that fragment starts, so the seek can be relative', function () {
    expect(fragmentAt(PLAYLIST, 13)?.startSec).equals(12)
    expect(fragmentAt(PLAYLIST, 12)?.startSec).equals(12)
    // A boundary belongs to the fragment that starts there, not the one that
    // ends there: seeking to the last instant of a fragment decodes the whole
    // of it for a picture the next one opens with.
    expect(fragmentAt(PLAYLIST, 11.999)?.startSec).equals(6)
  })

  it('carries the init segment, which a fragment cannot be read without', function () {
    expect(fragmentAt(PLAYLIST, 13)?.init).deep.equals({
      length: 1402,
      offset: 0
    })
  })

  it('has nothing past the end', function () {
    expect(fragmentAt(PLAYLIST, 24)).equals(undefined)
    expect(fragmentAt(PLAYLIST, 10000)).equals(undefined)
  })

  it('continues from the previous range when an offset is left out', function () {
    const terse = `#EXTM3U
#EXT-X-MAP:URI="video.mp4",BYTERANGE="1402@0"
#EXTINF:6.000000,
#EXT-X-BYTERANGE:1000
video.mp4
#EXTINF:6.000000,
#EXT-X-BYTERANGE:2000
video.mp4
#EXT-X-ENDLIST
`
    // The first picks up where the map ends, the second where the first does.
    expect(fragmentAt(terse, 1)?.segment).deep.equals({
      length: 1000,
      offset: 1402
    })
    expect(fragmentAt(terse, 7)?.segment).deep.equals({
      length: 2000,
      offset: 2402
    })
  })

  it('refuses a playlist with no map, rather than reading a headless fragment', function () {
    const headless = `#EXTM3U
#EXTINF:6.000000,
#EXT-X-BYTERANGE:1000@0
video.mp4
#EXT-X-ENDLIST
`
    expect(fragmentAt(headless, 1)).equals(undefined)
  })
})

describe('fetching one fragment out of the Space', function () {
  const workDir = join(tmpdir(), `tsFrames-${process.pid}`)
  const object = Buffer.alloc(11402)
  // Marked so the assembled file can be checked byte for byte.
  object.fill(0xaa, 0, 1402)
  object.fill(0xbb, 4402, 7402)

  let ranges: string[] = []

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    if (href.includes('video.m3u8')) {
      return new Response(PLAYLIST, { status: 200 })
    }
    const header = String(
      (init?.headers as Record<string, string> | undefined)?.range ?? ''
    )
    ranges.push(header)
    const found = /bytes=(\d+)-(\d+)/.exec(header)
    if (found == null) return new Response('', { status: 200 })
    const body = object.subarray(Number(found[1]), Number(found[2]) + 1)
    return new Response(body, { status: 206 })
  }) as unknown as typeof fetch

  beforeEach(function () {
    ranges = []
    clearFragmentCache()
  })

  afterEach(async function () {
    await rm(workDir, { recursive: true, force: true })
  })

  it('reads the init segment and one fragment, and nothing else', async function () {
    const frame = await fetchSpaceFrame({
      space: SPACE,
      videoId: 'vid_abc',
      atSec: 13,
      workDir,
      fetch: fakeFetch
    })
    if (frame == null) throw new Error('expected a frame')

    expect(ranges).deep.equals(['bytes=0-1401', 'bytes=4402-7401'])

    // Init first: the other way round FFmpeg has a fragment and no codec.
    const written = await readFile(frame.path)
    expect(written.length).equals(1402 + 3000)
    expect(written[0]).equals(0xaa)
    expect(written[1402]).equals(0xbb)

    await frame.release()
    expect(await readFile(frame.path).catch(() => null)).equals(null)
  })

  it('seeks from the fragment start, not from the start of the game', async function () {
    const frame = await fetchSpaceFrame({
      space: SPACE,
      videoId: 'vid_abc',
      atSec: 13,
      workDir,
      fetch: fakeFetch
    })
    // Second 13 of the video is second 1 of the fragment that holds it.
    expect(frame?.seekSec).equals(1)
    await frame?.release()
  })

  it('has nothing to offer past the end of the video', async function () {
    const frame = await fetchSpaceFrame({
      space: SPACE,
      videoId: 'vid_abc',
      atSec: 500,
      workDir,
      fetch: fakeFetch
    })
    expect(frame).equals(undefined)
  })

  it('gives up when the Space ignores the range', async function () {
    const whole = (async (url: string | URL) =>
      String(url).includes('video.m3u8')
        ? new Response(PLAYLIST, { status: 200 })
        : new Response(object, { status: 200 })) as unknown as typeof fetch

    const frame = await fetchSpaceFrame({
      space: SPACE,
      videoId: 'vid_abc',
      atSec: 13,
      workDir,
      fetch: whole
    })
    // A 200 is the whole 2 GB object on its way, which is the thing this
    // module exists to avoid.
    expect(frame).equals(undefined)
  })

  it('gives two stills of the same video files of their own', async function () {
    const [one, two] = await Promise.all([
      fetchSpaceFrame({
        space: SPACE,
        videoId: 'vid_abc',
        atSec: 13,
        workDir,
        fetch: fakeFetch
      }),
      fetchSpaceFrame({
        space: SPACE,
        videoId: 'vid_abc',
        atSec: 13,
        workDir,
        fetch: fakeFetch
      })
    ])
    expect(one?.path).not.equals(two?.path)
    // One releasing must not take the other's file away mid-read.
    await one?.release()
    expect((await readFile(two?.path ?? '')).length).equals(1402 + 3000)
    await two?.release()
  })
})
