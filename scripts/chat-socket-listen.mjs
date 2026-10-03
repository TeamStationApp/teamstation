// Listens to the chat hints on the socket and prints every frame the server
// sends as a line of JSON, for checking the chat socket by hand (E4).
//
//   node scripts/chat-socket-listen.mjs --api http://127.0.0.1:9120/api/v1 \
//     --email hc@chat.example.com --password '...' [--seconds 30] \
//     [--type cnv_… [--type …]]
//
// Signs in with --email and --password (or uses --token, or TS_TOKEN, sent as
// a bearer header; or --cookie, the `ts_session` cookie's value), then
// listens through the app's own client, `src/common/gameSocket.ts`, with
// `onChat` and no game subscribed, so a dropped connection reconnects and
// prints the `resync` the chat engine would get. --type sends a typing hint
// every three and a half seconds, to each conversation named in turn. --seconds
// exits after that long; --once exits after the first close or refusal
// instead of reconnecting.
//
// Each line is `{ "receivedAt": <iso>, ...frame }`. Beside the server's frames
// it prints `status` (connected or not), `chatEvent` (what an `onChat`
// listener heard, which for a reconnect is the client's own `resync`), and
// `socketError` (for example `Unexpected server response: 401` for a refused
// upgrade).
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
    cookie: { type: 'string' },
    type: { type: 'string', multiple: true, default: [] },
    seconds: { type: 'string' },
    once: { type: 'boolean', default: false }
  }
})

const print = line => {
  console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...line }))
}

async function signIn() {
  if (values.cookie != null) return undefined
  const token = values.token ?? process.env.TS_TOKEN
  if (token != null) return token
  if (values.email == null || values.password == null) {
    throw new Error('Give --email and --password, --token, or --cookie')
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
    // A browser sends its session cookie by itself; this one is given it.
    const headers = { ...options?.headers }
    if (values.cookie != null) headers.Cookie = `ts_session=${values.cookie}`
    super(url, protocols, { headers })
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
print({
  type: 'connecting',
  url: socket.url,
  with: values.cookie != null ? 'cookie' : 'bearer'
})
const stop = socket.onChat(event => {
  print({ type: 'chatEvent', event })
})
let typer
if (values.type.length > 0) {
  // One conversation a turn, in rotation: the server takes one hint every
  // three seconds from a socket.
  let turn = 0
  typer = setInterval(() => {
    const conversationId = values.type[turn++ % values.type.length]
    if (socket.sendTyping(conversationId)) {
      print({ type: 'sentTyping', conversationId })
    }
  }, 3500)
}
function finish(code) {
  if (finished) return
  finished = true
  clearInterval(typer)
  stop()
  socket.close()
  process.exitCode = code
  setTimeout(() => process.exit(code), 50)
}
if (values.seconds != null) {
  setTimeout(() => finish(0), Number(values.seconds) * 1000)
}
process.on('SIGINT', () => finish(0))
process.on('SIGTERM', () => finish(0))
