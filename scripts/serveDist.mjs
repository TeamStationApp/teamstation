// Serves the production web build in `dist/` (`npm run build.web`), for the
// browser coverage runs: `recordBrowserCoverage` reads the hashed
// `dist/app-<hash>.js` bundle and its map, which only that build writes.
//
//   node scripts/serveDist.mjs [port]         (8080 by default)
//
// A path that names a file in `dist/` is that file; any other path is
// `index.html`, as the app's addresses are. `/api/*` goes to TS_API_PROXY
// (`http://127.0.0.1:9100`) when it is set, so the build's relative `/api/v1`
// reaches a local server; without it `/api/*` answers 404, for a test that
// intercepts its requests in the browser.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const root = resolve('dist')
const port = Number(process.argv[2] ?? process.env.TS_SERVE_PORT ?? 8080)
if (!Number.isInteger(port) || port <= 0)
  throw new Error(`Expected a port, got ${process.argv[2]}`)
const proxy =
  process.env.TS_API_PROXY == null || process.env.TS_API_PROXY === ''
    ? null
    : new URL(process.env.TS_API_PROXY)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
}

/** The file in `dist/` a path names, or null when it names none. */
async function fileOf(pathname) {
  const path = normalize(join(root, decodeURIComponent(pathname)))
  if (path !== root && !path.startsWith(root + sep)) return null
  try {
    return (await stat(path)).isFile() ? path : null
  } catch {
    return null
  }
}

function forward(req, res) {
  const outgoing = request(
    {
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: proxy.host }
    },
    answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    }
  )
  outgoing.on('error', error => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`API proxy failed: ${error.message}`)
  })
  req.pipe(outgoing)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/api/')) {
    if (proxy != null) forward(req, res)
    else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'No API behind serveDist' }))
    }
    return
  }
  fileOf(url.pathname)
    .then(async file => {
      const path = file ?? join(root, 'index.html')
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-cache'
      })
      createReadStream(path).pipe(res)
    })
    .catch(error => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(error))
    })
})
server.listen(port, '127.0.0.1', () => {
  console.log(`dist on http://127.0.0.1:${port}`)
  console.log(
    proxy == null ? 'no API: /api/* answers 404' : `/api/* goes to ${proxy}`
  )
})
