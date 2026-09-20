import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { serverConfig } from '../serverConfig'
import { ffmpegEncoders, probeFfmpeg, remuxToHls } from './ffmpeg'
import { clearFragmentCache } from './spaceFrames'
import { ensureStill } from './stills'

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
  let ready = false
  let server: Server | undefined
  let port = 0

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
    workDir = await mkdtemp(join(tmpdir(), 'gsSpaceStill-'))

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
    if (workDir !== '') await rm(workDir, { recursive: true, force: true })
  })

  it('is the same picture as one cut from the file itself', async function () {
    const atSec = 20

    const fromFile = await ensureStill({
      ffmpegPath,
      source: { kind: 'file', path: join(workDir, 'video.mp4') },
      workDir: join(workDir, 'local'),
      videoId: 'vid_here',
      atSec
    })
    const fromSpace = await ensureStill({
      ffmpegPath,
      source: { kind: 'space', space, videoId: 'vid_there' },
      workDir: join(workDir, 'remote'),
      videoId: 'vid_there',
      atSec
    })

    const here = await readFile(fromFile)
    const there = await readFile(fromSpace)
    expect(there.length).greaterThan(0)
    // Byte for byte: the same frame, the same scale, the same encoder.
    expect(there.equals(here)).equals(true)
  })

  it('leaves no fragment behind once the frame is cut', async function () {
    const frames = join(workDir, 'remote', 'frames')
    const left = await readFile(frames).catch(() => null)
    expect(left).equals(null)
    const names = await import('node:fs/promises').then(
      async fs => await fs.readdir(frames).catch((): string[] => [])
    )
    expect(names).deep.equals([])
  })

  it('has nothing to offer for a moment past the end', async function () {
    const missing = await ensureStill({
      ffmpegPath,
      source: { kind: 'space', space, videoId: 'vid_there' },
      workDir: join(workDir, 'remote'),
      videoId: 'vid_there',
      atSec: 600
    }).catch(() => undefined)
    expect(missing).equals(undefined)
  })
})
