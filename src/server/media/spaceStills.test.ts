import { execFile } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { serverConfig } from '../serverConfig'
import { ffmpegEncoders, probeFfmpeg, remuxToHls } from './ffmpeg'
import { clearFragmentCache } from './spaceFrames'
import { ensureStill, MAX_CONCURRENT_CUTS, stillInSpace } from './stills'

const run = promisify(execFile)

/**
 * Cutting a still out of a video that is not on this host.
 *
 * The unit tests do the byte-range arithmetic against a made-up playlist. This
 * one runs the whole path on a real recording: FFmpeg writes a fragmented MP4,
 * a stand-in Space serves it over HTTP with ranges, and the still that comes
 * back has to be the same picture as the one cut from the file directly.
 *
 * That last comparison is the point. Every part of this can look like it works
 * while handing back the wrong moment — a fragment starts partway through the
 * game, so a seek measured from the start of the video lands somewhere else
 * entirely, and the result is still a plausible picture of a ball game.
 */
describe('a still from the Space', function () {
  this.timeout(180000)

  const ffmpegPath = serverConfig.ffmpegPath
  let workDir = ''
  let scratchRoot = ''
  const originalTemp = process.env.TMPDIR
  let ready = false
  let server: Server | undefined
  let port = 0
  /** What the stand-in Space was given, by key, and how many times. */
  const kept = new Map<string, Buffer>()
  let puts = 0

  const space = {
    endpoint: '',
    region: 'sfo3',
    bucket: 'b',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    pathStyle: true
  }

  before(async function () {
    try {
      await probeFfmpeg(ffmpegPath)
      ready = (await ffmpegEncoders(ffmpegPath)).has('libx265')
    } catch {
      ready = false
    }
    if (!ready) {
      this.skip()
      return
    }
    workDir = await mkdtemp(join(tmpdir(), 'tsSpaceStill-'))
    scratchRoot = await mkdtemp(join(workDir, 'scratch-'))
    // The cleanup assertion owns its temp root, even during concurrent suites.
    process.env.TMPDIR = scratchRoot
    await writeFile(join(workDir, 'ts-still-foreign'), 'foreign fixture')

    // Half a minute, so the remux writes several fragments and second 20 is
    // deep inside one of the later ones.
    const source = join(workDir, 'source.mp4')
    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=15',
        '-t',
        '30',
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=none:keyint=30',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        source
      ],
      { maxBuffer: 1 << 22 }
    )
    await remuxToHls(ffmpegPath, { input: source, outDir: workDir })

    // The stand-in Space: whatever the presigned URL asks for, out of the
    // directory the remux just filled, with ranges honoured.
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      // Path style: /<bucket>/<key>.
      const key = path.split('/').slice(2).join('/')
      if (req.method === 'PUT') {
        const parts: Buffer[] = []
        req.on('data', (part: Buffer) => parts.push(part))
        req.on('end', () => {
          kept.set(key, Buffer.concat(parts))
          puts += 1
          res.writeHead(200).end()
        })
        return
      }
      const stored = kept.get(key)
      if (stored != null) {
        res.writeHead(200, { 'content-length': String(stored.length) })
        res.end(stored)
        return
      }
      if (key.includes('/stills/')) {
        res.writeHead(404).end()
        return
      }
      const name = path.split('/').pop() ?? ''
      readFile(join(workDir, name)).then(
        body => {
          const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
          if (range == null) {
            res.writeHead(200, { 'content-length': String(body.length) })
            res.end(body)
            return
          }
          const part = body.subarray(Number(range[1]), Number(range[2]) + 1)
          res.writeHead(206, {
            'content-length': String(part.length),
            'content-range': `bytes ${range[1]}-${range[2]}/${body.length}`
          })
          res.end(part)
        },
        () => {
          res.writeHead(404).end()
        }
      )
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address != null ? address.port : 0
    space.endpoint = `http://127.0.0.1:${port}`
    clearFragmentCache()
  })

  after(async function () {
    server?.close()
    if (originalTemp == null) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTemp
    if (workDir !== '') await rm(workDir, { recursive: true, force: true })
  })

  it('is the same picture as one cut from the file itself, and kept in the Space', async function () {
    const atSec = 20

    const fromFile = await ensureStill({
      ffmpegPath,
      source: { kind: 'file', path: join(workDir, 'video.mp4') },
      space,
      videoId: 'vid_here',
      atSec
    })
    const fromSpace = await ensureStill({
      ffmpegPath,
      source: { kind: 'space', space, videoId: 'vid_there' },
      space,
      videoId: 'vid_there',
      atSec
    })
    expect(fromFile).equals('videos/vid_here/stills/20.jpg')
    expect(fromSpace).equals('videos/vid_there/stills/20.jpg')

    const here = kept.get(fromFile)
    const there = kept.get(fromSpace)
    expect(there?.length).greaterThan(0)
    // Byte for byte: the same frame, the same scale, the same encoder.
    expect(there?.equals(here ?? Buffer.alloc(0))).equals(true)
    expect(await stillInSpace(space, 'vid_there', atSec)).equals(true)
    expect(await stillInSpace(space, 'vid_there', 21)).equals(false)
  })

  it('cuts no more than a few stills at once, however many are asked for together', async function () {
    // FFmpeg behind a stand-in that notes when each run starts and ends.
    const log = join(workDir, 'cuts.log')
    const release = join(workDir, 'release-cuts')
    const wrapper = join(workDir, 'ffmpeg-counted.sh')
    await writeFile(log, '')
    await writeFile(
      wrapper,
      `#!/bin/sh\necho start >> '${log}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n'${ffmpegPath}' "$@"\nrc=$?\necho end >> '${log}'\nexit $rc\n`
    )
    await chmod(wrapper, 0o755)
    const seconds = [3, 6, 9, 12, 15, 18, 21, 24]
    const cuts = Promise.allSettled(
      seconds.map(
        async atSec =>
          await ensureStill({
            ffmpegPath: wrapper,
            source: { kind: 'file', path: join(workDir, 'video.mp4') },
            space,
            videoId: 'vid_many',
            atSec
          })
      )
    )
    // Hold the first wave open so even a fast encoder exercises the limit.
    const deadline = Date.now() + 10000
    try {
      while (Date.now() < deadline) {
        const starts = (await readFile(log, 'utf8'))
          .split('\n')
          .filter(line => line === 'start').length
        if (starts >= MAX_CONCURRENT_CUTS) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    } finally {
      await writeFile(release, '')
    }
    const keys = (await cuts).map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    expect(keys).deep.equals(
      seconds.map(atSec => `videos/vid_many/stills/${String(atSec)}.jpg`)
    )
    let running = 0
    let most = 0
    for (const line of (await readFile(log, 'utf8')).trim().split('\n')) {
      running += line === 'start' ? 1 : -1
      most = Math.max(most, running)
    }
    expect(most, 'at once').equals(MAX_CONCURRENT_CUTS)
    expect(running, 'all cuts finished').equals(0)
  })

  it('frees its turn when a cut fails', async function () {
    const failing = await Promise.allSettled(
      [9001, 9002, 9003].map(
        async atSec =>
          await ensureStill({
            ffmpegPath,
            source: { kind: 'file', path: join(workDir, 'video.mp4') },
            space,
            videoId: 'vid_failing',
            atSec
          })
      )
    )
    expect(failing.map(result => result.status)).deep.equals([
      'rejected',
      'rejected',
      'rejected'
    ])
    expect(
      await ensureStill({
        ffmpegPath,
        source: { kind: 'file', path: join(workDir, 'video.mp4') },
        space,
        videoId: 'vid_failing',
        atSec: 5
      })
    ).equals('videos/vid_failing/stills/5.jpg')
  })

  it('cuts a still once: the next ask finds it in the Space', async function () {
    const before = puts
    const again = await Promise.all([
      ensureStill({
        ffmpegPath,
        source: { kind: 'space', space, videoId: 'vid_there' },
        space,
        videoId: 'vid_there',
        atSec: 20
      }),
      ensureStill({
        ffmpegPath,
        source: { kind: 'space', space, videoId: 'vid_there' },
        space,
        videoId: 'vid_there',
        atSec: 20.3
      })
    ])
    expect(again).deep.equals([
      'videos/vid_there/stills/20.jpg',
      'videos/vid_there/stills/20.jpg'
    ])
    expect(puts).equals(before)
  })

  it('removes its own scratch files and leaves unrelated files alone', async function () {
    expect(await readdir(scratchRoot)).deep.equals([])
    expect(await readFile(join(workDir, 'ts-still-foreign'), 'utf8')).equals(
      'foreign fixture'
    )
  })

  it('has nothing to offer for a moment past the end, and keeps nothing', async function () {
    const before = puts
    const missing = await ensureStill({
      ffmpegPath,
      source: { kind: 'space', space, videoId: 'vid_there' },
      space,
      videoId: 'vid_there',
      atSec: 600
    }).catch(() => undefined)
    expect(missing).equals(undefined)
    expect(puts).equals(before)
  })

  it('refuses to cut a still with no Space to keep it in', async function () {
    const refused = await ensureStill({
      ffmpegPath,
      source: { kind: 'file', path: join(workDir, 'video.mp4') },
      space: { ...space, bucket: '' },
      videoId: 'vid_here',
      atSec: 20
    }).catch((error: unknown) => String(error))
    expect(refused).contains('No Space is configured')
  })
})
