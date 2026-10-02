// Listens to one or more games on the game socket and prints every frame the
// server sends as a line of JSON, for the socket checks in the walk-up songs
// plan (E10-E12, E16, E25).
//
//   node scripts/game-socket-listen.mjs --api http://127.0.0.1:9120/api/v1 \
//     --email m@example.com --password '...' --game gam_g2 [--game ...]
//
// Signs in with --email and --password (or uses --token, or TS_TOKEN), then
// subscribes through the app's own client, `src/common/gameSocket.ts`, so a
// dropped connection reconnects, subscribes again and prints the `resync` the
// screens would get. --no-token connects with no credentials at all, and
// --once exits after the first close or refusal instead of reconnecting.
//
// Each line is `{ "receivedAt": <iso>, ...frame }`. Beside the server's frames
// it prints `status` (connected or not), `resync`, and `socketError` (for
// example `Unexpected server response: 401` for a refused upgrade).
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import WebSocket from 'ws'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { GameSocket } = require('../src/common/gameSocket.ts')

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:9100/api/v1' },
    email: { type: 'string' },
    password: { type: 'string' },
    token: { type: 'string' },
    'no-token': { type: 'boolean', default: false },
    game: { type: 'string', multiple: true, default: [] },
    once: { type: 'boolean', default: false }
  }
})

const print = line => {
  console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...line }))
}

async function signIn() {
  if (values['no-token']) return undefined
  const token = values.token ?? process.env.TS_TOKEN
  if (token != null) return token
  if (values.email == null || values.password == null) {
    throw new Error('Give --email and --password, --token, or --no-token')
  }
  const response = await fetch(`${values.api}/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: values.email, password: values.password })
  })
  if (!response.ok) {
    throw new Error(`Signing in answered ${response.status}`)
  }
  return (await response.json()).token
}

let finished = false

/** `ws`, printing every frame and failure as it comes. */
class PrintingWebSocket extends WebSocket {
  constructor(url, protocols, options) {
    super(url, protocols, options)
    this.on('message', data => {
      try {
        print(JSON.parse(data.toString('utf8')))
      } catch {
        print({ type: 'unreadable', data: data.toString('utf8') })
      }
    })
    this.on('error', error => {
      print({ type: 'socketError', message: error.message })
      if (values.once) finish(1)
    })
    this.on('close', (code, reason) => {
      print({ type: 'closed', code, reason: reason.toString('utf8') })
      if (values.once) finish(0)
    })
  }
}

const token = await signIn()
const socket = new GameSocket({
  baseUrl: values.api,
  token,
  WebSocketImpl: PrintingWebSocket
})
socket.onStatus(connected => {
  print({ type: 'status', connected })
})
print({ type: 'connecting', url: socket.url, withToken: token != null })
for (const gameId of values.game) {
  socket.subscribe(gameId, event => {
    // Changes and errors are printed as the server sent them; the resync is
    // the client's own, and is what a screen would act on.
    if (event.type === 'resync') print(event)
  })
}
function finish(code) {
  if (finished) return
  finished = true
  socket.close()
  process.exitCode = code
  setTimeout(() => process.exit(code), 50)
}
process.on('SIGINT', () => finish(0))
process.on('SIGTERM', () => finish(0))
