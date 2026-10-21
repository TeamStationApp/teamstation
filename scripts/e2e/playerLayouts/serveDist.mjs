// The production web build (`npm run build.web`, `dist/app-<hash>.js` with its
// source map) and the API on one origin, for the player-layouts scenarios.
//
//   node scripts/e2e/playerLayouts/serveDist.mjs [--port 8091] \
//     [--api http://127.0.0.1:9140] [--dist dist] \
//     [--space http://127.0.0.1:9199 --bucket media-bucket]
//
// The production bundle asks for `/api/v1` on its own origin, so this serves
// `dist/` and passes `/api/*` (requests and WebSocket upgrades) through to the
// API. Browser coverage maps the bundle back to the sources through
// `dist/app-<hash>.js.map`, which only this build has. A local recording's
// `/media/*` goes to the API too. It listens on every
// address, so a phone on the network loads the same page.
//
// With `--space`, `/<bucket>/*` goes to the stand-in Space (`npm run
// fake-space`, which listens on the loopback only) with its Host left as
// the browser sent it: point `space.endpoint` at this server, and the
// presigned addresses, signed for this host, reach a phone too.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8091' },
    api: { type: 'string', default: 'http://127.0.0.1:9140' },
    dist: { type: 'string', default: 'dist' },
    space: { type: 'string' },
    bucket: { type: 'string', default: 'media-bucket' }
  }
})
const space = values.space == null ? null : new URL(values.space)
const root = resolve(values.dist)
const api = new URL(values.api)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const toSpace = space != null && url.pathname.startsWith(`/${values.bucket}/`)
  // The API serves a local recording's files under `/media/`, at the address
  // its `primaryUrlOverride` names: this server, for a phone to reach.
  const toApi =
    url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')
  if (toApi || toSpace) {
    const target = toSpace ? space : api
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: toSpace ? req.headers : { ...req.headers, host: api.host }
      },
      answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    return
  }
  // A path the app routes itself is its page.
  let file = join(root, normalize(url.pathname))
  if (!file.startsWith(root)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html')
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  })
  createReadStream(file).pipe(res)
})

// WebSockets (the board's change notices, the dashboard) go through as bytes.
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(Number(api.port), api.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(
        `${req.rawHeaders[i]}: ${req.rawHeaders[i].toLowerCase() === 'host' ? api.host : req.rawHeaders[i + 1]}`
      )
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(Number(values.port), '0.0.0.0', () => {
  console.log(`dist on http://0.0.0.0:${values.port}, /api to ${api.origin}`)
})
