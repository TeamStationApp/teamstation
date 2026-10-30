import { subscribe } from 'node:diagnostics_channel'
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Private fixture diagnostics: never publish addresses, agents or raw paths. */
export interface OriginRequest {
  at: number
  method: string
  path: string
  status: number
  address: string
  agent: string
}

// Preloaded only in the fixture viewer process, after sucrase/register.
// Query strings and authorization headers are never captured.
const trace = process.env.TS_ORIGIN_REQUEST_TRACE
if (trace != null) {
  subscribe('http.server.request.start', message => {
    const { request, response } = message as {
      request: IncomingMessage
      response: ServerResponse
    }
    const entry = {
      at: Date.now(),
      method: request.method ?? '',
      path: (request.url ?? '').split('?')[0],
      address: request.socket.remoteAddress ?? '',
      agent: request.headers['user-agent'] ?? ''
    }
    response.once('finish', () => {
      appendFileSync(
        trace,
        JSON.stringify({ ...entry, status: response.statusCode }) + '\n'
      )
    })
  })
}
