// Serve behind a public test origin for the signed-phone link preview scenario.
// Configure previewPage.pendingUrl as <origin>/pending.
import { createServer } from 'node:http'
import { URL } from 'node:url'

const active = new Set()
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const url = new URL(req.url, 'http://localhost')
  const probe = url.searchParams.get('probe')
  if (url.pathname !== '/pending' || !/^[a-f0-9-]{36}$/.test(probe ?? '')) {
    res.writeHead(404).end()
    return
  }
  if (req.method === 'HEAD') {
    res.writeHead(active.has(probe) ? 204 : 404).end()
    return
  }
  if (req.method !== 'GET' || active.size >= 64 || active.has(probe)) {
    res.writeHead(429).end()
    return
  }
  active.add(probe)
  const timer = setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<title>Delayed test page</title>')
  }, 10000)
  res.on('close', () => {
    clearTimeout(timer)
    active.delete(probe)
  })
}).listen(Number(process.env.PORT ?? 9884), '127.0.0.1')
