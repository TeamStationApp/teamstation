import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, createWriteStream } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'

/** A local, signature-checking S3 stand-in for development and HTTP tests. */
export const FAKE_SPACE_PORT = 9199

export interface FakeSpaceFault {
  method?: string
  key?: RegExp
  delayMs?: number
  status?: number
  truncateTo?: number
  readBack?: Buffer
}

export class FakeSpaceFaults {
  private rules: FakeSpaceFault[] = []

  set(rule: FakeSpaceFault): void {
    this.rules.push(rule)
  }

  clear(): void {
    this.rules = []
  }

  matching(method: string, key: string): FakeSpaceFault[] {
    return this.rules.filter(rule => {
      if (rule.method != null && rule.method !== method) return false
      if (rule.key == null) return true
      rule.key.lastIndex = 0
      return rule.key.test(key)
    })
  }
}

export interface FakeSpaceOptions {
  space: SpaceSettings
  dir: string
  log?: string
  faults?: FakeSpaceFaults
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

export function fakeSpaceHandler(options: FakeSpaceOptions): Handler {
  return (req, res) => {
    if (options.log != null)
      res.once('finish', () => {
        appendFileSync(
          options.log!,
          `${new Date().toISOString()} ${req.method} ${(req.url ?? '/').split('?')[0]} ${res.statusCode} ${req.socket.remoteAddress}\n`
        )
      })
    handle(options, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
      else res.destroy()
    })
  }
}

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

/** The caller sets space.endpoint to url when port zero chose the port. */
export async function startFakeSpace(
  options: FakeSpaceOptions & { host?: string; port?: number }
): Promise<{ server: Server; url: string; faults: FakeSpaceFaults }> {
  const faults = options.faults ?? new FakeSpaceFaults()
  if (options.log != null)
    await mkdir(dirname(options.log), { recursive: true })
  const host = options.host ?? '127.0.0.1'
  const server = await listen(host, options.port ?? 0, { ...options, faults })
  const address = server.address() as { port: number }
  return { server, url: `http://${host}:${address.port}`, faults }
}

/** A key must stay inside its own object directory. Sidecars are private. */
export function pathOfKey(dir: string, key: string): string | undefined {
  const parts = key.split('/')
  if (
    parts.some(
      part =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.includes('\\') ||
        part.includes('\0') ||
        part.endsWith('.content-type') ||
        part.startsWith('.upload-')
    )
  )
    return undefined
  if (
    (parts[0] === 'videos' && parts.length >= 3) ||
    (parts[0] === 'images' && parts.length >= 4) ||
    (parts[0] === 'chat' && parts.length === 3)
  )
    return join(dir, ...parts)
  return undefined
}

