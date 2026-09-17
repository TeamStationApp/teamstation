import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { presignGetUrl } from '../media/presign'
import { serverConfig } from '../serverConfig'

/**
 * A stand-in for the DigitalOcean Space, on this machine.
 *
 * It serves `/<bucket>/videos/<id>/<file>` out of the work directory and, like
 * the real thing, **refuses anything that is not correctly presigned**: it
 * recomputes the signature from the same key and compares. That is what makes
 * it worth running — it checks that the API signs the right key, for the right
 * bucket, with the right expiry, and that `Range` stays out of the signature so
 * a player can seek.
 *
 *   npm run fake-space
 *
 * Point `space` in serverConfig.json at it, with `pathStyle: true`, and flip a
 * video's `storage` to `spaces`.
 */
const PORT = 9199

const space = serverConfig.space

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end()
  })
})

async function handle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // The same CORS rule the real Space needs: GET and HEAD, the `Range`
  // request header, and the three headers a player reads back off a partial
  // response. Without these, hls.js cannot fetch a byte range at all.
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,HEAD,PUT')
  res.setHeader('access-control-allow-headers', 'range')
  res.setHeader(
    'access-control-expose-headers',
    'content-length,content-range,accept-ranges'
  )
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const prefix = `/${space.bucket}/`
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404).end('no such bucket')
    return
  }
  const key = decodeURIComponent(url.pathname.slice(prefix.length))

  // Two layouts live in the bucket: `videos/<id>/<file>` for a recording, and
  // `images/<kind>/<id>/<file>` for a mark or a face. Both map onto the work
  // directory, so what the importer wrote can be looked at with an image
  // viewer rather than only through a signature.
  const videoMatch = /^videos\/([^/]+)\/([^/]+)$/.exec(key)
  const imageMatch = /^images\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key)
  if (videoMatch == null && imageMatch == null) {
    res.writeHead(404).end('no such key')
    return
  }
  const file = videoMatch != null ? videoMatch[2] : imageMatch![3]
  const path =
    videoMatch != null
      ? join(serverConfig.workDir, 'videos', videoMatch[1], file)
      : join(
          serverConfig.workDir,
          'images',
          imageMatch![1],
          imageMatch![2],
          file
        )

  const expires = Number(url.searchParams.get('X-Amz-Expires') ?? '0')
  const signedAt = url.searchParams.get('X-Amz-Date') ?? ''
  const expected = presignGetUrl({
    ...space,
    method: req.method === 'PUT' ? 'PUT' : 'GET',
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
  // against this without a network or a bill. The signature covers the verb,
  // so a URL signed to read cannot be used to write.
  if (req.method === 'PUT') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.concat(chunks))
    res.writeHead(200).end()
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`a stand-in Space on http://127.0.0.1:${PORT}/${space.bucket}/`)
  console.log(`serving ${serverConfig.workDir}/videos, signatures enforced`)
})
