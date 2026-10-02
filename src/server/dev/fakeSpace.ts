import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'

/**
 * A stand-in for the object-storage Space, on this machine.
 *
 * It serves `/<bucket>/videos/<id>/<file>`, `/<bucket>/images/…` and
 * `/<bucket>/chat/<conversationId>/<attachmentId>` out of a directory and,
 * like the real thing, **refuses anything that is not correctly presigned**:
 * it recomputes the signature from the same key and compares. That is what
 * makes it worth running — it checks that the API signs the right key, for
 * the right bucket, with the right expiry and verb, and that `Range` stays
 * out of the signature so a player can seek.
 *
 *   npm run fake-space
 *
 * Point `space` in serverConfig.json at it, with `pathStyle: true`, and flip a
 * video's `storage` to `spaces`. It listens on `TS_FAKE_SPACE_HOST` (default
 * `127.0.0.1`; `0.0.0.0` when the phones must reach it) and port 9199
 * (`TS_FAKE_SPACE_PORT` when that is taken).
 *
 * Tests start `fakeSpaceHandler` themselves, on port 0, through `listen`.
 */
export const FAKE_SPACE_PORT = 9199

export interface FakeSpaceOptions {
  /** The bucket served and the keys signatures are checked against. */
  space: SpaceSettings
  /**
   * Where the stand-in keeps what has been "uploaded".
   *
   * Its own directory, not `workDir`: the work directory is the server's, and
   * the two would write to the same `videos/<id>/` path — the Space's copy of
   * a game landing on top of the local one it was copied from.
   */
  dir: string
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** The request handler, for `createServer`. */
export function fakeSpaceHandler(options: FakeSpaceOptions): Handler {
  return (req, res) => {
    handle(options, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  }
}

/** Serves the stand-in on `host:port` (0 picks a free port). */
export async function listen(
  host: string,
  port: number,
  options: FakeSpaceOptions
): Promise<Server> {
  const server = createServer(fakeSpaceHandler(options))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

/**
 * Where a key lives on disk, or undefined for a key the Space does not hold.
 *
 * Three layouts live in the bucket: `videos/<id>/<file>` for a recording,
 * `images/<kind>/<id>/<file>` for a mark or a face, and
 * `chat/<conversationId>/<attachmentId>` for an encrypted attachment. All map
 * onto the directory, so what the importer wrote can be looked at with an
 * image viewer rather than only through a signature.
 */
export function pathOfKey(dir: string, key: string): string | undefined {
  const video = /^videos\/([^/]+)\/([^/]+)$/.exec(key)
  if (video != null) return join(dir, 'videos', video[1], video[2])
  const image = /^images\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key)
  if (image != null) return join(dir, 'images', image[1], image[2], image[3])
  const chat = /^chat\/([^/]+)\/([^/]+)$/.exec(key)
  if (chat != null) return join(dir, 'chat', chat[1], chat[2])
  return undefined
}

async function handle(
  options: FakeSpaceOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { space, dir } = options
  // The same CORS rule the real Space needs: GET and HEAD, the `Range`
  // request header, and the three headers a player reads back off a partial
  // response. Without these, hls.js cannot fetch a byte range at all. PUT and
  // DELETE for the presigned writes and deletes.
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,HEAD,PUT,DELETE')
  res.setHeader('access-control-allow-headers', 'range')
  res.setHeader(
    'access-control-expose-headers',
    'content-length,content-range,accept-ranges'
  )
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const prefix = `/${space.bucket}/`
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404).end('no such bucket')
    return
  }
  const key = decodeURIComponent(url.pathname.slice(prefix.length))
  const path = pathOfKey(dir, key)
  if (path == null) {
    res.writeHead(404).end('no such key')
    return
  }
  const file = key.slice(key.lastIndexOf('/') + 1)

  // The signature covers the verb, so a URL signed to read can neither write
  // nor delete. HEAD is checked as GET, as it always has been here.
  const method =
    req.method === 'PUT' ? 'PUT' : req.method === 'DELETE' ? 'DELETE' : 'GET'
  const expires = Number(url.searchParams.get('X-Amz-Expires') ?? '0')
  const signedAt = url.searchParams.get('X-Amz-Date') ?? ''
  const expected = presignGetUrl({
    ...space,
    method,
    key,
    expiresSec: expires,
    now: parseAmzDate(signedAt)
  })
  const given = url.searchParams.get('X-Amz-Signature') ?? ''
  const wanted = new URL(expected).searchParams.get('X-Amz-Signature') ?? ''
  if (given === '' || given !== wanted) {
    res.writeHead(403).end('bad signature')
    return
  }

  // A presigned PUT writes the object, so an import can be run end to end
  // against this without a network or a bill.
  if (method === 'PUT') {
    // Written a block at a time, like the real thing and unlike a test double
    // that holds the object in memory: a game's `video.mp4` is gigabytes, and
    // a stand-in that cannot take one is no rehearsal at all.
    await mkdir(join(path, '..'), { recursive: true })
    await pipeline(req, createWriteStream(path))
    res.writeHead(200).end()
    return
  }

  // A delete of something absent is a success on S3 too: 204 either way.
  if (method === 'DELETE') {
    await rm(path, { force: true })
    res.writeHead(204).end()
    return
  }

  const info = await stat(path).catch(() => undefined)
  if (info == null) {
    res.writeHead(404).end('no such object')
    return
  }

  // Range, because this is how a player seeks and the whole point of one
  // signature per file.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range != null) {
    const start = range[1] === '' ? 0 : Number(range[1])
    const end = range[2] === '' ? info.size - 1 : Number(range[2])
    res.writeHead(206, {
      'content-type': contentType(file),
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'accept-ranges': 'bytes'
    })
    createReadStream(path, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': String(info.size),
    'accept-ranges': 'bytes'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path).pipe(res)
}

function contentType(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (file.endsWith('.mp4')) return 'video/mp4'
  if (file.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

/** `20130524T000000Z` back into a Date. */
function parseAmzDate(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (match == null) return new Date(0)
  const [, y, mo, d, h, mi, s] = match
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}

/* c8 ignore start: the script itself, run by `npm run fake-space` */
async function main(): Promise<void> {
  // Read here, not at the top: importing the configuration reads (and may
  // write) `./serverConfig.json`, which the tests of the handler must not.
  const { serverConfig } = await import('../serverConfig')
  const host = process.env.TS_FAKE_SPACE_HOST ?? '127.0.0.1'
  // Another port only when 9199 is taken (another worktree's stand-in).
  const port = Number(process.env.TS_FAKE_SPACE_PORT ?? FAKE_SPACE_PORT)
  const dir =
    process.env.TS_FAKE_SPACE_DIR ?? join(serverConfig.workDir, 'space')
  await listen(host, port, { space: serverConfig.space, dir })
  console.log(
    `a stand-in Space on http://${host}:${port}/${serverConfig.space.bucket}/`
  )
  console.log(`serving ${dir}/{videos,images,chat}, signatures enforced`)
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
/* c8 ignore stop */
