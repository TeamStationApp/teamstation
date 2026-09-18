import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  normaliseImage,
  putObject,
  putObjectFile,
  sha256Of,
  storeImage
} from './images'

const run = promisify(execFile)
const FFMPEG = process.env.GS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

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
    dir = await mkdtemp(join(tmpdir(), 'gsImageTest-'))
  })

  after(async function () {
    await rm(dir, { recursive: true, force: true })
  })

  it('names a key by the entity and the hash of its bytes', function () {
    const prefix = imagePathPrefix('user', 'usr_1', 'a'.repeat(64))
    expect(prefix).equals('images/user/usr_1/aaaaaaaa')
    expect(imageKey(prefix, 96)).equals('images/user/usr_1/aaaaaaaa-96.png')
    expect(imageKey(prefix, 192)).equals('images/user/usr_1/aaaaaaaa-192.png')
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
    let failed = false
    try {
      await normaliseImage({
        ffmpegPath: FFMPEG,
        source: Buffer.from('this is not a picture'),
        kind: 'user'
      })
    } catch {
      failed = true
    }
    expect(failed, 'a text file is not accepted as a face').equals(true)
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

    before(async function () {
      server = createServer((req, res) => {
        if (req.method !== 'PUT') {
          res.statusCode = 405
          res.end()
          return
        }
        const path = (req.url ?? '').split('?')[0] ?? ''
        framing.set(path, {
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding']
        })
        if (path.includes('refused')) {
          // A Space refuses a bad signature at once, without reading the body,
          // and hangs up. The sender sees a broken pipe; the answer is this.
          res.statusCode = 403
          res.end('<Error><Code>AccessDenied</Code></Error>')
          return
        }
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          written.set(path, Buffer.concat(chunks))
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

    it('uploads every size and reports where the row should point', async function () {
      const source = await makeSource(dir, 200, 200)
      const stored = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        entityId: 'usr_7',
        source
      })
      expect(stored, 'a new picture is stored').not.equals(undefined)
      expect(stored?.pathPrefix).contains('images/user/usr_7/')
      for (const size of IMAGE_SIZES) {
        const key = imageKey(stored?.pathPrefix ?? '', size)
        expect(written.has(`/example-media-bkt/${key}`), key).equals(true)
      }
    })

    it('uploads nothing when the picture has not changed', async function () {
      const source = await makeSource(dir, 200, 200)
      const first = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        entityId: 'usr_8',
        source
      })
      const before = written.size
      const again = await storeImage({
        ffmpegPath: FFMPEG,
        space,
        kind: 'user',
        entityId: 'usr_8',
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
