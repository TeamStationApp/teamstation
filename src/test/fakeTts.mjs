import { createServer } from 'node:http'

/**
 * A stand-in for xAI's text to speech, for the replay's announcer in tests
 * and on a development server. POST /tts answers a short tone as MP3 and
 * counts the request; GET /count answers how many it has had, and the text
 * of each; POST /fail?status=503 makes every later /tts answer that status,
 * and POST /fail?status=0 heals it.
 *
 *   node src/test/fakeTts.mjs [port]     prints the base URL to use
 */

/** 0.4 s of 440 Hz, mono, 24 kHz, 32 kbit/s. */
export const TONE = Buffer.from(
  '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',
  'base64'
)

export function startFakeTts(port = 0) {
  const spoken = []
  let failWith = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/count') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ count: spoken.length, spoken }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/fail') {
      failWith = Number(url.searchParams.get('status') ?? 0)
      res.end()
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/tts') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      if (failWith > 0) {
        res.statusCode = failWith
        res.end()
        return
      }
      spoken.push(JSON.parse(body).text)
      res.setHeader('content-type', 'audio/mpeg')
      res.end(TONE)
    })
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        spoken,
        close: () =>
          new Promise(resolve => {
            server.close(() => {
              resolve()
            })
          })
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeTts(Number(process.argv[2] ?? 0))
  console.log(fake.url)
}
