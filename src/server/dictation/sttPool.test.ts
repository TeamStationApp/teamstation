import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { WebSocketServer } from 'ws'

import { SttSession } from './stt'

describe('voice key fallback over real sockets', () => {
  it('replays the audio after a refused handshake and ends only with the successful transcript', async () => {
    const server = createServer()
    const provider = new WebSocketServer({ noServer: true })
    const seen: string[] = []
    const audio: Buffer[] = []
    server.on('upgrade', (request, socket, head) => {
      seen.push(request.headers.authorization ?? '')
      if (seen.length === 1) {
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        )
        return
      }
      provider.handleUpgrade(request, socket, head, ws => {
        ws.send(JSON.stringify({ type: 'transcript.created' }))
        ws.on('message', (data, binary) => {
          if (binary) audio.push(Buffer.from(data as Buffer))
          else if (
            JSON.parse((data as Buffer).toString('utf8')).type === 'finalize'
          )
            ws.send(
              JSON.stringify({
                type: 'transcript.partial',
                speech_final: true,
                text: 'Ball one'
              })
            )
        })
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    let session: SttSession | undefined
    try {
      const result = await new Promise<string>((resolve, reject) => {
        session = new SttSession(
          {
            apiKey: ['voice-a', 'voice-b'],
            url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
            handshakeTimeoutMs: 1000,
            finalTimeoutMs: 1000
          },
          {
            onPartial: () => undefined,
            onFinal: resolve,
            onError: message => {
              reject(new Error(message))
            }
          }
        )
        session.retarget(['Trout'])
        session.begin()
        session.write(Buffer.from([1, 0, 2, 0]))
        session.end()
      })
      expect(result).equals('Ball one')
      expect(seen).length(2)
      expect(new Set(seen).size).equals(2)
      expect(Buffer.concat(audio)).deep.equals(Buffer.from([1, 0, 2, 0]))
    } finally {
      session?.close()
      for (const client of provider.clients) client.terminate()
      provider.close()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })
})
