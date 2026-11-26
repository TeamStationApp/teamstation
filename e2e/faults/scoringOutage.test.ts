import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ScoringOutage } from './scoringOutage'

describe('a scoring handset outage on the isolated stack', function () {
  it('drops only the identified session across the native header and browser cookie, and releases it', function () {
    const gate = new ScoringOutage()
    const req = (
      method: string,
      path: string,
      token: string,
      cookie = false
    ): IncomingMessage =>
      ({
        method,
        url: '/api/v1/' + path,
        socket: new PassThrough(),
        headers: cookie
          ? { cookie: 'ts_session=' + token }
          : { authorization: 'Bearer ' + token }
      }) as unknown as IncomingMessage
    const socket = new PassThrough()
    const peerSocket = new PassThrough()
    try {
      gate.set('game', 'watch')
      gate.socket(req('GET', 'socket', 'handset', true), socket)
      gate.socket(req('GET', 'socket', 'peer', true), peerSocket)
      expect(() => {
        gate.set('game', 'offline')
      }).throws()
      expect(gate.request(req('POST', 'games/game/events', 'handset'))).equals(
        false
      )
      gate.set('game', 'offline')
      expect(socket.destroyed).equals(true)
      expect(peerSocket.destroyed).equals(false)
      const blocked = req('GET', 'games/game', 'handset', true)
      expect(gate.request(blocked)).equals(true)
      expect(blocked.socket.destroyed).equals(false)
      expect(gate.request(req('POST', 'games/game/events', 'handset'))).equals(
        true
      )
      expect(gate.request(req('POST', 'games/game/events', 'peer'))).equals(
        false
      )
      expect(
        gate.socket(req('GET', 'socket', 'handset'), new PassThrough())
      ).equals(true)
      expect(gate.status('game')).deep.equals({
        identified: true,
        offline: true,
        failedReads: 1,
        failedWrites: 1,
        closedSockets: 2
      })
      gate.set('game', 'online')
      expect(blocked.socket.destroyed).equals(true)
      expect(gate.request(req('GET', 'games/game', 'handset'))).equals(false)
    } finally {
      gate.close()
      peerSocket.destroy()
    }
  })
})
