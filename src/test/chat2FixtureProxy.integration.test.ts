import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  CHAT2_PROXY_CAPABILITIES,
  chat2FixtureProxy,
  type Chat2Proxy
} from './chat2FixtureProxy'

const conversation = 'cnv_group'
const token = 'k'.repeat(40)

/** A websocket frame from the server: unmasked text. */
function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}

/** A websocket frame from a client: masked text. */
function clientFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | payload.length]),
    mask,
    masked
  ])
}

describe('chat2 fixture proxy', () => {
  let api: Server
  let media: Server
  let proxy: Chat2Proxy
  let posted: number
  let mediaHosts: string[]
  const upgraded = new Set<Socket>()
  const upstream = (server: Server): string =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const listen = async (server: Server): Promise<void> => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  const calls: string[] = []

  beforeEach(async () => {
    posted = 0
    mediaHosts = []
    media = createServer((req, res) => {
      mediaHosts.push(req.headers.host ?? '')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('blob')
    })
    await listen(media)
    api = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/api/v1/auth/me') {
        const viewer = req.headers.authorization === 'Bearer viewer'
        res.writeHead(viewer ? 200 : 401, {
          'content-type': 'application/json'
        })
        res.end(viewer ? JSON.stringify({ id: 'usr_viewer' }) : '{}')
        return
      }
      if (
        url.pathname === `/api/v1/chat/conversations/${conversation}/messages`
      ) {
        if (req.method === 'POST') posted++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          req.method === 'POST'
            ? '{"id":"msg_new"}'
            : JSON.stringify([
                { id: 'msg_a', seq: 1, kind: 'reaction' },
                { id: 'msg_b', seq: 2, kind: 'edit' }
              ])
        )
        return
      }
      if (url.pathname === '/api/v1/chat/attachments/att_1') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ url: upstream(media) + '/recovery/chat/a?sig=1' })
        )
        return
      }
      res.writeHead(404).end()
    })
    api.on('upgrade', (_req, socket: Socket) => {
      upgraded.add(socket)
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
      )
      socket.write(
        serverFrame(
          JSON.stringify({
            type: 'chat',
            conversationId: conversation,
            kind: 'message',
            seq: 7
          })
        )
      )
    })
    await listen(api)
    calls.length = 0
    proxy = await chat2FixtureProxy({
      ownershipId: 'owned-fixture-1',
      applicationSource: 'a'.repeat(40),
      apiUpstream: upstream(api),
      mediaUpstream: upstream(media),
      controlToken: token,
      deferLimitMs: 2000,
      actions: {
        restoreAttention: async (viewer, chat) => {
          calls.push('restore ' + viewer + ' ' + chat)
          return 3
        },
        setLao: async (player, on) => {
          calls.push(`lao ${player} ${String(on)}`)
          return ['lg_1']
        },
        claimLocked: async () => {
          calls.push('claim')
        },
        prepareLoop: async () => ({ conversationId: conversation }),
        postLoop: async () => ({ targets: [], expectedCount: 3 })
      }
    })
  })
  afterEach(async () => {
    await proxy.close()
    for (const socket of upgraded) socket.destroy()
    upgraded.clear()
    await new Promise<void>(resolve =>
      api.close(() => {
        resolve()
      })
    )
    await new Promise<void>(resolve =>
      media.close(() => {
        resolve()
      })
    )
  })

  const control = async (
    detail: Record<string, unknown>,
    secret = token
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const answer = await fetch(proxy.apiOrigin + '/__chat2_fixture', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret },
      body: JSON.stringify({ ownershipId: 'owned-fixture-1', ...detail })
    })
    return {
      status: answer.status,
      body:
        answer.status === 403
          ? {}
          : ((await answer.json()) as Record<string, unknown>)
    }
  }
  const history = async (query: string): Promise<Response> =>
    await fetch(
      `${proxy.apiOrigin}/api/v1/chat/conversations/${conversation}/messages?${query}`,
      { headers: { authorization: 'Bearer viewer' } }
    )
  const events = async (
    detail: Record<string, unknown> = {}
  ): Promise<Array<Record<string, unknown>>> =>
    (await control({ action: 'snapshot', ...detail })).body.events as Array<
      Record<string, unknown>
    >

  it('proves ownership, its source and every required capability', async () => {
    const prepared = await control({
      action: 'prepare',
      source: 'a'.repeat(40)
    })
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.uiActions, false)
    assert.deepEqual(prepared.body.capabilities, [...CHAT2_PROXY_CAPABILITIES])
    const other = await control({ action: 'prepare', source: 'b'.repeat(40) })
    assert.equal(other.status, 409)
    assert.equal(other.body.ok, false)
    assert.equal(
      (await control({ action: 'prepare' }, 'x'.repeat(40))).status,
      403
    )
    const foreign = await fetch(proxy.apiOrigin + '/__chat2_fixture', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'prepare', ownershipId: 'someone-else' })
    })
    assert.equal(foreign.status, 409)
  })

  it('records history pages as metadata and orders every event', async () => {
    assert.equal((await history('before=9')).status, 200)
    const [page] = await events({
      viewerId: 'usr_viewer',
      conversationId: conversation
    })
    assert.equal(page.type, 'history-response')
    assert.deepEqual(page.rows, [
      { id: 'msg_a', seq: 1 },
      { id: 'msg_b', seq: 2 }
    ])
    assert.equal(page.operationsOnly, true)
    assert.equal(page.empty, false)
    assert.deepEqual(page.query, { before: 9 })
    assert.equal(page.actorId, 'usr_viewer')
    assert.equal((await events({ afterEvent: page.event })).length, 0)
    assert.equal((await events({ viewerId: 'usr_other' })).length, 0)
  })

  it('fails exactly one matching send without forwarding it, then lets the retry through', async () => {
    const installed = await control({
      action: 'fault',
      phase: 'send',
      viewerId: 'usr_viewer',
      conversationId: conversation
    })
    const rule = installed.body.rule as Record<string, unknown>
    assert.equal(rule.mode, 'fail')
    assert.equal(rule.remaining, 1)
    const send = async (): Promise<number> =>
      (
        await fetch(
          `${proxy.apiOrigin}/api/v1/chat/conversations/${conversation}/messages`,
          {
            method: 'POST',
            headers: { authorization: 'Bearer viewer' },
            body: '{}'
          }
        )
      ).status
    assert.equal(await send(), 503)
    assert.equal(posted, 0)
    assert.equal(await send(), 200)
    assert.equal(posted, 1)
    const types = (await events()).map(event => event.type)
    assert.deepEqual(types, ['fault-matched', 'send'])
  })

  it('holds a deferred history page until clear-fault releases it', async () => {
    await control({
      action: 'fault',
      phase: 'history-original',
      mode: 'defer',
      viewerId: 'usr_viewer',
      conversationId: conversation,
      beforeAtMost: 5
    })
    // Not matched: the opening page is above the read cursor.
    assert.equal((await history('before=9')).status, 200)
    let settled = false
    const pending = history('before=4').then(response => {
      settled = true
      return response
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(settled, false)
    const matched = (await events()).find(
      event => event.type === 'fault-matched'
    )
    assert.equal(matched?.mode, 'defer')
    assert.deepEqual(matched?.query, { before: 4 })
    assert(!(await events()).some(event => event.type === 'deferred-closed'))
    const cleared = await control({ action: 'clear-fault' })
    assert.equal(cleared.body.released, 1)
    assert.equal((await pending).status, 200)
    const closed = (await events()).find(
      event => event.type === 'deferred-closed'
    )
    assert.equal(closed?.ruleId, matched?.ruleId)
    assert.equal((await control({ action: 'clear-fault' })).body.released, 0)
  })

  it('answers an injected empty page and ignores forward fetches', async () => {
    await control({
      action: 'fault',
      phase: 'history-jump',
      mode: 'empty',
      viewerId: 'usr_viewer',
      conversationId: conversation
    })
    assert.equal(
      await (await history('after=2')).text(),
      JSON.stringify([
        { id: 'msg_a', seq: 1, kind: 'reaction' },
        { id: 'msg_b', seq: 2, kind: 'edit' }
      ])
    )
    assert.equal(await (await history('before=3')).text(), '[]')
    const injected = (await events()).find(event => event.injected === true)
    assert.equal(injected?.empty, true)
    assert.equal(
      (
        await control({
          action: 'fault',
          phase: 'send',
          mode: 'empty',
          viewerId: 'usr_viewer',
          conversationId: conversation
        })
      ).status,
      409
    )
  })

  it('points media at its own front and records requests without their bodies', async () => {
    const listing = (await (
      await fetch(proxy.apiOrigin + '/api/v1/chat/attachments/att_1')
    ).json()) as { url: string }
    assert(listing.url.startsWith(proxy.mediaOrigin + '/recovery/chat/a'))
    assert.equal(await (await fetch(listing.url)).text(), 'blob')
    assert.deepEqual(mediaHosts, [new URL(upstream(media)).host])
    const [request] = await events({ kind: 'media' })
    assert.deepEqual(
      { type: request.type, method: request.method, path: request.path },
      { type: 'media-request', method: 'GET', path: '/recovery/chat/a' }
    )
    assert.equal(JSON.stringify(request).includes('blob'), false)
  })

  it('reports both directions of socket traffic and its chat hints', async () => {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const port = Number(new URL(proxy.apiOrigin).port)
      const client = require('node:net').connect(port, '127.0.0.1', () => {
        client.write(
          'GET /api/v1/socket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
            createHash('sha1').update('k').digest('base64') +
            '\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer viewer\r\n\r\n'
        )
        resolve(client as Socket)
      })
      client.once('error', reject)
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    socket.write(clientFrame('{"type":"ping"}'))
    await new Promise(resolve => setTimeout(resolve, 200))
    const [row] = (await control({ action: 'snapshot', kind: 'socket' })).body
      .activeSockets as Array<Record<string, unknown>>
    assert.equal(row.status, 101)
    assert.equal(row.actorId, 'usr_viewer')
    assert.equal(row.clientPayloadBytes, '{"type":"ping"}'.length)
    assert(Number(row.serverPayloadBytes) > 0)
    assert.deepEqual(row.chatMessageHints, [
      { conversationId: conversation, seq: 7 }
    ])
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.deepEqual(
      (await control({ action: 'snapshot', kind: 'socket' })).body
        .activeSockets,
      []
    )
  })

  it('delegates state changes to its owner and refuses unknown actions', async () => {
    assert.equal(
      (
        await control({
          action: 'restore-attention',
          viewerId: 'usr_viewer',
          conversationId: conversation
        })
      ).body.cursor,
      3
    )
    assert.deepEqual(
      (await control({ action: 'set-lao', playerId: 'usr_p', on: true })).body
        .leagues,
      ['lg_1']
    )
    assert.equal((await control({ action: 'claim-locked' })).body.claimed, true)
    assert.equal(
      (await control({ action: 'post-loop', viewerId: 'usr_viewer' })).body
        .expectedCount,
      3
    )
    assert.deepEqual(calls, [
      'restore usr_viewer cnv_group',
      'lao usr_p true',
      'claim'
    ])
    assert.equal((await control({ action: 'reset-everything' })).status, 409)
  })
})
