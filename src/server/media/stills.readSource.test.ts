import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { serverConfig } from '../serverConfig'
import { remuxToHls } from './ffmpeg'
import { clearFragmentCache } from './spaceFrames'
import type { SpaceSettings } from './spacesHls'
import { ensureStill, stillKey, stillSpaceUrl } from './stills'

describe('shared still ownership', function () {
  this.timeout(60000)
  const servers: Server[] = []
  const scratch: string[] = []
  let sourceReads = 0
  let sourceWrites = 0
  let sourceRanges = 0
  const sourceAssets = new Map<string, Buffer>()
  let destinationWrites = 0
  let mode: number | 'disconnect' | 'timeout' = 200
  const destination = new Map<string, Buffer>()

  afterEach(async function () {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
    for (const dir of scratch.splice(0))
      await rm(dir, { recursive: true, force: true })
  })

  async function stores(): Promise<SpaceSettings> {
    sourceReads = sourceWrites = destinationWrites = 0
    destination.clear()
    sourceAssets.clear()
    sourceRanges = 0
    clearFragmentCache()
    const source = createServer((req, res) => {
      if (req.method !== 'GET') {
        sourceWrites++
        res.writeHead(403).end()
        return
      }
      sourceReads++
      if (mode === 'disconnect') {
        req.socket.destroy()
        return
      }
      if (mode === 'timeout') return
      if (mode === 200 && sourceAssets.size > 0) {
        const key = new URL(
          req.url ?? '/',
          'http://localhost'
        ).pathname.replace(/^\/reader\//, '')
        const bytes = sourceAssets.get(key)
        if (bytes == null) {
          res.writeHead(404).end()
          return
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
        if (range != null) {
          sourceRanges++
          const start = Number(range[1])
          const end = Number(range[2])
          res
            .writeHead(206, {
              'content-range': `bytes ${start}-${end}/${bytes.length}`
            })
            .end(bytes.subarray(start, end + 1))
        } else res.writeHead(200).end(bytes)
        return
      }
      res
        .writeHead(mode)
        .end(mode === 200 ? Buffer.from([255, 216, 255, 217]) : 'unavailable')
    })
    const primary = createServer((req, res) => {
      const key = new URL(req.url ?? '/', 'http://localhost').pathname.replace(
        /^\/writer\//,
        ''
      )
      if (req.method === 'PUT') {
        destinationWrites++
        const chunks: Buffer[] = []
        req.on('data', bytes => chunks.push(bytes))
        req.on('end', () => {
          destination.set(key, Buffer.concat(chunks))
          res.writeHead(200, { etag: 'example' }).end()
        })
      } else {
        const held = destination.get(key)
        res.writeHead(held == null ? 404 : 200).end(held)
      }
    })
    for (const server of [source, primary]) {
      servers.push(server)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    }
    const endpoint = (s: Server): string => {
      const addr = s.address()
      if (addr == null || typeof addr === 'string')
        throw new Error('No test endpoint')
      return `http://127.0.0.1:${addr.port}`
    }
    return {
      endpoint: endpoint(primary),
      region: 'example',
      bucket: 'writer',
      accessKeyId: 'WRITEREXAMPLE',
      secretAccessKey: 'EXAMPLE',
      pathStyle: true,
      readOnlySource: {
        endpoint: endpoint(source),
        region: 'example',
        bucket: 'reader',
        accessKeyId: 'READEREXAMPLE',
        secretAccessKey: 'EXAMPLE',
        pathStyle: true,
        keys: [stillKey('demo', 0)]
      }
    }
  }

  for (const failure of [404, 403, 500, 'disconnect', 'timeout'] as const) {
    it(`does not regenerate a source-owned still after ${failure}`, async function () {
      mode = failure
      const space = await stores()
      for (let attempt = 0; attempt < 2; attempt++) {
        let error: unknown
        try {
          await ensureStill({
            space,
            videoId: 'demo',
            atSec: 0,
            ffmpegPath: 'must-never-run',
            source: { kind: 'file', path: 'must-never-read' }
          })
        } catch (e) {
          error = e
        }
        expect(error).instanceOf(Error)
        expect((error as Error).message).equals(
          'Read-only source still is not available'
        )
      }
      expect(sourceReads).equals(2)
      expect(sourceWrites).equals(0)
      expect(destinationWrites).equals(0)
      expect(destination.size).equals(0)
    })
  }

  it('reuses a source-owned still without any write', async function () {
    mode = 200
    const space = await stores()
    const key = await ensureStill({
      space,
      videoId: 'demo',
      atSec: 0,
      ffmpegPath: 'must-never-run',
      source: { kind: 'file', path: 'unused' }
    })
    expect(key).equals(stillKey('demo', 0))
    expect(new URL(stillSpaceUrl(space, 'demo', 0, 300)).pathname).equals(
      '/reader/videos/demo/stills/0.jpg'
    )
    expect(sourceReads).equals(1)
    expect(sourceWrites + destinationWrites).equals(0)
  })

  it('generates and then reuses an unlisted still in the distinct development store', async function () {
    mode = 200
    const space = await stores()
    const dir = await mkdtemp(join(tmpdir(), 'sharedStill-'))
    scratch.push(dir)
    const file = join(dir, 'sample.mp4')
    execFileSync(serverConfig.ffmpegPath, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:d=1',
      '-c:v',
      'libx264',
      '-y',
      file
    ])
    const options = {
      space,
      videoId: 'new-demo',
      atSec: 0,
      ffmpegPath: serverConfig.ffmpegPath,
      source: { kind: 'file' as const, path: file }
    }
    expect(await ensureStill(options)).equals(stillKey('new-demo', 0))
    expect(await ensureStill(options)).equals(stillKey('new-demo', 0))
    expect(destinationWrites).equals(1)
    expect(sourceReads + sourceWrites).equals(0)
    const result = await fetch(stillSpaceUrl(space, 'new-demo', 0, 300))
    expect(result.status).equals(200)
    expect(new URL(result.url).pathname).equals(
      '/writer/videos/new-demo/stills/0.jpg'
    )
    const bytes = Buffer.from(await result.arrayBuffer())
    expect(bytes[0]).equals(255)
    expect(bytes[1]).equals(216)
  })

  it('reads a shared video while creating and reusing its new still only in development', async function () {
    mode = 200
    const space = await stores()
    const dir = await mkdtemp(join(tmpdir(), 'mixedStill-'))
    scratch.push(dir)
    const file = join(dir, 'source.mp4')
    execFileSync(serverConfig.ffmpegPath, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:d=30',
      '-c:v',
      'libx264',
      '-g',
      '25',
      '-y',
      file
    ])
    const outDir = join(dir, 'hls')
    await mkdir(outDir)
    await remuxToHls(serverConfig.ffmpegPath, {
      input: file,
      outDir,
      videoTag: null,
      segmentSeconds: 5
    })
    for (const name of ['master.m3u8', 'video.m3u8', 'video.mp4'])
      sourceAssets.set(
        `videos/demo/${name}`,
        await readFile(join(outDir, name))
      )
    const readOnlySource = space.readOnlySource
    if (readOnlySource == null) throw new Error('Missing source fixture')
    space.readOnlySource = { ...readOnlySource, keys: [...sourceAssets.keys()] }
    const options = {
      space,
      videoId: 'demo',
      atSec: 20,
      ffmpegPath: serverConfig.ffmpegPath,
      source: { kind: 'space' as const, space, videoId: 'demo' }
    }
    expect(await ensureStill(options)).equals(stillKey('demo', 20))
    expect(sourceReads).greaterThan(0)
    expect(sourceRanges).equals(2)
    expect(sourceWrites).equals(0)
    expect(destinationWrites).equals(1)
    const readsAfterGeneration = sourceReads
    expect(await ensureStill(options)).equals(stillKey('demo', 20))
    expect(sourceReads).equals(readsAfterGeneration)
    expect(destinationWrites).equals(1)
    const result = await fetch(stillSpaceUrl(space, 'demo', 20, 300))
    expect(result.status).equals(200)
    expect(new URL(result.url).pathname).equals(
      '/writer/videos/demo/stills/20.jpg'
    )
    const bytes = Buffer.from(await result.arrayBuffer())
    expect(bytes[0]).equals(255)
    expect(bytes[1]).equals(216)
  })
})
