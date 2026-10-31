import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { extname, join, normalize } from 'node:path'

/** The paths Caddy sends to the API on a seat. Everything else is the page. */
export const API_PATHS = [
  /^\/api(?:\/|$)/,
  /^\/socket(?:\/|$)/,
  /^\/media(?:\/|$)/,
  /^\/oauth(?:\/|$)/,
  /^\/\.well-known\/openid-configuration$/,
  /^\/\.well-known\/(?:apple-app-site-association|assetlinks\.json)$/,
  /^\/apple-app-site-association$/,
  /^\/signin(?:\/|$)/
]

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2'
}

export function goesToApi(path: string): boolean {
  return API_PATHS.some(pattern => pattern.test(path))
}

/**
 * Joins a stack's web build and API on one origin, the job Caddy does on a seat, so
 * the page's relative `/api/v1` and its socket reach the API.
 */
export async function startFront(options: {
  webDir: string
  apiPort: number
  host: string
  port: number
}): Promise<{ server: Server; url: string }> {
  const { webDir, apiPort, host, port } = options
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://front').pathname
    if (goesToApi(path)) {
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: apiPort,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            'x-forwarded-for': req.socket.remoteAddress ?? '',
            'x-forwarded-proto': 'http'
          }
        },
        reply => {
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        }
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
      return
    }
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
    const file = join(webDir, safe)
    const served =
      existsSync(file) && statSync(file).isFile()
        ? file
        : join(webDir, 'index.html')
    if (!existsSync(served)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(served)] ?? 'application/octet-stream'
    })
    createReadStream(served).pipe(res)
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://front').pathname
    if (!goesToApi(path)) {
      socket.destroy()
      return
    }
    const upstream = connect(apiPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join('\r\n')
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n` +
          `x-forwarded-for: ${req.socket.remoteAddress ?? ''}\r\n\r\n`
      )
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address() as { port: number }
  return { server, url: `http://${host}:${address.port}` }
}
