/**
 * Visual-regression screenshot driver for the gamestation web client.
 *
 * Boots the webpack dev server and the mock WebSocket server, then visits
 * each public route in headless Chromium and writes a deterministic PNG
 * to the configured output directory.
 *
 * Usage:
 *   node tools/screenshotWeb.js --out=screenshots/baseline
 *   node tools/screenshotWeb.js --out=screenshots/upgraded
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const net = require('net')

const puppeteer = require('puppeteer')
const mockWs = require('./mockWebSockets')

const REPO_ROOT = path.resolve(__dirname, '..')
const WEBPACK_PORT = 8080
// Use a non-default port so the screenshot harness never collides with
// a locally running gamestation server (which listens on 8008).
const MOCK_WS_PORT = Number(process.env.MOCK_WS_PORT ?? 8009)

const ROUTES = [
  { slug: 'home', path: '/' },
  { slug: 'links', path: '/links/visualtest' },
  { slug: 'dashboard', path: '/dashboard/visualtest' },
  { slug: 'scoreboard', path: '/scoreboard/visualtest' }
]

function parseArgs() {
  const args = {}
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) args[m[1]] = m[2]
  }
  if (args.out == null) {
    throw new Error('Missing --out=<dir> argument')
  }
  return args
}

async function waitForPort(port, host = '127.0.0.1', timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const sock = net.createConnection({ port, host })
      sock.once('connect', () => {
        sock.end()
        resolve(true)
      })
      sock.once('error', () => resolve(false))
    })
    if (open) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${host}:${port}`)
}

function startWebpackDevServer() {
  console.log('[screenshotWeb] starting webpack-dev-server on :' + WEBPACK_PORT)
  const child = spawn('yarn', ['start.web'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  child.stdout.on('data', d =>
    process.stderr.write('[webpack] ' + d.toString())
  )
  child.stderr.on('data', d =>
    process.stderr.write('[webpack] ' + d.toString())
  )
  return child
}

async function captureRoute(browser, route, outDir) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' }
  ])
  // Make Math.random deterministic so EventRegistration's random event id
  // does not change between runs.
  await page.evaluateOnNewDocument(() => {
    let seed = 0
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
  })

  // Redirect the client's WebSocket URLs to our mock port so the
  // screenshot harness does not collide with a real local gamestation
  // server already listening on the default 8008.
  await page.evaluateOnNewDocument(mockPort => {
    const Original = window.WebSocket
    function Patched(url, protocols) {
      try {
        const u = new URL(url)
        if (
          (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
          (u.port === '8008' || u.port === '')
        ) {
          u.port = String(mockPort)
          url = u.toString()
        }
      } catch (_) {}
      return new Original(url, protocols)
    }
    Patched.prototype = Original.prototype
    Patched.CONNECTING = Original.CONNECTING
    Patched.OPEN = Original.OPEN
    Patched.CLOSING = Original.CLOSING
    Patched.CLOSED = Original.CLOSED
    window.WebSocket = Patched
  }, MOCK_WS_PORT)

  const url = `http://localhost:${WEBPACK_PORT}${route.path}`
  console.log(`[screenshotWeb] visit ${url}`)
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 })

  // The Scoreboard screen sets document.body.style.backgroundColor to
  // transparent for OBS chroma keying. Force it back to opaque so the PNG
  // diffs against a stable background.
  await page.addStyleTag({
    content: `
      html, body { background: #111 !important; }
    `
  })

  await new Promise(resolve => setTimeout(resolve, 1500))

  const outPath = path.join(outDir, `${route.slug}.png`)
  await page.screenshot({ path: outPath, fullPage: false })
  console.log(`[screenshotWeb] wrote ${outPath}`)
  await page.close()
}

async function main() {
  const args = parseArgs()
  const outDir = path.resolve(REPO_ROOT, args.out)
  fs.mkdirSync(outDir, { recursive: true })

  const wss = mockWs.start({ port: MOCK_WS_PORT })
  const webpackChild = startWebpackDevServer()

  let browser
  try {
    await waitForPort(WEBPACK_PORT)
    console.log('[screenshotWeb] webpack-dev-server ready')

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    })

    for (const route of ROUTES) {
      await captureRoute(browser, route, outDir)
    }
  } finally {
    if (browser != null) await browser.close().catch(() => {})
    webpackChild.kill('SIGTERM')
    wss.close()
  }
  console.log('[screenshotWeb] done')
}

main().catch(err => {
  console.error('[screenshotWeb] error', err)
  process.exit(1)
})
