import { createServer } from 'node:http'
import { type AddressInfo, connect, type Socket } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { startFaultProxy } from './proxy'

describe('the fault proxy', function () {
  it('closes both sides of an upgraded connection when it closes', async function () {
    let upstreamClosed!: () => void
    const closed = new Promise<void>(resolve => {
      upstreamClosed = resolve
    })
    const api = createServer()
    api.on('upgrade', (_req, socket: Socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      )
      socket.on('end', upstreamClosed)
      socket.on('close', upstreamClosed)
    })
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    const { port } = api.address() as AddressInfo
    const proxy = await startFaultProxy({ target: `http://127.0.0.1:${port}` })
    const client = connect(proxy.port, '127.0.0.1')
    try {
      await new Promise<void>(resolve => client.once('connect', resolve))
      client.write(
        'GET /socket HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      )
      const reply = await new Promise<string>(resolve =>
        client.once('data', data => {
          resolve(String(data))
        })
      )
      expect(reply).includes('101')
      await proxy.close()
      const ended = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>(resolve => {
          setTimeout(() => {
            resolve(false)
          }, 2000)
        })
      ])
      expect(ended).equals(true)
    } finally {
      client.destroy()
      api.closeAllConnections()
      api.close()
    }
  }).timeout(10000)
})
