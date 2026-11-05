import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { type WebSocket, WebSocketServer } from 'ws'

import { SttSession } from './stt'

/** What the provider does with the upgrade for its `n`th connection, from 1. */
type Upgrade = (
  n: number,
  request: IncomingMessage,
  socket: Socket,
  accept: () => WebSocket
) => void

/** A stand-in for xAI that answers each `finalize` with `Ball <n>`. */
async function provider(upgrade: Upgrade): Promise<{
  url: string
  seen: string[]
  audio: Buffer[]
  stop: () => Promise<void>
}> {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const seen: string[] = []
  const audio: Buffer[] = []
  let finals = 0
  server.on('upgrade', (request, socket, head) => {
    seen.push(request.headers.authorization ?? '')
    upgrade(seen.length, request, socket as Socket, () => {
      let accepted: WebSocket | undefined
      wss.handleUpgrade(request, socket, head, ws => {
        accepted = ws
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
                text: `Ball ${++finals}`
              })
            )
        })
      })
      return accepted!
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    audio,
    stop: async () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  }
}

/** One hold through `session`, resolving with its transcript. */
async function hold(session: SttSession, finals: string[]): Promise<string> {
  const before = finals.length
  session.begin()
  session.write(Buffer.from([1, 0, 2, 0]))
  session.end()
  while (finals.length === before)
    await new Promise(resolve => setTimeout(resolve, 5))
  return finals[before]
}

function pooledSession(
  url: string,
  finals: string[],
  errors: string[]
): SttSession {
  return new SttSession(
    {
      apiKey: ['voice-a', 'voice-b'],
      url,
      handshakeTimeoutMs: 1000,
      finalTimeoutMs: 1000
    },
    {
      onPartial: () => undefined,
      onFinal: text => finals.push(text),
      onError: message => {
        errors.push(message)
        finals.push(`error ${message}`)
      }
    }
  )
}

describe('voice key fallback over real sockets', () => {
  it('replays the audio after a refused handshake and ends only with the successful transcript', async () => {
    const xai = await provider((n, _request, socket, accept) => {
      if (n === 1)
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        )
      else accept()
    })
    const finals: string[] = []
    const errors: string[] = []
    const session = pooledSession(xai.url, finals, errors)
    try {
      session.retarget(['Trout'])
      expect(await hold(session, finals)).equals('Ball 1')
      expect(errors).deep.equals([])
      expect(xai.seen).length(2)
      expect(new Set(xai.seen).size).equals(2)
      expect(Buffer.concat(xai.audio)).deep.equals(Buffer.from([1, 0, 2, 0]))
      // The next hold stays on the key that worked, over the same socket.
      expect(await hold(session, finals)).equals('Ball 2')
      expect(xai.seen).length(2)
    } finally {
      session.close()
      await xai.stop()
    }
  })

  it('serves every hold on a healthy key over one connection', async () => {
    const xai = await provider((_n, _request, _socket, accept) => {
      accept()
    })
    const finals: string[] = []
    const errors: string[] = []
    const session = pooledSession(xai.url, finals, errors)
    try {
      session.retarget(['Trout'])
      expect(await hold(session, finals)).equals('Ball 1')
      expect(await hold(session, finals)).equals('Ball 2')
      expect(errors).deep.equals([])
      expect(xai.seen).length(1)
    } finally {
      session.close()
      await xai.stop()
    }
  })

  it('replays a hold on another key when its connection drops', async () => {
    const xai = await provider((n, _request, _socket, accept) => {
      const ws = accept()
      if (n === 1) ws.terminate()
    })
    const finals: string[] = []
    const errors: string[] = []
    const session = pooledSession(xai.url, finals, errors)
    try {
      expect(await hold(session, finals)).equals('Ball 1')
      expect(errors).deep.equals([])
      expect(xai.seen).length(2)
      expect(new Set(xai.seen).size).equals(2)
    } finally {
      session.close()
      await xai.stop()
    }
  })
})
