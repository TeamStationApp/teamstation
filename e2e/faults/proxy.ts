import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse
} from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

import type { ServerError } from '../core/invariants'

/**
 * Sits between the app and a server, recording every 5xx, and breaking the matched
 * routes when a fault is named. With none it only records.
 */
export interface FaultProxyOptions {
  target: string
  fault?: string
  match?: RegExp
  host?: string
}

export interface FaultProxy {
  url: string
  port: number
  errors: ServerError[]
  /** What the proxy broke on purpose. */
  injections: Array<{ at: number; fault: string; path: string }>
  close: () => Promise<void>
}

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE']
/** Sign-in stays up by default, so a fault reaches the screens a scenario checks. */
const API_BUT_SIGN_IN = /^\/api(?!\/v1\/auth(?:\/|$))(?:\/|$)/
const SHOWN_TEXT = /name|title|label|venue/i
const SHOWN_NUMBER = /score|count|runs/i

/** Changes what a person would read, and leaves ids and states the app needs alone. */
export function corruptShown(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && SHOWN_TEXT.test(key)) {
    return 'Corrupted'
  }
  if (typeof value === 'number' && SHOWN_NUMBER.test(key)) return value + 1
  if (Array.isArray(value)) return value.map(row => corruptShown(row, key))
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, row]) => [
        name,
        corruptShown(row, name)
      ])
    )
  }
  return value
}

export async function startFaultProxy(
  options: FaultProxyOptions
): Promise<FaultProxy> {
  const { fault } = options
  const match = options.match ?? API_BUT_SIGN_IN
  const target = new URL(options.target)
  const errors: ServerError[] = []
  const injections: FaultProxy['injections'] = []
  const held = new Set<ServerResponse>()
  const open = new Set<Duplex>()

  const inject = (req: IncomingMessage): void => {
    injections.push({
      at: Date.now(),
      fault: fault ?? '',
      path: req.url ?? '/'
    })
  }
  const record = (req: IncomingMessage, status: number): void => {
    errors.push({
      at: Date.now(),
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      status
    })
  }

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    alter: boolean
  ): void => {
    const headers = { ...req.headers, host: target.host }
    if (alter) delete headers['accept-encoding']
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers
      },
      reply => {
        const status = reply.statusCode ?? 502
        if (status >= 500) record(req, status)
        const isJson = String(reply.headers['content-type']).includes('json')
        if (!alter || !isJson) {
          res.writeHead(status, reply.headers)
          reply.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        reply.on('data', (chunk: Buffer) => chunks.push(chunk))
        reply.on('end', () => {
          let body = Buffer.concat(chunks)
          try {
            body = Buffer.from(
              JSON.stringify(corruptShown(JSON.parse(body.toString())))
            )
            inject(req)
          } catch {
            // Not JSON after all: it goes through as it came.
          }
          const out = { ...reply.headers, 'content-length': body.length }
          delete out['transfer-encoding']
          res.writeHead(status, out)
          res.end(body)
        })
      }
    )
    upstream.on('error', () => {
      record(req, 502)
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://proxy').pathname
    const matched = match.test(path)
    if (matched && fault === 'api-500') {
      inject(req)
      record(req, 500)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"injected"}')
      return
    }
    if (matched && fault === 'api-hang') {
      inject(req)
      held.add(res)
      return
    }
    if (matched && fault === 'api-garbage') {
      inject(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('<<<not json>>>')
      return
    }
    if (matched && fault === 'not-saved' && WRITES.includes(req.method ?? '')) {
      inject(req)
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    forward(req, res, matched && fault === 'wrong-data')
  })

  server.on('upgrade', (req, socket, head) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    const path = new URL(req.url ?? '/', 'http://proxy').pathname
    if (fault === 'socket-drop' && !path.startsWith('/api/v1/none')) {
      inject(req)
      socket.destroy()
      return
    }
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = Object.entries(req.headers)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join('\r\n')
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines}\r\n\r\n`)
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const { port } = server.address() as { port: number }
  return {
    url: `http://${host}:${port}`,
    port,
    errors,
    injections,
    close: async () => {
      for (const res of held) res.destroy()
      for (const socket of open) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
}
