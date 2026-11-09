import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  type stat,
  writeFile
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  IMAGE_SIZES,
  imageKey,
  imagePathPrefix,
  isPublicImagePrefix,
  MAX_SOURCE_BYTES,
  normaliseImage,
  putObject,
  putObjectFile,
  putObjectMultipart,
  sha256Of,
  sizesFor,
  storeImage,
  UnreadableImage,
  WIDE_IMAGE_SIZES
} from './images'
import { uploadVideoDirectory } from './spacesVideo'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

/** A picture that is not square, so cropping and padding tell themselves apart. */
async function makeSource(
  dir: string,
  width: number,
  height: number
): Promise<Buffer> {
  const path = join(dir, `${width}x${height}.png`)
  await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${width}x${height}:rate=1`,
    '-frames:v',
    '1',
    path
  ])
  return await readFile(path)
}

/** Width and height, read back out of the PNG header. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('stored images', function () {
  this.timeout(30000)
  let dir = ''

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsImageTest-'))
  })

  after(async function () {
    await rm(dir, { recursive: true, force: true })
  })

  it('names a key by 16 random bytes and nothing else', function () {
    for (const kind of ['team', 'league', 'user', 'venue', 'field'] as const) {
      const prefix = imagePathPrefix(kind)
      expect(prefix).matches(new RegExp(`^images/${kind}/[0-9a-f]{32}$`))
      expect(isPublicImagePrefix(prefix), prefix).equals(true)
      expect(imagePathPrefix(kind), 'a second name').not.equals(prefix)
    }
    const prefix = imagePathPrefix('user')
    expect(imageKey(prefix, 96)).equals(`${prefix}-96.png`)
    expect(imageKey(prefix, 192)).equals(`${prefix}-192.png`)
  })

  it('takes neither a catalog picture nor an old name for a public one', function () {
    for (const prefix of [
      'images/catalog/v1/baseball/0123456789ab',
      'images/user/usr_1/aaaaaaaa',
      `images/team/${'A'.repeat(32)}`,
      `images/team/${'a'.repeat(31)}`,
      `images/photo/${'a'.repeat(32)}`,
      `images/team/${'a'.repeat(32)}/more`,
      'demo-startup/hosts'
    ])
      expect(isPublicImagePrefix(prefix), prefix).equals(false)
  })

  it('renders every size, square, whatever shape it was given', async function () {
    const source = await makeSource(dir, 320, 180)
    const image = await normaliseImage({
      ffmpegPath: FFMPEG,
      source,
      kind: 'user'
    })
    expect([...image.bySize.keys()]).deep.equals([...IMAGE_SIZES])
    for (const size of IMAGE_SIZES) {
      const bytes = image.bySize.get(size)
      expect(bytes, `size ${size}`).not.equals(undefined)
      expect(pngSize(bytes!)).deep.equals({
        width: size,
        height: size
      })
    }
  })

  it('is square for a mark too, padded rather than cropped', async function () {
    const source = await makeSource(dir, 320, 180)
    const image = await normaliseImage({
      ffmpegPath: FFMPEG,
      source,
      kind: 'team'
    })
    for (const size of IMAGE_SIZES) {
      expect(pngSize(image.bySize.get(size)!)).deep.equals({
        width: size,
        height: size
      })
    }
  })

  it('stores a place 16:9 and cover-cropped at the wide sizes, whatever its shape', async function () {
    for (const kind of ['venue', 'field'] as const) {
      expect(sizesFor(kind)).deep.equals([...WIDE_IMAGE_SIZES])
      const image = await normaliseImage({
        ffmpegPath: FFMPEG,
        source: await makeSource(dir, 300, 300),
        kind
      })
      expect([...image.bySize.keys()]).deep.equals([...WIDE_IMAGE_SIZES])
      for (const size of WIDE_IMAGE_SIZES)
        expect(pngSize(image.bySize.get(size)!)).deep.equals({
          width: size,
          height: (size * 9) / 16
        })
    }
    expect(sizesFor('team')).deep.equals([...IMAGE_SIZES])
  })

  it('hashes the same picture the same way twice', async function () {
    const source = await makeSource(dir, 256, 256)
    const first = await normaliseImage({
      ffmpegPath: FFMPEG,
      source,
      kind: 'user'
    })
    const again = await normaliseImage({
      ffmpegPath: FFMPEG,
      source,
      kind: 'user'
    })
    expect(again.sha256).equals(first.sha256)
    expect(first.sha256).to.have.length(64)
  })

  it('refuses something that is not a picture', async function () {
    let failed: unknown
    try {
      await normaliseImage({
        ffmpegPath: FFMPEG,
        source: Buffer.from('this is not a picture'),
        kind: 'user'
      })
    } catch (error) {
      failed = error
    }
    expect(failed, 'a text file is not accepted as a face').instanceOf(
      UnreadableImage
    )
  })

  it('refuses one too heavy to be a picture without reaching for FFmpeg', async function () {
    let failed: unknown
    try {
      await normaliseImage({
        ffmpegPath: '/does/not/exist',
        source: Buffer.alloc(MAX_SOURCE_BYTES + 1),
        kind: 'team'
      })
    } catch (error) {
      failed = error
    }
    expect(failed).instanceOf(UnreadableImage)
  })

  it('does not blame the picture when there is no FFmpeg to run', async function () {
    let failed: unknown
    try {
      await normaliseImage({
        ffmpegPath: '/does/not/exist',
        source: Buffer.from('any bytes at all'),
        kind: 'team'
      })
    } catch (error) {
      failed = error
    }
    expect(failed).instanceOf(Error)
    expect(failed).not.instanceOf(UnreadableImage)
    expect((failed as { code?: unknown }).code).equals('ENOENT')
  })

  describe('an FFmpeg that started and failed', function () {
    let stubs = ''

    before(async function () {
      stubs = await mkdtemp(join(tmpdir(), 'tsFfmpegStubs-'))
    })

    after(async function () {
      await rm(stubs, { recursive: true, force: true })
    })

    /** A stand-in FFmpeg: a shell script, executable unless told not to be. */
    async function stub(
      name: string,
      body: string,
      mode = 0o755
    ): Promise<string> {
      const path = join(stubs, name)
      await writeFile(path, `#!/bin/sh\n${body}\n`, { mode })
      return path
    }

    async function failureOf(ffmpegPath: string): Promise<unknown> {
      try {
        await normaliseImage({
          ffmpegPath,
          source: Buffer.from('any bytes at all'),
          kind: 'user'
        })
      } catch (error) {
        return error
      }
      throw new Error('normaliseImage did not fail')
    }

    it('blames the picture when FFmpeg exits with a status', async function () {
      const failed = await failureOf(await stub('exits', 'exit 1'))
      expect(failed).instanceOf(UnreadableImage)
    })

    it('blames the picture when FFmpeg is killed by a signal', async function () {
      const failed = await failureOf(await stub('killed', 'kill -9 $$'))
      expect(failed).instanceOf(UnreadableImage)
      const cause = (failed as Error).cause as {
        code?: unknown
        signal?: unknown
      }
      expect(cause.code).equals(null)
      expect(cause.signal).equals('SIGKILL')
    })

    it('blames the picture when FFmpeg says more than the buffer holds', async function () {
      const failed = await failureOf(
        await stub('chatty', 'head -c 5000000 /dev/zero >&2\nexit 0')
      )
      expect(failed).instanceOf(UnreadableImage)
      expect(((failed as Error).cause as { code?: unknown }).code).equals(
        'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      )
    })

    it('blames the picture when FFmpeg succeeds and writes nothing', async function () {
      const failed = await failureOf(
        await stub('silent', 'for arg; do last=$arg; done\n: > "$last"')
      )
      expect(failed).instanceOf(UnreadableImage)
      expect((failed as Error).message).equals('FFmpeg produced no image')
    })

    it('does not blame the picture when FFmpeg cannot be started', async function () {
      const failed = await failureOf(
        await stub('notExecutable', 'exit 0', 0o644)
      )
      expect(failed).not.instanceOf(UnreadableImage)
      expect((failed as { code?: unknown }).code).equals('EACCES')
    })
  })

  it('refuses an empty one without reaching for FFmpeg', async function () {
    let message = ''
    try {
      await normaliseImage({
        ffmpegPath: '/does/not/exist',
        source: Buffer.alloc(0),
        kind: 'user'
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).equals('Empty image')
  })

  describe('against a stand-in Space', function () {
    let server: Server | undefined
    let space = {
      endpoint: '',
      region: 'sfo3',
      bucket: 'example-media-bkt',
      accessKeyId: 'AKIAEXAMPLE000000000',
      secretAccessKey: 'secret',
      pathStyle: true
    }
    const written = new Map<string, Buffer>()
    /** How each request was framed, which is what S3 is strict about. */
    const framing = new Map<
      string,
      { contentLength?: string; transferEncoding?: string }
    >()
    /** What each PUT signed and sent besides its body. */
    const access = new Map<
      string,
      { signed: string | null; acl?: string; cacheControl?: string }
    >()
    const parts = new Map<string, Map<number, Buffer>>()
    const aborted: string[] = []
    const deleted: string[] = []
    /** Refuses every PUT whose path ends with this, for one test. */
    let refuseSuffix: string | undefined
    /** Answers every DELETE with a 500, for one test. */
    let refuseDeletes = false
    let nextUploadId = 1

    before(async function () {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://space.test')
        const path = url.pathname
        const method = req.method ?? ''

        if (method === 'POST' && url.searchParams.has('uploads')) {
          const uploadId = `upload-${nextUploadId++}`
          res.statusCode = 200
          res.end(
            `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
          )
          return
        }
        if (method === 'DELETE' && url.searchParams.has('uploadId')) {
          aborted.push(path)
          parts.delete(path)
          res.statusCode = 204
          res.end()
          return
        }
        if (method === 'POST' && url.searchParams.has('uploadId')) {
          const held = parts.get(path) ?? new Map()
          const ordered = [...held.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(entry => entry[1])
          written.set(path, Buffer.concat(ordered))
          parts.delete(path)
          res.statusCode = 200
          res.end('<CompleteMultipartUploadResult/>')
          return
        }
        if (method === 'DELETE' && refuseDeletes) {
          res.statusCode = 500
          res.end('<Error><Code>InternalError</Code></Error>')
          return
        }
        if (method === 'DELETE') {
          deleted.push(path)
          written.delete(path)
          res.statusCode = 204
          res.end()
          return
        }
        if (method !== 'PUT') {
          res.statusCode = 405
          res.end()
          return
        }
        framing.set(path, {
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding']
        })
        access.set(path, {
          signed: url.searchParams.get('X-Amz-SignedHeaders'),
          acl: req.headers['x-amz-acl'] as string | undefined,
          cacheControl: req.headers['cache-control']
        })
        if (
          path.includes('refused') ||
          (refuseSuffix != null && path.endsWith(refuseSuffix))
        ) {
          // A Space refuses a bad signature at once, without reading the body,
          // and hangs up. The sender sees a broken pipe; the answer is this.
          res.statusCode = 403
          res.end('<Error><Code>AccessDenied</Code></Error>')
          return
        }
        const partNumber = Number(url.searchParams.get('partNumber') ?? '0')
        if (path.includes('fail-part') && partNumber === 2) {
          res.statusCode = 400
          res.end('<Error><Code>EntityTooLarge</Code></Error>')
          return
        }
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          if (partNumber > 0) {
            const held = parts.get(path) ?? new Map()
            held.set(partNumber, body)
            parts.set(path, held)
            res.setHeader('etag', `"${sha256Of(body).slice(0, 16)}"`)
            res.statusCode = 200
            res.end()
            return
          }
          written.set(path, body)
          res.statusCode = 200
          res.end()
        })
      })
      await new Promise<void>(resolve => {
        server?.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      const port =
        typeof address === 'object' && address != null ? address.port : 0
      space = { ...space, endpoint: `http://127.0.0.1:${port}` }
    })

    after(function () {
      server?.close()
    })

    it('puts an object where its key says', async function () {
      await putObject({
        space,
        key: 'images/team/tem_1/abcd1234-96.png',
        body: Buffer.from('bytes'),
        contentType: 'image/png'
      })
      const path = '/example-media-bkt/images/team/tem_1/abcd1234-96.png'
      expect(written.get(path)?.toString()).equals('bytes')
    })

    it('sends a file as a sized PUT, not a chunked one', async function () {
      // Eight megabytes: more than one write, so the framing is the request's
      // own and not something a single small body made true by accident.
      const source = join(dir, 'video.mp4')
      const bytes = Buffer.alloc(8 * 1024 * 1024, 7)
      await writeFile(source, bytes)

      await putObjectFile({
        space,
        key: 'videos/vid_1/video.mp4',
        path: source,
        contentType: 'video/mp4'
      })

      const path = '/example-media-bkt/videos/vid_1/video.mp4'
      expect(written.get(path)?.length, 'every byte arrived').equals(
        bytes.length
      )
      expect(sha256Of(written.get(path) ?? Buffer.alloc(0))).equals(
        sha256Of(bytes)
      )
      expect(framing.get(path)?.contentLength, 'the length is stated').equals(
        String(bytes.length)
      )
      expect(
        framing.get(path)?.transferEncoding,
        'S3 refuses a chunked body against a presigned signature'
      ).equals(undefined)
    })

    it('sends an empty file as an empty PUT, leaving no request open', async function () {
      const source = join(dir, 'empty.m4s')
      await writeFile(source, '')
      await putObjectFile({
        space,
        key: 'videos/vid_empty/seg000000.m4s',
        path: source,
        contentType: 'video/iso.segment'
      })
      const path = '/example-media-bkt/videos/vid_empty/seg000000.m4s'
      expect(written.get(path)?.length).equals(0)
      expect(framing.get(path)?.contentLength).equals('0')
    })

    it('fails at once, and leaves nothing to reject later, when the file is shorter than it was', async function () {
      const source = join(dir, 'shrunk.m4s')
      await writeFile(source, Buffer.alloc(1000, 5))
      const files = require('node:fs/promises') as { stat: typeof stat }
      const original = files.stat
      // The stat sees the file before a writer truncated it.
      files.stat = (async () => {
        const info = await original(source)
        return Object.assign(info, { size: 4000 })
      }) as unknown as typeof stat
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      let message = ''
      const started = Date.now()
      try {
        await putObjectFile({
          space,
          key: 'videos/vid_shrunk/seg000000.m4s',
          path: source,
          contentType: 'video/iso.segment'
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      } finally {
        files.stat = original
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      process.off('unhandledRejection', onUnhandled)
      expect(message).contains('shorter')
      expect(Date.now() - started, 'not the idle timeout').lessThan(2000)
      expect(unhandled).deep.equals([])
    })

    it('reports what the Space said when it refuses mid-send', async function () {
      const source = join(dir, 'refused.mp4')
      await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 3))
      let message = ''
      const started = Date.now()
      try {
        await putObjectFile({
          space,
          key: 'videos/vid_refused/video.mp4',
          path: source,
          contentType: 'video/mp4'
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message, 'the refusal, not the broken pipe').contains('403')
      expect(message).contains('AccessDenied')
      // It is reported when it is said, not when the abandoned write finally
      // times out — which is five seconds later, and would be five seconds per
      // file of a game that is never going to upload.
      expect(Date.now() - started, 'reported at once').lessThan(2000)
    })

    it('reassembles a file from multipart parts', async function () {
      // 12 MB in 5 MB parts: two full parts and a remainder, without writing
      // a 5 GB file just to cross the production threshold.
      const source = join(dir, 'multipart.mp4')
      const bytes = Buffer.alloc(12 * 1024 * 1024)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
      await writeFile(source, bytes)

      await putObjectMultipart({
        space,
        key: 'videos/vid_big/video.mp4',
        path: source,
        contentType: 'video/mp4',
        size: bytes.length,
        partSize: 5 * 1024 * 1024
      })

      const path = '/example-media-bkt/videos/vid_big/video.mp4'
      expect(written.get(path)?.length, 'every byte arrived').equals(
        bytes.length
      )
      expect(sha256Of(written.get(path) ?? Buffer.alloc(0))).equals(
        sha256Of(bytes)
      )
    })

    it('aborts a multipart upload when a part is refused', async function () {
      const source = join(dir, 'abort.mp4')
      await writeFile(source, Buffer.alloc(12 * 1024 * 1024, 9))
      let message = ''
      try {
        await putObjectMultipart({
          space,
          key: 'videos/vid_fail-part/video.mp4',
          path: source,
          contentType: 'video/mp4',
          size: 12 * 1024 * 1024,
          partSize: 5 * 1024 * 1024
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).contains('400')
      expect(aborted).includes(
        '/example-media-bkt/videos/vid_fail-part/video.mp4'
      )
    })

    it('uploads every size, public, and reports where the row should point', async function () {
      const source = await makeSource(dir, 200, 200)
      const stored = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        source
      })
      expect(stored, 'a new picture is stored').not.equals(undefined)
      expect(stored?.pathPrefix).matches(/^images\/user\/[0-9a-f]{32}$/)
      for (const size of IMAGE_SIZES) {
        const key = imageKey(stored?.pathPrefix ?? '', size)
        expect(written.has(`/example-media-bkt/${key}`), key).equals(true)
        expect(access.get(`/example-media-bkt/${key}`), key).deep.equals({
          signed: 'host;x-amz-acl',
          acl: 'public-read',
          cacheControl: undefined
        })
      }
    })

    it('deletes the sizes already up when the Space refuses a later one', async function () {
      const source = await makeSource(dir, 200, 200)
      const before = new Set(written.keys())
      deleted.length = 0
      refuseSuffix = `-${IMAGE_SIZES[1]}.png`
      let message = ''
      try {
        await storeImage({ ffmpegPath: FFMPEG, space, kind: 'user', source })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      } finally {
        refuseSuffix = undefined
      }
      expect(message).contains('403')
      expect(deleted, 'the first size is released').to.have.length(1)
      expect(deleted[0]).matches(
        new RegExp(
          `^/example-media-bkt/images/user/[0-9a-f]{32}-${IMAGE_SIZES[0]}\\.png$`
        )
      )
      expect([...written.keys()].filter(key => !before.has(key))).deep.equals(
        []
      )
    })

    it('throws the upload failure, not the clean-up one, when the delete is refused too', async function () {
      const source = await makeSource(dir, 200, 200)
      const logged: string[] = []
      const consoleError = console.error
      console.error = (...args: unknown[]) => logged.push(args.join(' '))
      refuseSuffix = `-${IMAGE_SIZES[1]}.png`
      refuseDeletes = true
      let message = ''
      try {
        await storeImage({ ffmpegPath: FFMPEG, space, kind: 'user', source })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      } finally {
        refuseSuffix = undefined
        refuseDeletes = false
        console.error = consoleError
      }
      expect(message).contains('Upload of').and.contains('403')
      expect(logged).to.have.length(1)
      expect(logged[0]).contains('pictures: releasing').and.contains('500')
    })

    it('keeps a still and a chat attachment private, signing host alone', async function () {
      // A still's PUT, as `stills.ts` makes it.
      await putObject({
        space,
        key: 'stills/vid_1/12-480.jpg',
        body: Buffer.from('jpeg'),
        contentType: 'image/jpeg',
        signal: AbortSignal.timeout(5000)
      })
      // A chat attachment's, as `chat/attachments.ts` makes it.
      const whole = join(dir, 'attachment')
      await writeFile(whole, 'sealed')
      await putObjectFile({
        space,
        key: 'chat/att_1',
        path: whole,
        contentType: 'application/octet-stream'
      })
      for (const path of [
        '/example-media-bkt/stills/vid_1/12-480.jpg',
        '/example-media-bkt/chat/att_1'
      ])
        expect(access.get(path), path).deep.equals({
          signed: 'host',
          acl: undefined,
          cacheControl: undefined
        })
    })

    it('keeps a secret-path segment public and cached, as it was', async function () {
      const video = join(dir, 'secretVideo')
      await rm(video, { recursive: true, force: true })
      await mkdir(video)
      await writeFile(join(video, 'seg000001.m4s'), 'segment')
      await uploadVideoDirectory({
        space,
        videoId: 'vid_secret',
        spaceSecret: 'c'.repeat(32),
        dir: video
      })
      const [path] = [...access.keys()].filter(key =>
        key.endsWith('/seg000001.m4s')
      )
      expect(path).contains('vid_secret')
      expect(access.get(path)).deep.equals({
        signed: 'cache-control;host;x-amz-acl',
        acl: 'public-read',
        cacheControl: 'public, max-age=600'
      })
    })

    it('uploads nothing when the picture has not changed', async function () {
      const source = await makeSource(dir, 200, 200)
      const first = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        source
      })
      const before = written.size
      const again = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        source,
        knownSha256: first?.sha256
      })
      expect(again, 'an unchanged picture is skipped').equals(undefined)
      expect(written.size, 'nothing new was written').equals(before)
    })
  })

  it('hashes bytes, not objects', function () {
    expect(sha256Of(Buffer.from('a'))).equals(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    )
  })
})