async function handle(
  options: FakeSpaceOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { space, dir } = options
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
  const method = req.method
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'PUT' &&
    method !== 'DELETE'
  ) {
    res.writeHead(405).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const prefix = `/${space.bucket}/`
  if (!url.pathname.startsWith(prefix) && url.pathname !== `/${space.bucket}`) {
    res.writeHead(404).end('no such bucket')
    return
  }
  const key = decodeURIComponent(url.pathname.slice(prefix.length))
  const listing =
    key === '' && method === 'GET' && url.searchParams.get('list-type') === '2'
  const path = pathOfKey(dir, key)
  if (!listing && path == null) {
    res.writeHead(404).end('no such key')
    return
  }
  const query = Object.fromEntries(
    [...url.searchParams].filter(([name]) => !name.startsWith('X-Amz-'))
  )
  const expires = Number(url.searchParams.get('X-Amz-Expires') ?? '0')
  const expected = new URL(
    presignGetUrl({
      ...space,
      method,
      key,
      query,
      expiresSec: expires,
      now: parseAmzDate(url.searchParams.get('X-Amz-Date') ?? '')
    })
  )
  if (
    url.searchParams.size !== expected.searchParams.size ||
    [...expected.searchParams].some(
      ([name, value]) => url.searchParams.get(name) !== value
    )
  ) {
    res.writeHead(403).end('bad signature')
    return
  }
  let truncateTo: number | undefined
  let readBack: Buffer | undefined
  for (const fault of options.faults?.matching(method, key) ?? []) {
    if (fault.delayMs != null)
      await new Promise(resolve => setTimeout(resolve, fault.delayMs))
    if (fault.status != null) {
      req.resume()
      res.writeHead(fault.status).end()
      return
    }
    truncateTo = fault.truncateTo ?? truncateTo
    readBack = fault.readBack ?? readBack
  }
  if (listing) {
    const all = (await objectKeys(dir))
      .filter(key => key.startsWith(query.prefix ?? ''))
      .sort()
    const after = query['continuation-token'] ?? ''
    const max = Math.max(1, Math.min(1000, Number(query['max-keys'] ?? 1000)))
    const remaining = all.filter(key => key > after)
    const page = remaining.slice(0, max)
    const contents: string[] = []
    // Recordings can exceed Buffer's size limit. Bound both open files and
    // memory while computing their ETags, preserving the sorted page order.
    for (let offset = 0; offset < page.length; offset += 8) {
      contents.push(
        ...(await Promise.all(
          page.slice(offset, offset + 8).map(async key => {
            const file = await open(join(dir, key), 'r')
            try {
              const { size } = await file.stat()
              const hash = createHash('md5')
              for await (const chunk of file.createReadStream({
                autoClose: false
              }))
                hash.update(chunk)
              return `<Contents><Key>${xml(key)}</Key><Size>${size}</Size><ETag>&quot;${hash.digest('hex')}&quot;</ETag></Contents>`
            } finally {
              await file.close()
            }
          })
        ))
      )
    }
    const truncated = remaining.length > page.length
    res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<ListBucketResult>${contents.join('')}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(page[page.length - 1])}</NextContinuationToken>` : ''}</ListBucketResult>`
      )
    return
  }
  // path has been checked above; a listing has already returned.
  const file = path!
  if (method === 'PUT') {
    await mkdir(dirname(file), { recursive: true })
    const temp = join(dirname(file), `.upload-${randomUUID()}`)
    let taken = 0
    const trim = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const out =
          truncateTo == null
            ? chunk
            : chunk.subarray(0, Math.max(0, truncateTo - taken))
        taken += out.length
        done(null, out)
      }
    })
    try {
      await pipeline(req, trim, createWriteStream(temp))
      await rename(temp, file)
      await writeFile(
        `${file}.content-type`,
        req.headers['content-type'] ?? contentType(file)
      )
    } finally {
      await rm(temp, { force: true })
    }
    res.writeHead(200).end()
    return
  }
  if (method === 'DELETE') {
    await rm(file, { force: true })
    await rm(`${file}.content-type`, { force: true })
    res.writeHead(204).end()
    return
  }
  const info = await stat(file).catch(() => undefined)
  if (info?.isFile() !== true) {
    res.writeHead(404).end('no such object')
    return
  }
  const type = await readFile(`${file}.content-type`, 'utf8').catch(() =>
    contentType(file)
  )
  const size = readBack?.length ?? info.size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0
  let end = size - 1
  if (range != null) {
    start =
      range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
    end =
      range[1] === '' || range[2] === ''
        ? size - 1
        : Math.min(size - 1, Number(range[2]))
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
      return
    }
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
  }
  res.writeHead(range == null ? 200 : 206, {
    'content-type': type,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes'
  })
  if (method === 'HEAD') res.end()
  else if (readBack != null) res.end(readBack.subarray(start, end + 1))
  else
    await pipeline(
      createReadStream(file, range == null ? undefined : { start, end }),
      res
    )
}

async function objectKeys(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), {
    withFileTypes: true
  }).catch(() => [])
  const keys: string[] = []
  for (const entry of entries) {
    const key = prefix + entry.name
    if (entry.isDirectory()) keys.push(...(await objectKeys(dir, key + '/')))
    else if (entry.isFile() && pathOfKey(dir, key) != null) keys.push(key)
  }
  return keys
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function contentType(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (file.endsWith('.m4s')) return 'video/iso.segment'
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
  await startFakeSpace({
    host,
    port,
    space: serverConfig.space,
    dir,
    log: process.env.TS_FAKE_SPACE_LOG
  })
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
