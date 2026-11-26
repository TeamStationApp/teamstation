import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { mock } from 'node:test'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { type WebSocket, WebSocketServer } from 'ws'

import { SEARCH_SOCKET_PATH } from '../../common/search/types'
import { withQueryReplies } from '../../test/queryReplies'
import { asServerConfig } from '../serverConfigSchema'
import { attachSearchSocket } from './socket'

describe('search frame admission', () => {
  it('charges the open connection and closes an over-budget guest before reading the database', async () => {
    await withQueryReplies([], async db => {
      const socket = new PassThrough()
      const request = {
        url: SEARCH_SOCKET_PATH,
        headers: { 'x-forwarded-for': '192.0.2.44' },
        socket: { remoteAddress: '127.0.0.1' }
      } as unknown as IncomingMessage
      const frames = new EventEmitter()
      const close = mock.fn()
      const ws = Object.assign(frames, { close })
      const handshake = mock.method(
        WebSocketServer.prototype,
        'handleUpgrade',
        (
          _request: IncomingMessage,
          _stream: PassThrough,
          _head: Buffer,
          done: (ws: WebSocket) => void
        ) => {
          done(ws as unknown as WebSocket)
        }
      )
      let finish!: (seconds: number) => void
      const charge = mock.fn(
        async () =>
          await new Promise<number>(resolve => {
            finish = resolve
          })
      )
      const search = attachSearchSocket({
        db,
        deps: { jevBaseUrl: '', space: asServerConfig({}).space },
        spendSearch: charge
      })
      try {
        expect(search.acceptUpgrade(request, socket, Buffer.alloc(0))).equals(
          true
        )
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(search.size()).equals(1)
        frames.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'search',
              seq: 1,
              text: 'fixture',
              location: null,
              mode: 'all'
            })
          ),
          false
        )
        await new Promise<void>(resolve => setImmediate(resolve))
        frames.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'search',
              seq: 2,
              text: 'another',
              location: null,
              mode: 'all'
            })
          ),
          false
        )
        finish(3)
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(charge.mock.calls.map(call => call.arguments)).deep.equals([
          ['192.0.2.44', undefined, socket]
        ])
        expect(close.mock.calls.map(call => call.arguments)).deep.equals([
          [1013, 'Try again in 3 seconds']
        ])
      } finally {
        frames.emit('close')
        search.close()
        handshake.mock.restore()
        socket.destroy()
      }
    })
  })
})
