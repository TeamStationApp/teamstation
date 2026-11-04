import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, it } from 'mocha'
import { WebSocket, WebSocketServer } from 'ws'

import { RecoveryFaults } from './chatRecoveryFaults'
import { recoveryRelay } from './chatRecoveryRelay'

describe('owned chat recovery HTTP fault relay', () => {
  it('isolates faults by authenticated user and restores normal HTTP and socket traffic', async () => {
    const posts: string[] = []
    const upstream = createServer((req, res) => {
      const handle = async (): Promise<void> => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/api/v1/auth/me') {
          res.end(
            JSON.stringify({
              id: req.headers.cookie === 'actor=yes' ? 'usr_actor' : 'usr_other'
            })
          )
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        if (req.method === 'POST') posts.push(Buffer.concat(chunks).toString())
        res.end(JSON.stringify({ normal: true }))
      }
      handle().catch(() => {
        res.writeHead(500).end()
      })
    })
    const ws = new WebSocketServer({ server: upstream })
    ws.on('connection', socket =>
      socket.on('message', data => {
        socket.send(data)
      })
    )
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const token = 'x'.repeat(32)
    const relay = await recoveryRelay({
      disposable: true,
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      controlToken: token,
      faults: new RecoveryFaults(() => {}),
      allowedOrigins: ['http://127.0.0.1:8080']
    })
    const base = `http://127.0.0.1:${relay.port}`
    const path = '/api/v1/chat/conversations/cnv_scene/messages'
    const control = async (body: object, secret = token): Promise<Response> =>
      await fetch(base + '/__recovery_fault', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + secret },
        body: JSON.stringify(body)
      })
    const gate = {
      gateId: 'send-failure',
      userId: 'usr_actor',
      conversationId: 'cnv_scene',
      kind: 'send',
      outcome: 'failure',
      delayMs: 0,
      remaining: 1
    }
    try {
      assert.equal((await control(gate, 'wrong')).status, 403)
      assert.equal((await control({ ...gate, remaining: -1 })).status, 400)
      assert.equal((await control(gate)).status, 204)
      assert.equal(
        (await fetch(base + path, { method: 'POST', body: 'other' })).status,
        200
      )
      const failed = await fetch(base + path, {
        method: 'POST',
        body: 'withheld',
        headers: { cookie: 'actor=yes', origin: 'http://127.0.0.1:8080' }
      })
      assert.equal(failed.status, 503)
      assert.equal(
        failed.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:8080'
      )
      assert.equal(
        (
          await fetch(base + path, {
            method: 'POST',
            body: 'retried',
            headers: { cookie: 'actor=yes' }
          })
        ).status,
        200
      )
      assert.deepEqual(posts, ['other', 'retried'])
      assert.equal(
        (
          await control({
            ...gate,
            gateId: 'empty-page',
            kind: 'page',
            outcome: 'empty'
          })
        ).status,
        204
      )
      assert.deepEqual(
        await (
          await fetch(base + path + '?after=1', {
            headers: { cookie: 'actor=yes' }
          })
        ).json(),
        { normal: true }
      )
      assert.deepEqual(
        await (
          await fetch(base + path + '?before=1', {
            headers: { cookie: 'actor=yes' }
          })
        ).json(),
        []
      )
      assert.equal((await control({ ...gate, gateId: 'clear-me' })).status, 204)
      assert.equal(
        (
          await fetch(base + '/__recovery_fault', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ' + token }
          })
        ).status,
        204
      )
      assert.equal(
        (
          await fetch(base + path, {
            method: 'POST',
            headers: { cookie: 'actor=yes' }
          })
        ).status,
        200
      )
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket')
      await once(socket, 'open')
      const message = once(socket, 'message')
      socket.send('opaque socket frame')
      assert.equal(String((await message)[0]), 'opaque socket frame')
      const closed = once(socket, 'close')
      socket.close()
      await closed
    } finally {
      await relay.close()
      ws.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve =>
        upstream.close(() => {
          resolve()
        })
      )
    }
  })

  it('refuses nonlocal upstreams and absent ownership before listening', async () => {
    const options = {
      disposable: true as const,
      upstream: 'https://example.com',
      controlToken: 'x'.repeat(32),
      faults: new RecoveryFaults(() => {}),
      allowedOrigins: []
    }
    await assert.rejects(recoveryRelay(options))
    await assert.rejects(
      recoveryRelay({ ...options, upstream: 'http://example.com' })
    )
    await assert.rejects(
      recoveryRelay({
        ...options,
        upstream: 'http://127.0.0.1',
        disposable: false as true
      })
    )
    await assert.rejects(
      recoveryRelay({
        ...options,
        upstream: 'http://127.0.0.1',
        controlToken: ''
      })
    )
  })
})
