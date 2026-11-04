import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import type { RecoveryFault, RecoveryFaults } from './chatRecoveryFaults'

/** Only a test-owned loopback API may receive relayed credentials or ciphertext. */
export async function recoveryRelay(options: {
  disposable: true
  upstream: string
  controlToken: string
  faults: RecoveryFaults
  allowedOrigins: string[]
  port?: number
  host?: string
}): Promise<{ port: number; close: () => Promise<void> }> {
  assert.equal(options.disposable, true)
  const upstream = new URL(options.upstream)
  assert.equal(upstream.protocol, 'http:')
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))
  assert.equal(
    upstream.username + upstream.password + upstream.search + upstream.hash,
    ''
  )
  assert.equal(upstream.pathname, '/')
  assert(options.controlToken.length >= 32)
  assert(
    options.allowedOrigins.every(
      origin => new URL(origin).origin === origin && origin !== 'null'
    )
  )
  const sockets = new Set<Socket>()
  const validControl = (req: IncomingMessage): boolean => {
    const actual = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from('Bearer ' + options.controlToken)
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    )
  }
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', upstream)
      // Absolute-form URLs must not turn a test proxy into a general relay.
      assert.equal(url.origin, upstream.origin)
      if (
        req.headers.origin != null &&
        options.allowedOrigins.includes(req.headers.origin)
      ) {
        res.setHeader('access-control-allow-origin', req.headers.origin)
        res.setHeader('access-control-allow-credentials', 'true')
        res.setHeader('vary', 'Origin')
      }
      if (url.pathname === '/__recovery_fault') {
        if (!validControl(req)) {
          res.writeHead(403).end()
          return
        }
        if (req.method === 'DELETE') {
          options.faults.clear()
          res.writeHead(204).end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const part of req) {
          const chunk = Buffer.from(part)
          length += chunk.length
          assert(length <= 4096, 'Control body too large')
          chunks.push(chunk)
        }
        options.faults.set(
          JSON.parse(Buffer.concat(chunks).toString()) as RecoveryFault
        )
        res.writeHead(204).end()
        return
      }
      if (
        /^\/api\/v1\/chat\/conversations\/cnv_[a-zA-Z0-9_-]+\/(messages|epochs)$/.test(
          url.pathname
        )
      ) {
        const auth = await fetch(new URL('/api/v1/auth/me', upstream), {
          headers: {
            ...(req.headers.cookie == null
              ? {}
              : { cookie: req.headers.cookie }),
            ...(req.headers.authorization == null
              ? {}
              : { authorization: req.headers.authorization })
          },
          redirect: 'error',
          signal: AbortSignal.timeout(5000)
        })
        const actor = auth.ok
          ? ((await auth.json()) as { id?: string })
          : undefined
        if (typeof actor?.id === 'string') {
          const fault = options.faults.claim(actor.id, req.method ?? '', url)
          if (fault != null) {
            await options.faults.wait(fault)
            if (fault.outcome === 'failure') {
              res
                .writeHead(503, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'Synthetic scoped fault' }))
              return
            }
            if (fault.outcome === 'empty') {
              res
                .writeHead(200, { 'content-type': 'application/json' })
                .end('[]')
              return
            }
          }
        }
      }
      const proxy = request(
        url,
        {
          method: req.method,
          headers: { ...req.headers, host: upstream.host }
        },
        response => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        }
      )
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.on('aborted', () => proxy.destroy())
      req.pipe(proxy)
    }
    handle().catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', upstream)
    if (url.origin !== upstream.origin) {
      socket.destroy()
      return
    }
    const proxy = request(url, {
      headers: { ...req.headers, host: upstream.host }
    })
    proxy.on('upgrade', (response, target, targetHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n`
      )
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(
          `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`
        )
      socket.write('\r\n')
      if (targetHead.length > 0) socket.write(targetHead)
      if (head.length > 0) target.write(head)
      target.pipe(socket).pipe(target)
      socket.once('close', () => target.destroy())
      target.once('error', () => socket.destroy())
    })
    proxy.on('response', () => socket.destroy())
    proxy.on('error', () => socket.destroy())
    socket.once('error', () => proxy.destroy())
    proxy.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      options.faults.clear()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
      )
    }
  }
}
