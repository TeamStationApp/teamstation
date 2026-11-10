import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { FFMPEG, installFfmpeg, main, writeServerConfig } from './testTools.mjs'

const bytes = Buffer.from('a pinned ffmpeg archive')

/** A fetch that answers with `body`, failing the first `failures` times. */
function fakeFetch(
  body: Buffer,
  failures = 0,
  status = 200
): {
  fetchFn: (url: string) => Promise<{
    ok: boolean
    status: number
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
  asked: string[]
} {
  const asked: string[] = []
  const fetchFn = async (
    url: string
  ): Promise<{
    ok: boolean
    status: number
    arrayBuffer: () => Promise<ArrayBuffer>
  }> => {
    asked.push(url)
    if (asked.length <= failures) throw new Error('connection reset')
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    }
  }
  return { fetchFn, asked }
}

/** An extractor that writes the binaries a real archive holds. */
function fakeExtract(
  unpacked: string[]
): (archive: string, dir: string) => void {
  return (archive: string, dir: string): void => {
    unpacked.push(archive)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'ffmpeg'), '')
    writeFileSync(join(dir, 'bin', 'ffprobe'), '')
  }
}

describe('testTools', function () {
  let root: string
  const pinned = { ...FFMPEG }

  beforeEach(function () {
    root = mkdtempSync(join(tmpdir(), 'test-tools-'))
    FFMPEG.sha256 = createHash('sha256').update(bytes).digest('hex')
  })

  afterEach(function () {
    rmSync(root, { recursive: true, force: true })
    Object.assign(FFMPEG, pinned)
  })

  it('downloads, checks and unpacks the pinned FFmpeg, then reuses it', async function () {
    const { fetchFn, asked } = fakeFetch(bytes, 1)
    const unpacked: string[] = []
    const options = { fetchFn, extract: fakeExtract(unpacked), scratch: root }
    const first = await installFfmpeg(root, options)
    expect(first).deep.equals({
      ffmpegPath: join(root, '.test-tools/ffmpeg/bin/ffmpeg'),
      ffmpegVersion: FFMPEG.version,
      bin: join(root, '.test-tools/ffmpeg/bin')
    })
    // One failed attempt, then one that worked.
    expect(asked).deep.equals([FFMPEG.url, FFMPEG.url])
    expect(unpacked).lengthOf(1)
    await installFfmpeg(root, options)
    expect(asked).lengthOf(2)
  })

  it('refuses a download whose checksum is not the pinned one', async function () {
    const { fetchFn } = fakeFetch(Buffer.from('something else'))
    const unpacked: string[] = []
    let caught: unknown
    try {
      await installFfmpeg(root, {
        fetchFn,
        extract: fakeExtract(unpacked),
        scratch: root
      })
    } catch (error) {
      caught = error
    }
    expect(String(caught)).match(/not the pinned/)
    expect(unpacked).deep.equals([])
  })

  it('gives up after three failed answers', async function () {
    const { fetchFn, asked } = fakeFetch(bytes, 0, 404)
    let caught: unknown
    try {
      await installFfmpeg(root, {
        fetchFn,
        extract: fakeExtract([]),
        scratch: root
      })
    } catch (error) {
      caught = error
    }
    expect(String(caught)).match(/answered 404/)
    expect(asked).lengthOf(3)
  })

  it('writes the FFmpeg settings into serverConfig.json and keeps the rest', async function () {
    const file = join(root, 'serverConfig.json')
    writeFileSync(file, JSON.stringify({ listenPort: 9100 }))
    writeServerConfig(file, { ffmpegPath: '/x/ffmpeg', ffmpegVersion: 'v' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).deep.equals({
      listenPort: 9100,
      ffmpegPath: '/x/ffmpeg',
      ffmpegVersion: 'v'
    })
    rmSync(file)
    writeServerConfig(file, { ffmpegPath: '/y', ffmpegVersion: 'w' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).deep.equals({
      ffmpegPath: '/y',
      ffmpegVersion: 'w'
    })
  })

  it('runs `ffmpeg --server-config` and refuses another tool', async function () {
    const { fetchFn } = fakeFetch(bytes)
    const result = await main(['ffmpeg', '--server-config'], root, {
      fetchFn,
      extract: fakeExtract([]),
      scratch: root
    })
    expect(existsSync(join(root, 'serverConfig.json'))).equals(true)
    expect(result.ffmpegVersion).equals(FFMPEG.version)
    let caught: unknown
    try {
      await main(['caddy'], root)
    } catch (error) {
      caught = error
    }
    expect(String(caught)).match(/Usage/)
  })
})
