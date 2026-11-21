// What a first visit to the web build transfers: the page, and every JS,
// CSS and WASM file it names or its scripts name, each asked for as a
// browser asks (`Accept-Encoding: br, gzip`), with the encoding it came in
// and its bytes on the wire, and the total.
//
//   node scripts/webTransferSize.mjs http://127.0.0.1:8180
//
// It reads the raw response, not a decoded one, so the bytes are what
// crossed the network.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

const origin = process.argv[2]
if (origin == null) throw new Error('usage: webTransferSize.mjs <origin>')

/** One GET, raw: status, headers and the bytes as they came. */
async function get(url) {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise((resolve, reject) => {
    const req = send(
      target,
      { headers: { 'accept-encoding': 'br, gzip' } },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** The text of a response, decoded as its encoding says. */
function text(answer) {
  const encoding = answer.headers['content-encoding']
  const raw =
    encoding === 'br'
      ? brotliDecompressSync(answer.body)
      : encoding === 'gzip'
        ? gunzipSync(answer.body)
        : answer.body
  return raw.toString('utf8')
}

const ASSET = /["'(](\/[\w./-]+?\.(?:js|css|wasm))["')]/g

const rows = []
const seen = new Set()
async function visit(path) {
  if (seen.has(path)) return
  seen.add(path)
  const answer = await get(new URL(path, origin).href)
  rows.push({
    path,
    status: answer.status,
    type: String(answer.headers['content-type'] ?? ''),
    encoding: String(answer.headers['content-encoding'] ?? 'identity'),
    vary: String(answer.headers.vary ?? ''),
    bytes: answer.body.length
  })
  if (answer.status !== 200) return
  if (path === '/' || path.endsWith('.js') || path.endsWith('.css'))
    for (const [, named] of text(answer).matchAll(ASSET))
      if (!named.startsWith('//')) await visit(named)
}

await visit('/')
const width = Math.max(...rows.map(row => row.path.length))
console.log(`First visit to ${origin}, Accept-Encoding: br, gzip`)
for (const row of rows)
  console.log(
    `${row.path.padEnd(width)}  ${String(row.status).padStart(3)}  ${row.encoding.padEnd(8)}  ${String(row.bytes).padStart(10)}  ${row.type}${row.vary === '' ? '' : `  vary: ${row.vary}`}`
  )
const total = rows.reduce((sum, row) => sum + row.bytes, 0)
console.log(
  `${'total'.padEnd(width)}       ${''.padEnd(8)}  ${String(total).padStart(10)}  bytes over ${rows.length} files`
)
